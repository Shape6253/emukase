import { readAndroidPackage } from "./android-package";
import { selectAndroidDocument, hasAndroidTreeReadGrant } from "./android-document-picker";
import { withAndroidUiDump } from "./android-ui-dump";
import type { AndroidUiSnapshot } from "./android-ui";
import { primaryStorageForUser, readAndroidUser, userScopedDevice } from "./android-user";
import { validateArmsx2Inputs } from "./armsx2-inputs";
import { readArmsx2Labels } from "./armsx2-labels";
import { ARMSX2_PACKAGE, armsx2Action, armsx2HasLabel, finishArmsx2Wizard, goToArmsx2WizardPage, openArmsx2Wizard, tapArmsx2Action, type Armsx2UiContext } from "./armsx2-navigation";
import { withAwakeDevice } from "./device-awake";
import { keepDeviceAwake } from "./device-keep-awake";
import type { ConfigurationItemState, EmulatorConfigurationOptions } from "./emulator-configuration-types";
import { restartEmulator, waitEmulatorUi } from "./emulator-ui";
import { scanPlatformLibrary } from "./library-scan";
import { createMediaStoreFolders, queryMediaStoreFiles } from "./media-store";
import { uploadMediaStoreFile } from "./media-store-upload";
import type { DeviceTransport } from "./transport";
import { workspacePaths } from "./workspace";

export interface Armsx2ConfigurationResult {
  bios: ConfigurationItemState;
  library: "accepted" | "unverified";
  setupComplete: boolean;
  contentVerified: boolean;
}

function biosAccepted(context: Armsx2UiContext, snapshot: AndroidUiSnapshot, name?: string): boolean {
  return armsx2HasLabel(context, snapshot, "setup.status.biosSelected")
    && !!armsx2Action(context, snapshot, "setup.button.next")
    && (!name || snapshot.nodes.some((node) => node.text === name));
}

async function libraryConnected(context: Armsx2UiContext, snapshot: AndroidUiSnapshot, directory: string): Promise<boolean> {
  const relative = directory.slice(primaryStorageForUser(context.user).length + 1);
  return snapshot.nodes.some((node) => node.text === relative)
    && await hasAndroidTreeReadGrant(context, ARMSX2_PACKAGE, directory, true);
}

async function inspectSetup(context: Armsx2UiContext, options: EmulatorConfigurationOptions, expectedBios?: string): Promise<Armsx2ConfigurationResult> {
  const { setupComplete } = await openArmsx2Wizard(context);
  const biosPage = await goToArmsx2WizardPage(context, 2);
  const bios = biosAccepted(context, biosPage, expectedBios);
  if (!bios) return { bios: "missing", library: "unverified", setupComplete, contentVerified: false };
  const gamesPage = await goToArmsx2WizardPage(context, 3);
  const workspace = workspacePaths(primaryStorageForUser(context.user), options.folders);
  const library = await libraryConnected(context, gamesPage, `${workspace.roms}/ps2`);
  // Re-entering an already-completed wizard does not reset the setup flag. Close
  // that editor through its existing completion action when its fields are valid.
  if (setupComplete && armsx2Action(context, gamesPage, "setup.button.next")) await finishArmsx2Wizard(context);
  return { bios: "accepted", library: library ? "accepted" : "unverified", setupComplete, contentVerified: true };
}

