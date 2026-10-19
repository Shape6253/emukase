import { assertAndroidUser, primaryStorageForUser } from "./android-user";
import { cleanQueryOutput, contentCommand } from "./media-store";
import type { DeviceTransport, FileTransferOptions } from "./transport";
import { normalizeStorageFolder } from "./workspace";

const FILES_URI = "content://media/external/file?includePending=1";
const TEMPORARY_NAME = /^emukase-upload-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.bin$/;

interface UploadRecord {
  id: string;
  path: string;
  bytes: number | undefined;
  pending: boolean;
}

export interface MediaStoreUploadOptions extends FileTransferOptions {
  replaceExisting?: boolean;
  mimeType?: string;
}

async function readRecord(device: DeviceTransport, user: number, where: string, signal?: AbortSignal): Promise<UploadRecord | undefined> {
  const output = cleanQueryOutput(await contentCommand(device, user, [
    "query", "--projection", "_id:_data:_size:is_pending", "--where", where,
  ], signal, FILES_URI));
  if (output === "No result found.") return undefined;
  const record = /^Row: 0 _id=([1-9]\d{0,18}), _data=([^\r\n]+), _size=(NULL|null|\d+), is_pending=([01])$/.exec(output);
  if (!record) throw new Error("Android did not confirm the uploaded MediaStore record.");
  const bytes = /^null$/i.test(record[3] ?? "") ? undefined : Number(record[3]);
  if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 0)) throw new Error("Invalid uploaded ROM size.");
  return { id: record[1] ?? "", path: record[2] ?? "", bytes, pending: record[4] === "1" };
}

/** A pending record hides partial files and content write bypasses shell storage restrictions. */
export async function uploadMediaStoreFile(
  device: DeviceTransport, user: number, directory: string, file: File, options: MediaStoreUploadOptions = {},
): Promise<void> {
  if (options.mimeType !== undefined && !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(options.mimeType)) {
    throw new Error("Invalid upload MIME type.");
  }
  const temporaryName = `emukase-upload-${crypto.randomUUID()}.bin`;
  const write = (): Promise<void> => writePendingFile(device, user, directory, file, temporaryName, options);
  if (typeof globalThis.navigator?.locks?.request === "function") {
    await navigator.locks.request(temporaryName, { signal: options.signal }, () => options.replaceExisting
      ? navigator.locks.request(`emukase-support:${user}:${directory}/${file.name.toLowerCase()}`, { signal: options.signal }, write)
      : write());
  } else {
    await write();
  }
}

