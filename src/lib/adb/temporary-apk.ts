export interface TemporaryApk {
  handle: FileSystemFileHandle;
  dispose(): Promise<void>;
}

const temporaryApkName = /^emukase-apk-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

async function removeFile(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
}

async function recoverFiles(directory: FileSystemDirectoryHandle, signal?: AbortSignal): Promise<void> {
  for await (const [name, entry] of directory.entries()) {
    signal?.throwIfAborted();
    if (entry.kind !== "file" || !temporaryApkName.test(name)) continue;
    await navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      signal?.throwIfAborted();
      await removeFile(directory, name);
    });
  }
}

function retainLock(name: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    const request: Promise<void> = navigator.locks.request(name, { signal }, async () => {
      // Keep the APK protected after downloading, while it waits for installation.
      await new Promise<void>((release) => {
        resolve(async () => {
          release();
          await request;
        });
      });
    });
    void request.catch(reject);
  });
}

export async function createTemporaryApk(signal?: AbortSignal): Promise<TemporaryApk> {
  signal?.throwIfAborted();
  if (typeof globalThis.navigator?.storage?.getDirectory !== "function") {
    throw new Error("Temporary APK storage is unavailable. Use Chrome or Edge over HTTPS or localhost.");
  }
  if (typeof navigator.locks?.request !== "function") {
    throw new Error("Temporary APK storage requires Web Locks. Use Chrome or Edge over HTTPS or localhost.");
  }
  const directory = await navigator.storage.getDirectory();
  await recoverFiles(directory, signal);
  const name = `emukase-apk-${crypto.randomUUID()}`;
  const release = await retainLock(name, signal);
  let disposed: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    disposed ??= (async () => {
      try {
        await removeFile(directory, name);
      } finally {
        await release();
      }
    })();
    return disposed;
  };
  try {
    signal?.throwIfAborted();
    const handle = await directory.getFileHandle(name, { create: true });
    signal?.throwIfAborted();
    return { handle, dispose };
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
}