async function deviceBios(context: Armsx2UiContext, options: EmulatorConfigurationOptions): Promise<{ directory: string; name: string }> {
  const workspace = workspacePaths(primaryStorageForUser(context.user), options.folders);
  const scan = await scanPlatformLibrary(context.device, "ps2", options.folders, context.signal);
  const candidates = scan.requirements.flatMap((entry) => entry.files).filter((file) => file.bytes >= 4 * 1024 * 1024 && file.bytes <= 8 * 1024 * 1024);
  const supplied = candidates.filter((file) => !/^ps2\/import_[a-f\d]+\//.test(file.relativePath));
  if (supplied.length > 1) throw new Error("Multiple PS2 BIOS images are available. Choose one image or ZIP to import.");
  let selected = supplied[0];
  if (!selected && candidates.length > 1) {
    const indexed = await queryMediaStoreFiles(context.device, context.user, workspace.bios, context.signal);
    const order = new Map(indexed.map((file) => [file.path.slice(workspace.bios.length + 1), BigInt(file.id)]));
    if (candidates.some((file) => !order.has(file.relativePath))) throw new Error("The PS2 BIOS import order could not be confirmed. Choose an image or ZIP to import.");
    candidates.sort((left, right) => (order.get(left.relativePath) ?? 0n) > (order.get(right.relativePath) ?? 0n) ? -1 : 1);
  }
  selected ??= candidates[0];
  if (!selected) throw new Error("No PS2 BIOS image is available in the support library. Choose a BIOS image or ZIP first.");
  const slash = selected.relativePath.lastIndexOf("/");
  return { directory: slash < 0 ? workspace.bios : `${workspace.bios}/${selected.relativePath.slice(0, slash)}`, name: selected.relativePath.slice(slash + 1) };
}

async function completeSetup(context: Armsx2UiContext, options: EmulatorConfigurationOptions, uploaded?: { directory: string; name: string }): Promise<Armsx2ConfigurationResult> {
  await openArmsx2Wizard(context);
  let snapshot = await goToArmsx2WizardPage(context, 2);
  let expected = uploaded?.name;
  if (uploaded || !biosAccepted(context, snapshot)) {
    const input = uploaded ?? await deviceBios(context, options);
    expected = input.name.replace(/[^A-Za-z0-9._-]/gu, "_");
    options.onStatus?.("Importing the BIOS through ARMSX2's native verifier…");
    const choose = armsx2HasLabel(context, snapshot, "setup.button.pickDifferentFolder") ? "setup.button.pickDifferentFolder" : "setup.bios.selectTitle";
    await tapArmsx2Action(context, choose);
    await selectAndroidDocument(context, ARMSX2_PACKAGE, input.directory, true);
    snapshot = await waitEmulatorUi(context, (value) => biosAccepted(context, value, expected) ? value : undefined, 60_000);
  }
  const workspace = workspacePaths(primaryStorageForUser(context.user), options.folders);
  const games = `${workspace.roms}/ps2`;
  options.onStatus?.("Connecting ARMSX2 to the PS2 game folder…");
  await createMediaStoreFolders(context.device, context.user, [games], context.signal);
  snapshot = await goToArmsx2WizardPage(context, 3);
  if (!await libraryConnected(context, snapshot, games)) {
    await tapArmsx2Action(context, armsx2HasLabel(context, snapshot, "setup.button.pickRomsFolder") ? "setup.button.pickRomsFolder" : "setup.button.addAnotherFolder");
    await selectAndroidDocument(context, ARMSX2_PACKAGE, games, true);
    await waitEmulatorUi(context, async (value) => await libraryConnected(context, value, games) ? true : undefined);
  }
  await finishArmsx2Wizard(context);
  options.onStatus?.("Restarting ARMSX2 and checking its saved BIOS and game folder…");
  await restartEmulator(context, ARMSX2_PACKAGE, "ARMSX2");
  return inspectSetup(context, options, expected);
}

async function runArmsx2<T>(device: DeviceTransport, options: EmulatorConfigurationOptions, action: (context: Armsx2UiContext) => Promise<T>): Promise<T> {
  const user = await readAndroidUser(device, options.signal);
  const scoped = userScopedDevice(device, user, options.signal);
  const info = await readAndroidPackage(scoped, ARMSX2_PACKAGE, user, options.signal);
  if (!info) throw new Error("Install ARMSX2 before configuring its BIOS.");
  if (info.version !== "2.8.3") throw new Error(`ARMSX2 ${info.version} is not supported by this configuration recipe.`);
  const lease = await keepDeviceAwake(scoped, user, { signal: options.signal });
  try {
    return await withAwakeDevice(scoped, user, { signal: options.signal, onUnlockRequired: options.onUnlockRequired }, (ensureUnlocked) =>
      withAndroidUiDump(scoped, options.signal, async () => {
        const base = { device: scoped, user, signal: options.signal, ensureUnlocked };
        return action({ ...base, labels: await readArmsx2Labels(base) });
      }));
  } finally {
    await lease.release();
  }
}

export async function verifyArmsx2(device: DeviceTransport, options: EmulatorConfigurationOptions = {}): Promise<Armsx2ConfigurationResult> {
  options.onStatus?.("Checking ARMSX2's selected BIOS, initial setup and game folder…");
  return runArmsx2(device, options, async (context) => {
    await restartEmulator(context, ARMSX2_PACKAGE, "ARMSX2");
    return inspectSetup(context, options);
  });
}

export async function configureArmsx2(device: DeviceTransport, files: readonly File[], options: EmulatorConfigurationOptions = {}): Promise<Armsx2ConfigurationResult> {
  const input = await validateArmsx2Inputs(files, options.signal);
  return runArmsx2(device, options, async (context) => {
    const workspace = workspacePaths(primaryStorageForUser(context.user), options.folders);
    const directory = `${workspace.bios}/ps2/import_${crypto.randomUUID().replaceAll("-", "")}`;
    options.onStatus?.(`Uploading PS2 BIOS ${input.info.version} (${input.info.zone})…`);
    await uploadMediaStoreFile(context.device, context.user, directory, input.file, {
      signal: context.signal, onProgress: (bytes) => options.onProgress?.(bytes, input.file.size),
    });
    return completeSetup(context, options, { directory, name: input.file.name });
  });
}

export async function repairArmsx2(device: DeviceTransport, options: EmulatorConfigurationOptions = {}): Promise<Armsx2ConfigurationResult> {
  options.onStatus?.("Checking what ARMSX2 still needs…");
  return runArmsx2(device, options, (context) => completeSetup(context, options));
}
