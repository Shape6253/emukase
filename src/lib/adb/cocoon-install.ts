import { readAndroidUser, userScopedDevice } from "./android-user";
import { selectAbi } from "./catalog";
import { COCOON_PACKAGE } from "./cocoon-navigation";
import type { CocoonSetupOptions } from "./cocoon-types";
import { getObtainiumTrackedApps } from "./obtainium-catalog";
import { installApplicationViaObtainium } from "./obtainium-install";
import { shellCommand, type DeviceTransport } from "./transport";

/** Install Cocoon through Obtainium, registering its official source when necessary. */
export async function installCocoon(
  device: DeviceTransport, options: CocoonSetupOptions & { importSource?: boolean } = {},
): Promise<string> {
  const user = await readAndroidUser(device, options.signal);
  const scoped = userScopedDevice(device, user, options.signal);
  const sdkText = (await scoped.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
  const sdk = Number(sdkText);
  if (!/^[1-9]\d*$/.test(sdkText) || !Number.isSafeInteger(sdk) || sdk < 24) {
    throw new Error("Cocoon requires a confirmed Android 7 or newer device.");
  }
  if (sdk < 26) throw new Error("Automatic Cocoon installation requires Android 8 or newer for native UI inspection.");
  const abi = selectAbi((await scoped.shell(shellCommand("getprop", "ro.product.cpu.abilist"))).trim().split(","));
  const app = getObtainiumTrackedApps(abi, { sdk }).find((entry) => entry.id === COCOON_PACKAGE);
  if (!app) throw new Error("Cocoon's official update source does not support this Android device.");
  return installApplicationViaObtainium(scoped, app, {
    signal: options.signal, log: options.log, importSource: options.importSource ?? true,
    reportStatus(message, status) {
      options.onStatus?.(message);
      if (status?.unlockRequired !== undefined) options.onUnlockRequired?.(status.unlockRequired);
    },
  });
}
