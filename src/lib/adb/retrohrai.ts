import { hasAndroidTreeReadGrant } from "./android-document-picker";
import { readAndroidPackage } from "./android-package";
import { withAndroidUiDump } from "./android-ui-dump";
import { primaryStorageForUser, readAndroidUser, userScopedDevice } from "./android-user";
import { selectAbi } from "./catalog";
import { withAwakeDevice } from "./device-awake";
import { keepDeviceAwake } from "./device-keep-awake";
import { retroArchPackageName } from "./emulators";
import { ensureSharedLibraryFolders } from "./library-structure";
import { createMediaStoreFolders } from "./media-store";
import { exportRetroHraiProfile, importRetroHraiProfile } from "./retrohrai-backup";
import { installRetroHrai } from "./retrohrai-install";
import { launchRetroHrai, readRetroHraiLabels, restartRetroHrai, type RetroHraiContext } from "./retrohrai-navigation";
import { finishRetroHraiOnboarding, retroHraiOnboarding } from "./retrohrai-onboarding";
import { readRetroHraiPlatformPlans, validateRetroHraiPlatformIds, type RetroHraiPlatformPlan } from "./retrohrai-platforms";
import { assertRetroHraiPreserved, createRetroHraiProfile, retroHraiPlayerSaved, type RetroHraiSavedProfile } from "./retrohrai-profile";
import { connectRetroHraiRoot, detectRetroHraiSystems, ensureRetroHraiArtwork, retroHraiTreeUri } from "./retrohrai-storage";
import { RETROHRAI_PACKAGE } from "./retrohrai-types";
import type { RetroHraiConfigurationResult, RetroHraiSetupOptions } from "./retrohrai-types";
import { shellCommand, type DeviceTransport } from "./transport";
import { workspacePaths } from "./workspace";

export { installRetroHrai } from "./retrohrai-install";
export { readRetroHraiProfile } from "./retrohrai-profile";
export type { RetroHraiSavedProfile } from "./retrohrai-profile";
export type { RetroHraiConfigurationResult, RetroHraiPlatformConfiguration, RetroHraiSetupOptions } from "./retrohrai-types";

const active = new WeakSet<DeviceTransport>();

async function installedPackages(device: DeviceTransport, user: number): Promise<ReadonlySet<string>> {
  const output = await device.shell(shellCommand("pm", "list", "packages", "--user", String(user)));
  const lines = output.trim().split(/\r?\n/);
  if (output.length > 2_097_152 || !lines.length || lines.some((line) => !/^package:[A-Za-z][\w]*(?:\.[\w]+)*$/.test(line))) {
    throw new Error("Android's installed emulator packages could not be confirmed.");
  }
  return new Set(lines.map((line) => line.slice("package:".length)));
}

async function readHome(device: DeviceTransport, user: number): Promise<string> {
  const output = await device.shell(shellCommand("cmd", "package", "resolve-activity", "--brief", "--user", String(user),
    "-a", "android.intent.action.MAIN", "-c", "android.intent.category.HOME"));
  const components = output.trim().split(/\r?\n/).filter((line) => /^[\w.]+\/[\w.$]+$/.test(line));
  if (components.length !== 1 || !components[0]) throw new Error("Android's current HOME could not be confirmed.");
  return components[0];
}

