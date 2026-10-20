import { readAndroidPackage } from "./android-package";
import { withAndroidUiDump } from "./android-ui-dump";
import { androidUserProcessPid, primaryStorageForUser, readAndroidUser, userScopedDevice } from "./android-user";
import { withAwakeDevice } from "./device-awake";
import { keepDeviceAwake } from "./device-keep-awake";
import { waitEmulatorUi } from "./emulator-ui";
import { prepareEsdeAppMenu } from "./esde-app-menu";
import { planEsdeConfigFiles } from "./esde-config-files";
import { assertEsdeSystemLanguage, withEsdeDefaults } from "./esde-defaults";
import { ensureEsdeStorageAccess, readEsdeHome, resolveEsdeLauncher } from "./esde-environment";
import { applyEsdeFile, ensureEsdeDirectory, readEsdeText } from "./esde-files";
import { esdeLibraryProfile } from "./esde-library";
import { completeEsdeOnboarding, esdeWizardActions } from "./esde-onboarding";
import { readEsdeProfile, validateEsdeProfile } from "./esde-profile";
import type { EsdeConfigurationProfile } from "./esde-profile";
import { removeEmptyEsdeRootDirectory } from "./esde-root-directory";
import { esdeStartupState, launchEsde, stopEsde, verifyEsdeStartup } from "./esde-runtime";
import type { EsdeStartup } from "./esde-runtime";
import { verifyEsdeThemeSelection } from "./esde-theme";
import { ESDE_PACKAGE } from "./esde-types";
import type { EsdeConfigurationOptions, EsdeConfigurationResult, EsdeContext, EsdeFileChange } from "./esde-types";
import { ensureSharedLibraryFolders } from "./library-structure";
import { shellCommand } from "./transport";
import type { DeviceTransport } from "./transport";
import { workspacePaths } from "./workspace";

export { readEsdeProfile } from "./esde-profile";
export type { EsdeConfigurationProfile } from "./esde-profile";
export type { EsdeConfigurationOptions, EsdeConfigurationResult, EsdeRecoveryRecord } from "./esde-types";

const active = new WeakSet<DeviceTransport>();

