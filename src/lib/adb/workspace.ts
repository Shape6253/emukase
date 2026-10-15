export const WORKSPACE_FOLDER = "Emukase";
export const ROMS_FOLDER = "ROMs";
export const SUPPORT_FOLDER = "BIOS";

export interface LibraryFolderOptions {
  libraryFolder?: string;
  romsFolder?: string;
  biosFolder?: string;
}

export interface WorkspacePaths {
  root: string;
  roms: string;
  bios: string;
  esde: string;
  media: string;
  saves: string;
  states: string;
  setup: string;
}

export function workspacePaths(primaryStorage: string, options: LibraryFolderOptions = {}): WorkspacePaths {
  const user = /^\/storage\/emulated\/(0|[1-9]\d*)$/.exec(primaryStorage)?.[1];
  if (user === undefined || !Number.isSafeInteger(Number(user))) {
    throw new Error("Workspace requires the current Android user's resolved internal storage.");
  }
  const folderPath = (folder: string): string => `${primaryStorage}/${normalizeStorageFolder(folder)}`;
  const root = folderPath(options.libraryFolder ?? WORKSPACE_FOLDER);
  return {
    root,
    roms: options.romsFolder === undefined ? `${root}/${ROMS_FOLDER}` : folderPath(options.romsFolder),
    bios: options.biosFolder === undefined ? `${root}/${SUPPORT_FOLDER}` : folderPath(options.biosFolder),
    esde: `${root}/ES-DE`,
    media: `${root}/ES-DE/downloaded_media`,
    saves: `${root}/saves`,
    states: `${root}/states`,
    setup: `${root}/setup`,
  };
}

export function normalizeStorageFolder(value: string): string {
  const path = value.trim().replace(/^\/+|\/+$/g, "");
  if (!path) {
    throw new Error("Enter a folder inside internal storage, for example Emukase or Games/ROMs.");
  }
  if (/[\u0000-\u001f\u007f"*:<>?\\|]/.test(value)) {
    throw new Error("Folder names must not contain control characters or \" : * ? < > | \\.");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("The folder path must not contain empty or relative segments.");
  }
  if (path.includes(".")) {
    throw new Error("Folder names must not contain dots; use underscores instead.");
  }
  // MediaStore can truncate long names during insertion.
  if (parts.some((part) => new TextEncoder().encode(part).length > 255)) {
    throw new Error("Each folder name must fit within 255 UTF-8 bytes.");
  }
  if (parts.includes("Android")) {
    throw new Error("The Android folder is reserved for app data; choose another folder.");
  }
  return path;
}
