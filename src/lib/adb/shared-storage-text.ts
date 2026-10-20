import { primaryStorageForUser } from "./android-user";
import { cleanQueryOutput, contentCommand, queryMediaStoreFile } from "./media-store";
import { uploadMediaStoreFile } from "./media-store-upload";
import { checkAbort } from "./setup-events";
import { shellCommand, type DeviceTransport } from "./transport";

export async function sharedStorageReadable(device: DeviceTransport, user: number, signal?: AbortSignal): Promise<boolean> {
  const storage = primaryStorageForUser(user);
  checkAbort(signal);
  const output = await device.shell(shellCommand("sh", "-c",
    `if ${shellCommand("test", "-d", storage)} && ${shellCommand("test", "-r", storage)} && ${shellCommand("test", "-x", storage)}; then printf readable; else printf inaccessible; fi`));
  checkAbort(signal);
  if (!["readable", "inaccessible"].includes(output)) throw new Error("Android's shared-storage access could not be confirmed.");
  return output === "readable";
}

function validatePath(path: string, user: number): void {
  const prefix = `${primaryStorageForUser(user)}/`;
  if (!path.startsWith(prefix) || path.length > 2048 || /[\x00-\x1f\x7f]/.test(path)
    || path.slice(prefix.length).split("/").some((part) => !part || part === "." || part === "..")
    || path.slice(prefix.length).split("/")[0] === "Android") {
    throw new Error("Invalid shared configuration path.");
  }
}

/** Scan app-owned writes before querying: a stale media index is not file evidence. */
export async function readSharedStorageText(
  device: DeviceTransport, user: number, path: string, maxBytes: number, signal?: AbortSignal,
): Promise<string | undefined> {
  validatePath(path, user);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16_777_216) throw new Error("Invalid shared-text size limit.");
  const scan = cleanQueryOutput(await contentCommand(device, user, ["call", "--method", "scan_file", "--arg", path], signal, "content://media"));
  if (!scan.startsWith("Result: Bundle[") || /Exception|Error:|Permission Denial/.test(scan)) {
    throw new Error("Android could not inspect the shared configuration file through MediaStore.");
  }
  const record = await queryMediaStoreFile(device, user, path, signal);
  if (!record) return undefined;
  if (record.bytes > maxBytes) throw new Error("The shared configuration file is too large.");
  const marker = `emukase-shared-text-${crypto.randomUUID()}`;
  const errors = `/data/local/tmp/${marker}.err`;
  const prefix = `${marker}:begin\n`;
  const delimiter = `\n${marker}\n`;
  const output = await device.shell(shellCommand("sh", "-c", [
    "set -eu", shellCommand("trap", shellCommand("rm", "-f", errors), "EXIT"),
    // Keep a UTF-8 BOM inside the frame so transport decoders cannot strip it.
    shellCommand("printf", prefix),
    `${shellCommand("content", "read", "--user", String(user), "--uri", `content://media/external/file/${record.id}`)} 2> ${shellCommand(errors)} | ${shellCommand("head", "-c", String(maxBytes + 1))}`,
    shellCommand("printf", delimiter), shellCommand("cat", errors),
  ].join("\n")));
  checkAbort(signal);
  const boundary = output.lastIndexOf(delimiter);
  if (!output.startsWith(prefix) || boundary < prefix.length) throw new Error("Android did not finish reading the shared configuration file.");
  const diagnostics = cleanQueryOutput(output.slice(boundary + delimiter.length));
  if (diagnostics) {
    if (/FileNotFoundException[^\r\n]*(?:ENOENT|No such file)/.test(diagnostics)) return undefined;
    throw new Error("Android could not read the shared configuration file through MediaStore.");
  }
  const text = output.slice(prefix.length, boundary);
  if (new TextEncoder().encode(text).length > maxBytes || text.includes("\0")) throw new Error("The shared configuration file is invalid or too large.");
  return text;
}

export async function writeSharedStorageText(
  device: DeviceTransport, user: number, path: string, text: string,
  options: { replaceExisting?: boolean; signal?: AbortSignal; beforePublish?: () => Promise<void> } = {},
): Promise<void> {
  validatePath(path, user);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > 16_777_216 || text.includes("\0")) throw new Error("The shared configuration file is invalid or too large.");
  const directory = path.slice(0, path.lastIndexOf("/"));
  const name = path.slice(path.lastIndexOf("/") + 1);
  // The pending relative_path insert creates any missing parent directories.
  await uploadMediaStoreFile(device, user, directory, new File([text], name), options);
  if (await readSharedStorageText(device, user, path, Math.max(bytes, 1), options.signal) !== text) {
    throw new Error("Android did not retain the complete shared configuration file.");
  }
}
