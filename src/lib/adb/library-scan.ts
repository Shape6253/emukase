import { coreFilenameForId } from "./catalog";
import { shellCommand, type DeviceTransport } from "./transport";
import { checkAbort } from "./setup-events";
import { assertAndroidUser, primaryStorageForUser, readAndroidUser, userScopedDevice } from "./android-user";
import { libraryPlatform, type LibraryPlatform, type LibrarySupportRequirement } from "./library-catalog";

/** Folders created by the library setup flow inside the current profile's storage. */
export const WORKSPACE_FOLDER = "Emukase";
export const ROMS_FOLDER = "ROMs";
export const SUPPORT_FOLDER = "BIOS";

/** Per-folder listing limit; large collections report a truncation instead of streaming everything. */
const MAX_LISTED_FILES = 500;

export interface LibraryFileEntry {
  /** Path relative to the scanned folder. */
  relativePath: string;
  bytes: number;
}

export interface LibraryRequirementStatus {
  requirement: LibrarySupportRequirement;
  present: boolean;
  /** Matched files, relative to the shared support folder. */
  files: LibraryFileEntry[];
}

export type LibraryCoreState = "installed" | "missing" | "unavailable";

export interface PlatformEmulatorStatus {
  packages: readonly string[];
  /** Packages installed in the current Android profile. */
  installed: readonly string[];
  /** Core file names the platform can use. */
  coreFiles: readonly string[];
  /** Undefined when the platform has no core or the app is not installed yet. */
  coreState?: LibraryCoreState;
  /** Full path of the core when its files are visible over USB. */
  corePath?: string;
}

export interface PlatformLibraryScan {
  platform: LibraryPlatform;
  romsRoot: string;
  romDirectory: string;
  supportDirectory: string;
  workspaceFound: boolean;
  romDirectoryFound: boolean;
  supportDirectoryFound: boolean;
  roms: LibraryFileEntry[];
  romFileCount: number;
  supportFiles: LibraryFileEntry[];
  supportFileCount: number;
  requirements: LibraryRequirementStatus[];
  emulator: PlatformEmulatorStatus;
}

export interface ParsedLibraryScan {
  workspaceFound: boolean;
  romDirectoryFound: boolean;
  supportDirectoryFound: boolean;
  roms: LibraryFileEntry[];
  romFileCount: number;
  supportFiles: LibraryFileEntry[];
  supportFileCount: number;
  installedPackages: string[];
  coreFiles: string[];
  coreDirectories: string[];
}

export interface LibraryScanOptions {
  /** Folder inside the current profile's internal storage; defaults to the shared Emukase library. */
  romsFolder?: string;
}

/** Folder below /storage/emulated/<user>/ that the ROMs editor produces; internal storage only. */
export function normalizeRomsFolder(value: string): string {
  const path = value.trim().replace(/^\/+|\/+$/g, "");
  if (!path) {
    throw new Error("Enter a folder inside internal storage, for example Games/ROMs.");
  }
  if (/[\u0000-\u001f\u007f]/.test(path) || path.includes("\\")) {
    throw new Error("The folder path contains unsupported characters.");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("The folder path must not contain empty or relative segments.");
  }
  if (parts.includes("Android")) {
    throw new Error("The Android folder is reserved for app data; choose another folder.");
  }
  return path;
}

function fileListingCommand(directory: string): string {
  // `stat -c` exists on every Android release the setup flow supports (API 24+).
  return `${shellCommand("find", directory, "-type", "f", "-exec", "stat", "-c", "%s %n", "{}", ";")} 2>/dev/null`;
}

function listingSection(label: string, directory: string): string[] {
  return [
    `if ${shellCommand("test", "-d", directory)}; then`,
    `printf '${label}\\n'`,
    `printf '${label}-count %s\\n' "$( ${shellCommand("find", directory, "-type", "f")} 2>/dev/null | wc -l )"`,
    // head closes the pipe after the limit, which also stops find from listing more files.
    `${fileListingCommand(directory)} | head -n ${MAX_LISTED_FILES}`,
    "else",
    `printf '${label}-missing\\n'`,
    "fi",
  ];
}

/** Shared core locations RetroArch can use; its private app storage stays invisible over USB. */
function coreDirectories(platform: LibraryPlatform, primaryStorage: string): string[] {
  if (!platform.cores.length) return [];
  return [
    `${primaryStorage}/RetroArch/cores`,
    ...platform.emulatorPackages.map((name) => `${primaryStorage}/Android/data/${name}/files/cores`),
  ];
}

