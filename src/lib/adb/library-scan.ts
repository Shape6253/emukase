import { coreFilenameForId } from "./catalog";
import { shellCommand, type DeviceTransport } from "./transport";
import { checkAbort } from "./setup-events";
import { assertAndroidUser, primaryStorageForUser, readAndroidUser, userScopedDevice } from "./android-user";
import { libraryPlatform, type LibraryPlatform, type LibrarySupportRequirement } from "./library-catalog";
import { workspacePaths } from "./workspace";
import type { LibraryFolderOptions } from "./workspace";
import { queryMediaStoreFiles, queryMediaStoreFolders, readMediaStoreFiles, readMediaStoreFolders } from "./media-store";

/** Only the ROM preview is limited; support checks must inspect every file. */
const MAX_LISTED_FILES = 500;
type ScanDirectory = "workspace" | "roms" | "support";

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
  /** MediaStore listings can lag filesystem edits when direct access is blocked. */
  romsFromIndex: boolean;
  requirements: LibraryRequirementStatus[];
  emulator: PlatformEmulatorStatus;
}

interface ParsedLibraryScan {
  workspaceFound: boolean;
  romDirectoryFound: boolean;
  supportDirectoryFound: boolean;
  roms: LibraryFileEntry[];
  romFileCount: number;
  romsFromIndex: boolean;
  supportFiles: LibraryFileEntry[];
  installedPackages: string[];
  coreFiles: string[];
  unavailableDirectories: ScanDirectory[];
}

function fileListingCommand(directory: string): string {
  // `stat -c` exists on every Android release the setup flow supports (API 24+).
  return `${shellCommand("find", directory, "-type", "f", "-exec", "stat", "-c", "%s %n", "{}", "+")} 2>/dev/null`;
}

function missingDirectoryLines(label: ScanDirectory, directory: string): string[] {
  return [
    // test -d alone returns false for both ENOENT and EACCES. Preserve that distinction.
    `if reason=$( ${shellCommand("stat", "-c", "%F", directory)} 2>&1 ); then`,
    `printf '${label}-unavailable\\n'`,
    "else",
    `case "$reason" in *'No such file or directory'*) printf '${label}-missing\\n' ;; *) printf '${label}-unavailable\\n' ;; esac`,
    "fi",
  ];
}

