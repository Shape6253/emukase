import { checkAbort } from "./setup-events";
import { shellMarker } from "./shell-marker";
import { shellCommand, type DeviceTransport } from "./transport";

const DIRECT_FOLDER_BATCH_SIZE = 32;

async function directFolders(device: DeviceTransport, paths: readonly string[], create: boolean,
  signal?: AbortSignal, onProgress?: (completed: number) => void): Promise<void> {
  for (let offset = 0; offset < paths.length; offset += DIRECT_FOLDER_BATCH_SIZE) {
    checkAbort(signal);
    const batch = paths.slice(offset, offset + DIRECT_FOLDER_BATCH_SIZE);
    const marker = shellMarker("direct_folders");
    const script = [
      ...(create ? [`${shellCommand("mkdir", "-p", ...batch)} || exit 1`] : []),
      `for path in ${shellCommand(...batch)}; do`,
      "if [ ! -d \"$path\" ] || [ ! -r \"$path\" ] || [ ! -w \"$path\" ] || [ ! -x \"$path\" ]; then",
      "  printf 'Folder is missing or inaccessible: %s\\n' \"$path\" >&2; exit 1",
      "fi",
      "done",
      `printf '%s\\n' ${shellCommand(marker)}`,
    ].join("\n");
    const output = await device.shell(shellCommand("sh", "-c", script));
    checkAbort(signal);
    if (output.trim() !== marker) throw new Error("Android did not confirm direct folder access.");
    onProgress?.(offset + batch.length);
  }
}

export function verifyDirectFolders(device: DeviceTransport, paths: readonly string[], signal?: AbortSignal): Promise<void> {
  return directFolders(device, paths, false, signal);
}

export function createDirectFolders(device: DeviceTransport, paths: readonly string[], signal?: AbortSignal,
  onProgress?: (completed: number) => void): Promise<void> {
  return directFolders(device, paths, true, signal, onProgress);
}
