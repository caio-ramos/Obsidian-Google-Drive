import { checkConnection, getDriveClient } from "helpers/drive";
import { refreshAccessToken } from "helpers/ky";
import { pull } from "helpers/pull";
import { push } from "helpers/push";
import { reset } from "helpers/reset";
import {
	App,
	debounce,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
} from "obsidian";

interface PluginSettings {
	refreshToken: string;
	operations: Record<string, "create" | "delete" | "modify">;
	driveIdToPath: Record<string, string>;
	lastSyncedAt: number;
	changesToken: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	refreshToken: "",
	operations: {},
	driveIdToPath: {},
	lastSyncedAt: 0,
	changesToken: "",
};

export default class ObsidianGoogleDrive extends Plugin {
	settings: PluginSettings;
	accessToken = {
		token: "",
		expiresAt: 0,
	};
	drive = getDriveClient(this);
	ribbonIcon: HTMLElement;
	syncing: boolean;

	async onload() {
		const { vault } = this.app;

		await this.loadSettings();

		this.addSettingTab(new SettingsTab(this.app, this));

		if (!this.settings.refreshToken) {
			new Notice(
				"Please add your refresh token to Google Drive Sync through our website or our readme/this plugin's settings. If you haven't already, PLEASE read through this plugin's readme or website CAREFULLY for instructions on how to use this plugin. If you don't know what you're doing, your data could get DELETED.",
				0
			);
			return;
		}

		this.ribbonIcon = this.addRibbonIcon(
			"refresh-cw",
			"Push to Google Drive",
			() => push(this)
		);

		this.addCommand({
			id: "push",
			name: "Push to Google Drive",
			callback: () => push(this),
		});

		this.addCommand({
			id: "pull",
			name: "Pull from Google Drive",
			callback: () => pull(this),
		});

		this.addCommand({
			id: "reset",
			name: "Reset local vault to Google Drive",
			callback: () => reset(this),
		});

		this.registerEvent(
			this.app.workspace.on("quit", () => this.saveSettings())
		);

		this.app.workspace.onLayoutReady(() =>
			this.registerEvent(vault.on("create", this.handleCreate.bind(this)))
		);
		this.registerEvent(vault.on("delete", this.handleDelete.bind(this)));
		this.registerEvent(vault.on("modify", this.handleModify.bind(this)));
		this.registerEvent(vault.on("rename", this.handleRename.bind(this)));

		checkConnection().then(async (connected) => {
			if (connected) {
				this.syncing = true;
				this.ribbonIcon.addClass("spin");
				await pull(this, true);
				await this.endSync();
			}
		});
	}