function listingSection(label: "roms" | "support", directory: string): string[] {
  // Consume the whole stream so find/stat failures cannot become an empty or
  // partial successful scan. Limit only the ROM preview, not its count.
  const preview = [
    "(count=0; set --; while IFS= read -r -d '' entry; do",
    "count=$((count + 1))",
    `if [ "$count" -le ${MAX_LISTED_FILES} ]; then set -- "$@" "$entry"; fi`,
    "done",
    `if [ "$#" -gt 0 ]; then ${shellCommand("stat", "-c", "%s %n")} "$@" 2>/dev/null || exit 1; fi`,
    "printf 'roms-count %s\\n' \"$count\")",
  ].join("\n");
  const listing = label === "roms"
    ? `${shellCommand("find", directory, "-type", "f", "-print0")} 2>/dev/null | ${preview}`
    : fileListingCommand(directory);
  return [
    `if ${shellCommand("test", "-d", directory)}; then`,
    `if ${shellCommand("test", "-r", directory)} && ${shellCommand("test", "-x", directory)} && entries=$( ${listing} ); then`,
    `printf '${label}\\n'`,
    `if [ -n "$entries" ]; then printf '%s\\n' "$entries"; fi`,
    "else",
    `printf '${label}-unavailable\\n'`,
    "fi",
    "else",
    ...missingDirectoryLines(label, directory),
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
    "set -o pipefail",
    `printf '%s\\n' ${shellCommand(options.marker)}`,
    `if ${shellCommand("test", "-d", options.workspaceRoot)}; then printf 'workspace\\n'; else`,
    ...missingDirectoryLines("workspace", options.workspaceRoot),
    "fi",
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
    romsFromIndex: false,
    supportFiles: [],
    installedPackages: [],
    coreFiles: [],
    unavailableDirectories: [],
  };
  let section: "roms" | "support" | undefined;
  let workspaceSeen = false;
  let appsSeen = false;
  let coreSeen = false;
  let sectionCounts = 0;
  let parsedCounts = 0;
  for (const line of lines) {
    if (line === "workspace" || line === "workspace-missing" || line === "workspace-unavailable") {
      workspaceSeen = true;
      result.workspaceFound = line === "workspace";
      if (line === "workspace-unavailable") result.unavailableDirectories.push("workspace");
      section = undefined;
      continue;
    }
    if (line === "roms" || line === "roms-missing" || line === "roms-unavailable") {
      sectionCounts++;
      result.romDirectoryFound = line === "roms";
      if (line === "roms-unavailable") result.unavailableDirectories.push("roms");
      section = line === "roms" ? "roms" : undefined;
      continue;
    }
    if (line === "support" || line === "support-missing" || line === "support-unavailable") {
      sectionCounts++;
      result.supportDirectoryFound = line === "support";
      if (line === "support-unavailable") result.unavailableDirectories.push("support");
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

async function recoverMediaStoreDirectories(
  device: DeviceTransport,
  user: number,
  parsed: ParsedLibraryScan,
  directories: Record<ScanDirectory, string>,
  platform: LibraryPlatform,
  signal?: AbortSignal,
): Promise<void> {
  const withinWorkspace = (path: string) => path === directories.workspace || path.startsWith(`${directories.workspace}/`);
  const usesWorkspace = withinWorkspace(directories.roms) || withinWorkspace(directories.support);
  const confirmWorkspace = (confirmed: ReadonlySet<string>) => {
    parsed.workspaceFound ||= confirmed.has(directories.workspace) ||
      (withinWorkspace(directories.roms) && (parsed.romDirectoryFound || confirmed.has(directories.roms))) ||
      (withinWorkspace(directories.support) && (parsed.supportDirectoryFound || confirmed.has(directories.support)));
  };
  confirmWorkspace(new Set());
  const missing = [
    ...(!parsed.workspaceFound && usesWorkspace ? [directories.workspace] : []),
    ...(!parsed.romDirectoryFound ? [directories.roms] : []),
    ...(!parsed.supportDirectoryFound ? [directories.support] : []),
  ];
  if (!missing.length) return;
  const records = await queryMediaStoreFolders(device, user, [...new Set(missing)], signal);
  const confirmed = await readMediaStoreFolders(device, user, records, signal);
  confirmWorkspace(confirmed);
  for (const label of parsed.unavailableDirectories) {
    if (label === "workspace" && (!usesWorkspace || parsed.workspaceFound)) continue;
    const directory = directories[label];
    if (!confirmed.has(directory)) {
      throw new Error(`Android blocked access to the library folder: ${directory}. MediaStore could not confirm it. Unlock the selected Android profile and verify its library folders.`);
    }
  }
  if (!parsed.romDirectoryFound && confirmed.has(directories.roms)) {
    const files = await queryMediaStoreFiles(device, user, directories.roms, signal);
    parsed.romDirectoryFound = true;
    parsed.romFileCount = files.length;
    parsed.romsFromIndex = true;
    parsed.roms = sortEntries(files.map(({ path, bytes }) => ({ relativePath: path.slice(directories.roms.length + 1), bytes }))).slice(0, MAX_LISTED_FILES);
  }
  if (!parsed.supportDirectoryFound && confirmed.has(directories.support)) {
    const files = await queryMediaStoreFiles(device, user, directories.support, signal);
    const candidates = files.filter(({ path }) => platform.requirements.some((requirement) =>
      requirement.matches(path.slice(directories.support.length + 1))));
    const readable = await readMediaStoreFiles(device, user, candidates, signal);
    parsed.supportDirectoryFound = true;
    parsed.supportFiles = sortEntries(readable.map(({ path, bytes }) => ({ relativePath: path.slice(directories.support.length + 1), bytes })));
  }
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
  options: LibraryFolderOptions = {},
  signal?: AbortSignal,
): Promise<PlatformLibraryScan> {
  const platform = libraryPlatform(platformId);
  checkAbort(signal);
  const user = await readAndroidUser(device, signal);
  const scoped = userScopedDevice(device, user, signal);
  const primaryStorage = primaryStorageForUser(user);
  const workspace = workspacePaths(primaryStorage, options);
  const romDirectory = `${workspace.roms}/${platform.id}`;
  const directories = platform.cores.length ? coreDirectories(platform.emulatorPackages, primaryStorage) : [];
  const marker = `__emukase_scan_${crypto.randomUUID()}__`;
  const output = await scoped.shell(shellCommand("sh", "-c", scanScript({
    workspaceRoot: workspace.root,
    romDirectory,
    supportDirectory: workspace.bios,
    user,
    coreLines: coreCheckLines(directories, platform.cores.map((id) => coreFilenameForId(id))),
    marker,
  })));
  const parsed = parseLibraryScanOutput(output, marker, romDirectory, workspace.bios);
  await recoverMediaStoreDirectories(scoped, user, parsed, {
    workspace: workspace.root, roms: romDirectory, support: workspace.bios,
  }, platform, signal);
  await assertAndroidUser(scoped, user, signal);
  return {
    platform,
    workspaceFound: parsed.workspaceFound,
    romDirectoryFound: parsed.romDirectoryFound,
    supportDirectoryFound: parsed.supportDirectoryFound,
    roms: parsed.roms,
    romFileCount: parsed.romFileCount,
    romsFromIndex: parsed.romsFromIndex,
    requirements: platform.requirements.map((requirement) => {
      const files = parsed.supportFiles.filter((file) => requirement.matches(file.relativePath));
      return { requirement, present: files.length > 0, files };
    }),
    emulator: emulatorStatus(platform, parsed, primaryStorage),
  };
}
