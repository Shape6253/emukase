import { AdbInstallVerifierRestoreError } from "./adb-install-verifier";
import { DeviceAwakeRestoreError } from "./device-keep-awake";

export function setupErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (error instanceof AdbInstallVerifierRestoreError || error instanceof DeviceAwakeRestoreError || error instanceof AggregateError) return raw;
  if (raw.includes("INSTALL_FAILED_VERIFICATION_FAILURE")) return "Android's app verification blocked this APK.";
  if (raw.includes("INSTALL_GRANT_RUNTIME_PERMISSIONS") || raw.includes("INSTALL_FAILED_USER_RESTRICTED")) {
    return "Android blocked APK installation. Check USB installation permissions on the device, then try again.";
  }
  if (/disconnect|USB connection/i.test(raw)) return "The USB connection was interrupted. Reconnect the same device, then install again.";
  return raw;
}
