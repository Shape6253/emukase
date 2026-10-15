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

export interface PlatformLibraryScan {
  platform: LibraryPlatform;
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
}

export interface ParsedLibraryScan {
  workspaceFound: boolean;
  romDirectoryFound: boolean;
  supportDirectoryFound: boolean;
  roms: LibraryFileEntry[];
  romFileCount: number;
  supportFiles: LibraryFileEntry[];
  supportFileCount: number;
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

function scanScript(workspaceRoot: string, romDirectory: string, supportDirectory: string, marker: string): string {
  return [
    "set -eu",
    `printf '%s\\n' ${shellCommand(marker)}`,
    `if ${shellCommand("test", "-d", workspaceRoot)}; then printf 'workspace\\n'; else printf 'workspace-missing\\n'; fi`,
    ...listingSection("roms", romDirectory),
    ...listingSection("support", supportDirectory),
    `printf '%s' ${shellCommand(marker)}`,
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
  };
  let section: "roms" | "support" | undefined;
  let workspaceSeen = false;
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
    const count = /^(roms|support)-count\s+(\d+)$/.exec(line);
    if (count) {
      const value = Number(count[2]);
      if (!Number.isSafeInteger(value)) throw new Error("Invalid library scan count.");
      if (count[1] === "roms") result.romFileCount = value;
      else result.supportFileCount = value;
      parsedCounts++;
      continue;
    }
    if (!section) continue;
    const entry = relativeEntry(line, section === "roms" ? romDirectory : supportDirectory);
    if (!entry) continue;
    if (section === "roms") result.roms.push(entry);
    else result.supportFiles.push(entry);
  }
  const expectedCounts = Number(result.romDirectoryFound) + Number(result.supportDirectoryFound);
  if (!workspaceSeen || sectionCounts !== 2 || parsedCounts !== expectedCounts) {
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

/** Read-only inspection of one platform's ROM folder and the shared support folder. */
export async function scanPlatformLibrary(
  device: DeviceTransport,
  platformId: string,
  signal?: AbortSignal,
): Promise<PlatformLibraryScan> {
  const platform = libraryPlatform(platformId);
  checkAbort(signal);
  const user = await readAndroidUser(device, signal);
  const scoped = userScopedDevice(device, user, signal);
  const primaryStorage = primaryStorageForUser(user);
  const workspaceRoot = `${primaryStorage}/${WORKSPACE_FOLDER}`;
  const romDirectory = `${workspaceRoot}/${ROMS_FOLDER}/${platform.id}`;
  const supportDirectory = `${workspaceRoot}/${SUPPORT_FOLDER}`;
  const marker = `__emukase_scan_${crypto.randomUUID()}__`;
  const output = await scoped.shell(shellCommand("sh", "-c", scanScript(workspaceRoot, romDirectory, supportDirectory, marker)));
  checkAbort(signal);
  await assertAndroidUser(scoped, user, signal);
  const parsed = parseLibraryScanOutput(output, marker, romDirectory, supportDirectory);
  return {
    platform,
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
  };
}