async function runEsde<T>(
  device: DeviceTransport, options: EsdeConfigurationOptions,
  action: (context: EsdeContext) => Promise<T>,
): Promise<T> {
  const connection = device.restorationDevice ?? device;
  if (active.has(connection)) throw new Error("ES-DE configuration is already running on this connection.");
  for (const value of [options.createAppMenu, options.controllerNavigationVerified, options.connectLibrary]) {
    if (value !== undefined && typeof value !== "boolean") throw new Error("Invalid ES-DE configuration option.");
  }
  active.add(connection);
  try {
    options.signal?.throwIfAborted();
    const user = await readAndroidUser(device, options.signal);
    const scoped = userScopedDevice(device, user, options.signal);
    const installed = await readAndroidPackage(scoped, ESDE_PACKAGE, user, options.signal);
    if (!installed) throw new Error("Install your licensed ES-DE APK before configuring it.");
    const sdk = (await scoped.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
    if (!/^\d+$/.test(sdk) || !Number.isSafeInteger(Number(sdk)) || Number(sdk) < 29) {
      throw new Error("ES-DE configuration requires Android 10 or newer.");
    }
    const workspace = workspacePaths(primaryStorageForUser(user), options.folders);
    const launcher = await resolveEsdeLauncher({ device: scoped, user });
    const home = await readEsdeHome({ device: scoped, user });
    const lease = await keepDeviceAwake(scoped, user, { signal: options.signal });
    try {
      return await withAwakeDevice(scoped, user, { signal: options.signal, onUnlockRequired: options.onUnlockRequired }, (ensureUnlocked) =>
        withAndroidUiDump(scoped, options.signal, async () => {
          const context: EsdeContext = { device: scoped, user, signal: options.signal, ensureUnlocked,
            installed, sdk: Number(sdk), workspace, launcher, home, options };
          const result = await action(context);
          const current = await readAndroidPackage(scoped, ESDE_PACKAGE, user, options.signal);
          // Only detect an update during this operation; no release is allowlisted.
          if (!current || current.version !== installed.version) throw new Error("ES-DE was updated during configuration; inspect it again before retrying.");
          if (await readEsdeHome(context) !== home) throw new Error("Android's HOME changed during ES-DE configuration.");
          return result;
        }));
    } finally {
      await lease.release();
    }
  } finally {
    active.delete(connection);
  }
}

function result(context: EsdeContext, startup: EsdeStartup, changes: readonly EsdeFileChange[], menu: readonly string[] = []): EsdeConfigurationResult {
  assertEsdeSystemLanguage(startup.settings);
  verifyEsdeThemeSelection({ settings: startup.settings }, startup.log, startup.library);
  return { packageName: ESDE_PACKAGE, version: context.installed.version, dataDirectory: context.workspace.esde,
    romDirectory: context.workspace.roms, onboarding: "complete", directoryAccess: "persisted-read-write",
    settings: "verified-after-restart", library: startup.library, homeChanged: false,
    changedFiles: [...menu, ...changes.map((change) => change.path)],
    backups: changes.flatMap((change) => change.backupPath ? [change.backupPath] : []), gameplayVerified: false };
}

/** Configure an installed ES-DE using native files. Only initial onboarding and
 * genuine app-owned tree grants use UI; existing settings are never reselected. */
export async function configureEsde(
  device: DeviceTransport, input: EsdeConfigurationProfile | Blob | string = {}, options: EsdeConfigurationOptions = {},
): Promise<EsdeConfigurationResult> {
  const imported = typeof input === "string" || input instanceof Blob ? await readEsdeProfile(input) : structuredClone(input);
  validateEsdeProfile(imported);
  const profile = withEsdeDefaults(imported);
  return runEsde(device, options, async (context) => {
    options.onStatus?.("Preparing ES-DE's shared library…");
    for (const path of [context.workspace.root, context.workspace.roms, context.workspace.esde]) await ensureEsdeDirectory(context, path);
    await ensureSharedLibraryFolders(context.device, context.signal, options.onStatus, options.folders);
    await ensureEsdeStorageAccess(context);
    if (await androidUserProcessPid(context.device, ESDE_PACKAGE, context.user, context.signal)) await stopEsde(context);
    const menu = options.createAppMenu === false ? { paths: [], created: [] } : await prepareEsdeAppMenu(context);
    let launch = await launchEsde(context);
    const onboarding = await waitEmulatorUi(context, async (snapshot) => {
      if (!snapshot.component.startsWith(`${ESDE_PACKAGE}/`)) return undefined;
      if (esdeWizardActions(snapshot, "welcome")) return true;
      const log = await readEsdeText(context, `${context.workspace.esde}/logs/es_log.txt`);
      if (log !== undefined && log !== launch.previousLog && esdeStartupState(log)) return false;
      return undefined;
    }, 60_000);
    if (onboarding) {
      await completeEsdeOnboarding(context);
      launch = await launchEsde(context);
    }
    let startup = await verifyEsdeStartup(context, launch);
    await removeEmptyEsdeRootDirectory(context);
    options.onStatus?.("Checking the imported ES-DE profile against this installation…");
    const desired = options.connectLibrary ? await esdeLibraryProfile(context, profile) : profile;
    let changes = await planEsdeConfigFiles(context, desired, startup.log);
    if (changes.length) {
      await stopEsde(context);
      // onStop may save app-owned preferences. Plan again from those final bytes
      // before taking backups or replacing anything.
      changes = await planEsdeConfigFiles(context, desired, startup.log);
      options.onStatus?.("Importing ES-DE configuration files…");
      for (const change of changes) await applyEsdeFile(context, change);
      options.onStatus?.("Restarting ES-DE and verifying the imported settings…");
      startup = await verifyEsdeStartup(context, await launchEsde(context));
      if ((await planEsdeConfigFiles(context, desired, startup.log)).length) {
        throw new Error("ES-DE did not retain the imported profile after restart. Verified original backups are available.");
      }
    }
    if (menu.paths.length && startup.library !== "loaded") throw new Error("ES-DE did not load the native-app menu; the no-games state was not reported as ready.");
    verifyEsdeThemeSelection(profile, startup.log, startup.library);
    options.onStatus?.("ES-DE configuration verified. Game launching and physical controls require separate verification.");
    return result(context, startup, changes, menu.created);
  });
}

/** Recheck app-generated files and grants after a fresh launch, without
 * granting permissions, rerunning onboarding or applying a profile. */
export async function verifyEsde(device: DeviceTransport, options: EsdeConfigurationOptions = {}): Promise<EsdeConfigurationResult> {
  return runEsde(device, options, async (context) => {
    options.onStatus?.("Restarting ES-DE and checking its saved configuration…");
    const startup = await verifyEsdeStartup(context, await launchEsde(context));
    if (options.connectLibrary && (await planEsdeConfigFiles(context, await esdeLibraryProfile(context, {}), startup.log)).length) {
      throw new Error("ES-DE's saved Library emulator selections could not be confirmed after restarting.");
    }
    return result(context, startup, []);
  });
}
