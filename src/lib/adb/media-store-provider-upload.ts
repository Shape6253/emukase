import { loadAndroidUiDump } from "./android-ui-dump";
import { primaryStorageForUser } from "./android-user";
import { cleanQueryOutput } from "./media-store";
import type { MediaStoreUploadOptions } from "./media-store-upload";
import { shellCommand, type DeviceTransport } from "./transport";
import { normalizeStorageFolder } from "./workspace";

/** Batch metadata on Android while retaining the transport's cancellable stream.
 * False means the helper explicitly declined before creating a MediaStore row. */
export async function uploadThroughMediaStoreProvider(
  device: DeviceTransport, user: number, directory: string, file: File,
  temporary: string, options: MediaStoreUploadOptions,
): Promise<boolean> {
  if (options.beforePublish) return false;
  const root = `${primaryStorageForUser(user)}/`;
  if (!directory.startsWith(root) || normalizeStorageFolder(directory.slice(root.length)) !== directory.slice(root.length)
    || !(file instanceof File) || !Number.isSafeInteger(file.size) || file.size < 0
    || !file.name || file.name === "." || file.name === ".." || /[\x00-\x1f\x7f/\\"*:<>?|]/.test(file.name)
    || new TextEncoder().encode(file.name).length > 255) throw new Error("Invalid provider upload destination.");
  const staging = `/data/local/tmp/emukase-media-upload-${crypto.randomUUID()}`;
  const dex = `${staging}/helper.dex`;
  const request = `${staging}/request.json`;
  const recovery = device.restorationDevice ?? device;
  const cleanup = `${shellCommand("rm", "-f", dex, request, `${staging}/state.json`, `${staging}/state.tmp`)}\n${shellCommand("rmdir", staging)}`;
  const command = (phase: "begin" | "finish" | "abort"): string => shellCommand("sh", "-c", [
    "set -eu", "umask 077",
    shellCommand("env", `CLASSPATH=${dex}`, "app_process", "/", "MediaStoreUpload", phase, request),
  ].join("\n"));
  let started = false;
  let published = false;
  let retainJournal = false;
  try {
    options.signal?.throwIfAborted();
    await device.shell(shellCommand("sh", "-c", `umask 077\n${shellCommand("mkdir", staging)}`));
    await device.push(await loadAndroidUiDump(options.signal), dex, { signal: options.signal });
    await device.push(new TextEncoder().encode(JSON.stringify({
      user, directory, name: file.name, bytes: file.size, temporary,
      replaceExisting: options.replaceExisting === true, mimeType: options.mimeType ?? "",
    })), request, { signal: options.signal });
    await device.shell(shellCommand("chmod", "400", dex, request));
    started = true;
    const prepared = cleanQueryOutput(await device.shell(command("begin")));
    if (prepared === "media-upload:unsupported") {
      started = false;
      return false;
    }
    const id = /^media-upload:pending:([1-9]\d{0,18})$/.exec(prepared)?.[1];
    if (!id) throw new Error(`Android did not prepare the provider upload. ${prepared}`);
    options.signal?.throwIfAborted();
    await device.writeContent(file, `content://media/external/file/${id}`, user, options);
    options.signal?.throwIfAborted();
    const completed = cleanQueryOutput(await device.shell(command("finish")));
    if (completed !== "media-upload:published") throw new Error(`Android did not confirm the provider upload. ${completed}`);
    published = true;
    options.signal?.throwIfAborted();
    return true;
  } catch (error) {
    if (started && !published) {
      try {
        const restored = cleanQueryOutput(await recovery.shell(command("abort")));
        if (restored !== "media-upload:cleaned") throw new Error("Provider upload cleanup was not confirmed.");
      } catch (cleanupError) {
        retainJournal = true;
        throw new Error("The provider upload could not be cleaned up. Reconnect the same Android profile before trying again.", {
          cause: new AggregateError([error, cleanupError]),
        });
      }
    }
    throw error;
  } finally {
    if (!retainJournal) await recovery.shell(shellCommand("sh", "-c", cleanup)).catch(() => {});
  }
}