async function writePendingFile(
  device: DeviceTransport, user: number, directory: string, file: File, temporaryName: string, options: MediaStoreUploadOptions,
): Promise<void> {
  const storage = primaryStorageForUser(user);
  const relative = directory.slice(storage.length + 1);
  if (!directory.startsWith(`${storage}/`) || normalizeStorageFolder(relative) !== relative) {
    throw new Error("ROM uploads require a folder in the selected Android profile's internal storage.");
  }
  const temporaryWhere = `_display_name='${temporaryName}'`;
  let record: UploadRecord | undefined;
  let previous: UploadRecord | undefined;
  let backupPath: string | undefined;
  let insertStarted = false;
  let published = false;
  try {
    options.signal?.throwIfAborted();
    if (options.replaceExisting) {
      const destination = `${directory}/${file.name}`.replaceAll("'", "''");
      previous = await readRecord(device, user, `_data='${destination}' COLLATE NOCASE AND (format IS NULL OR format != 12289)`, options.signal);
      if (previous && (previous.pending || previous.path.slice(0, previous.path.lastIndexOf("/")) !== directory)) {
        throw new Error("The existing support file is not ready for replacement.");
      }
    }
    insertStarted = true;
    await contentCommand(device, user, [
      "insert", "--bind", `_display_name:s:${temporaryName}`, "--bind", "mime_type:s:application/octet-stream",
      "--bind", `relative_path:s:${relative}/`, "--bind", "is_pending:i:1",
    ], options.signal);
    // Some Android content CLIs omit insert's URI; find only this run's unique name.
    record = await readRecord(device, user, temporaryWhere, options.signal);
    const basename = record?.path.slice(record.path.lastIndexOf("/") + 1);
    if (!record || record.path.slice(0, record.path.lastIndexOf("/")) !== directory || !record.pending ||
      (basename !== temporaryName && !new RegExp(`^\\.pending-\\d+-${temporaryName.replaceAll(".", "\\.")}$`).test(basename ?? ""))) {
      throw new Error("Android did not create the pending ROM in the selected folder.");
    }
    await device.writeContent(file, `content://media/external/file/${record.id}`, user, options);
    if (previous) {
      // Keep the old file until the new transfer is complete, and restore its
      // original name if publication fails or the operation is cancelled.
      backupPath = `${directory}/${temporaryName.replace("emukase-upload-", "emukase-replaced-")}`;
      await renameRecord(device, user, previous, backupPath, options.signal);
    }
    // MediaProvider refreshes size and resolves name collisions when publishing.
    await contentCommand(device, user, [
      "update", "--bind", `_display_name:s:${file.name}`, "--bind", "is_pending:i:0",
      ...(options.mimeType ? ["--bind", `mime_type:s:${options.mimeType}`] : []),
    ], options.signal, `content://media/external/file/${record.id}?includePending=1`);
    const completed = await readRecord(device, user, `_id=${record.id}`, options.signal);
    if (!completed || completed.pending || completed.path !== `${directory}/${file.name}` || completed.bytes !== file.size) {
      throw new Error(`Android did not confirm the complete size and destination of ${file.name}. Existing files have been kept.`);
    }
    if (options.mimeType) {
      const mime = cleanQueryOutput(await contentCommand(device, user, ["query", "--projection", "mime_type"], options.signal,
        `content://media/external/file/${record.id}`));
      if (mime !== `Row: 0 mime_type=${options.mimeType}`) throw new Error("Android did not retain the uploaded file's MIME type.");
    }
    published = true;
    if (previous) await deleteRecord(device.restorationDevice ?? device, user, previous.id);
  } catch (error) {
    if (!insertStarted || published) throw error;
    const cleanup = device.restorationDevice ?? device;
    try {
      await assertAndroidUser(cleanup, user);
      record ??= await readRecord(cleanup, user, temporaryWhere);
      if (record) await deleteRecord(cleanup, user, record.id);
      if (previous && backupPath) {
        const original = await readRecord(cleanup, user, `_id=${previous.id}`);
        if (!original || (original.path !== previous.path && original.path !== backupPath)) {
          throw new Error("The original support file could not be located for restoration.");
        }
        if (original.path !== previous.path) await renameRecord(cleanup, user, original, previous.path);
      }
    } catch (cleanupError) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason} The partial upload could not be removed. Reconnect the same Android profile before trying again.`, {
        cause: new AggregateError([error, cleanupError]),
      });
    }
    throw error;
  }
}

async function renameRecord(device: DeviceTransport, user: number, record: UploadRecord, path: string, signal?: AbortSignal): Promise<void> {
  await contentCommand(device, user, ["update", "--bind", `_display_name:s:${path.slice(path.lastIndexOf("/") + 1)}`], signal,
    `content://media/external/file/${record.id}?includePending=1`);
  const renamed = await readRecord(device, user, `_id=${record.id}`, signal);
  if (!renamed || renamed.path !== path || renamed.pending !== record.pending || renamed.bytes !== record.bytes) {
    throw new Error("Android did not confirm the support file rename.");
  }
}

async function deleteRecord(device: DeviceTransport, user: number, id: string): Promise<void> {
  await contentCommand(device, user, ["delete", "--where", `_id=${id}`], undefined, FILES_URI);
  if (await readRecord(device, user, `_id=${id}`)) throw new Error("Android did not remove the upload record.");
}

/** Recover only abandoned app uploads; Web Locks protect active transfers in other tabs. */
export async function recoverMediaStoreUploads(
  device: DeviceTransport, user: number, directory: string, signal?: AbortSignal,
): Promise<void> {
  if (typeof globalThis.navigator?.locks?.request !== "function") return;
  const storage = primaryStorageForUser(user);
  const relative = directory.slice(storage.length + 1);
  if (!directory.startsWith(`${storage}/`) || normalizeStorageFolder(relative) !== relative) throw new Error("Invalid ROM recovery folder.");
  const where = `is_pending=1 AND relative_path='${relative.replaceAll("'", "''")}/' AND _display_name GLOB 'emukase-upload-*.bin'`;
  const output = cleanQueryOutput(await contentCommand(device, user, [
    "query", "--projection", "_id:_data:_display_name", "--where", where,
  ], signal, FILES_URI));
  if (output === "No result found.") return;
  for (const line of output.split(/\r?\n/)) {
    signal?.throwIfAborted();
    const match = /^Row: \d+ _id=([1-9]\d{0,18}), _data=([^\r\n]+), _display_name=([^\r\n]+)$/.exec(line);
    if (!match) throw new Error("Android did not confirm abandoned ROM uploads.");
    const [, id, path, name] = match;
    if (!id || !path || !name || !TEMPORARY_NAME.test(name) || path.slice(0, path.lastIndexOf("/")) !== directory) continue;
    const basename = path.slice(path.lastIndexOf("/") + 1);
    if (basename !== name && !new RegExp(`^\\.pending-\\d+-${name.replaceAll(".", "\\.")}$`).test(basename)) continue;
    await navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      signal?.throwIfAborted();
      const record = await readRecord(device, user, `_id=${id}`, signal);
      if (!record?.pending || record.path !== path) return;
      await contentCommand(device, user, ["delete", "--where", `_id=${id}`], signal, FILES_URI);
      if (await readRecord(device, user, `_id=${id}`, signal)) throw new Error("Android could not remove an abandoned ROM upload.");
    });
  }
}
