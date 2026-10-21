import { loadAndroidUiDump } from "./android-ui-dump";
import { primaryStorageForUser } from "./android-user";
import { cleanQueryOutput } from "./media-store";
import { checkAbort } from "./setup-events";
import { shellCommand, type DeviceTransport } from "./transport";

export type MediaStoreEntryState = "directory" | "file" | "missing" | "failed";

/** Stat provider descriptors without copying file contents or opening /dev/full. */
export async function readMediaStoreProviderEntries(
  device: DeviceTransport, user: number, records: readonly { id: string; path: string }[], signal?: AbortSignal,
): Promise<ReadonlyMap<string, MediaStoreEntryState>> {
  const states = new Map<string, MediaStoreEntryState>();
  if (!records.length) return states;
  const prefix = `${primaryStorageForUser(user)}/`;
  for (const { id, path } of records) {
    if (!/^[1-9]\d{0,18}$/.test(id) || !path.startsWith(prefix) || path.length > 2048
      || /[\x00-\x1f\x7f]/.test(path) || path.slice(prefix.length).split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("Invalid MediaStore entry identity.");
    }
  }
  const directory = `/data/local/tmp/emukase-media-entries-${crypto.randomUUID()}`;
  const dex = `${directory}/helper.dex`;
  const request = `${directory}/request.json`;
  try {
    checkAbort(signal);
    await device.shell(shellCommand("sh", "-c", `umask 077\n${shellCommand("mkdir", directory)}`));
    await device.push(await loadAndroidUiDump(signal), dex, { signal });
    await device.shell(shellCommand("chmod", "400", dex));
    for (let offset = 0; offset < records.length; offset += 64) {
      checkAbort(signal);
      const batch = records.slice(offset, offset + 64);
      await device.push(new TextEncoder().encode(JSON.stringify({ user, records: batch })), request, { signal });
      const output = cleanQueryOutput(await device.shell(shellCommand("sh", "-c", [
        "set -eu", shellCommand("chmod", "600", request),
        shellCommand("env", `CLASSPATH=${dex}`, "app_process", "/", "MediaStoreStat", "--entries", request),
      ].join("\n"))));
      checkAbort(signal);
      if (!output.startsWith("media-entries:")) throw new Error(`Android did not confirm the library entry metadata. ${output}`);
      const value: unknown = JSON.parse(output.slice("media-entries:".length));
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== batch.length) {
        throw new Error("Android returned incomplete library entry metadata.");
      }
      for (const { id, path } of batch) {
        const state: unknown = Object.getOwnPropertyDescriptor(value, id)?.value;
        if (state !== "directory" && state !== "file" && state !== "missing" && state !== "failed") {
          throw new Error("Android returned invalid library entry metadata.");
        }
        states.set(path, state);
      }
    }
    return states;
  } finally {
    await (device.restorationDevice ?? device).shell(shellCommand("sh", "-c", [
      shellCommand("rm", "-f", dex, request), shellCommand("rmdir", directory),
    ].join("\n"))).catch(() => {});
  }
}
