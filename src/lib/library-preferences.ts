import { normalizeStorageFolder, WORKSPACE_FOLDER } from "./adb/workspace";

export interface LibraryPreferences {
  libraryFolder: string;
  romsFolder: string;
  biosFolder: string;
}

function storageKey(serial: string): string {
  return `emukase.device.library.v1.${encodeURIComponent(serial)}`;
}

function folder(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  try {
    return normalizeStorageFolder(value);
  } catch {
    return "";
  }
}

/** Existing global paths seed devices that do not have saved preferences yet. */
function legacyFolders(): LibraryPreferences {
  try {
    const legacyRoot = localStorage.getItem("emukase.library.romsRoot");
    const relativeRoot = legacyRoot ? /^(?:\/sdcard|\/storage\/emulated\/\d+)\/(.+)$/.exec(legacyRoot)?.[1] : undefined;
    return {
      libraryFolder: folder(localStorage.getItem("emukase.library.folder")) || WORKSPACE_FOLDER,
      romsFolder: folder(localStorage.getItem("emukase.library.romsFolder")) || folder(relativeRoot),
      biosFolder: folder(localStorage.getItem("emukase.library.biosFolder")),
    };
  } catch {
    return { libraryFolder: WORKSPACE_FOLDER, romsFolder: "", biosFolder: "" };
  }
}

export function readLibraryPreferences(serial?: string): LibraryPreferences {
  if (serial) {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(storageKey(serial)) ?? "null");
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        const value = stored as Record<string, unknown>;
        return {
          libraryFolder: folder(value.libraryFolder) || WORKSPACE_FOLDER,
          romsFolder: folder(value.romsFolder),
          biosFolder: folder(value.biosFolder),
        };
      }
    } catch {
      // Invalid or unavailable browser storage must not prevent device setup.
    }
  }
  return legacyFolders();
}

export function persistLibraryPreferences(serial: string, preferences: LibraryPreferences): void {
  try {
    localStorage.setItem(storageKey(serial), JSON.stringify(preferences));
  } catch {
    // Keep using the in-memory preferences when browser storage is unavailable.
  }
}
