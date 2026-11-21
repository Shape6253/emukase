import { readAndroidPackage } from "./android-package";
import { withAndroidUiDump } from "./android-ui-dump";
import { primaryStorageForUser, readAndroidUser, userScopedDevice } from "./android-user";
import { readAndroidSdk } from "./android-version";
import { selectAndroidDocument, hasAndroidTreeReadGrant, readAndroidTreeGrants, type AndroidTreeGrants } from "./android-document-picker";
import type { AndroidUiSnapshot } from "./android-ui";
import { keepDeviceAwake } from "./device-keep-awake";
import { withAwakeDevice } from "./device-awake";
import type { ConfigurationItemState, EmulatorConfigurationOptions } from "./emulator-configuration-types";
import { tapEmulatorNode, uiNode, waitEmulatorUi, type EmulatorUiContext } from "./emulator-ui";
import { findMelonDsDirectory } from "./melonds-device-inputs";
import { validateMelonDsInputs, type MelonDsConsole } from "./melonds-inputs";
import { prepareEmulatorSupport } from "./emulator-support";
import { MELONDS_PACKAGE, melonDsPreference, melonDsSummary, melonDsText, openMelonDsMenu, openMelonDsPreferences, restartMelonDs, tapMelonDsPreference, type MelonDsPreference } from "./melonds-navigation";
import { prepareEmulatorFolders } from "./media-store";
import type { DeviceTransport } from "./transport";
import { workspacePaths } from "./workspace";

export interface MelonDsConfigurationResult {
  /** DS availability, including the built-in BIOS when custom BIOS is disabled. */
  ds: ConfigurationItemState;
  dsBios: ConfigurationItemState;
  dsi: ConfigurationItemState;
  customBios: boolean;
  consoleType: MelonDsConsole;
  library: "accepted" | "unverified";
  contentVerified: boolean;
}

interface NativeDirectory { state: ConfigurationItemState; path?: string }
interface PreparedDirectory { console: MelonDsConsole; directory: string }

async function inspectDirectory(context: EmulatorUiContext, console: MelonDsConsole, observed?: MelonDsPreference, grants?: AndroidTreeGrants): Promise<NativeDirectory> {
  const preference = observed ?? await melonDsPreference(context, console === "DS" ? "bios_directory" : "dsi_bios_directory");
  const summary = melonDsSummary(preference);
  if (!summary || summary === await melonDsText(context, "not_set")) return { state: "missing" };
  // This release hides imageViewStatus only for a VALID native directory result.
  if (preference.children.some((node) => node.resourceId === `${MELONDS_PACKAGE}:id/imageViewStatus`)) return { state: "missing", path: summary };
  const prefix = `${primaryStorageForUser(context.user)}/`;
  if (!summary.startsWith(prefix) || summary.split("/").some((part) => part === "." || part === "..") || /[\x00-\x1f\x7f]/.test(summary)) {
    return { state: "unverified" };
  }
  // The NAND is written by melonDS; a read-only grant is insufficient.
  const granted = grants ? grants.has(summary, true) : await hasAndroidTreeReadGrant(context, MELONDS_PACKAGE, summary, true);
  return { state: granted ? "accepted" : "unverified", path: summary };
}

async function customBiosEnabled(context: EmulatorUiContext, observed?: MelonDsPreference): Promise<boolean> {
  const preference = observed ?? await melonDsPreference(context, "use_custom_bios");
  const switches = preference.children.filter((node) => node.resourceId === "android:id/switch_widget");
  if (switches.length !== 1 || !switches[0]) throw new Error("melonDS's custom BIOS setting could not be read.");
  return switches[0].checked;
}

async function consoleType(context: EmulatorUiContext, observed?: MelonDsPreference): Promise<MelonDsConsole> {
  const value = melonDsSummary(observed ?? await melonDsPreference(context, "console_type"));
  if (value === await melonDsText(context, "console_ds")) return "DS";
  if (value === await melonDsText(context, "console_dsi")) return "DSi";
  throw new Error("melonDS's default system could not be read.");
}

