import { normalizeRomsFolder } from "./adb/library-scan";

const ROMS_FOLDER_KEY = "emukase.library.romsFolder";
const LEGACY_ROMS_ROOT_KEY = "emukase.library.romsRoot";

/** Converts an older absolute ROMs root to the storage-relative folder; invalid values are ignored. */
function legacyRomsFolder(): string {
  try {
    const value = localStorage.getItem(LEGACY_ROMS_ROOT_KEY);
    if (!value) return "";
    const relative = value.replace(/^\/sdcard\//, "").replace(/^\/storage\/emulated\/\d+\//, "");
    const folder = normalizeRomsFolder(relative);
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
    if (value) return normalizeRomsFolder(value);
    return legacyRomsFolder();
  } catch {
    return "";
  }
}

/** Shared library configuration: the ROMs folder override inside internal storage. */
export class LibrarySettings {
  /** Whether the library settings form is expanded. */
  open = $state(false);
  /** Custom storage-relative ROMs folder; empty uses the shared Emukase library folder. */
  romsFolder = $state(storedRomsFolder());

  setRomsFolder(value: string): void {
    const folder = normalizeRomsFolder(value);
    this.romsFolder = folder;
    try {
      localStorage.setItem(ROMS_FOLDER_KEY, folder);
    } catch {
      // The folder still applies for this session; only persistence failed.
    }
  }

  resetRomsFolder(): void {
    this.romsFolder = "";
    try {
      localStorage.removeItem(ROMS_FOLDER_KEY);
    } catch {
      // Nothing to clean up if storage is unavailable.
    }
  }
}
