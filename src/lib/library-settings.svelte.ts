import { normalizeStorageFolder, ROMS_FOLDER, SUPPORT_FOLDER, WORKSPACE_FOLDER } from "./adb/workspace";
import type { LibraryFolderOptions } from "./adb/workspace";

const LIBRARY_FOLDER_KEY = "emukase.library.folder";
const ROMS_FOLDER_KEY = "emukase.library.romsFolder";
const BIOS_FOLDER_KEY = "emukase.library.biosFolder";
const LEGACY_ROMS_ROOT_KEY = "emukase.library.romsRoot";

/** Converts an older absolute ROMs root to the storage-relative folder; invalid values are ignored. */
function legacyRomsFolder(): string {
  try {
    const value = localStorage.getItem(LEGACY_ROMS_ROOT_KEY);
    if (!value) return "";
    const relative = /^(?:\/sdcard|\/storage\/emulated\/\d+)\/(.+)$/.exec(value)?.[1];
    if (!relative) return "";
    const folder = normalizeStorageFolder(relative);
    localStorage.setItem(ROMS_FOLDER_KEY, folder);
    localStorage.removeItem(LEGACY_ROMS_ROOT_KEY);
    return folder;
  } catch {
    return "";
  }
}

function storedRomsFolder(): string {
  try {
    const value = localStorage.getItem(ROMS_FOLDER_KEY);
    if (value) return normalizeStorageFolder(value);
    return legacyRomsFolder();
  } catch {
    return "";
  }
}

function storedFolder(key: string): string {
  try {
    const value = localStorage.getItem(key);
    return value ? normalizeStorageFolder(value) : "";
  } catch {
    return "";
  }
}

function persistFolder(key: string, folder: string): void {
  try {
    if (folder) localStorage.setItem(key, folder);
    else localStorage.removeItem(key);
  } catch {
    // The folder still applies for this session when browser storage is unavailable.
  }
}

/** Folder paths are relative to the current Android profile's internal storage. */
export class LibrarySettings {
  open = $state(false);
  checkEmulatorSetup = $state(true);
  libraryFolderInvalid = $state(false);
  romsFolderInvalid = $state(false);
  biosFolderInvalid = $state(false);
  foldersInvalid = $derived(this.libraryFolderInvalid || this.romsFolderInvalid || this.biosFolderInvalid);
  libraryFolder = $state(storedFolder(LIBRARY_FOLDER_KEY) || WORKSPACE_FOLDER);
  defaultRomsFolder = $derived(`${this.libraryFolder}/${ROMS_FOLDER}`);
  defaultBiosFolder = $derived(`${this.libraryFolder}/${SUPPORT_FOLDER}`);
  /** Empty uses ROMs under the selected library root. */
  romsFolder = $state(storedRomsFolder());
  /** Empty uses BIOS under the selected library root. */
  biosFolder = $state(storedFolder(BIOS_FOLDER_KEY));

  get folderOptions(): LibraryFolderOptions {
    return {
      libraryFolder: this.libraryFolder,
      romsFolder: this.romsFolder || undefined,
      biosFolder: this.biosFolder || undefined,
    };
  }

  setCheckEmulatorSetup(enabled: boolean): void {
    this.checkEmulatorSetup = enabled;
  }

  setLibraryFolder(value: string): void {
    const folder = normalizeStorageFolder(value);
    this.libraryFolder = folder;
    persistFolder(LIBRARY_FOLDER_KEY, folder === WORKSPACE_FOLDER ? "" : folder);
  }

  setRomsFolder(value: string): void {
    const folder = normalizeStorageFolder(value);
    if (folder === this.defaultRomsFolder) {
      this.resetRomsFolder();
      return;
    }
    this.romsFolder = folder;
    persistFolder(ROMS_FOLDER_KEY, folder);
  }

  resetRomsFolder(): void {
    this.romsFolder = "";
    persistFolder(ROMS_FOLDER_KEY, "");
  }

  setBiosFolder(value: string): void {
    const folder = normalizeStorageFolder(value);
    if (folder === this.defaultBiosFolder) {
      this.resetBiosFolder();
      return;
    }
    this.biosFolder = folder;
    persistFolder(BIOS_FOLDER_KEY, folder);
  }

  resetBiosFolder(): void {
    this.biosFolder = "";
    persistFolder(BIOS_FOLDER_KEY, "");
  }
}
