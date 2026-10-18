import { readAndroidUser, userScopedDevice } from "./android-user";
import { selectAbi } from "./catalog";
import { getObtainiumTrackedApps } from "./obtainium-catalog";
import { installApplicationViaObtainium } from "./obtainium-install";
import { RETROHRAI_PACKAGE } from "./retrohrai-types";
import type { RetroHraiSetupOptions } from "./retrohrai-types";
import { shellCommand, type DeviceTransport } from "./transport";

/** Install the official stable APK and register its update source in Obtainium. */
export async function installRetroHrai(device: DeviceTransport, options: RetroHraiSetupOptions = {}): Promise<string> {
  const user = await readAndroidUser(device, options.signal);
  const scoped = userScopedDevice(device, user, options.signal);
  const sdkText = (await scoped.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
  const sdk = Number(sdkText);
  if (!/^[1-9]\d*$/.test(sdkText) || !Number.isSafeInteger(sdk) || sdk < 26) {
    throw new Error("RetroHrai requires a confirmed Android 8 or newer device.");
  }
  const abi = selectAbi((await scoped.shell(shellCommand("getprop", "ro.product.cpu.abilist"))).trim().split(","));
  const app = getObtainiumTrackedApps(abi, { sdk }).find((entry) => entry.id === RETROHRAI_PACKAGE);
  if (!app) throw new Error("RetroHrai's official update source does not support this Android device.");
  return installApplicationViaObtainium(scoped, app, {
    signal: options.signal, log: options.log, importSource: true,
    reportStatus(message, status) {
      options.onStatus?.(message);
      if (status?.unlockRequired !== undefined) options.onUnlockRequired?.(status.unlockRequired);
    },
  });
}
