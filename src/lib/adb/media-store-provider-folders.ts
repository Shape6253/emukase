import { primaryStorageForUser } from "./android-user";
import { checkAbort } from "./setup-events";
import { cleanupStaging, dexCommand, stageDexHelper } from "./dex-helper";
import { assertFolderBatchPath, assertMediaRecordId } from "./media-store-validation";
import { shellCommand, type DeviceTransport } from "./transport";

export interface MediaStorePathRecord {
  id: string;
  path: string;
  format: number;
}

type Mode = "query" | "create";

const BATCH_LIMIT = 32;

function validatePaths(user: number, paths: readonly string[], mode: Mode): void {
  const prefix = `${primaryStorageForUser(user)}/`;
  if (!paths.length || paths.length > BATCH_LIMIT || new Set(paths).size !== paths.length) {
    throw new Error("Invalid MediaStore path batch.");
  }
  for (const path of paths) assertFolderBatchPath(user, path);
  // Fail fast with a clear error instead of the helper's generic failure:
  // creation rejects dots, the Android segment, and overlong names,
  // matching MediaStoreFolders.validate and normalizeStorageFolder.
  if (mode === "create") {
    for (const path of paths) {
      const parts = path.slice(prefix.length).split("/");
      if (path.slice(prefix.length).includes(".") || parts.includes("Android")
        || parts.some((part) => new TextEncoder().encode(part).length > 255)) {
        throw new Error("Invalid MediaStore path batch.");
      }
    }
  }
}

/** One staged helper reused for several folder batches. */
export interface MediaStoreProviderFoldersSession {
  query(user: number, paths: readonly string[], signal?: AbortSignal): Promise<MediaStorePathRecord[] | undefined>;
  create(user: number, paths: readonly string[], signal?: AbortSignal): Promise<MediaStorePathRecord[] | undefined>;
  close(): Promise<void>;
}

/** Query or create indexed paths without the content command on Android 12+. */
export async function openMediaStoreProviderFolders(device: DeviceTransport, signal?: AbortSignal): Promise<MediaStoreProviderFoldersSession> {
  const { directory, dex, recovery } = await stageDexHelper(device, "emukase-media-folders", signal);
  const request = `${directory}/request.json`;
  let closed = false;
  const run = async (user: number, paths: readonly string[], mode: Mode,
    runSignal?: AbortSignal): Promise<MediaStorePathRecord[] | undefined> => {
    if (closed) throw new Error("MediaStore provider session is closed.");
    validatePaths(user, paths, mode);
    checkAbort(runSignal);
    await device.push(new TextEncoder().encode(JSON.stringify({ user, paths })), request, { signal: runSignal });
    await device.shell(shellCommand("chmod", "400", request));
    const output = await device.shell(dexCommand(dex, "MediaStoreFolders", mode, request));
    checkAbort(runSignal);
    const line = output.trim().split(/\r?\n/).at(-1);
    if (line === "media-folders:unsupported") return undefined;
    if (!line?.startsWith("media-folders:")) {
      throw new Error(`Android did not confirm MediaStore folders. ${output.trim().slice(0, 1024)}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(line.slice("media-folders:".length));
    } catch {
      throw new Error("Android returned invalid MediaStore folder metadata.");
    }
    if (!Array.isArray(value) || value.length > paths.length || (mode === "create" && value.length !== paths.length)) {
      throw new Error("Android returned incomplete MediaStore folder records.");
    }
    const expected = new Set(paths);
    const seenPaths = new Set<string>();
    const seenIds = new Set<string>();
    const records: MediaStorePathRecord[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid MediaStore folder record.");
      const { id, path, format } = entry as { id?: unknown; path?: unknown; format?: unknown };
      assertMediaRecordId(id);
      if (typeof path !== "string" || !expected.has(path) || seenPaths.has(path) || seenIds.has(id)
        || typeof format !== "number" || !Number.isSafeInteger(format) || format < 0 || format > 65535) {
        throw new Error("Invalid MediaStore folder record.");
      }
      seenPaths.add(path);
      seenIds.add(id);
      records.push({ id, path, format });
    }
    return records;
  };
  return {
    query(user, paths, runSignal) {
      return run(user, paths, "query", runSignal);
    },
    create(user, paths, runSignal) {
      return run(user, paths, "create", runSignal);
    },
    async close() {
      if (closed) return;
      closed = true;
      await cleanupStaging(recovery, directory, dex, request);
    },
  };
}