	onunload() {
		return this.saveSettings();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	saveSettings() {
		return this.saveData(this.settings);
	}

	debouncedSaveSettings = debounce(this.saveSettings.bind(this), 500, true);

	handleCreate(file: TAbstractFile) {
		// Include hidden files and folders (starting with .)
		if (this.shouldSyncFile(file.path)) {
			if (this.settings.operations[file.path] === "delete") {
				if (file instanceof TFile) {
					this.settings.operations[file.path] = "modify";
				} else {
					delete this.settings.operations[file.path];
				}
			} else {
				this.settings.operations[file.path] = "create";
			}
			this.debouncedSaveSettings();
		}
	}

	handleDelete(file: TAbstractFile) {
		// Include hidden files and folders (starting with .)
		if (this.shouldSyncFile(file.path)) {
			if (this.settings.operations[file.path] === "create") {
				delete this.settings.operations[file.path];
			} else {
				this.settings.operations[file.path] = "delete";
			}
			this.debouncedSaveSettings();
		}
	}

	handleModify(file: TFile) {
		// Include hidden files and folders (starting with .)
		if (this.shouldSyncFile(file.path)) {
			const operation = this.settings.operations[file.path];
			if (operation === "create" || operation === "modify") {
				return;
			}
			this.settings.operations[file.path] = "modify";
			this.debouncedSaveSettings();
		}
	}

	shouldSyncFile(path: string): boolean {
		// Allow syncing of hidden files/folders (starting with .)
		// Exclude only system files that shouldn't be synced
		const excludePatterns = [
			'.DS_Store',
			'.git/',
			'node_modules/',
			'.obsidian/workspace.json',
			'.obsidian/workspace-mobile.json',
		];
		
		return !excludePatterns.some(pattern => 
			pattern.endsWith('/') ? path.startsWith(pattern) : path.includes(pattern)
		);
	}

	handleRename(file: TAbstractFile, oldPath: string) {
		this.handleDelete({ ...file, path: oldPath });
		this.handleCreate(file);
		this.debouncedSaveSettings();
	}

	async createFolder(path: string) {
		const oldOperation = this.settings.operations[path];
		await this.app.vault.createFolder(path);
		this.settings.operations[path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[path];
	}

	async createFile(
		path: string,
		content: ArrayBuffer,
		modificationDate?: number | string | Date
	) {
		const oldOperation = this.settings.operations[path];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.createBinary(path, content, {
			mtime: modificationDate,
		});
		this.settings.operations[path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[path];
	}

	async modifyFile(
		file: TFile,
		content: ArrayBuffer,
		modificationDate?: number | string | Date
	) {
		const oldOperation = this.settings.operations[file.path];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.modifyBinary(file, content, {
			mtime: modificationDate,
		});
		this.settings.operations[file.path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[file.path];
	}

	async upsertFile(
		file: string,
		content: ArrayBuffer,
		modificationDate?: number | string | Date
	) {
		const oldOperation = this.settings.operations[file];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.adapter.writeBinary(file, content, {
			mtime: modificationDate,
		});
		this.settings.operations[file] = oldOperation;
		if (!oldOperation) delete this.settings.operations[file];
	}

	async deleteFile(file: TAbstractFile) {
		const oldOperation = this.settings.operations[file.path];
		await this.app.fileManager.trashFile(file);
		delete this.settings.operations[file.path];
		if (!oldOperation) delete this.settings.operations[file.path];
	}

	async startSync() {
		if (!(await checkConnection())) {
			throw new Notice(
				"You are not connected to the internet, so you cannot sync right now. Please try syncing once you have connection again."
			);
		}
		this.ribbonIcon.addClass("spin");
		this.syncing = true;
		return new Notice("Syncing (0%)", 0);
	}

	async endSync(syncNotice?: Notice, retainConfigChanges = true) {
		if (retainConfigChanges) {
			const configFilesToSync = await this.drive.getConfigFilesToSync();

			this.settings.lastSyncedAt = Date.now();

			await Promise.all(
				configFilesToSync.map(async (file) =>
					this.app.vault.adapter.writeBinary(
						file,
						await this.app.vault.adapter.readBinary(file),
						{ mtime: Date.now() }
					)
				)
			);
		} else {
			this.settings.lastSyncedAt = Date.now();
		}

		const changesToken = await this.drive.getChangesStartToken();
		if (!changesToken) {
			return new Notice(
				"An error occurred fetching Google Drive changes token."
			);
		}
		this.settings.changesToken = changesToken;
		await this.saveSettings();
		this.ribbonIcon.removeClass("spin");
		this.syncing = false;
		syncNotice?.hide();
	}
}

class SettingsTab extends PluginSettingTab {
	plugin: ObsidianGoogleDrive;

	constructor(app: App, plugin: ObsidianGoogleDrive) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		const { vault } = this.app;

		containerEl.empty();

		containerEl.createEl("a", {
			href: "https://ogd.richardxiong.com",
			text: "Get refresh token",
		});

		new Setting(containerEl)
			.setName("Refresh token")
			.setDesc(
				"A refresh token is required to access your Google Drive for syncing. We suggest cloning your Google Drive vault to the current vault BEFORE syncing."
			)
			.addText((text) => {
				const cancel = () => {
					this.plugin.settings.refreshToken = "";
					text.setValue("");
					return this.plugin.saveSettings();
				};

				text.setPlaceholder("Enter your refresh token")
					.setValue(this.plugin.settings.refreshToken)
					.onChange(async (value) => {
						this.plugin.settings.refreshToken = value;
						if (!value) {
							return this.plugin.debouncedSaveSettings();
						}
						if (!(await refreshAccessToken(this.plugin))) {
							text.setValue("");
							return;
						}
						
						// Ensure Obsidian folder structure exists
						const structureCreated = await this.plugin.drive.ensureObsidianStructure();
						if (!structureCreated) {
							new Notice("Failed to create Obsidian folder structure in Google Drive.");
							return cancel();
						}

						const changesToken =
							await this.plugin.drive.getChangesStartToken();
						if (!changesToken) {
							return new Notice(
								"An error occurred fetching Google Drive changes token."
							);
						}
						this.plugin.settings.changesToken = changesToken;

						await this.plugin.saveSettings();
						
						// Perform automatic sync if vault is empty (including hidden files)
						const allFiles = await this.getAllVaultFiles();
						const vaultFiles = allFiles.filter(path => 
							path !== "/" && this.plugin.shouldSyncFile(path)
						);
						
						if (vaultFiles.length === 0) {
							new Notice("Performing initial sync from Google Drive...");
							try {
								await pull(this.plugin, true);
								new Notice("Initial sync completed successfully!");
							} catch (error) {
								console.error("[GDriveSync] Initial sync failed:", error);
								new Notice("Initial sync failed. You can manually sync later.");
							}
						} else {
							new Notice(
								"Your vault contains files. Please manually sync to merge with Google Drive content.",
								8000
							);
						}
						
						new Notice(
							"Refresh token saved! Google Drive sync is now active.",
							5000
						);
					});
			});
	}

	async getAllVaultFiles(): Promise<string[]> {
		const { adapter } = this.app.vault;
		const files: string[] = [];
		
		const collectFiles = async (folderPath: string = ""): Promise<void> => {
			try {
				const list = await adapter.list(folderPath);
				
				// Add all files
				for (const file of list.files) {
					files.push(file);
				}
				
				// Recursively collect from folders
				for (const folder of list.folders) {
					files.push(folder);
					await collectFiles(folder);
				}
			} catch (error) {
				console.warn(`[GDriveSync] Could not list folder: ${folderPath}`, error);
			}
		};
		
		await collectFiles();
		return files;
	}
}
