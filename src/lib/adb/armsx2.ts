import { readAndroidPackage } from "./android-package";
import { selectAndroidDocument, hasAndroidTreeReadGrant } from "./android-document-picker";
import { withAndroidUiDump } from "./android-ui-dump";
import type { AndroidUiNode, AndroidUiSnapshot } from "./android-ui";
import { primaryStorageForUser, readAndroidUser, userScopedDevice } from "./android-user";
import { validateArmsx2Inputs } from "./armsx2-inputs";
import { readArmsx2Labels } from "./armsx2-labels";
import { ARMSX2_PACKAGE, armsx2Action, armsx2HasLabel, closeArmsx2Wizard, findArmsx2WizardContent, finishArmsx2Wizard, goToArmsx2WizardPage, openArmsx2Wizard, tapArmsx2Action, type Armsx2UiContext } from "./armsx2-navigation";
import { withAwakeDevice } from "./device-awake";
import { keepDeviceAwake } from "./device-keep-awake";
import type { ConfigurationItemState, EmulatorConfigurationOptions } from "./emulator-configuration-types";
import { emulatorNodeVisible, restartEmulator, tapEmulatorNode, uiWithin, waitEmulatorUi } from "./emulator-ui";
import { createMediaStoreFolders } from "./media-store";
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
  if (!armsx2Action(context, snapshot, "setup.button.next")) return false;
  const selected = snapshot.nodes.filter((node) => [node.text, node.description].some((value) =>
    value.split(/\r?\n/).some((line) => context.labels.get("setup.status.biosSelected")?.has(line))));
  if (selected.length !== 1) return false;
  if (!name) return true;
  const named = snapshot.nodes.filter((node) => node.text.split(/\r?\n/).includes(name));
  if (named.length !== 1 || !named[0] || !selected[0]) return false;
  let row: AndroidUiNode | undefined = named[0];
  while (row && !row.clickable) row = row.parent === null ? undefined : snapshot.nodes[row.parent];
  return !row || uiWithin(snapshot, selected[0], row);
}

async function selectUploadedBios(context: Armsx2UiContext, name: string): Promise<AndroidUiSnapshot> {
  const initial = await waitEmulatorUi(context, (value) => armsx2Action(context, value, "setup.button.next") ? value : undefined, 60_000);
  const found = await findArmsx2WizardContent<{ snapshot: AndroidUiSnapshot; node?: AndroidUiNode }>(context, (snapshot) => {
    if (biosAccepted(context, snapshot, name)) return { snapshot };
    const candidates = snapshot.nodes.filter((node) => node.text.split(/\r?\n/).includes(name) && emulatorNodeVisible(snapshot, node));
    if (candidates.length > 1) throw new Error("ARMSX2's uploaded BIOS selection is ambiguous.");
    return candidates[0] ? { snapshot, node: candidates[0] } : undefined;
  }, "down", initial);
  if (!found) throw new Error("ARMSX2 did not list the uploaded BIOS in the selected folder.");
  if (!found.node) return found.snapshot;
  await tapEmulatorNode(context, found.snapshot, found.node);
  return waitEmulatorUi(context, (value) => biosAccepted(context, value, name) ? value : undefined);
}

interface Armsx2LibraryConnection {
  connected: boolean;
  snapshot: AndroidUiSnapshot | undefined;
}

async function libraryConnection(context: Armsx2UiContext, directory: string, initial?: AndroidUiSnapshot): Promise<Armsx2LibraryConnection> {
  const relative = directory.slice(primaryStorageForUser(context.user).length + 1);
  const snapshot = await findArmsx2WizardContent(context, (value) => value.nodes.some((node) => node.text === relative) ? value : undefined, "down", initial);
  return { snapshot, connected: snapshot !== undefined && await hasAndroidTreeReadGrant(context, ARMSX2_PACKAGE, directory, true) };
}

async function inspectSetup(context: Armsx2UiContext, options: EmulatorConfigurationOptions, expectedBios?: string): Promise<Armsx2ConfigurationResult> {
  options.onStatus?.("Opening ARMSX2's setup…");
  const opened = await openArmsx2Wizard(context, true);
  const { setupComplete } = opened;
  options.onStatus?.("Checking the BIOS selected in ARMSX2…");
  const biosPage = await goToArmsx2WizardPage(context, 2, opened);
  const bios = biosAccepted(context, biosPage, expectedBios);
  if (!bios) return { bios: "missing", library: "unverified", setupComplete, contentVerified: false };
  const workspace = workspacePaths(primaryStorageForUser(context.user), options.folders);
  options.onStatus?.(`Checking ARMSX2's saved game folder: ${workspace.roms}/ps2…`);
  const gamesPage = await goToArmsx2WizardPage(context, 3, { snapshot: biosPage, page: 2 });
  const library = await libraryConnection(context, `${workspace.roms}/ps2`, gamesPage);
  // Inspecting an existing setup does not change its completion flag.
  if (setupComplete) await closeArmsx2Wizard(context);
  return { bios: "accepted", library: library.connected ? "accepted" : "unverified", setupComplete, contentVerified: true };
}

