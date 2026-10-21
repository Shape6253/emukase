import { installedAndroidPackages, readAndroidPackage } from "./android-package";
import { withAndroidUiDump } from "./android-ui-dump";
import { primaryStorageForUser, readAndroidUser, userScopedDevice } from "./android-user";
import { selectAbi } from "./catalog";
import { cocoonRootConnected, inspectCocoonPlatform } from "./cocoon-library";
import { installCocoon } from "./cocoon-install";
import { isCocoon, launchCocoon, openCocoonSettings, readCocoonLabels, restartCocoon, waitCocoonUi,
  COCOON_ONBOARDING_ACTIVITY, COCOON_PACKAGE, type CocoonUiContext } from "./cocoon-navigation";
import { finishCocoonOnboarding } from "./cocoon-onboarding";
import { prepareCocoonProfilePlayers } from "./cocoon-player-import";
import { cocoonPlatformPlans, validateCocoonPlatformIds, type CocoonPlatformPlan } from "./cocoon-platforms";
import { cocoonPhysicalDisplayCount, inspectCocoonSystem } from "./cocoon-system";
import type { CocoonConfigurationResult, CocoonPlatformConfiguration, CocoonSetupOptions } from "./cocoon-types";
import { withAwakeDevice } from "./device-awake";
import { keepDeviceAwake } from "./device-keep-awake";
import { retroArchPackageName } from "./emulators";
import { createMediaStoreFolders } from "./media-store";
import { shellCommand, type DeviceTransport } from "./transport";
import { workspacePaths } from "./workspace";

export { installCocoon } from "./cocoon-install";
export type { CocoonConfigurationResult, CocoonPlatformConfiguration, CocoonSetupOptions, CocoonSystemConfiguration } from "./cocoon-types";

async function inspectLibrary(
  context: CocoonUiContext, plans: readonly CocoonPlatformPlan[], packages: ReadonlySet<string>,
  options: CocoonSetupOptions, configure: boolean,
): Promise<Omit<CocoonConfigurationResult, "system">> {
  const paths = workspacePaths(primaryStorageForUser(context.user), options.folders);
  options.onStatus?.(`${configure ? "Connecting" : "Checking"} Cocoon's shared ROM folder…`);
  const root = await cocoonRootConnected(context, paths.roms, configure);
  const platforms: CocoonPlatformConfiguration[] = [];
  for (const plan of plans) {
    context.signal?.throwIfAborted();
    options.onStatus?.(`${configure ? "Configuring" : "Checking"} Cocoon: ${plan.name}…`);
    platforms.push(await inspectCocoonPlatform(context, plan, `${paths.roms}/${plan.platformId}`,
      packages.has(plan.emulatorPackage), configure, root !== "missing"));
  }
  return { setupComplete: true, defaultGamesFolder: root, library: platforms.length > 0 && platforms.every((platform) => platform.state === "accepted")
    ? "accepted" : "missing", romDirectory: paths.roms, platforms };
}

