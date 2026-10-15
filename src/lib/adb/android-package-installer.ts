import { readAndroidPackage } from "./android-package";
import { userScopedDevice } from "./android-user";
import { checkAbort } from "./setup-events";
import { shellCommand, type DeviceTransport } from "./transport";

export interface PackageInstallerOptions {
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export type PackageInstallerResult = void | { status: "skipped"; message: string };

function assignmentRefused(output: string): boolean {
  return /SecurityException|Permission Denial|not permitted|not allowed|same cert|unknown command|unsupported|not supported|Unknown (?:target|installer) package/i.test(output);
}

/** Try changing the installer of record without downloading or reinstalling an APK.
 * Android stores this per package, across profiles; this does not set update ownership. */
export async function assignAndroidPackageInstaller(
  device: DeviceTransport,
  packageName: string,
  installerPackageName: string,
  user: number,
  options: PackageInstallerOptions = {},
): Promise<PackageInstallerResult> {
  for (const name of [packageName, installerPackageName]) {
    if (typeof name !== "string" || name.length >= 255 || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(name)) {
      throw new Error("Invalid Android package name for installer assignment.");
    }
  }
  const { signal, log } = options;
  const scoped = userScopedDevice(device, user, signal);
  const [installed, installer] = await Promise.all([
    readAndroidPackage(scoped, packageName, user, signal),
    readAndroidPackage(scoped, installerPackageName, user, signal),
  ]);
  if (!installed) throw new Error("The application is not installed in this Android profile.");
  if (!installer) throw new Error("The update installer is not installed in this Android profile.");
  if (installed.installer === installerPackageName) {
    log?.(`Android already records ${installerPackageName} as the installer of ${packageName}.`);
    return;
  }

  let output: string;
  try {
    // The shell command has no --user option; the scoped transport checks the foreground profile.
    output = await scoped.shell(shellCommand("pm", "set-installer", packageName, installerPackageName));
  } catch (error) {
    checkAbort(signal);
    const detail = error instanceof Error ? error.message : String(error);
    if (!assignmentRefused(detail)) throw error;
    output = detail;
  }
  checkAbort(signal);
  const confirmed = await readAndroidPackage(scoped, packageName, user, signal);
  if (!confirmed) throw new Error("The application disappeared while assigning its update installer.");
  if (confirmed.installer === installerPackageName) {
    log?.(`Assigned ${installerPackageName} as the installer of ${packageName} and confirmed it by readback.`);
    return;
  }
  if (output.trim() !== "Success" && !assignmentRefused(output)) {
    throw new Error("Android returned an unexpected response while assigning the update installer.");
  }
  const message = "Android did not change the installer; Obtainium updates may require confirmation.";
  log?.(`${message} Kept the installed APK. ${output.trim().slice(0, 1024)}`);
  return { status: "skipped", message };
}