async function completeSetup(context: Armsx2UiContext, options: EmulatorConfigurationOptions, uploaded: { directory: string; name: string }): Promise<Armsx2ConfigurationResult> {
  options.onStatus?.("Opening ARMSX2's setup…");
  const opened = await openArmsx2Wizard(context);
  let snapshot = await goToArmsx2WizardPage(context, 2, opened);
  const expected = uploaded.name.replace(/[^A-Za-z0-9._-]/gu, "_");
  options.onStatus?.("Importing the BIOS through ARMSX2's native verifier…");
  const choose = armsx2HasLabel(context, snapshot, "setup.button.pickDifferentFolder") ? "setup.button.pickDifferentFolder" : "setup.bios.selectTitle";
  await tapArmsx2Action(context, choose, snapshot);
  await selectAndroidDocument(context, ARMSX2_PACKAGE, uploaded.directory, true);
  snapshot = await selectUploadedBios(context, expected);
  const workspace = workspacePaths(primaryStorageForUser(context.user), options.folders);
  const games = `${workspace.roms}/ps2`;
  options.onStatus?.("Connecting ARMSX2 to the PS2 game folder…");
  await createMediaStoreFolders(context.device, context.user, [games], context.signal);
  const gamesPage = await goToArmsx2WizardPage(context, 3, { snapshot, page: 2 });
  let library = await libraryConnection(context, games, gamesPage);
  if (!library.connected) {
    const addAction = await findArmsx2WizardContent(context, (value) => {
      for (const key of ["setup.button.pickRomsFolder", "setup.button.addAnotherFolder"] as const) {
        const action = armsx2Action(context, value, key);
        if (action && emulatorNodeVisible(value, action)) return { key, snapshot: value };
      }
      return undefined;
    });
    if (!addAction) throw new Error("ARMSX2's ROM folder action was not found in its setup.");
    await tapArmsx2Action(context, addAction.key, addAction.snapshot);
    await selectAndroidDocument(context, ARMSX2_PACKAGE, games, true);
    library = await waitEmulatorUi(context, async (value) => {
      if (!armsx2HasLabel(context, value, "setup.button.next")) return undefined;
      const connected = await libraryConnection(context, games, value);
      return connected.connected ? connected : undefined;
    });
  }
  await finishArmsx2Wizard(context, library.snapshot ? { snapshot: library.snapshot, page: 3 } : undefined);
  options.onStatus?.("Restarting ARMSX2 and checking its saved BIOS and game folder…");
  await restartEmulator(context, ARMSX2_PACKAGE, "ARMSX2");
  return inspectSetup(context, options, expected);
}

async function runArmsx2<T>(device: DeviceTransport, options: EmulatorConfigurationOptions, action: (context: Armsx2UiContext) => Promise<T>): Promise<T> {
  options.onStatus?.("Checking ARMSX2's installation…");
  const user = await readAndroidUser(device, options.signal);
  const scoped = userScopedDevice(device, user, options.signal);
  const info = await readAndroidPackage(scoped, ARMSX2_PACKAGE, user, options.signal);
  if (!info) throw new Error("Install ARMSX2 before configuring its BIOS.");
  options.onStatus?.("Preparing ARMSX2's setup check…");
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
    options.onStatus?.("Restarting ARMSX2 to check its saved setup…");
    await restartEmulator(context, ARMSX2_PACKAGE, "ARMSX2");
    return inspectSetup(context, options);
  });
}

export async function configureArmsx2(device: DeviceTransport, files: readonly File[], options: EmulatorConfigurationOptions = {}): Promise<Armsx2ConfigurationResult> {
  const input = await validateArmsx2Inputs(files, options.signal);
  return runArmsx2(device, options, async (context) => {
    const workspace = workspacePaths(primaryStorageForUser(context.user), options.folders);
    const directory = `${workspace.bios}/ps2`;
    options.onStatus?.(`Uploading PS2 BIOS ${input.info.version} (${input.info.zone})…`);
    await uploadMediaStoreFile(context.device, context.user, directory, input.file, {
      replaceExisting: true,
      signal: context.signal, onProgress: (bytes) => options.onProgress?.(bytes, input.file.size),
    });
    return completeSetup(context, options, { directory, name: input.file.name });
  });
}