async function runRetroHrai(device: DeviceTransport, options: RetroHraiSetupOptions, configure: boolean): Promise<RetroHraiConfigurationResult> {
  validateRetroHraiPlatformIds(options.platformIds);
  options = { ...options, folders: options.folders ? { ...options.folders } : undefined,
    platformIds: options.platformIds ? [...options.platformIds] : undefined };
  const connection = device.restorationDevice ?? device;
  if (active.has(connection)) throw new Error("RetroHrai setup is already running on this connection.");
  active.add(connection);
  try {
    options.signal?.throwIfAborted();
    const user = await readAndroidUser(device, options.signal);
    const scoped = userScopedDevice(device, user, options.signal);
    const paths = workspacePaths(primaryStorageForUser(user), options.folders);
    const sdkText = (await scoped.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
    const sdk = Number(sdkText);
    if (!/^[1-9]\d*$/.test(sdkText) || !Number.isSafeInteger(sdk) || sdk < 26) throw new Error("Automatic RetroHrai setup requires a confirmed Android 8 or newer device.");
    const installed = await readAndroidPackage(scoped, RETROHRAI_PACKAGE, user, options.signal);
    if (!installed) throw new Error("Install RetroHrai before configuring its library.");
    const packages = await installedPackages(scoped, user);
    const abi = selectAbi((await scoped.shell(shellCommand("getprop", "ro.product.cpu.abilist"))).trim().split(","));
    const retroarchAbi = !packages.has(retroArchPackageName(abi)) && packages.has("com.retroarch.ra32")
      ? (abi === "x86_64" ? "x86" : "armeabi-v7a") : abi;
    const plans = await readRetroHraiPlatformPlans(scoped, user, retroarchAbi, packages, options.platformIds);
    if (!plans.length || !plans.some((plan) => packages.has(plan.emulatorPackage))) throw new Error("Install a supported Library emulator before configuring RetroHrai.");
    if (user !== 0 && plans.some((plan) => plan.coreId && packages.has(plan.emulatorPackage))) {
      throw new Error("RetroHrai's bundled RetroArch players hardcode owner-profile config paths; automatic setup currently requires the owner profile.");
    }
    const home = await readHome(scoped, user);
    const lease = await keepDeviceAwake(scoped, user, { signal: options.signal, log: options.log });
    try {
      return await withAwakeDevice(scoped, user, { signal: options.signal, onUnlockRequired: options.onUnlockRequired }, (ensureUnlocked) =>
        withAndroidUiDump(scoped, options.signal, async () => {
          const base = { device: scoped, user, signal: options.signal, ensureUnlocked };
          const context: RetroHraiContext = { ...base, sdk, labels: await readRetroHraiLabels(base) };
          const fallback = `${paths.root}/RetroHrai`;
          const result = async (profile: RetroHraiSavedProfile | undefined, dataDirectory: string, profilePath?: string, backupPath?: string): Promise<RetroHraiConfigurationResult> => {
            const current = await readAndroidPackage(scoped, RETROHRAI_PACKAGE, user, options.signal);
            if (!current || current.version !== installed.version || profile && profile.version !== installed.version) throw new Error("RetroHrai changed during setup; inspect it again before retrying.");
            if (await readHome(scoped, user) !== home) throw new Error("Android's HOME changed during RetroHrai setup.");
            const currentPackages = await installedPackages(scoped, user);
            const root = !!profile?.romRoots.includes(retroHraiTreeUri(user, paths.roms)) && await hasAndroidTreeReadGrant(context, RETROHRAI_PACKAGE, paths.roms);
            const artwork = profile?.artworkUri === retroHraiTreeUri(user, dataDirectory)
              && await hasAndroidTreeReadGrant(context, RETROHRAI_PACKAGE, dataDirectory, true);
            const platforms = plans.map((plan) => {
              const player = !currentPackages.has(plan.emulatorPackage) ? "missing" : profile ? retroHraiPlayerSaved(profile, plan) ? "accepted" : "missing" : "unverified";
              return { platformId: plan.platformId, emulatorPackage: plan.emulatorPackage, coreId: plan.coreId, playerId: plan.playerId,
                romDirectory: `${paths.roms}/${plan.platformId}`, state: player, player } as const;
            });
            return { packageName: RETROHRAI_PACKAGE, version: installed.version, setupComplete: !!profile,
              dataDirectory, romDirectory: paths.roms, artworkFolder: artwork ? "accepted" : profile ? "missing" : "unverified",
              defaultGamesFolder: root ? "accepted" : profile ? "missing" : "unverified",
              library: root && artwork && platforms.every((platform) => platform.state === "accepted") ? "accepted" : "missing",
              platforms, platformFolders: "not-exported", homeChanged: false, gameplayVerified: false, profilePath, backupPath };
          };
          if (configure) {
            options.onStatus?.("Preparing RetroHrai's shared library…");
            await ensureSharedLibraryFolders(scoped, options.signal, options.log, options.folders);
            if (sdk < 29) await scoped.shell(shellCommand("mkdir", "-p", fallback));
            else await createMediaStoreFolders(scoped, user, [fallback], options.signal);
          }
          await restartRetroHrai(context);
          let snapshot = await launchRetroHrai(context);
          if (!configure && retroHraiOnboarding(context, snapshot)) return result(undefined, fallback);
          if (configure && retroHraiOnboarding(context, snapshot)) {
            snapshot = await finishRetroHraiOnboarding(context, fallback, paths.roms, options, snapshot);
          }
          const directory = await ensureRetroHraiArtwork(context, fallback, configure);
          options.onStatus?.("Exporting RetroHrai's saved configuration…");
          let saved = await exportRetroHraiProfile(context, directory);
          if (saved.profile.version !== installed.version) throw new Error("RetroHrai changed during setup; inspect it again before retrying.");
          if (configure && (!saved.profile.romRoots.includes(retroHraiTreeUri(user, paths.roms))
            || !await hasAndroidTreeReadGrant(context, RETROHRAI_PACKAGE, paths.roms))) {
            options.onStatus?.("Connecting RetroHrai's shared ROM folder…");
            await connectRetroHraiRoot(context, paths.roms);
            saved = await exportRetroHraiProfile(context, directory);
            if (!saved.profile.romRoots.includes(retroHraiTreeUri(user, paths.roms)) || !await hasAndroidTreeReadGrant(context, RETROHRAI_PACKAGE, paths.roms)) {
              throw new Error("RetroHrai did not retain the shared ROM root and its Android folder access.");
            }
          }
          const installedPlans = plans.filter((plan) => packages.has(plan.emulatorPackage));
          const missingSystems = (profile: RetroHraiSavedProfile): readonly RetroHraiPlatformPlan[] => installedPlans.filter((plan) =>
            !profile.platforms.some((platform) => platform.internalName === plan.platformKey));
          if (configure && missingSystems(saved.profile).length) {
            options.onStatus?.("Adding RetroHrai systems using its native Select all action…");
            await detectRetroHraiSystems(context);
            saved = await exportRetroHraiProfile(context, directory);
            if (missingSystems(saved.profile).length) throw new Error("RetroHrai did not detect all requested Library systems in the shared ROM folder.");
          }
          const changes = configure ? installedPlans.filter((plan) => !retroHraiPlayerSaved(saved.profile, plan)) : [];
          let profilePath: string | undefined;
          if (changes.length) {
            const current = await readAndroidPackage(scoped, RETROHRAI_PACKAGE, user, options.signal);
            if (!current || current.version !== installed.version) throw new Error("RetroHrai changed before import; inspect it again before retrying.");
            options.onStatus?.(`Importing one RetroHrai profile for ${changes.length} emulator selections…`);
            profilePath = await importRetroHraiProfile(context, paths.setup, createRetroHraiProfile(saved.profile, changes));
            const applied = await exportRetroHraiProfile(context, directory);
            assertRetroHraiPreserved(saved.profile, applied.profile, changes);
            if (changes.some((plan) => !retroHraiPlayerSaved(applied.profile, plan))) throw new Error("RetroHrai did not retain the imported emulator selections. The original backup has been kept.");
          }
          if (!configure) return result(saved.profile, directory);
          options.onStatus?.("Restarting RetroHrai and verifying its saved profile…");
          await restartRetroHrai(context);
          snapshot = await launchRetroHrai(context);
          if (retroHraiOnboarding(context, snapshot)) throw new Error("RetroHrai did not retain its initial setup after restarting.");
          if (await ensureRetroHraiArtwork(context, fallback, false) !== directory) throw new Error("RetroHrai changed its artwork folder after restarting.");
          const verified = await exportRetroHraiProfile(context, directory);
          if (installedPlans.some((plan) => !retroHraiPlayerSaved(verified.profile, plan))) throw new Error("RetroHrai did not retain its default emulators after restarting.");
          const verifiedResult = await result(verified.profile, directory, profilePath, profilePath ? saved.path : undefined);
          if (verifiedResult.defaultGamesFolder !== "accepted") throw new Error("RetroHrai did not retain the shared ROM root after restarting.");
          if (verifiedResult.artworkFolder !== "accepted") throw new Error("RetroHrai did not retain the artwork folder and its write access after restarting.");
          if (verifiedResult.platforms.some((platform) => packages.has(platform.emulatorPackage) && platform.state !== "accepted")) {
            throw new Error("A Library emulator was removed or changed during RetroHrai setup; inspect it again before retrying.");
          }
          options.onStatus?.("RetroHrai's ROM root, artwork access and default emulators are verified after restart.");
          return verifiedResult;
        }));
    } finally { await lease.release(); }
  } finally { active.delete(connection); }
}

/** Configure native storage and import every emulator choice through one .retrobackup file. */
export async function configureRetroHrai(device: DeviceTransport, options: RetroHraiSetupOptions = {}): Promise<RetroHraiConfigurationResult> {
  return runRetroHrai(device, options, true);
}

/** Restart and inspect a fresh native export without changing the saved selections. */
export async function verifyRetroHrai(device: DeviceTransport, options: RetroHraiSetupOptions = {}): Promise<RetroHraiConfigurationResult> {
  return runRetroHrai(device, options, false);
}

export async function setupRetroHrai(device: DeviceTransport, options: RetroHraiSetupOptions = {}): Promise<RetroHraiConfigurationResult> {
  validateRetroHraiPlatformIds(options.platformIds);
  const user = await readAndroidUser(device, options.signal);
  const scoped = userScopedDevice(device, user, options.signal);
  workspacePaths(primaryStorageForUser(user), options.folders);
  await installRetroHrai(scoped, options);
  return configureRetroHrai(scoped, options);
}
