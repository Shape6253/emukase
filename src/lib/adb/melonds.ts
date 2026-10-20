import { readAndroidPackage } from "./android-package";
import { withAndroidUiDump } from "./android-ui-dump";
import { primaryStorageForUser, readAndroidUser, userScopedDevice } from "./android-user";
import { selectAndroidDocument, hasAndroidTreeReadGrant } from "./android-document-picker";
import { keepDeviceAwake } from "./device-keep-awake";
import { withAwakeDevice } from "./device-awake";
import type { ConfigurationItemState, EmulatorConfigurationOptions } from "./emulator-configuration-types";
import { tapEmulatorNode, uiNode, waitEmulatorUi, type EmulatorUiContext } from "./emulator-ui";
import { findMelonDsDirectory } from "./melonds-device-inputs";
import { validateMelonDsInputs, type MelonDsConsole } from "./melonds-inputs";
import { MELONDS_PACKAGE, melonDsPreference, melonDsSummary, melonDsText, openMelonDsMenu, openMelonDsPreferences, restartMelonDs, tapMelonDsPreference, type MelonDsPreference } from "./melonds-navigation";
import { createMediaStoreFolders } from "./media-store";
import { uploadMediaStoreFile } from "./media-store-upload";
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

async function inspectDirectory(context: EmulatorUiContext, console: MelonDsConsole, observed?: MelonDsPreference): Promise<NativeDirectory> {
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
  return { state: await hasAndroidTreeReadGrant(context, MELONDS_PACKAGE, summary, true) ? "accepted" : "unverified", path: summary };
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

async function libraryConnected(context: EmulatorUiContext, directory: string): Promise<boolean> {
  const page = await openMelonDsPreferences(context, "roms");
  const summary = melonDsSummary(await melonDsPreference(context, "rom_search_directory", page));
  return summary?.split("\n").includes(directory) === true && await hasAndroidTreeReadGrant(context, MELONDS_PACKAGE, directory, true);
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
  const page = await openMelonDsPreferences(context, "firmware");
  const custom = await melonDsPreference(context, "use_custom_bios", page);
  const system = await melonDsPreference(context, "console_type", custom.snapshot);
  const dsDirectory = await melonDsPreference(context, "bios_directory", system.snapshot);
  const dsiDirectory = await melonDsPreference(context, "dsi_bios_directory", dsDirectory.snapshot);
  const customBios = await customBiosEnabled(context, custom);
  const console = await consoleType(context, system);
  const ds = await inspectDirectory(context, "DS", dsDirectory);
  const dsi = await inspectDirectory(context, "DSi", dsiDirectory);
  const workspace = workspacePaths(primaryStorageForUser(context.user), options.folders);
  options.onStatus?.("Checking melonDS's game folder…");
  const library = await libraryConnected(context, `${workspace.roms}/nds`);
  const nativeReady = ds.state === "accepted" && dsi.state === "accepted" && ds.path !== dsi.path;
  if (nativeReady) options.onStatus?.("Checking melonDS's DSi NAND…");
  const nand = nativeReady && await verifyNativeNand(context);
  return {
    ds: customBios ? ds.state : "accepted",
    dsBios: ds.state,
    dsi: dsi.state === "accepted" && nativeReady && !nand ? "missing"
      : dsi.state === "accepted" && (!nativeReady || !customBios) ? "unverified" : dsi.state,
    customBios, consoleType: console,
    library: library ? "accepted" : "unverified",
    contentVerified: nand,
  };
}

async function selectDirectory(context: EmulatorUiContext, console: MelonDsConsole, directory: string): Promise<void> {
  await tapMelonDsPreference(context, console === "DS" ? "bios_directory" : "dsi_bios_directory");
  await selectAndroidDocument(context, MELONDS_PACKAGE, directory, true, undefined, { keyboardNavigation: true });
  const result = await inspectDirectory(context, console);
  if (result.state !== "accepted" || result.path !== directory) {
    throw new Error(`melonDS rejected the ${console} folder. Check that its files are complete, valid and writable.`);
  }
}

async function selectConsoleType(context: EmulatorUiContext, console: MelonDsConsole): Promise<void> {
  if (await consoleType(context) === console) return;
  await tapMelonDsPreference(context, "console_type");
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
  await createMediaStoreFolders(context.device, context.user, [games], context.signal);
  if (!await libraryConnected(context, games)) {
    await tapMelonDsPreference(context, "rom_search_directory");
    await selectAndroidDocument(context, MELONDS_PACKAGE, games, true, undefined, { keyboardNavigation: true });
    await melonDsPreference(context, "rom_search_directory");
  }
}

async function completeSetup(context: EmulatorUiContext, options: EmulatorConfigurationOptions, uploaded: { console: MelonDsConsole; directory: string }): Promise<MelonDsConfigurationResult> {
  const workspace = workspacePaths(primaryStorageForUser(context.user), options.folders);
  await openMelonDsPreferences(context, "firmware");
  let ds = await inspectDirectory(context, "DS");
  if (ds.state !== "accepted" || uploaded.console === "DS") {
    const directory = uploaded.console === "DS" ? uploaded.directory : await findMelonDsDirectory(context, workspace.bios, "DS");
    if (directory) { await selectDirectory(context, "DS", directory); ds = await inspectDirectory(context, "DS"); }
  }
  if (uploaded.console === "DSi") await selectDirectory(context, "DSi", uploaded.directory);
  // Configuring DS must not replace the selected DSi NAND or activate DSi mode.
  if (ds.state === "accepted" && (uploaded.console === "DS" || ds.path !== uploaded.directory)) {
    if (!await customBiosEnabled(context)) await tapMelonDsPreference(context, "use_custom_bios");
    await selectConsoleType(context, uploaded.console);
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
  const lease = await keepDeviceAwake(scoped, user, { signal: options.signal });
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
    await openMelonDsPreferences(context, "firmware");
    if (await customBiosEnabled(context)) await tapMelonDsPreference(context, "use_custom_bios");
    await selectConsoleType(context, "DS");
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
  if (files.length === 0) return configureBuiltInBios(device, options);
  const inputs = await validateMelonDsInputs(files, options.signal);
  return runMelonDs(device, options, async (context) => {
    const workspace = workspacePaths(primaryStorageForUser(context.user), options.folders);
    const root = `${workspace.bios}/nds/${inputs.console}`;
    // A DSi NAND holds installed titles and saves; keep previous sets intact.
    const directory = inputs.console === "DSi" ? `${root}/import_${crypto.randomUUID().replaceAll("-", "")}` : root;
    const total = inputs.files.reduce((bytes, file) => bytes + file.size, 0);
    let transferred = 0;
    for (const file of inputs.files) {
      options.onStatus?.(`Uploading ${file.name}…`);
      await uploadMediaStoreFile(context.device, context.user, directory, file, {
        replaceExisting: inputs.console === "DS",
        signal: context.signal, onProgress: (bytes) => options.onProgress?.(transferred + bytes, total),
      });
      transferred += file.size;
    }
    options.onStatus?.(`Configuring melonDS's ${inputs.console} system files…`);
    return completeSetup(context, options, { console: inputs.console, directory });
  });
}