function coreCheckLines(directories: readonly string[], files: readonly string[]): string[] {
  const lines: string[] = [];
  for (const directory of directories) {
    for (const file of files) {
      const path = `${directory}/${file}`;
      lines.push(`if ${shellCommand("test", "-f", path)}; then printf 'core-found %s\\n' ${shellCommand(path)}; fi`);
    }
    lines.push(
      `if ${shellCommand("test", "-d", directory)} && ${shellCommand("test", "-r", directory)}; then printf 'core-dir %s\\n' ${shellCommand(directory)}; fi`,
    );
  }
  return lines;
}

function scanScript(options: {
  workspaceRoot: string;
  romDirectory: string;
  supportDirectory: string;
  user: number;
  packages: readonly string[];
  coreLines: readonly string[];
  marker: string;
}): string {
  return [
    "set -eu",
    `printf '%s\\n' ${shellCommand(options.marker)}`,
    `if ${shellCommand("test", "-d", options.workspaceRoot)}; then printf 'workspace\\n'; else printf 'workspace-missing\\n'; fi`,
    ...listingSection("roms", options.romDirectory),
    ...listingSection("support", options.supportDirectory),
    "printf 'apps\\n'",
    `${shellCommand("pm", "list", "packages", "--user", String(options.user), ...options.packages)} 2>/dev/null`,
    "printf 'core-check\\n'",
    ...options.coreLines,
    `printf '%s' ${shellCommand(options.marker)}`,
  ].join("\n");
}

function relativeEntry(line: string, directory: string): LibraryFileEntry | undefined {
  const entry = /^(\d+) (.+)$/.exec(line);
  if (!entry) return undefined;
  const bytes = Number(entry[1]);
  if (!Number.isSafeInteger(bytes)) return undefined;
  const path = entry[2]!;
  if (!path.startsWith(`${directory}/`)) return undefined;
  const relativePath = path.slice(directory.length + 1);
  if (!relativePath || /[\u0000-\u001f\u007f]/.test(relativePath)) return undefined;
  if (relativePath.split("/").some((part) => part === "." || part === "..")) return undefined;
  return { relativePath, bytes };
}

function scanPath(line: string): string | undefined {
  if (!line.startsWith("/") || /[\u0000-\u001f\u007f]/.test(line)) return undefined;
  if (line.split("/").some((part) => part === "." || part === "..")) return undefined;
  return line;
}

function sortEntries(entries: LibraryFileEntry[]): LibraryFileEntry[] {
  return entries.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
}

/** Pure parser for the scan script output; exported for verification without a device. */
export function parseLibraryScanOutput(
  output: string,
  marker: string,
  romDirectory: string,
  supportDirectory: string,
): ParsedLibraryScan {
  const trimmed = output.trimEnd();
  if (!trimmed.endsWith(marker)) throw new Error("Android did not complete the library scan.");
  const lines = trimmed.slice(0, -marker.length).trimEnd().split(/\r?\n/);
  if (lines.shift() !== marker) throw new Error("Unexpected library scan output.");
  const result: ParsedLibraryScan = {
    workspaceFound: false,
    romDirectoryFound: false,
    supportDirectoryFound: false,
    roms: [],
    romFileCount: 0,
    supportFiles: [],
    supportFileCount: 0,
    installedPackages: [],
    coreFiles: [],
    coreDirectories: [],
  };
  let section: "roms" | "support" | undefined;
  let workspaceSeen = false;
  let appsSeen = false;
  let coreSeen = false;
  let sectionCounts = 0;
  let parsedCounts = 0;
  for (const line of lines) {
    if (line === "workspace" || line === "workspace-missing") {
      workspaceSeen = true;
      result.workspaceFound = line === "workspace";
      section = undefined;
      continue;
    }
    if (line === "roms" || line === "roms-missing") {
      sectionCounts++;
      result.romDirectoryFound = line === "roms";
      section = line === "roms" ? "roms" : undefined;
      continue;
    }
    if (line === "support" || line === "support-missing") {
      sectionCounts++;
      result.supportDirectoryFound = line === "support";
      section = line === "support" ? "support" : undefined;
      continue;
    }
    if (line === "apps") {
      appsSeen = true;
      section = undefined;
      continue;
    }
    if (line === "core-check") {
      coreSeen = true;
      section = undefined;
      continue;
    }
    const count = /^(roms|support)-count\s+(\d+)$/.exec(line);
    if (count) {
      const value = Number(count[2]);
      if (!Number.isSafeInteger(value)) throw new Error("Invalid library scan count.");
      if (count[1] === "roms") result.romFileCount = value;
      else result.supportFileCount = value;
      parsedCounts++;
      continue;
    }
    const installed = /^package:([A-Za-z0-9_.]+)$/.exec(line);
    if (installed) {
      result.installedPackages.push(installed[1]!);
      continue;
    }
    const coreFound = /^core-found (.+)$/.exec(line);
    if (coreFound) {
      const path = scanPath(coreFound[1]!);
      if (path) result.coreFiles.push(path);
      continue;
    }
    const coreDirectory = /^core-dir (.+)$/.exec(line);
    if (coreDirectory) {
      const path = scanPath(coreDirectory[1]!);
      if (path) result.coreDirectories.push(path);
      continue;
    }
    if (!section) continue;
    const entry = relativeEntry(line, section === "roms" ? romDirectory : supportDirectory);
    if (!entry) continue;
    if (section === "roms") result.roms.push(entry);
    else result.supportFiles.push(entry);
  }
  const expectedCounts = Number(result.romDirectoryFound) + Number(result.supportDirectoryFound);
  if (!workspaceSeen || !appsSeen || !coreSeen || sectionCounts !== 2 || parsedCounts !== expectedCounts) {
    throw new Error("Library scan output was incomplete.");
  }
  sortEntries(result.roms);
  sortEntries(result.supportFiles);
  return result;
}

