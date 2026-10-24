import { readAndroidPackage } from "./android-package";
import { withAndroidUiDump } from "./android-ui-dump";
import { primaryStorageForUser, readAndroidUser, userScopedDevice } from "./android-user";
import { cocoonRootConnected } from "./cocoon-library";
import { installCocoon } from "./cocoon-install";
import { isCocoon, launchCocoon, openCocoonSettings, readCocoonLabels, restartCocoon, waitCocoonUi,
  COCOON_ONBOARDING_ACTIVITY, COCOON_PACKAGE, type CocoonUiContext } from "./cocoon-navigation";
import { finishCocoonOnboarding } from "./cocoon-onboarding";
import { cocoonPhysicalDisplayCount, inspectCocoonSystem } from "./cocoon-system";
import type { CocoonConfigurationResult, CocoonSetupOptions } from "./cocoon-types";
import { withAwakeDevice } from "./device-awake";
import { keepDeviceAwake } from "./device-keep-awake";
import { createMediaStoreFolders } from "./media-store";
import { shellCommand, type DeviceTransport } from "./transport";
import { workspacePaths } from "./workspace";

export { installCocoon } from "./cocoon-install";
export type { CocoonConfigurationResult, CocoonSetupOptions, CocoonSystemConfiguration } from "./cocoon-types";

async function inspectLibrary(
  context: CocoonUiContext, options: CocoonSetupOptions, configure: boolean,
): Promise<Omit<CocoonConfigurationResult, "system">> {
  const paths = workspacePaths(primaryStorageForUser(context.user), options.folders);
  options.onStatus?.(`${configure ? "Connecting" : "Checking"} Cocoon's shared ROM folder…`);
  const root = await cocoonRootConnected(context, paths.roms, configure);
  return { setupComplete: true, defaultGamesFolder: root, library: root, romDirectory: paths.roms };
}

async function runCocoon(device: DeviceTransport, options: CocoonSetupOptions, configure: boolean): Promise<CocoonConfigurationResult> {
  options.signal?.throwIfAborted();
  const user = await readAndroidUser(device, options.signal);
  const scoped = userScopedDevice(device, user, options.signal);
  const sdk = (await scoped.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
  if (!/^[1-9]\d*$/.test(sdk) || !Number.isSafeInteger(Number(sdk)) || Number(sdk) < 26) {
    throw new Error("Automatic Cocoon configuration requires a confirmed Android 8 or newer device.");
  }
  const info = await readAndroidPackage(scoped, COCOON_PACKAGE, user, options.signal);
  if (!info) throw new Error("Install Cocoon before configuring its library.");
  const paths = workspacePaths(primaryStorageForUser(user), options.folders);
  const physicalDisplays = cocoonPhysicalDisplayCount(await scoped.shell(shellCommand("dumpsys", "display")));
  const lease = await keepDeviceAwake(scoped, user, { signal: options.signal, log: options.log });
  try {
    return await withAwakeDevice(scoped, user, { signal: options.signal, onUnlockRequired: options.onUnlockRequired }, (ensureUnlocked) =>
      withAndroidUiDump(scoped, options.signal, async () => {
        const base = { device: scoped, user, signal: options.signal, ensureUnlocked };
        options.onStatus?.("Opening Cocoon's library settings…");
        const context: CocoonUiContext = { ...base, labels: await readCocoonLabels(base) };
        if (!configure) await restartCocoon(context);
        let snapshot = await waitCocoonUi(context, (value) => value);
        if (!isCocoon(snapshot)) snapshot = await launchCocoon(context);
        if (configure) {
          await createMediaStoreFolders(scoped, user, [`${paths.root}/Cocoon`, paths.roms], options.signal);
          snapshot = await finishCocoonOnboarding(context, `${paths.root}/Cocoon`, paths.roms, options, snapshot);
        } else if (snapshot.component === COCOON_ONBOARDING_ACTIVITY) {
          return { setupComplete: false, system: { language: "unverified", screenMode: "unverified", physicalDisplays, singleScreen: null },
            defaultGamesFolder: "unverified", library: "missing", romDirectory: paths.roms };
        }
        await openCocoonSettings(context, snapshot);
        options.onStatus?.("Checking Cocoon's system language and physical screens…");
        const system = await inspectCocoonSystem(context, physicalDisplays, configure);
        const result = { ...await inspectLibrary(context, options, configure), system };
        if (!configure) return result;
        if (result.defaultGamesFolder === "missing") {
          throw new Error("Cocoon did not retain access to its shared ROM folder.");
        }
        return result;
      }));
  } finally { await lease.release(); }
}

/** Configure shared storage and system settings, preserving native platform discovery. */
export async function configureCocoon(device: DeviceTransport, options: CocoonSetupOptions = {}): Promise<CocoonConfigurationResult> {
  return runCocoon(device, options, true);
}

/** Inspect shared storage and system settings after restarting. */
export async function verifyCocoon(device: DeviceTransport, options: CocoonSetupOptions = {}): Promise<CocoonConfigurationResult> {
  return runCocoon(device, options, false);
}

export async function setupCocoon(device: DeviceTransport, options: CocoonSetupOptions = {}): Promise<CocoonConfigurationResult> {
  const user = await readAndroidUser(device, options.signal);
  const scoped = userScopedDevice(device, user, options.signal);
  workspacePaths(primaryStorageForUser(user), options.folders);
  await installCocoon(scoped, options);
  return configureCocoon(scoped, options);
}
