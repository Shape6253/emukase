import { shellCommand } from "./transport";
import type { DeviceTransport } from "./transport";
import { assertAndroidUser, primaryStorageForUser } from "./android-user";
import { checkAbort } from "./setup-events";
import { normalizeStorageFolder } from "./workspace";

const FILES_URI = "content://media/external/file";
const DIRECTORY_FORMAT = 12289;
const QUERY_BATCH_SIZE = 32;
const READ_BATCH_SIZE = 4;

export interface MediaStoreRecord {
  id: string;
  path: string;
  format: number;
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
async function contentCommand(device: DeviceTransport, user: number, args: readonly string[], signal?: AbortSignal, uri = FILES_URI): Promise<string> {
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

function queryResult(output: string, expected: ReadonlySet<string>): MediaStoreRecord[] {
  // This specific startup warning also appears on successful commands on Pocket FIT.
  const clean = output.replace(/^java\.lang\.NumberFormatException: For input string: ""\r?\n(?:\s+at [^\r\n]+\r?\n)*/gm, "").trim();
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

/** A database row alone is not proof of a folder. Reading its URI must fail with
 * the kernel's EISDIR; ENOENT means the row is stale. No files are created here. */
export async function readMediaStoreFolders(device: DeviceTransport, user: number, records: readonly MediaStoreRecord[], signal?: AbortSignal): Promise<ReadonlySet<string>> {
  const confirmed = new Set<string>();
  for (const record of records) {
    folderPath(record.path, user);
    if (record.format !== DIRECTORY_FORMAT) throw new Error(`Library path is occupied by a file: ${record.path}`);
  }
  for (let offset = 0; offset < records.length; offset += READ_BATCH_SIZE) {
    await assertAndroidUser(device, user, signal);
    const batch = records.slice(offset, offset + READ_BATCH_SIZE);
    const marker = `__emukase_folder_${crypto.randomUUID()}__`;
    const script = batch.map(({ id }) => {
      if (!/^[1-9]\d{0,18}$/.test(id)) throw new Error("Invalid MediaStore record ID.");
      const read = shellCommand("content", "read", "--user", String(user), "--uri", `${FILES_URI}/${id}`);
      // A pipe enables Android's splice optimization, which reports EINVAL for
      // directories. A character device preserves EISDIR and stops regular-file
      // copying at the first write, without downloading file contents.
      return `(\nresult=$( ${read} 2>&1 >/dev/full )\ncase "$result" in\n`
        + `*"read failed: EISDIR"*) state=directory ;;\n*"open failed: ENOENT"*) state=missing ;;\n*) state=failed ;;\nesac\n`
        + `printf '%s' "${marker}:${id}:$state\n"\n) &`;
    }).join("\n") + `\nwait\nprintf '%s:complete\\n' ${shellCommand(marker)}`;
    const output = await device.shell(shellCommand("sh", "-c", script));
    checkAbort(signal);
    const lines = output.trim().split(/\r?\n/);
    if (lines.pop() !== `${marker}:complete` || lines.length !== batch.length) {
      throw new Error("Android did not confirm the library folder checks.");
    }
    const statuses = new Map<string, string>();
    for (const line of lines) {
      const match = new RegExp(`^${marker}:([1-9]\\d{0,18}):(directory|missing|failed)$`).exec(line);
      const id = match?.[1];
      const state = match?.[2];
      if (!id || !state || !batch.some((record) => record.id === id) || statuses.has(id)) {
        throw new Error(`Ambiguous MediaStore folder check.\n${output.trim().slice(0, 1024)}`);
      }
      statuses.set(id, state);
    }
    for (const { id, path } of batch) {
      const state = statuses.get(id);
      if (state === "directory") confirmed.add(path);
      else if (state !== "missing") throw new Error(`Cannot confirm a readable directory through MediaStore: ${path}`);
    }
  }
  return confirmed;
}

async function removeMarker(device: DeviceTransport, user: number, path: string, known?: MediaStoreRecord): Promise<void> {
  const record = known ?? (await queryPaths(device, user, [path]))[0];
  if (!record) return;
  // No content was written. Remove just our database entry, preserving disk files
  // even if another process unexpectedly used the generated name in the meantime.
  await contentCommand(device, user, ["delete", "--where", `_data=${sqlString(path)}`], undefined, `${FILES_URI}/${record.id}?deletedata=false`);
  if ((await queryPaths(device, user, [path])).length) throw new Error(`MediaStore did not remove its temporary record: ${path}`);
}

/** Inserting a unique file record creates its parent folders. The empty record is
 * deleted in finally; no ZIP, ROM, binary stdin or APK installation is needed. */
export async function createMediaStoreFolder(device: DeviceTransport, user: number, path: string, signal?: AbortSignal): Promise<void> {
  folderPath(path, user);
  const relativePath = `${path.slice(primaryStorageForUser(user).length + 1)}/`;
  const name = `emukase-folder-${crypto.randomUUID()}.bin`;
  const markerPath = `${path}/${name}`;
  if ((await queryPaths(device, user, [markerPath], signal)).length) throw new Error("Temporary MediaStore name already exists.");
  let started = false;
  let failure: unknown;
  let record: MediaStoreRecord | undefined;
  try {
    checkAbort(signal);
    started = true;
    const inserted = await contentCommand(device, user, ["insert", "--bind", `_display_name:s:${name}`, "--bind", "mime_type:s:application/octet-stream",
      "--bind", `relative_path:s:${relativePath}`], signal);
    const records = await queryPaths(device, user, [markerPath], signal);
    record = records[0];
    if (records.length !== 1 || !record || record.format === DIRECTORY_FORMAT) {
      const reason = /(?:java\.lang\.(?:IllegalArgumentException|SecurityException)|java\.io\.[A-Za-z]+Exception): ([^\r\n]+)/.exec(inserted)?.[1];
      throw new Error(`MediaStore did not create its temporary record in ${path}.${reason ? ` ${reason}` : ""}`);
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
        await removeMarker(device.restorationDevice ?? device, user, markerPath, record);
      } catch (error) {
        const original = failure instanceof Error ? `${failure.message}\n` : "";
        throw new Error(`${original}Temporary MediaStore record cleanup failed: ${markerPath}`, { cause: error });
      }
    }
  }
}
