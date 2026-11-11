import { assertAndroidUser, primaryStorageForUser } from "./android-user";
import { cleanupStaging, stageDexHelper } from "./dex-helper";
import { cleanQueryOutput, contentCommand } from "./media-store";
import { assertStorageEntryPath } from "./media-store-validation";
import { checkAbort } from "./setup-events";
import { shellCommand, type DeviceTransport } from "./transport";

export interface MediaStoreFileStat { modifiedSeconds: number; bytes: number }

async function fileId(device: DeviceTransport, user: number, path: string, signal?: AbortSignal): Promise<string | undefined> {
  const output = cleanQueryOutput(await contentCommand(device, user, ["query", "--projection", "_id:_data:format",
    "--where", `_data='${path.replaceAll("'", "''")}'`], signal, "content://media/external/file?includePending=1"));
  if (output === "No result found.") return undefined;
  const match = /^Row: 0 _id=([1-9]\d{0,18}), _data=([^\r\n]+), format=(NULL|null|\d+)$/.exec(output);
  if (!match || match[2] !== path || match[3] === "12289") throw new Error("Android did not confirm the shared file's identity.");
  return match[1];
}

/** Pending SAF records can have null cached metadata. Stat their actual file
 * descriptor without publishing the record or changing the app-owned file. */
export async function statMediaStoreFile(
  device: DeviceTransport, user: number, path: string, signal?: AbortSignal,
): Promise<MediaStoreFileStat | undefined> {
  assertStorageEntryPath(user, path);
  if (path.slice(`${primaryStorageForUser(user)}/`.length).split("/")[0] === "Android") {
    throw new Error("Invalid shared file metadata path.");
  }
  const scan = cleanQueryOutput(await contentCommand(device, user, ["call", "--method", "scan_file", "--arg", path], signal, "content://media"));
  if (!scan.startsWith("Result: Bundle[") || /Exception|Error:|Permission Denial/.test(scan)) throw new Error("Android could not inspect the shared file.");
  const id = await fileId(device, user, path, signal);
  if (id === undefined) return undefined;
  const { directory, dex, recovery } = await stageDexHelper(device, "emukase-media-stat", signal);
  const cleanup = shellCommand("rm", "-f", dex);
  try {
    checkAbort(signal);
    await assertAndroidUser(device, user, signal);
    const output = cleanQueryOutput(await device.shell(shellCommand("sh", "-c", [
      "set -eu", shellCommand("trap", cleanup, "EXIT"), shellCommand("chmod", "400", dex),
      shellCommand("timeout", "10", "env", `CLASSPATH=${dex}`, "app_process", "/", "MediaStoreStat", String(user), id),
    ].join("\n"))));
    checkAbort(signal);
    const after = await fileId(device, user, path, signal);
    if (output === `media-missing:${user}:${id}`) return undefined;
    const match = new RegExp(`^media-stat:${user}:${id}:(\\d+):(\\d+)$`).exec(output);
    if (!match || after !== id) throw new Error("Android did not confirm the shared file's current metadata.");
    const modifiedSeconds = Number(match[1]);
    const bytes = Number(match[2]);
    if (!Number.isSafeInteger(modifiedSeconds) || !Number.isSafeInteger(bytes)) throw new Error("Android returned invalid shared-file metadata.");
    return { modifiedSeconds, bytes };
  } finally {
    await cleanupStaging(recovery, directory, dex);
  }
}
