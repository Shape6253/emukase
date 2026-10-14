import { assertAndroidUser } from "./android-user";
import { checkAbort } from "./setup-events";
import { shellCommand, type DeviceTransport } from "./transport";

const SETTING = "verifier_verify_adb_installs";
type VerifierSetting = "0" | "1" | null;

export interface AdbInstallVerifierOptions {
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export class AdbInstallVerifierRestoreError extends Error {}

function parseSetting(output: string): VerifierSetting {
  const value = output.trim();
  if (output.length <= 64) {
    if (value === "null") return null;
    if (value === "0" || value === "1") return value;
  }
  throw new Error("Android's ADB APK verification setting was not a single supported value.");
}

export async function withAdbInstallVerifier<T>(
  device: DeviceTransport,
  user: number,
  install: () => Promise<T>,
  options: AdbInstallVerifierOptions = {},
): Promise<T> {
  const restoration = device.restorationDevice ?? device;
  const read = shellCommand("settings", "get", "global", SETTING);
  const log = (message: string): void => {
    try { options.log?.(message); } catch { /* Logging must not interrupt restoration. */ }
  };
  await assertAndroidUser(device, user, options.signal);
  const original = parseSetting(await device.shell(read));
  checkAbort(options.signal);
  let attempted = false;
  let failed = false;
  let installError: unknown;
  try {
    await assertAndroidUser(device, user, options.signal);
    // A cancelled or failed command can still have changed the setting.
    attempted = true;
    await device.shell(shellCommand("settings", "put", "global", SETTING, "0"));
    checkAbort(options.signal);
    if (parseSetting(await device.shell(read)) !== "0") {
      throw new Error("Android did not apply the temporary ADB APK verification setting.");
    }
    checkAbort(options.signal);
    log(`Saved ${SETTING}=${original ?? "null"}; confirmed temporary value 0.`);
    return await install();
  } catch (error) {
    failed = true;
    installError = error;
    throw error;
  } finally {
    if (attempted) {
      try {
        // This global setting must be restored even after cancellation or a profile switch.
        await restoration.shell(original === null
          ? shellCommand("settings", "delete", "global", SETTING)
          : shellCommand("settings", "put", "global", SETTING, original));
        if (parseSetting(await restoration.shell(read)) !== original) {
          throw new Error("The original value was not confirmed by readback.");
        }
        log(`Restored ${SETTING}=${original ?? "null"} and confirmed it by readback.`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const cause = failed ? new AggregateError([installError, error], "Installation and restoration failed.") : error;
        throw new AdbInstallVerifierRestoreError(
          `Could not restore Android's ADB APK verification setting (${SETTING}=${original ?? "null"}): ${detail}`,
          { cause },
        );
      }
    }
  }
}