async function inspectLibrary(context: EmulatorUiContext, directory: string, grants?: AndroidTreeGrants): Promise<{ connected: boolean; preference: MelonDsPreference }> {
  const page = await openMelonDsPreferences(context, "roms");
  const preference = await melonDsPreference(context, "rom_search_directory", page);
  const summary = melonDsSummary(preference);
  const connected = summary?.split("\n").includes(directory) === true
    && (grants ? grants.has(directory, true) : await hasAndroidTreeReadGrant(context, MELONDS_PACKAGE, directory, true));
  return { connected, preference };
}

async function verifyNativeNand(context: EmulatorUiContext): Promise<boolean> {
  const [ready, ...errors] = await Promise.all([
    "import_dsiware_title", "dsiware_manager_no_dsi_setup", "dsiware_manager_invalid_dsi_setup", "dsiware_manager_load_error",
  ].map((resource) => melonDsText(context, resource)));
  await openMelonDsMenu(context, "dsiware_manager");
  return waitEmulatorUi(context, (snapshot) => {
    if (snapshot.component !== `${MELONDS_PACKAGE}/${MELONDS_PACKAGE}.ui.dsiwaremanager.DSiWareManagerActivity`) return undefined;
    if (snapshot.nodes.some((node) => errors.includes(node.text))) return false;
    // This control is composed only in Ready, after native openNand/listTitles.
    return snapshot.nodes.some((node) => node.description === ready) ? true : undefined;
  });
}

async function inspectSetup(context: EmulatorUiContext, options: EmulatorConfigurationOptions): Promise<MelonDsConfigurationResult> {
  options.onStatus?.("Checking melonDS's system files and console settings…");
  const [grants] = await Promise.all([
    readAndroidTreeGrants(context, MELONDS_PACKAGE),
    // Resolve independent native labels together rather than adding a shell
    // round trip between each row observed on the same settings page.
    Promise.all(["use_custom_bios", "console_type", "bios_directory", "dsi_bios_directory", "not_set", "console_ds", "console_dsi"]
      .map((resource) => melonDsText(context, resource))),
  ]);
  const page = await openMelonDsPreferences(context, "firmware");
  const custom = await melonDsPreference(context, "use_custom_bios", page);
  const system = await melonDsPreference(context, "console_type", custom.snapshot);
  const dsDirectory = await melonDsPreference(context, "bios_directory", system.snapshot);
  const dsiDirectory = await melonDsPreference(context, "dsi_bios_directory", dsDirectory.snapshot);
  const customBios = await customBiosEnabled(context, custom);
  const console = await consoleType(context, system);
  const ds = await inspectDirectory(context, "DS", dsDirectory, grants);
  const dsi = await inspectDirectory(context, "DSi", dsiDirectory, grants);
  const workspace = workspacePaths(primaryStorageForUser(context.user), options.folders);
  options.onStatus?.("Checking melonDS's game folder…");
  const library = await inspectLibrary(context, `${workspace.roms}/nds`, grants);
  const nativeReady = ds.state === "accepted" && dsi.state === "accepted" && ds.path !== dsi.path;
  if (nativeReady) options.onStatus?.("Checking melonDS's DSi NAND…");
  const nand = nativeReady && await verifyNativeNand(context);
  return {
    ds: customBios ? ds.state : "accepted",
    dsBios: ds.state,
    dsi: dsi.state === "accepted" && nativeReady && !nand ? "missing"
      : dsi.state === "accepted" && (!nativeReady || !customBios) ? "unverified" : dsi.state,
    customBios, consoleType: console,
    library: library.connected ? "accepted" : "unverified",
    contentVerified: nand,
  };
}

async function selectDirectory(context: EmulatorUiContext, console: MelonDsConsole, directory: string, initial: AndroidUiSnapshot): Promise<AndroidUiSnapshot> {
  const resource = console === "DS" ? "bios_directory" : "dsi_bios_directory";
  const observed = await melonDsPreference(context, resource, initial);
  if (melonDsSummary(observed) === directory && (await inspectDirectory(context, console, observed)).state === "accepted") {
    // The directory grant covers replacement files at the same path. The
    // inspection after restart still verifies the newly uploaded contents.
    return observed.snapshot;
  }
  await tapMelonDsPreference(context, resource, observed.snapshot);
  await selectAndroidDocument(context, MELONDS_PACKAGE, directory, true, undefined, { directoryNavigation: "scroll-first" });
  const preference = await melonDsPreference(context, resource);
  const result = await inspectDirectory(context, console, preference);
  if (result.state !== "accepted" || result.path !== directory) {
    throw new Error(`melonDS rejected the ${console} folder. Check that its files are complete, valid and writable.`);
  }
  return preference.snapshot;
}