function requirementStatuses(
  requirements: readonly LibrarySupportRequirement[],
  supportFiles: readonly LibraryFileEntry[],
): LibraryRequirementStatus[] {
  return requirements.map((requirement) => {
    const files = supportFiles.filter((file) => requirement.matches(file.relativePath));
    const present = requirement.satisfied
      ? requirement.satisfied(files.map((file) => file.relativePath))
      : files.length > 0;
    return { requirement, present, files };
  });
}

function emulatorStatus(
  platform: LibraryPlatform,
  parsed: ParsedLibraryScan,
  directories: readonly string[],
): PlatformEmulatorStatus {
  const installed = platform.emulatorPackages.filter((name) => parsed.installedPackages.includes(name));
  const coreFiles = platform.cores.map((id) => coreFilenameForId(id));
  const status: PlatformEmulatorStatus = { packages: platform.emulatorPackages, installed, coreFiles };
  if (!coreFiles.length) return status;
  for (const directory of directories) {
    for (const file of coreFiles) {
      if (!parsed.coreFiles.includes(`${directory}/${file}`)) continue;
      return { ...status, coreState: "installed", corePath: `${directory}/${file}` };
    }
  }
  if (!installed.length) return status;
  // Visible core folders prove absence; otherwise the cores may live in RetroArch's app storage.
  const readable = directories.some((directory) => parsed.coreDirectories.includes(directory));
  return { ...status, coreState: readable ? "missing" : "unavailable" };
}

/** Read-only inspection of one platform's ROM folder, the shared support folder and its emulator. */
export async function scanPlatformLibrary(
  device: DeviceTransport,
  platformId: string,
  options: LibraryScanOptions = {},
  signal?: AbortSignal,
): Promise<PlatformLibraryScan> {
  const platform = libraryPlatform(platformId);
  checkAbort(signal);
  const user = await readAndroidUser(device, signal);
  const scoped = userScopedDevice(device, user, signal);
  const primaryStorage = primaryStorageForUser(user);
  const workspaceRoot = `${primaryStorage}/${WORKSPACE_FOLDER}`;
  const supportDirectory = `${workspaceRoot}/${SUPPORT_FOLDER}`;
  const romsRoot = options.romsFolder
    ? `${primaryStorageForUser(user)}/${normalizeRomsFolder(options.romsFolder)}`
    : `${workspaceRoot}/${ROMS_FOLDER}`;
  const romDirectory = `${romsRoot}/${platform.id}`;
  const directories = coreDirectories(platform, primaryStorage);
  const marker = `__emukase_scan_${crypto.randomUUID()}__`;
  const output = await scoped.shell(shellCommand("sh", "-c", scanScript({
    workspaceRoot,
    romDirectory,
    supportDirectory,
    user,
    packages: platform.emulatorPackages,
    coreLines: coreCheckLines(directories, platform.cores.map((id) => coreFilenameForId(id))),
    marker,
  })));
  checkAbort(signal);
  await assertAndroidUser(scoped, user, signal);
  const parsed = parseLibraryScanOutput(output, marker, romDirectory, supportDirectory);
  return {
    platform,
    romsRoot,
    romDirectory,
    supportDirectory,
    workspaceFound: parsed.workspaceFound,
    romDirectoryFound: parsed.romDirectoryFound,
    supportDirectoryFound: parsed.supportDirectoryFound,
    roms: parsed.roms,
    romFileCount: parsed.romFileCount,
    supportFiles: parsed.supportFiles,
    supportFileCount: parsed.supportFileCount,
    requirements: requirementStatuses(platform.requirements, parsed.supportFiles),
    emulator: emulatorStatus(platform, parsed, directories),
  };
}