async function runCocoon(device: DeviceTransport, options: CocoonSetupOptions, configure: boolean): Promise<CocoonConfigurationResult> {
  options.signal?.throwIfAborted();
  const user = await readAndroidUser(device, options.signal);
  const scoped = userScopedDevice(device, user, options.signal);
  const sdk = (await scoped.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
  if (!/^[1-9]\d*$/.test(sdk) || !Number.isSafeInteger(Number(sdk)) || Number(sdk) < 26) {
    throw new Error("Automatic Cocoon configuration requires a confirmed Android 8 or newer device.");
  }
  const abi = selectAbi((await scoped.shell(shellCommand("getprop", "ro.product.cpu.abilist"))).trim().split(","));
  const info = await readAndroidPackage(scoped, COCOON_PACKAGE, user, options.signal);
  if (!info) throw new Error("Install Cocoon before configuring its library.");
  const packages = await installedAndroidPackages(scoped, user, options.signal);
  const retroarchAbi = !packages.has(retroArchPackageName(abi)) && packages.has("com.retroarch.ra32")
    ? (abi === "x86_64" ? "x86" : "armeabi-v7a") : abi;
  let plans: readonly CocoonPlatformPlan[] = cocoonPlatformPlans(retroarchAbi, options.platformIds)
    .filter((plan) => options.platformIds !== undefined || packages.has(plan.emulatorPackage));
  if (!plans.length) throw new Error("Install a supported Library emulator before configuring Cocoon.");
  const paths = workspacePaths(primaryStorageForUser(user), options.folders);
  const physicalDisplays = cocoonPhysicalDisplayCount(await scoped.shell(shellCommand("dumpsys", "display")));
  const lease = await keepDeviceAwake(scoped, user, { signal: options.signal, log: options.log });
  try {
    return await withAwakeDevice(scoped, user, { signal: options.signal, onUnlockRequired: options.onUnlockRequired }, (ensureUnlocked) =>
      withAndroidUiDump(scoped, options.signal, async () => {
        const base = { device: scoped, user, sdk: Number(sdk), signal: options.signal, ensureUnlocked };
        options.onStatus?.("Opening Cocoon's library settings…");
        let changed = false;
        const context: CocoonUiContext = { ...base, labels: await readCocoonLabels(base), onMutation: () => { changed = true; } };
        if (!configure) await restartCocoon(context);
        let snapshot = await waitCocoonUi(context, (value) => value);
        if (!isCocoon(snapshot)) snapshot = await launchCocoon(context);
        // Inspect saved settings once on a repeat run. A second restart and
        // inspection is needed only after changing Cocoon's configuration.
        if (configure && snapshot.component !== COCOON_ONBOARDING_ACTIVITY) {
          await restartCocoon(context);
          snapshot = await launchCocoon(context);
        }
        if (configure) {
          await createMediaStoreFolders(scoped, user, [`${paths.root}/Cocoon`, paths.roms,
            ...plans.filter((plan) => packages.has(plan.emulatorPackage)).map((plan) => `${paths.roms}/${plan.platformId}`)], options.signal);
          if (snapshot.component === COCOON_ONBOARDING_ACTIVITY) changed = true;
          snapshot = await finishCocoonOnboarding(context, `${paths.root}/Cocoon`, paths.roms, options, snapshot);
        } else if (snapshot.component === COCOON_ONBOARDING_ACTIVITY) {
          return { setupComplete: false, system: { language: "unverified", screenMode: "unverified", physicalDisplays, singleScreen: null },
            defaultGamesFolder: "unverified", library: "missing", romDirectory: paths.roms, platforms: plans.map((plan) => ({
            platformId: plan.platformId, emulatorPackage: plan.emulatorPackage, coreId: plan.coreId, playerId: plan.playerId,
            romDirectory: `${paths.roms}/${plan.platformId}`, state: "unverified", folder: "unverified", player: "unverified",
          })) };
        }
        await openCocoonSettings(context, snapshot);
        plans = await prepareCocoonProfilePlayers(context, plans, packages, `${paths.root}/Cocoon`, configure, options.onStatus);
        options.onStatus?.("Checking Cocoon's system language and physical screens…");
        const system = await inspectCocoonSystem(context, physicalDisplays, configure);
        const result = { ...await inspectLibrary(context, plans, packages, options, configure), system };
        if (!configure || !changed) return result;
        options.onStatus?.("Restarting Cocoon and checking its saved library settings…");
        await restartCocoon(context);
        const restarted = await launchCocoon(context);
        if (restarted.component === COCOON_ONBOARDING_ACTIVITY) throw new Error("Cocoon did not retain its initial setup.");
        await openCocoonSettings(context, restarted);
        const savedSystem = await inspectCocoonSystem(context, physicalDisplays, false);
        if (savedSystem.language !== "accepted" || savedSystem.screenMode !== "accepted") {
          throw new Error("Cocoon did not retain its system language and physical-screen configuration after restarting.");
        }
        const verified = { ...await inspectLibrary(context, plans, await installedAndroidPackages(scoped, user, options.signal), options, false), system: savedSystem };
        if (verified.defaultGamesFolder === "missing") {
          throw new Error("Cocoon did not retain access to its shared ROM folder after restarting.");
        }
        const failed = verified.platforms.filter((platform) => packages.has(platform.emulatorPackage) && platform.state !== "accepted");
        if (failed.length) {
          throw new Error(`Cocoon's saved ROM folders and default players could not be confirmed for: ${failed.map((platform) =>
            `${platform.platformId} (folder: ${platform.folder}, player: ${platform.player})`).join(", ")}.`);
        }
        return verified;
      }));
  } finally { await lease.release(); }
}

/** Configure existing emulators; preserves unrelated platforms, folders and game data. */
export async function configureCocoon(device: DeviceTransport, options: CocoonSetupOptions = {}): Promise<CocoonConfigurationResult> {
  return runCocoon(device, options, true);
}

/** Inspect the saved setup after restarting, without changing folder/player choices. */
export async function verifyCocoon(device: DeviceTransport, options: CocoonSetupOptions = {}): Promise<CocoonConfigurationResult> {
  return runCocoon(device, options, false);
}

export async function setupCocoon(device: DeviceTransport, options: CocoonSetupOptions = {}): Promise<CocoonConfigurationResult> {
  validateCocoonPlatformIds(options.platformIds);
  const user = await readAndroidUser(device, options.signal);
  const scoped = userScopedDevice(device, user, options.signal);
  workspacePaths(primaryStorageForUser(user), options.folders);
  await installCocoon(scoped, options);
  return configureCocoon(scoped, options);
}