async function selectConsoleType(context: EmulatorUiContext, console: MelonDsConsole, initial?: AndroidUiSnapshot): Promise<void> {
  const setting = await melonDsPreference(context, "console_type", initial);
  if (await consoleType(context, setting) === console) return;
  await tapMelonDsPreference(context, "console_type", setting.snapshot);
  const label = await melonDsText(context, console === "DS" ? "console_ds" : "console_dsi");
  const snapshot = await waitEmulatorUi(context, (value) => uiNode(value, "android:id/text1", label) ? value : undefined);
  const item = uiNode(snapshot, "android:id/text1", label);
  if (!item) throw new Error(`${console} mode is unavailable.`);
  await tapEmulatorNode(context, snapshot, item);
}

async function connectLibrary(context: EmulatorUiContext, options: EmulatorConfigurationOptions): Promise<void> {
  const workspace = workspacePaths(primaryStorageForUser(context.user), options.folders);
  options.onStatus?.("Connecting melonDS to the DS / DSi game folder…");
  const games = `${workspace.roms}/nds`;
  const library = await inspectLibrary(context, games);
  if (!library.connected) {
    await prepareEmulatorFolders(context.device, context.user, [games], context.signal);
    await tapMelonDsPreference(context, "rom_search_directory", library.preference.snapshot);
    await selectAndroidDocument(context, MELONDS_PACKAGE, games, true, undefined, { directoryNavigation: "scroll-first" });
    await melonDsPreference(context, "rom_search_directory");
  }
}

async function completeSetup(context: EmulatorUiContext, options: EmulatorConfigurationOptions, uploaded: readonly PreparedDirectory[]): Promise<MelonDsConfigurationResult> {
  const workspace = workspacePaths(primaryStorageForUser(context.user), options.folders);
  const dsInput = uploaded.find((input) => input.console === "DS");
  const dsiInput = uploaded.find((input) => input.console === "DSi");
  const target = dsiInput ?? dsInput;
  if (!target) throw new Error("No melonDS system files were prepared.");
  const page = await openMelonDsPreferences(context, "firmware");
  options.onStatus?.("Selecting melonDS's DS BIOS folder…");
  let snapshot = page;
  let dsPath = dsInput?.directory;
  if (!dsPath) {
    const preference = await melonDsPreference(context, "bios_directory", page);
    snapshot = preference.snapshot;
    const observed = await inspectDirectory(context, "DS", preference);
    if (observed.state === "accepted") dsPath = observed.path;
    else {
      const directory = await findMelonDsDirectory(context, workspace.bios, "DS");
      if (directory) {
        snapshot = await selectDirectory(context, "DS", directory, snapshot);
        dsPath = directory;
      }
    }
  } else {
    snapshot = await selectDirectory(context, "DS", dsPath, snapshot);
  }
  if (dsiInput) {
    options.onStatus?.("Selecting melonDS's DSi BIOS and NAND folder…");
    snapshot = await selectDirectory(context, "DSi", dsiInput.directory, snapshot);
  }
  // Configuring DS must not replace the selected DSi NAND or activate DSi mode.
  if (dsPath && dsPath !== dsiInput?.directory) {
    const custom = await melonDsPreference(context, "use_custom_bios", snapshot);
    const enabled = await customBiosEnabled(context, custom);
    if (!enabled) await tapMelonDsPreference(context, "use_custom_bios", custom.snapshot);
    await selectConsoleType(context, target.console, enabled ? custom.snapshot : undefined);
  }
  await connectLibrary(context, options);
  options.onStatus?.("Restarting melonDS and checking its saved setup…");
  await restartMelonDs(context);
  return inspectSetup(context, options);
}

