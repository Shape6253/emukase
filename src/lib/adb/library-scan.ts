import { coreFilenameForId } from "./catalog";
import { shellCommand, type DeviceTransport } from "./transport";
import { checkAbort } from "./setup-events";
import { assertAndroidUser, primaryStorageForUser, readAndroidUser, userScopedDevice } from "./android-user";
import { libraryPlatform, type LibraryPlatform, type LibrarySupportRequirement } from "./library-catalog";

/** Folders created by the library setup flow inside the current profile's storage. */
export const WORKSPACE_FOLDER = "Emukase";
export const ROMS_FOLDER = "ROMs";
export const SUPPORT_FOLDER = "BIOS";

/** Only the ROM preview is limited; support checks must inspect every file. */
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

export type LibraryCoreState = "installed" | "unavailable";

export interface PlatformEmulatorStatus {
  /** Packages installed in the current Android profile. */
  installed: readonly string[];
  /** Undefined when the platform has no core or the app is not installed yet. */
  coreState?: LibraryCoreState;
  /** Full path of the core when its files are visible over USB. */
  corePath?: string;
}

export interface PlatformLibraryScan {
  platform: LibraryPlatform;
  workspaceFound: boolean;
  romDirectoryFound: boolean;
  supportDirectoryFound: boolean;
  roms: LibraryFileEntry[];
  romFileCount: number;
  requirements: LibraryRequirementStatus[];
  emulator: PlatformEmulatorStatus;
}

interface ParsedLibraryScan {
  workspaceFound: boolean;
  romDirectoryFound: boolean;
  supportDirectoryFound: boolean;
  roms: LibraryFileEntry[];
  romFileCount: number;
  supportFiles: LibraryFileEntry[];
  installedPackages: string[];
  coreFiles: string[];
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
  return `${shellCommand("find", directory, "-type", "f", "-exec", "stat", "-c", "%s %n", "{}", "+")} 2>/dev/null`;
}

function listingSection(label: "roms" | "support", directory: string): string[] {
  const listing = fileListingCommand(directory);
  return [
    `if ${shellCommand("test", "-d", directory)}; then`,
    `printf '${label}\\n'`,
    ...(label === "roms" ? [
      `printf 'roms-count %s\\n' "$( ${shellCommand("find", directory, "-type", "f")} 2>/dev/null | wc -l )"`,
      `${listing} | head -n ${MAX_LISTED_FILES}`,
    ] : [listing]),
    "else",
    `printf '${label}-missing\\n'`,
    "fi",
  ];
}

/** Shared core locations RetroArch can use; its private app storage stays invisible over USB. */
function coreDirectories(packages: readonly string[], primaryStorage: string): string[] {
  return [
    `${primaryStorage}/RetroArch/cores`,
    ...packages.map((name) => `${primaryStorage}/Android/data/${name}/files/cores`),
  ];
}

function coreCheckLines(directories: readonly string[], files: readonly string[]): string[] {
  const lines: string[] = [];
  for (const directory of directories) {
    for (const file of files) {
      const path = `${directory}/${file}`;
      lines.push(`if ${shellCommand("test", "-f", path)}; then printf 'core-found %s\\n' ${shellCommand(path)}; fi`);
    }
  }
  return lines;
}

function scanScript(options: {
  workspaceRoot: string;
  romDirectory: string;
  supportDirectory: string;
  user: number;
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
    `${shellCommand("pm", "list", "packages", "--user", String(options.user))} 2>/dev/null`,
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
  const path = entry[2];
  if (!path || !scanPath(path) || !path.startsWith(`${directory}/`)) return undefined;
  const relativePath = path.slice(directory.length + 1);
  if (!relativePath) return undefined;
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

function parseLibraryScanOutput(
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
    installedPackages: [],
    coreFiles: [],
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
    const count = /^roms-count\s+(\d+)$/.exec(line);
    if (count) {
      const value = Number(count[1]);
      if (!Number.isSafeInteger(value)) throw new Error("Invalid library scan count.");
      result.romFileCount = value;
      parsedCounts++;
      continue;
    }
    const installed = /^package:([A-Za-z0-9_.]+)$/.exec(line)?.[1];
    if (installed) {
      result.installedPackages.push(installed);
      continue;
    }
    const coreFound = /^core-found (.+)$/.exec(line)?.[1];
    if (coreFound) {
      const path = scanPath(coreFound);
      if (path) result.coreFiles.push(path);
      continue;
    }
    if (!section) continue;
    const entry = relativeEntry(line, section === "roms" ? romDirectory : supportDirectory);
    if (!entry) continue;
    if (section === "roms") result.roms.push(entry);
    else result.supportFiles.push(entry);
  }
  const expectedCounts = Number(result.romDirectoryFound);
  if (!workspaceSeen || !appsSeen || !coreSeen || sectionCounts !== 2 || parsedCounts !== expectedCounts) {
    throw new Error("Library scan output was incomplete.");
  }
  sortEntries(result.roms);
  sortEntries(result.supportFiles);
  return result;
}

function emulatorStatus(
  platform: LibraryPlatform,
  parsed: ParsedLibraryScan,
  primaryStorage: string,
): PlatformEmulatorStatus {
  const installed = platform.emulatorPackages.filter((name) => parsed.installedPackages.includes(name));
  const coreFiles = platform.cores.map((id) => coreFilenameForId(id));
  const status: PlatformEmulatorStatus = { installed };
  if (!coreFiles.length || !installed.length) return status;
  for (const directory of coreDirectories(installed, primaryStorage)) {
    for (const file of coreFiles) {
      if (!parsed.coreFiles.includes(`${directory}/${file}`)) continue;
      return { ...status, coreState: "installed", corePath: `${directory}/${file}` };
    }
  }
  return { ...status, coreState: "unavailable" };
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
  const directories = platform.cores.length ? coreDirectories(platform.emulatorPackages, primaryStorage) : [];
  const marker = `__emukase_scan_${crypto.randomUUID()}__`;
  const output = await scoped.shell(shellCommand("sh", "-c", scanScript({
    workspaceRoot,
    romDirectory,
    supportDirectory,
    user,
    coreLines: coreCheckLines(directories, platform.cores.map((id) => coreFilenameForId(id))),
    marker,
  })));
  checkAbort(signal);
  await assertAndroidUser(scoped, user, signal);
  const parsed = parseLibraryScanOutput(output, marker, romDirectory, supportDirectory);
  return {
    platform,
    workspaceFound: parsed.workspaceFound,
    romDirectoryFound: parsed.romDirectoryFound,
    supportDirectoryFound: parsed.supportDirectoryFound,
    roms: parsed.roms,
    romFileCount: parsed.romFileCount,
    requirements: platform.requirements.map((requirement) => {
      const files = parsed.supportFiles.filter((file) => requirement.matches(file.relativePath));
      return { requirement, present: files.length > 0, files };
    }),
    emulator: emulatorStatus(platform, parsed, primaryStorage),
  };
}
