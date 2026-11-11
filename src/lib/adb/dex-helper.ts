import { loadAndroidUiDump } from "./android-ui-dump";
import { checkAbort } from "./setup-events";
import { shellCommand, type DeviceTransport } from "./transport";

/** Original connection for cleanup after cancellation. */
export function recoveryDevice(device: DeviceTransport): DeviceTransport {
  return device.restorationDevice ?? device;
}

/** Remove staged DEX files without failing the caller. */
export async function cleanupStaging(device: DeviceTransport, directory: string, ...files: string[]): Promise<void> {
  await device.shell(shellCommand("sh", "-c", [
    shellCommand("rm", "-f", ...files),
    shellCommand("rmdir", directory),
  ].join("\n"))).catch(() => {});
}

export interface DexStaging {
  directory: string;
  dex: string;
  recovery: DeviceTransport;
}

/** Push the shared helper DEX to a private tmp dir. Request files stay caller-owned. */
export async function stageDexHelper(device: DeviceTransport, prefix: string, signal?: AbortSignal): Promise<DexStaging> {
  checkAbort(signal);
  const directory = `/data/local/tmp/${prefix}-${crypto.randomUUID()}`;
  const dex = `${directory}/helper.dex`;
  try {
    await device.shell(shellCommand("sh", "-c", `umask 077\n${shellCommand("mkdir", directory)}`));
    await device.push(await loadAndroidUiDump(signal), dex, { signal });
    await device.shell(shellCommand("chmod", "400", dex));
  } catch (error) {
    await cleanupStaging(recoveryDevice(device), directory, dex).catch(() => {});
    throw error;
  }
  return { directory, dex, recovery: recoveryDevice(device) };
}

/** Inner `app_process` call for embedding in a larger `sh -c` script. */
export function dexEnv(dex: string, entry: string, ...args: string[]): string {
  return shellCommand("env", `CLASSPATH=${dex}`, "app_process", "/", entry, ...args);
}

/** Guarded `app_process` invocation for a staged helper DEX. */
export function dexCommand(dex: string, entry: string, ...args: string[]): string {
  return shellCommand("sh", "-c", dexEnv(dex, entry, ...args));
}