async function runMelonDs<T>(device: DeviceTransport, options: EmulatorConfigurationOptions, action: (context: EmulatorUiContext) => Promise<T>): Promise<T> {
  const user = await readAndroidUser(device, options.signal);
  const scoped = userScopedDevice(device, user, options.signal);
  const info = await readAndroidPackage(scoped, MELONDS_PACKAGE, user, options.signal);
  if (!info) throw new Error("Install melonDS before configuring its support files.");
  const lease = await keepDeviceAwake(scoped, user, { signal: options.signal, log: options.log });
  try {
    return await withAwakeDevice(scoped, user, { signal: options.signal, onUnlockRequired: options.onUnlockRequired }, (ensureUnlocked) =>
      withAndroidUiDump(scoped, options.signal, () => action({ device: scoped, user, signal: options.signal, ensureUnlocked })));
  } finally {
    await lease.release();
  }
}

export async function verifyMelonDs(device: DeviceTransport, options: EmulatorConfigurationOptions = {}): Promise<MelonDsConfigurationResult> {
  options.onStatus?.("Checking DS and DSi…");
  return runMelonDs(device, options, async (context) => {
    await restartMelonDs(context);
    return inspectSetup(context, options);
  });
}

async function configureBuiltInBios(device: DeviceTransport, options: EmulatorConfigurationOptions): Promise<MelonDsConfigurationResult> {
  return runMelonDs(device, options, async (context) => {
    options.onStatus?.("Setting up Nintendo DS with FreeBIOS…");
    await restartMelonDs(context);
    const page = await openMelonDsPreferences(context, "firmware");
    const custom = await melonDsPreference(context, "use_custom_bios", page);
    const enabled = await customBiosEnabled(context, custom);
    if (enabled) await tapMelonDsPreference(context, "use_custom_bios", custom.snapshot);
    await selectConsoleType(context, "DS", enabled ? undefined : custom.snapshot);
    await connectLibrary(context, options);
    options.onStatus?.("Restarting melonDS and checking FreeBIOS…");
    await restartMelonDs(context);
    const result = await inspectSetup(context, options);
    if (result.customBios || result.consoleType !== "DS" || result.ds !== "accepted" || result.library !== "accepted") {
      throw new Error("melonDS did not retain its FreeBIOS setup and shared game folder.");
    }
    return result;
  });
}

export async function configureMelonDs(device: DeviceTransport, files: readonly File[], options: EmulatorConfigurationOptions = {}): Promise<MelonDsConfigurationResult> {
  return configureMelonDsSets(device, [files], options);
}

async function prepareSystemFiles(
  context: EmulatorUiContext, groups: readonly (readonly File[])[], options: EmulatorConfigurationOptions,
): Promise<PreparedDirectory[]> {
  const first = groups[0];
  if (groups.length === 1 && first) return [await prepareEmulatorSupport(context.device, context.user, "nds", first, options)];

  // Validate both sets before starting independent uploads to their own folders.
  const sets = await Promise.all(groups.map((files) => validateMelonDsInputs(files, options.signal)));
  if (new Set(sets.map(({ console }) => console)).size !== sets.length) throw new Error("Choose only one set per melonDS console.");
  const total = groups.reduce((bytes, files) => bytes + files.reduce((sum, file) => sum + file.size, 0), 0);
  const transferred = groups.map(() => 0);
  const prepare = (files: readonly File[], index: number): Promise<PreparedDirectory> =>
    prepareEmulatorSupport(context.device, context.user, "nds", files, {
      ...options, onProgress: (bytes) => {
        transferred[index] = bytes;
        options.onProgress?.(transferred.reduce((sum, count) => sum + count, 0), total);
      },
    });
  if (groups.length > 1 && await readAndroidSdk(context.device, options.signal) >= 31) {
    const results = await Promise.allSettled(groups.map(prepare));
    return results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
  }
  const uploaded: PreparedDirectory[] = [];
  for (const [index, files] of groups.entries()) uploaded.push(await prepare(files, index));
  return uploaded;
}

/** Select both native BIOS directories before leaving Firmware settings, then
 * connect the shared DS/DSi ROM folder and verify once after a single restart. */
export async function configureMelonDsSets(device: DeviceTransport, groups: readonly (readonly File[])[], options: EmulatorConfigurationOptions = {}): Promise<MelonDsConfigurationResult> {
  const selected = groups.filter((files) => files.length);
  if (!selected.length) return configureBuiltInBios(device, options);
  return runMelonDs(device, options, async (context) => {
    options.onStatus?.("Preparing melonDS's system files…");
    return completeSetup(context, options, await prepareSystemFiles(context, selected, options));
  });
}
