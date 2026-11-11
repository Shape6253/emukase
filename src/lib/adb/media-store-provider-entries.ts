import { checkAbort } from "./setup-events";
import { cleanupStaging, dexEnv, stageDexHelper } from "./dex-helper";
import { cleanQueryOutput } from "./media-store";
import { assertMediaRecordId, assertStorageEntryPath } from "./media-store-validation";
import { shellCommand, type DeviceTransport } from "./transport";

export type MediaStoreEntryState = "directory" | "file" | "missing" | "failed";

/** Stat provider descriptors without copying file contents or opening /dev/full. */
export async function readMediaStoreProviderEntries(
  device: DeviceTransport, user: number, records: readonly { id: string; path: string }[], signal?: AbortSignal,
): Promise<ReadonlyMap<string, MediaStoreEntryState>> {
  const states = new Map<string, MediaStoreEntryState>();
  if (!records.length) return states;
  for (const { id, path } of records) {
    assertMediaRecordId(id);
    assertStorageEntryPath(user, path);
  }
  const { directory, dex, recovery } = await stageDexHelper(device, "emukase-media-entries", signal);
  const request = `${directory}/request.json`;
  try {
    for (let offset = 0; offset < records.length; offset += 64) {
      checkAbort(signal);
      const batch = records.slice(offset, offset + 64);
      await device.push(new TextEncoder().encode(JSON.stringify({ user, records: batch })), request, { signal });
      const output = cleanQueryOutput(await device.shell(shellCommand("sh", "-c", [
        "set -eu", shellCommand("chmod", "600", request),
        dexEnv(dex, "MediaStoreStat", "--entries", request),
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
    await cleanupStaging(recovery, directory, dex, request);
  }
}
