import ObsidianGoogleDrive from "main";
import { Notice, TFile, TFolder } from "obsidian";
import {
	batchAsyncs,
	FileMetadata,
	folderMimeType,
	foldersToBatches,
	getSyncMessage,
} from "./drive";
import { refreshAccessToken } from "./ky";

export const pull = async (
	t: ObsidianGoogleDrive,
	silenceNotices?: boolean
) => {
	let syncNotice: any = null;

	if (!silenceNotices) {
		if (t.syncing) return;
		syncNotice = await t.startSync();
	}

	const { vault } = t.app;
	const adapter = vault.adapter;

	console.log("[GDriveSync] Starting pull operation");
	
	if (!t.accessToken.token) await refreshAccessToken(t);

	console.log("[GDriveSync] Searching for recently modified files...");
	const recentlyModified = await t.drive.searchFiles({
		include: ["id", "modifiedTime", "properties", "mimeType"],
		matches: [
			{
				modifiedTime: {
					gt: new Date(t.settings.lastSyncedAt).toISOString(),
				},
			},
		],
	});
	if (!recentlyModified) {
		console.error("[GDriveSync] Failed to fetch recently modified files");
		return new Notice("An error occurred fetching Google Drive files. Check console for details.");
	}

	console.log(`[GDriveSync] Found ${recentlyModified.length} recently modified files`);

	// Also fetch hidden files that might not be captured by regular search
	console.log("[GDriveSync] Searching for hidden files...");
	const hiddenFiles = await t.drive.searchHiddenFiles();
	const recentHiddenFiles = hiddenFiles.filter(file => 
		new Date(file.modifiedTime) > new Date(t.settings.lastSyncedAt)
	);
	
	console.log(`[GDriveSync] Found ${hiddenFiles.length} total hidden files, ${recentHiddenFiles.length} recently modified`);
	
	const allRecentFiles = [...recentlyModified, ...recentHiddenFiles];
	console.log(`[GDriveSync] Total files to process: ${allRecentFiles.length}`);

	const changes = await t.drive.getChanges(t.settings.changesToken);
	if (!changes) {
		return new Notice("An error occurred fetching Google Drive changes.");
	}

	const deletions = changes
		.filter(({ removed }) => removed)
		.map(({ fileId }) => {
			const path = t.settings.driveIdToPath[fileId];
			if (!path) return;
			delete t.settings.driveIdToPath[fileId];

			const file = vault.getAbstractFileByPath(path);

			if (!file && t.settings.operations[path] === "delete") {
				delete t.settings.operations[path];
				return;
			}
			return file;
		});

	if (!allRecentFiles.length && !deletions.length) {
		if (silenceNotices) return;
		t.endSync(syncNotice);
		return new Notice("You're up to date!");
	}

	const pathToId = Object.fromEntries(
		Object.entries(t.settings.driveIdToPath).map(([id, path]) => [path, id])
	);

	const updateMap = () => {
		allRecentFiles.forEach(({ id, properties }) => {
			if (properties?.path) {
				pathToId[properties.path] = id;
			}
		});

		t.settings.driveIdToPath = Object.fromEntries(
			Object.entries(pathToId).map(([path, id]) => [id, path])
		);
	};

	updateMap();

	const deleteFiles = async () => {
		const deletedFiles = deletions
			.filter((file) => file instanceof TFile)
			.filter((file: TFile) => {
				if (t.settings.operations[file.path] === "modify") {
					if (!pathToId[file.path]) {
						t.settings.operations[file.path] = "create";
					}
					return;
				}
				return true;
			}) as TFile[];

		const deletionPaths = deletions.map((file) => file?.path);

		const deletedFolders = deletions
			.filter((folder) => folder instanceof TFolder)
			.filter((folder: TFolder) => {
				if (pathToId[folder.path]) return;
				if (
					folder.children.find(
						({ path }) => !deletionPaths.includes(path)
					)
				) {
					return true;
				}
				t.settings.operations[folder.path] = "create";
			}) as TFolder[];

		await t.drive.deleteFilesMinimumOperations([
			...deletedFolders,
			...deletedFiles,
		]);
	};

	await deleteFiles();

	syncNotice?.setMessage("Syncing (33%)");

	const upsertFiles = async () => {
		const newFolders = allRecentFiles.filter(
			({ mimeType }) => mimeType === folderMimeType
		);

		if (newFolders.length) {
			const batches = foldersToBatches(
				newFolders.map(({ properties }) => properties?.path).filter(Boolean)
			);

			for (const batch of batches) {
				await Promise.all(
					batch.map(async (folder) => {
						delete t.settings.operations[folder];
						if (
							vault.getFolderByPath(folder) ||
							(await adapter.exists(folder))
						) {
							return;
						}
						return t.createFolder(folder);
					})
				);
			}
		}

		let completed = 0;

		const newNotes = allRecentFiles.filter(
			({ mimeType }) => mimeType !== folderMimeType
		);

		await batchAsyncs(
			newNotes.map((file: FileMetadata) => async () => {
				// Skip files without path property (shouldn't happen with hidden files, but safety check)
				if (!file.properties?.path) return;
				
				const localFile =
					vault.getFileByPath(file.properties.path) ||
					(await adapter.exists(file.properties.path));
				const operation = t.settings.operations[file.properties.path];

				completed++;

				if (localFile && operation === "modify") {
					return;
				}

				if (localFile && operation === "create") {
					t.settings.operations[file.properties.path] = "modify";
					return;
				}

				const content = await t.drive.getFile(file.id).arrayBuffer();

				syncNotice?.setMessage(
					getSyncMessage(33, 100, completed, newNotes.length)
				);

				if (localFile instanceof TFile) {
					return t.modifyFile(localFile, content, file.modifiedTime);
				}

				return t.upsertFile(
					file.properties.path,
					content,
					file.modifiedTime
				);
			})
		);
	};

	await upsertFiles();

	const deleteConfigs = async () => {
		const configDeletions = await Promise.all(
			changes
				.filter(({ removed }) => removed)
				.map(async ({ fileId }) => {
					const path = t.settings.driveIdToPath[fileId];
					if (!path || vault.getAbstractFileByPath(path)) return;
					const stat = await adapter.stat(path);
					if (!stat) return;
					return { path, type: stat.type };
				})
		);

		let configDeletionsFiltered = configDeletions.filter(Boolean) as {
			path: string;
			type: "file" | "folder";
		}[];

		const trashMethod = (vault as any).getConfig("trashOption");

		if (trashMethod === "local" || trashMethod === "system") {
			const deletionMethod =
				trashMethod === "local"
					? adapter.trashLocal
					: adapter.trashSystem;

			const folders = configDeletionsFiltered.filter(
				(file) => file.type === "folder"
			);

			if (folders.length) {
				const maxDepth = Math.max(
					...folders.map(({ path }) => path.split("/").length)
				);

				for (let depth = 1; depth <= maxDepth; depth++) {
					const foldersToDelete = configDeletionsFiltered.filter(
						(file) =>
							file.type === "folder" &&
							file.path.split("/").length === depth
					);
					await Promise.all(
						foldersToDelete.map(({ path }) => deletionMethod(path))
					);
					foldersToDelete.forEach(
						(folder) =>
							(configDeletionsFiltered =
								configDeletionsFiltered.filter(
									({ path }) =>
										!path.startsWith(folder.path + "/") &&
										path !== folder.path
								))
					);
				}
			}

			return Promise.all(
				configDeletionsFiltered.map(({ path }) => deletionMethod(path))
			);
		}

		const deletedFiles = configDeletionsFiltered.filter(
			(file) => file.type === "file"
		);
		await Promise.all(deletedFiles.map(({ path }) => adapter.remove(path)));

		const deletedFolders = configDeletionsFiltered.filter(
			(file) => file.type === "folder"
		);
		const batches = foldersToBatches(
			deletedFolders.map(({ path }) => path)
		);
		batches.reverse();

		for (const batch of batches) {
			await Promise.all(
				batch.map(async (folder) => {
					const list = await adapter.list(folder);
					if (list.files.length + list.folders.length) return;
					adapter.rmdir(folder, false);
				})
			);
		}
	};

	await deleteConfigs();

	if (silenceNotices) return;

	await t.endSync(syncNotice);

	new Notice("Files have been synced from Google Drive!");
};
