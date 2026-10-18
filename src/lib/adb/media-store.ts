import { shellCommand } from "./transport";
import type { DeviceTransport } from "./transport";
import { assertAndroidUser, primaryStorageForUser } from "./android-user";
import { checkAbort } from "./setup-events";
import { normalizeStorageFolder } from "./workspace";

const FILES_URI = "content://media/external/file";
const DIRECTORY_FORMAT = 12289;
const QUERY_BATCH_SIZE = 32;
const FOLDER_BATCH_SIZE = 32;
const READ_BATCH_SIZE = 8;
const MUTATION_WAVE_SIZE = 8;

export interface MediaStoreRecord {
  id: string;
  path: string;
  format: number;
}

export interface MediaStoreFile {
  id: string;
  path: string;
  bytes: number;
}

function folderPath(path: string, user: number): void {
  const root = primaryStorageForUser(user);
  const relative = path.slice(root.length + 1);
  if (!path.startsWith(`${root}/`) || normalizeStorageFolder(relative) !== relative) {
    throw new Error("MediaStore requires an explicit folder in the selected user's internal storage.");
  }
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Content's exit code and stderr are unreliable on some firmware. Frame completion
 * here, then let each operation verify its actual records or filesystem result. */
export async function contentCommand(device: DeviceTransport, user: number, args: readonly string[], signal?: AbortSignal, uri = FILES_URI): Promise<string> {
  await assertAndroidUser(device, user, signal);
  const marker = `__emukase_content_${crypto.randomUUID()}__`;
  const operation = args[0];
  if (!operation) throw new Error("Missing MediaStore operation.");
  const command = shellCommand("content", operation, "--user", String(user), "--uri", uri, ...args.slice(1));
  const script = `${command} 2>&1\ncode=$?\nprintf '\\n%s:%s\\n' ${shellCommand(marker)} "$code"`;
  const output = await device.shell(shellCommand("sh", "-c", script));
  checkAbort(signal);
  const frame = new RegExp(`\\n${marker}:[0-9]+\\r?\\n?$`).exec(output);
  if (!frame) throw new Error("Android did not confirm MediaStore command completion.");
  return output.slice(0, frame.index);
}

interface ContentMutation {
  args: readonly ["insert" | "delete", ...string[]];
  uri?: string;
}

async function contentMutations(device: DeviceTransport, user: number, mutations: readonly ContentMutation[], signal?: AbortSignal): Promise<ReadonlyMap<number, string>> {
  primaryStorageForUser(user);
  checkAbort(signal);
  if (!mutations.length) return new Map();
  const marker = `__emukase_mutations_${crypto.randomUUID()}__`;
  const mutate = [
    "mutate() {",
    "  index=$1; shift",
    `  if [ "$( ${shellCommand("am", "get-current-user")} 2>/dev/null )" != ${shellCommand(String(user))} ]; then`,
    `    printf '%s' "${marker}:$index:profile-changed\n"`,
    "  else",
    `    result=$( ${shellCommand("content")} "$@" 2>&1 )`,
    "    code=$?; detail=",
    "    case \"$result\" in",
    "      *java.lang.IllegalArgumentException:\\ *) detail=${result#*java.lang.IllegalArgumentException: } ;;",
    "      *java.lang.SecurityException:\\ *) detail=${result#*java.lang.SecurityException: } ;;",
    "      *java.io.*Exception:\\ *) detail=${result#*java.io.}; detail=${detail#*Exception: } ;;",
    "    esac",
    "    detail=${detail%%\"\n\"*}",
    "    if [ \"${#detail}\" -gt 512 ]; then detail='Android returned an exception with a long message.'; fi",
    `    printf '%s' "${marker}:$index:$code:$detail\n"`,
    "  fi",
    "}",
  ].join("\n");
  const completed = new Map<number, string>();
  const resultPattern = new RegExp(`^${marker}:(\\d+):(\\d+|profile-changed)(?::(.*))?$`);
  for (let offset = 0; offset < mutations.length; offset += MUTATION_WAVE_SIZE) {
    checkAbort(signal);
    const wave = mutations.slice(offset, offset + MUTATION_WAVE_SIZE);
    const workers = wave.map(({ args, uri = FILES_URI }, index) =>
      `${shellCommand("mutate", String(offset + index), args[0], "--user", String(user), "--uri", uri, ...args.slice(1))} &`);
    // Each shell call runs one mutation per worker so sequential operations do
    // not accumulate against the transport deadline. Await the wave before cleanup.
    const script = `${mutate}\n${workers.join("\n")}\nwait\nprintf '%s:complete\\n' ${shellCommand(marker)}`;
    const output = await device.shell(shellCommand("sh", "-c", script));
    checkAbort(signal);
    const lines = output.trim().split(/\r?\n/);
    if (lines.pop() !== `${marker}:complete` || lines.length !== wave.length) {
      throw new Error("Android did not confirm the MediaStore mutation batch.");
    }
    let profileChanged = false;
    for (const line of lines) {
      const match = resultPattern.exec(line);
      const index = Number(match?.[1]);
      if (!match || !Number.isSafeInteger(index) || index < offset || index >= offset + wave.length || completed.has(index)) {
        throw new Error("Android returned ambiguous MediaStore mutation results.");
      }
      completed.set(index, match[3]?.trim() ?? "");
      if (match[2] === "profile-changed") profileChanged = true;
    }
    if (profileChanged) throw new Error("Android user changed during setup. Reconnect to the selected profile.");
  }
  return completed;
}

export function cleanQueryOutput(output: string): string {
  // This specific startup warning also appears on successful commands on Pocket FIT.
  return output.replace(/^java\.lang\.NumberFormatException: For input string: ""\r?\n(?:\s+at [^\r\n]+\r?\n)*/gm, "").trim();
}

function queryResult(output: string, expected: ReadonlySet<string>): MediaStoreRecord[] {
  const clean = cleanQueryOutput(output);
  if (clean === "No result found.") return [];
  const rows: MediaStoreRecord[] = [];
  const paths = new Set<string>();
  const ids = new Set<string>();
  for (const line of clean.split(/\r?\n/)) {
    const match = /^Row: (\d+) _id=([1-9]\d{0,18}), _data=([^\r\n]+), format=(\d+)$/.exec(line);
    if (!match || Number(match[1]) !== rows.length) {
      throw new Error(`MediaStore query failed or returned an invalid response.\n${clean.slice(0, 1024)}`);
    }
    const [, , id, path, rawFormat] = match;
    if (!id || !path || !rawFormat || !expected.has(path) || paths.has(path) || ids.has(id)) {
      throw new Error("MediaStore returned ambiguous records or an unexpected storage path.");
    }
    const format = Number(rawFormat);
    if (!Number.isSafeInteger(format) || format < 0 || format > 65535) throw new Error("Invalid MediaStore file format.");
    rows.push({ id, path, format });
    paths.add(path);
    ids.add(id);
  }
  return rows;
}

async function queryPaths(device: DeviceTransport, user: number, paths: readonly string[], signal?: AbortSignal): Promise<MediaStoreRecord[]> {
  const records: MediaStoreRecord[] = [];
  for (let offset = 0; offset < paths.length; offset += QUERY_BATCH_SIZE) {
    const batch = paths.slice(offset, offset + QUERY_BATCH_SIZE);
    const where = `_data IN (${batch.map(sqlString).join(",")})`;
    const output = await contentCommand(device, user, ["query", "--projection", "_id:_data:format", "--where", where], signal);
    records.push(...queryResult(output, new Set(batch)));
  }
  return records;
}

export async function queryMediaStoreFolders(device: DeviceTransport, user: number, paths: readonly string[], signal?: AbortSignal): Promise<MediaStoreRecord[]> {
  for (const path of paths) folderPath(path, user);
  if (new Set(paths).size !== paths.length) throw new Error("Duplicate folders in the library plan.");
  return queryPaths(device, user, paths, signal);
}

/** Read indexed files recursively when Android hides shared storage from shell.
 * GLOB keeps prefixes case-sensitive; escape its metacharacters in folder names. */
export async function queryMediaStoreFiles(device: DeviceTransport, user: number, directory: string, signal?: AbortSignal): Promise<MediaStoreFile[]> {
  folderPath(directory, user);
  const prefix = `${directory.replace(/[\[\]*?]/g, (character) => `[${character}]`)}/*`;
  const where = `_data GLOB ${sqlString(prefix)} AND (format IS NULL OR format != ${DIRECTORY_FORMAT})`;
  const output = await contentCommand(device, user, ["query", "--projection", "_id:_data:_size", "--where", where], signal);
  const clean = cleanQueryOutput(output);
  if (clean === "No result found.") return [];
  const files: MediaStoreFile[] = [];
  const paths = new Set<string>();
  const ids = new Set<string>();
  for (const line of clean.split(/\r?\n/)) {
    const match = /^Row: (\d+) _id=([1-9]\d{0,18}), _data=(.+), _size=(\d+)$/.exec(line);
    if (!match || Number(match[1]) !== files.length) {
      throw new Error(`MediaStore file query failed or returned an invalid response.\n${clean.slice(0, 1024)}`);
    }
    const [, , id, path, rawBytes] = match;
    const bytes = Number(rawBytes);
    if (!id || !path || !path.startsWith(`${directory}/`) || path === `${directory}/` ||
      /[\u0000-\u001f\u007f]/.test(path) || path.slice(1).split("/").some((part) => !part || part === "." || part === "..") ||
      paths.has(path) || ids.has(id) || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error("MediaStore returned ambiguous files or an unexpected storage path.");
    }
    paths.add(path);
    ids.add(id);
    files.push({ id, path, bytes });
  }
  return files;
}

/** A database row alone is not proof of a folder. Confirm a directly accessible
 * canonical directory, or require the provider's kernel EISDIR response instead.
 * ENOENT means the row is stale. No files are created here. */
export async function readMediaStoreFolders(device: DeviceTransport, user: number, records: readonly MediaStoreRecord[], signal?: AbortSignal): Promise<ReadonlySet<string>> {
  const confirmed = new Set<string>();
  for (const record of records) {
    folderPath(record.path, user);
    if (record.format !== DIRECTORY_FORMAT) throw new Error(`Library path is occupied by a file: ${record.path}`);
  }
  const states = await readMediaStoreEntries(device, user, records, signal);
  for (const record of records) {
    const state = states.get(record.path);
    if (state === "directory") confirmed.add(record.path);
    else if (state !== "missing") throw new Error(`Cannot confirm a readable directory through MediaStore: ${record.path}`);
  }
  return confirmed;
}

/** Check only support-file candidates; reading into /dev/full stops at the first
 * write, so firmware/BIOS contents are never copied over USB or read in full. */
export async function readMediaStoreFiles(device: DeviceTransport, user: number, files: readonly MediaStoreFile[], signal?: AbortSignal): Promise<MediaStoreFile[]> {
  checkAbort(signal);
  if (!files.length) return [];
  const sdk = (await device.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
  checkAbort(signal);
  if (!/^[1-9]\d*$/.test(sdk) || !Number.isSafeInteger(Number(sdk))) {
    throw new Error("Android version was not confirmed for support-file verification.");
  }
  // Older content read uses PrintStream, which suppresses /dev/full write errors
  // and would keep reading an entire firmware image. API 28+ uses FileUtils.copy.
  if (Number(sdk) < 28) {
    throw new Error("Verifying support files through MediaStore requires Android 9 or newer. Android blocked direct access to these files.");
  }
  const states = await readMediaStoreEntries(device, user, files, signal);
  return files.filter((file) => {
    const state = states.get(file.path);
    if (state === "failed") throw new Error(`Cannot confirm a readable file through MediaStore: ${file.path}`);
    return state === "file";
  });
}

type MediaStoreReadState = "directory" | "file" | "missing" | "failed";

async function readMediaStoreEntries(device: DeviceTransport, user: number, records: readonly { id: string; path: string; format?: number }[], signal?: AbortSignal): Promise<ReadonlyMap<string, MediaStoreReadState>> {
  const states = new Map<string, MediaStoreReadState>();
  for (const record of records) {
    if (!record.path.startsWith(`${primaryStorageForUser(user)}/`)) throw new Error("MediaStore read targets another Android user's storage.");
  }
  for (let offset = 0; offset < records.length; offset += READ_BATCH_SIZE) {
    await assertAndroidUser(device, user, signal);
    const batch = records.slice(offset, offset + READ_BATCH_SIZE);
    const marker = `__emukase_folder_${crypto.randomUUID()}__`;
    const script = batch.map(({ id, path, format }) => {
      if (!/^[1-9]\d{0,18}$/.test(id)) throw new Error("Invalid MediaStore record ID.");
      const read = shellCommand("content", "read", "--user", String(user), "--uri", `${FILES_URI}/${id}`);
      // A pipe enables Android's splice optimization, which reports EINVAL for
      // directories. A character device preserves EISDIR and stops regular-file
      // copying at the first write, without downloading file contents.
      // OEM SELinux policies may deny /dev/full even while ordinary ADB folder
      // access is available. An indexed directory plus direct, canonical disk
      // read/traversal checks is stronger evidence and needs no device-node I/O.
      const direct = format === DIRECTORY_FORMAT ? `if ${shellCommand("test", "-d", path)} && ${shellCommand("test", "-r", path)} && ${shellCommand("test", "-x", path)} && test "$( ${shellCommand("readlink", "-f", path)} )" = ${shellCommand(path)}; then\nstate=directory\nelse\n` : "";
      return `(\n${direct}result=$( ${read} 2>&1 >/dev/full )\ncode=$?\ncase "$result" in\n`
        + `*"read failed: EISDIR"*) state=directory ;;\n*"open failed: ENOENT"*) state=missing ;;\n*"write failed: ENOSPC"*) state=file ;;\n'') if [ "$code" = 0 ]; then state=file; else state=failed; fi ;;\n*) state=failed ;;\nesac\n`
        + (direct ? "fi\n" : "")
        + `printf '%s' "${marker}:${id}:$state\n"\n) &`;
    }).join("\n") + `\nwait\nprintf '%s:complete\\n' ${shellCommand(marker)}`;
    const output = await device.shell(shellCommand("sh", "-c", script));
    checkAbort(signal);
    const lines = output.trim().split(/\r?\n/);
    if (lines.pop() !== `${marker}:complete` || lines.length !== batch.length) {
      throw new Error("Android did not confirm the library entry checks.");
    }
    const statuses = new Map<string, MediaStoreReadState>();
    for (const line of lines) {
      const match = new RegExp(`^${marker}:([1-9]\\d{0,18}):(directory|file|missing|failed)$`).exec(line);
      const id = match?.[1];
      const state = match?.[2] as MediaStoreReadState | undefined;
      if (!id || !state || !batch.some((record) => record.id === id) || statuses.has(id)) {
        throw new Error(`Ambiguous MediaStore entry check.\n${output.trim().slice(0, 1024)}`);
      }
      statuses.set(id, state);
    }
    for (const { id, path } of batch) {
      states.set(path, statuses.get(id)!);
    }
  }
  return states;
}

async function removeMarkers(device: DeviceTransport, user: number, paths: readonly string[], known?: readonly MediaStoreRecord[]): Promise<void> {
  const records = known ?? await queryPaths(device, user, paths);
  // No content was written. Remove just our database entries, preserving disk files
  // even if another process unexpectedly used the generated name in the meantime.
  if (records.length) {
    const where = records.map((record) => `(_id=${record.id} AND _data=${sqlString(record.path)})`).join(" OR ");
    await contentMutations(device, user, [{
      args: ["delete", "--where", where],
      uri: `${FILES_URI}?deletedata=false`,
    }]);
  }
  if (!(await queryPaths(device, user, paths)).length) return;
  // Some providers reject collection deletes. Retry the original ID/path pairs
  // individually, without broadening the selection or removing physical files.
  await contentMutations(device, user, records.map((record) => ({
    args: ["delete", "--where", `_data=${sqlString(record.path)}`],
    uri: `${FILES_URI}/${record.id}?deletedata=false`,
  })));
  if ((await queryPaths(device, user, paths)).length) throw new Error("MediaStore did not remove all temporary records.");
}

async function createFolderBatch(device: DeviceTransport, user: number, paths: readonly string[], signal?: AbortSignal): Promise<void> {
  const markers = paths.map((path) => {
    const name = `emukase-folder-${crypto.randomUUID()}.bin`;
    return { folder: path, name, path: `${path}/${name}`, relative: `${path.slice(primaryStorageForUser(user).length + 1)}/` };
  });
  const markerPaths = markers.map((marker) => marker.path);
  if ((await queryPaths(device, user, markerPaths, signal)).length) throw new Error("Temporary MediaStore name already exists.");
  let started = false;
  let failure: unknown;
  let records: MediaStoreRecord[] | undefined;
  try {
    checkAbort(signal);
    started = true;
    // Wait for every insert before cleanup, including commands that finish after
    // cancellation or a peer failure. Queries are shared across the whole batch.
    const results = await contentMutations(device, user, markers.map((marker) => ({
      args: ["insert", "--bind", `_display_name:s:${marker.name}`, "--bind", "mime_type:s:application/octet-stream",
        "--bind", `relative_path:s:${marker.relative}`],
    })), signal);
    records = await queryPaths(device, user, markerPaths, signal);
    const byPath = new Map(records.map((record) => [record.path, record]));
    const unconfirmed = markers.filter((marker) => !byPath.has(marker.path)).map((marker) => marker.folder);
    const confirmed = unconfirmed.length
      ? await readMediaStoreFolders(device, user, await queryMediaStoreFolders(device, user, unconfirmed, signal), signal)
      : undefined;
    for (const [index, marker] of markers.entries()) {
      const record = byPath.get(marker.path);
      if ((!record && !confirmed?.has(marker.folder)) || record?.format === DIRECTORY_FORMAT) {
        const reason = results.get(index);
        throw new Error(`MediaStore did not create its temporary record in ${marker.folder}.${reason ? ` ${reason}` : ""}`);
      }
    }
    // The caller checks the complete directory plan after creation. Verifying each
    // leaf here would repeat hundreds of slow content processes before that check.
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (started) {
      try {
        // The job's wrapper may be cancelled; cleanup still uses the live connection
        // and explicitly checks that the original profile is still foreground.
        await removeMarkers(device.restorationDevice ?? device, user, markerPaths, records);
      } catch (error) {
        const original = failure instanceof Error ? `${failure.message}\n` : "";
        throw new Error(`${original}Temporary MediaStore record cleanup failed.`, { cause: error });
      }
    }
  }
}

/** Inserting unique file records creates their parent folders. Empty records are
 * removed in finally; creation and cleanup use bounded parallel batches. */
export async function createMediaStoreFolders(device: DeviceTransport, user: number, paths: readonly string[],
  signal?: AbortSignal, onProgress?: (completed: number) => void): Promise<void> {
  for (const path of paths) folderPath(path, user);
  if (new Set(paths).size !== paths.length) throw new Error("Duplicate folders in the library plan.");
  checkAbort(signal);
  for (let offset = 0; offset < paths.length; offset += FOLDER_BATCH_SIZE) {
    const batch = paths.slice(offset, offset + FOLDER_BATCH_SIZE);
    await createFolderBatch(device, user, batch, signal);
    checkAbort(signal);
    onProgress?.(offset + batch.length);
  }
}
