import { readAndroidPackage } from "./android-package";
import { withAndroidUiDump } from "./android-ui-dump";
import { readAndroidUser, primaryStorageForUser, userScopedDevice, androidUserProcessPid } from "./android-user";
import { keepDeviceAwake } from "./device-keep-awake";
import { withAwakeDevice } from "./device-awake";
import { selectAndroidDocument, hasAndroidTreeReadGrant } from "./android-document-picker";
import { validateEdenInputs } from "./eden-inputs";
import { navigateEden } from "./eden-navigation";
import { findEdenDeviceInputs, type EdenImport } from "./eden-device-inputs";
import { EMULATORS } from "./emulators";
import { androidResourceText, emulatorNodeVisible, scrollEmulatorList, tapEmulatorNode, uiWithin, uiNode, waitEmulatorUi, type EmulatorUiContext } from "./emulator-ui";
import { AndroidUiStateChangedError, assertAndroidUiSnapshot, type AndroidUiSnapshot, type AndroidUiNode } from "./android-ui";
import { createMediaStoreFolders } from "./media-store";
import { uploadMediaStoreFile } from "./media-store-upload";
import { checkActivityStart, shellCommand, type DeviceTransport } from "./transport";
import { workspacePaths, type LibraryFolderOptions } from "./workspace";
import type { EmulatorConfigurationOptions } from "./emulator-configuration-types";

const PACKAGE = EMULATORS.eden.packages[0];
const ACTIVITY = `${PACKAGE}/org.yuzu.yuzu_emu.ui.main.MainActivity`;
const id = (name: string): string => `${PACKAGE}:id/${name}`;
const action = (name: string): string => `${PACKAGE}:string/${name}`;

export type EdenConfigurationOptions = EmulatorConfigurationOptions;

export interface EdenConfigurationResult {
  keys: "accepted" | "missing" | "unverified";
  firmware: "accepted" | "missing" | "unverified";
  library: "accepted" | "unverified";
  contentVerified: boolean;
}

function isEden(snapshot: AndroidUiSnapshot): boolean {
  return snapshot.component.startsWith(`${PACKAGE}/`);
}

function dataPage(snapshot: AndroidUiSnapshot): boolean {
  return !!uiNode(snapshot, id("viewPager2")) && !!uiNode(snapshot, id("button_back"))
    && !!uiNode(snapshot, id("button_next")) && !uiNode(snapshot, action("get_started"));
}

function dataStatus(snapshot: AndroidUiSnapshot): EdenConfigurationResult {
  if (!dataPage(snapshot)) throw new Error("Eden's native data setup page is unavailable.");
  const complete = !!uiNode(snapshot, id("text_confirmation")) && !snapshot.nodes.some((node) => node.resourceId.startsWith(`${PACKAGE}:string/`));
  const state = (name: string): "accepted" | "missing" | "unverified" => {
    const node = uiNode(snapshot, action(name));
    return complete || node?.enabled === false ? "accepted" : node ? "missing" : "unverified";
  };
  return { keys: state("keys"), firmware: state("firmware"), library: state("games") === "accepted" ? "accepted" : "unverified", contentVerified: false };
}

async function launchWithStatus(context: EmulatorUiContext, restart: boolean): Promise<{ snapshot: AndroidUiSnapshot; keys: EdenConfigurationResult["keys"] }> {
  if (restart) {
    if (await androidUserProcessPid(context.device, PACKAGE, context.user, context.signal)) {
      // A previous disconnected session may have left a noncancellable native
      // installer running. Bring it forward and wait before stopping its process.
      checkActivityStart(await context.device.shell(shellCommand("am", "start", "--user", String(context.user), "--display", "0", "-W", "-n", ACTIVITY)));
      await waitEmulatorUi(context, (value) => {
        if (isEden(value)) return value.nodes.some((node) => node.className === "android.widget.ProgressBar") ? undefined : true;
        return /documentsui.*\/com.android.documentsui.picker.PickActivity$/.test(value.component) ? true : undefined;
      }, 180_000);
    }
    // HOME runs Eden's onStop and saves app-owned settings before stopping it.
    await context.device.shell(shellCommand("input", "keyevent", "KEYCODE_HOME"));
    const deadline = Date.now() + 15_000;
    let stopped = false;
    while (Date.now() < deadline) {
      const pid = await androidUserProcessPid(context.device, PACKAGE, context.user, context.signal);
      if (!pid) { stopped = true; break; }
      // ActivityManager records STOPPED after the app's stop callback. Unlike
      // client dumps, this remains available when Eden's dump service stalls.
      const output = await context.device.shell(shellCommand("dumpsys", "activity", "activities"));
      const records = output.split(/(?=^\s*\* Hist\s+#\d+:)/m).filter((block) => {
        return new RegExp(`^\\s*\\* Hist\\s+#\\d+: ActivityRecord\\{[a-f\\d]+ u${context.user} ${PACKAGE.replaceAll(".", "\\.")}/`).test(block)
          && new RegExp(`\\bapp=ProcessRecord\\{[^\\r\\n]+ ${pid}:${PACKAGE.replaceAll(".", "\\.")}/`).test(block);
      });
      if (records.length && records.every((block) => /^\s+state=STOPPED\b/m.test(block))) { stopped = true; break; }
    }
    if (!stopped) throw new Error("Eden did not finish saving its settings before restart.");
    await context.device.shell(shellCommand("am", "force-stop", "--user", String(context.user), PACKAGE));
  }
  checkActivityStart(await context.device.shell(shellCommand("am", "start", "--user", String(context.user), "--display", "0", "-W",
    ...(restart ? ["-f", "0x10008000"] : []), "-n", ACTIVITY)));
  const keysMissing = await androidResourceText(context, PACKAGE, action("keys_missing"));
  const missingKeys = (value: AndroidUiSnapshot): boolean => (uiNode(value, id("alertTitle")) ?? uiNode(value, "android:id/alertTitle"))?.text === keysMissing;
  let snapshot = await waitEmulatorUi(context, (value) => isEden(value)
    && (missingKeys(value) || uiNode(value, id("viewPager2")) || uiNode(value, id("settings_button"))) ? value : undefined);
  let keys: EdenConfigurationResult["keys"] = "unverified";
  if (missingKeys(snapshot)) {
    keys = "missing";
    const dismiss = uiNode(snapshot, "android:id/button1");
    if (!dismiss) throw new Error("Eden's missing-keys report cannot be confirmed.");
    await tapEmulatorNode(context, snapshot, dismiss);
    snapshot = await waitEmulatorUi(context, (value) => isEden(value) && uiNode(value, id("settings_button")) ? value : undefined);
  } else if (restart && uiNode(snapshot, id("settings_button"))) {
    // This release checks areKeysPresent synchronously in a fresh MainActivity
    // before showing the game library. Missing keys produce the dialog above.
    keys = "accepted";
  }
  snapshot = await advanceToDataPage(context, snapshot);
  return { snapshot, keys };
}

async function advanceToDataPage(context: EmulatorUiContext, snapshot: AndroidUiSnapshot): Promise<AndroidUiSnapshot> {
  if (uiNode(snapshot, id("viewPager2")) && !uiNode(snapshot, id("button_back")) && uiNode(snapshot, id("button_next"))) {
    const next = uiNode(snapshot, id("button_next"));
    if (!next) throw new Error("Eden's setup navigation is unavailable.");
    await tapEmulatorNode(context, snapshot, next);
    snapshot = await waitEmulatorUi(context, (value) => isEden(value) && dataPage(value) ? value : undefined);
  }
  return snapshot;
}

async function launch(context: EmulatorUiContext, restart = false): Promise<AndroidUiSnapshot> {
  return (await launchWithStatus(context, restart)).snapshot;
}

function importButton(snapshot: AndroidUiSnapshot, title: AndroidUiNode): AndroidUiNode | undefined {
  const list = uiNode(snapshot, id("list_installables"));
  if (!list) throw new Error("Eden's support-file list is unavailable.");
  let card = title;
  while (card.parent !== null && snapshot.nodes[card.parent] !== list) {
    const parent = snapshot.nodes[card.parent];
    if (!parent) throw new Error("Eden's support-file card is invalid.");
    card = parent;
  }
  if (card.parent === null) throw new Error("Eden's support-file title is outside its list.");
  const buttons = snapshot.nodes.filter((node) => node.resourceId === id("button_install") && uiWithin(snapshot, node, card));
  if (buttons.length > 1) throw new Error("Eden's support-file card has ambiguous actions.");
  const button = buttons[0];
  return button && emulatorNodeVisible(snapshot, button) ? button : undefined;
}

async function findLabel(context: EmulatorUiContext, resource: string, titleId: "option_title" | "title"): Promise<{ snapshot: AndroidUiSnapshot; node: AndroidUiNode }> {
  const text = await androidResourceText(context, PACKAGE, action(resource));
  const listId = titleId === "option_title" ? "home_settings_list" : "list_installables";
  const scrollId = titleId === "option_title" ? "scroll_view_settings" : listId;
  let previous = "";
  let unchanged = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    const snapshot = await waitEmulatorUi(context, (value) => {
      const list = uiNode(value, id(listId));
      const scroll = uiNode(value, id(scrollId));
      return isEden(value) && list && scroll && scroll.bounds[3] > scroll.bounds[1]
        && value.nodes.some((entry) => (entry.text || entry.clickable) && uiWithin(value, entry, list)) ? value : undefined;
    });
    const node = uiNode(snapshot, id(titleId), text);
    if (node && (titleId !== "title" || importButton(snapshot, node))) return { snapshot, node };
    const signature = JSON.stringify(snapshot.nodes.map((entry) => [entry.resourceId, entry.text, entry.bounds, entry.focused]));
    unchanged = signature === previous ? unchanged + 1 : 0;
    if (unchanged >= 2) break;
    previous = signature;
    const scroll = uiNode(snapshot, id(scrollId));
    if (!scroll?.enabled || !scroll.scrollable) break;
    // Eden's nested cards consume touch scrolling on small screens. Focus
    // navigation scrolls their controls without activating any action.
    if (snapshot.nodes.some((entry) => entry.className === "android.widget.EditText" && entry.focused)) {
      throw new Error("Close Eden's text input before navigating its settings.");
    }
    await context.ensureUnlocked();
    try {
      await assertAndroidUiSnapshot(context.device, context.user, snapshot, context.signal);
    } catch (error) {
      if (error instanceof AndroidUiStateChangedError) continue;
      throw error;
    }
    await context.device.shell(shellCommand("input", "keyevent", "KEYCODE_DPAD_DOWN"));
  }
  throw new Error(`Eden's ${resource} control was not found.`);
}

async function openSettings(context: EmulatorUiContext, snapshot: AndroidUiSnapshot): Promise<void> {
  if (dataPage(snapshot)) throw new Error("Finish Eden's initial setup before changing installed support files.");
  await navigateEden(context, "homeSettingsFragment", "toolbar_home_settings");
}

async function openImport(context: EmulatorUiContext, input: EdenImport, snapshot: AndroidUiSnapshot): Promise<void> {
  if (dataPage(snapshot)) {
    const button = uiNode(snapshot, action(input.kind === "keys" ? "keys" : "firmware"));
    if (!button?.enabled) throw new Error("Eden already accepts this support item. Finish its initial setup before replacing it.");
    await tapEmulatorNode(context, snapshot, button);
    return;
  }
  await navigateEden(context, "installableFragment", "toolbar_installables");
  const install = await findLabel(context, input.kind === "keys" ? "install_prod_keys" : "install_firmware", "title");
  const button = importButton(install.snapshot, install.node);
  if (!button) throw new Error("Eden's support-file import action is not visible.");
  await tapEmulatorNode(context, install.snapshot, button);
}

async function nativeToast(context: EmulatorUiContext, text: string): Promise<boolean> {
  // Return only this app's toast section; unrelated notifications stay on Android.
  const command = `${shellCommand("dumpsys", "notification", "--package", PACKAGE)} | ${shellCommand("sed", "-n", "/Toast Queue:/,/^  $/p")}`;
  const output = await context.device.shell(shellCommand("sh", "-c", command));
  const records = output.split(/\r?\n/).filter((line) => line.includes("TextToastRecord{") && line.includes(`:${PACKAGE}/u${context.user}a`));
  return records.some((line) => line.includes(` text=${text} duration=`));
}

async function finishImport(context: EmulatorUiContext, input: EdenImport, success: string): Promise<void> {
  let nativeSuccess = await nativeToast(context, success);
  await waitEmulatorUi(context, async (snapshot) => {
    if (!isEden(snapshot)) return undefined;
    if (!nativeSuccess) nativeSuccess = await nativeToast(context, success);
    const dialog = uiNode(snapshot, id("alertTitle")) ?? uiNode(snapshot, "android:id/alertTitle");
    const message = uiNode(snapshot, "android:id/message");
    if (dialog || message) {
      if (snapshot.nodes.some((node) => node.className === "android.widget.ProgressBar")) return undefined;
      throw new Error("Eden rejected the selected support file. Check the result on the device.");
    }
    if (snapshot.nodes.some((node) => node.className === "android.widget.ProgressBar")) return undefined;
    if (dataPage(snapshot)) {
      const state = dataStatus(snapshot);
      if (input.name === "title.keys") return nativeSuccess ? true : undefined;
      return nativeSuccess && state[input.kind === "keys" ? "keys" : "firmware"] === "accepted" ? true : undefined;
    }
    return nativeSuccess && uiNode(snapshot, id("toolbar_installables")) ? true : undefined;
  }, input.kind === "firmware" ? 180_000 : 30_000);
}

async function handoffNativeImport(
  context: EmulatorUiContext, input: EdenImport, snapshot: AndroidUiSnapshot, node: AndroidUiNode, options: EdenConfigurationOptions,
): Promise<void> {
  const device = userScopedDevice(context.device.restorationDevice ?? context.device, context.user);
  // Cancellation remains immediate while navigating. Once the file is handed
  // to Eden, keep monitoring and holding the device until its installer returns.
  await withAwakeDevice(device, context.user, { onUnlockRequired: options.onUnlockRequired }, (ensureUnlocked) =>
    withAndroidUiDump(device, undefined, async () => {
      const native: EmulatorUiContext = { device, user: context.user, ensureUnlocked };
      const success = await androidResourceText(native, PACKAGE,
        action(input.kind === "keys" ? "keys_install_success" : "save_file_imported_success"));
      context.signal?.throwIfAborted();
      options.onNativeInstallPhase?.(true);
      try {
        await tapEmulatorNode(native, snapshot, node);
        await finishImport(native, input, success);
      } finally {
        options.onNativeInstallPhase?.(false);
      }
    }));
  context.signal?.throwIfAborted();
}

async function selectLibrary(context: EmulatorUiContext, snapshot: AndroidUiSnapshot, directory: string, existing = false): Promise<void> {
  const onboarding = dataPage(snapshot);
  const games = uiNode(snapshot, onboarding ? action("games") : id("add_directory"));
  if (!games?.enabled) return;
  await createMediaStoreFolders(context.device, context.user, [directory], context.signal);
  await tapEmulatorNode(context, snapshot, games);
  await selectAndroidDocument(context, PACKAGE, directory, true);
  if (existing) {
    // Eden refreshes the real SAF grant and returns directly when this exact
    // URI is already in its native list; it does not show the add-folder dialog.
    await waitEmulatorUi(context, (value) => isEden(value) && uiNode(value, id("settings_button")) ? true : undefined);
    if (!await hasAndroidTreeReadGrant(context, PACKAGE, directory)) throw new Error("Eden did not restore read permission for its game folder.");
    return;
  }
  const dialog = await waitEmulatorUi(context, (value) => isEden(value) && uiNode(value, id("path")) ? value : undefined);
  const path = uiNode(dialog, id("path"));
  const expected = `/tree/primary:${directory.slice(primaryStorageForUser(context.user).length + 1)}`;
  const confirm = uiNode(dialog, "android:id/button1");
  if (path?.text !== expected || !confirm) throw new Error("Eden did not confirm the selected game folder.");
  const saved = onboarding ? undefined : await androidResourceText(context, PACKAGE, action("add_directory_success"));
  await tapEmulatorNode(context, dialog, confirm);
  let nativeSaved = saved === undefined ? false : await nativeToast(context, saved);
  await waitEmulatorUi(context, async (value) => {
    if (!isEden(value) || uiNode(value, id("path"))) return undefined;
    if (onboarding) return dataPage(value) && dataStatus(value).library === "accepted" ? true : undefined;
    if (!nativeSaved && saved !== undefined) nativeSaved = await nativeToast(context, saved);
    return nativeSaved && uiNode(value, id("settings_button")) ? true : undefined;
  });
  if (!await hasAndroidTreeReadGrant(context, PACKAGE, directory)) throw new Error("Eden did not retain read permission for the selected game folder.");
}

function libraryPath(context: EmulatorUiContext, directory: string): string {
  return `/tree/primary:${directory.slice(primaryStorageForUser(context.user).length + 1)}`;
}

type NativeLibraryState = "connected" | "grant-missing" | "missing" | "type-conflict";

async function inspectNativeLibrary(context: EmulatorUiContext, snapshot: AndroidUiSnapshot, directory: string): Promise<NativeLibraryState> {
  if (dataPage(snapshot)) return "missing";
  await navigateEden(context, "gameFoldersFragment", "toolbar_folders");
  const games = await androidResourceText(context, PACKAGE, action("games"));
  let previous = "";
  for (let attempt = 0; attempt < 60; attempt++) {
    const current = await waitEmulatorUi(context, (value) => isEden(value) && uiNode(value, id("list_folders")) ? value : undefined);
    const paths = current.nodes.filter((node) => node.resourceId === id("path") && node.text === libraryPath(context, directory));
    for (const path of paths) {
      const parent = path.parent === null ? undefined : current.nodes[path.parent];
      if (!parent) continue;
      const types = current.nodes.filter((node) => node.resourceId === id("type_indicator") && uiWithin(current, node, parent));
      if (types.length !== 1) throw new Error("Eden's game-folder type could not be identified.");
      if (types[0]?.text !== games) return "type-conflict";
      return await hasAndroidTreeReadGrant(context, PACKAGE, directory) ? "connected" : "grant-missing";
    }
    const signature = JSON.stringify(current.nodes.map((node) => [node.resourceId, node.text, node.bounds]));
    const list = uiNode(current, id("list_folders"));
    if (signature === previous || !list?.scrollable) return "missing";
    previous = signature;
    await scrollEmulatorList(context, current, list);
  }
  throw new Error("Eden's game folder list exceeded the inspection limit.");
}

async function ensureNativeLibrary(context: EmulatorUiContext, directory: string): Promise<void> {
  let snapshot = await launch(context, true);
  if (dataPage(snapshot)) {
    const state = dataStatus(snapshot);
    let selectedExact = false;
    if (state.library !== "accepted") {
      await selectLibrary(context, snapshot, directory);
      snapshot = await launch(context, true);
      if (!dataPage(snapshot) || dataStatus(snapshot).library !== "accepted"
        || !await hasAndroidTreeReadGrant(context, PACKAGE, directory)) throw new Error("Eden did not retain its selected game folder after restart.");
      selectedExact = true;
    }
    const stateAfter = dataStatus(snapshot);
    if (stateAfter.keys !== "accepted" || stateAfter.firmware !== "accepted") {
      if (!selectedExact) throw new Error("Finish Eden's missing support items before verifying or changing its existing game folder.");
      return;
    }
    snapshot = await finishSetup(context, snapshot);
    snapshot = await launch(context, true);
  }
  const state = await inspectNativeLibrary(context, snapshot, directory);
  if (state === "connected") return;
  if (state === "type-conflict") throw new Error("The selected Switch folder is configured as external content in Eden. Change its type to Games in Eden before connecting it.");
  snapshot = await launch(context, true);
  await selectLibrary(context, snapshot, directory, state === "grant-missing");
  if (await inspectNativeLibrary(context, await launch(context, true), directory) !== "connected") {
    throw new Error("Eden did not retain the exact Switch game folder after restart.");
  }
}

async function verifyNativeContent(context: EmulatorUiContext, snapshot: AndroidUiSnapshot): Promise<void> {
  await openSettings(context, snapshot);
  const verify = await findLabel(context, "verify_installed_content", "option_title");
  await tapEmulatorNode(context, verify.snapshot, verify.node);
  const expected = await androidResourceText(context, PACKAGE, action("verify_success"));
  await waitEmulatorUi(context, async (value) => {
    if (!isEden(value)) return undefined;
    const title = uiNode(value, id("alertTitle")) ?? uiNode(value, "android:id/alertTitle");
    if (!title || value.nodes.some((node) => node.className === "android.widget.ProgressBar")) return undefined;
    if (title.text !== expected) throw new Error("Eden's installed-content verification failed. Check its report on the device.");
    const ok = uiNode(value, "android:id/button1");
    if (!ok) throw new Error("Eden's verification result cannot be confirmed.");
    await tapEmulatorNode(context, value, ok);
    return true;
  }, 180_000);
}

async function inspectNativeFirmware(context: EmulatorUiContext, snapshot: AndroidUiSnapshot): Promise<EdenConfigurationResult["firmware"]> {
  // The setup page calls isFirmwareAvailable directly. Reopening it through
  // Android Navigation does not reset the completed-onboarding preference.
  if (!dataPage(snapshot)) snapshot = await navigateEden(context, "firstTimeSetupFragment", "viewPager2");
  return dataStatus(await advanceToDataPage(context, snapshot)).firmware;
}

async function finishSetup(context: EmulatorUiContext, snapshot: AndroidUiSnapshot): Promise<AndroidUiSnapshot> {
  const state = dataStatus(snapshot);
  if (state.keys !== "accepted" || state.firmware !== "accepted" || state.library !== "accepted") {
    throw new Error("Complete Eden's missing support items before replacing an item it already accepts.");
  }
  const next = uiNode(snapshot, id("button_next"));
  if (!next) throw new Error("Eden's setup navigation is unavailable.");
  await tapEmulatorNode(context, snapshot, next);
  const final = await waitEmulatorUi(context, (value) => isEden(value) && uiNode(value, action("get_started")) ? value : undefined);
  const start = uiNode(final, action("get_started"));
  if (!start) throw new Error("Eden's setup completion action is unavailable.");
  await tapEmulatorNode(context, final, start);
  return waitEmulatorUi(context, (value) => isEden(value) && uiNode(value, id("settings_button")) ? value : undefined);
}

async function runEden<T>(device: DeviceTransport, options: EdenConfigurationOptions, action: (context: EmulatorUiContext) => Promise<T>): Promise<T> {
  const user = await readAndroidUser(device, options.signal);
  const scoped = userScopedDevice(device, user, options.signal);
  const info = await readAndroidPackage(scoped, PACKAGE, user, options.signal);
  if (!info) throw new Error("Install Eden before configuring its support files.");
  // The native resource/callback recipe is checked against the current official release.
  if (info.version !== "1f6734c" && info.version !== "0.2.1") throw new Error(`Eden ${info.version} is not supported by this configuration recipe.`);
  const lease = await keepDeviceAwake(scoped, user, { signal: options.signal });
  try {
    return await withAwakeDevice(scoped, user, { signal: options.signal, onUnlockRequired: options.onUnlockRequired }, (ensureUnlocked) =>
      withAndroidUiDump(scoped, options.signal, () => action({ device: scoped, user, signal: options.signal, ensureUnlocked })));
  } finally {
    await lease.release();
  }
}

/** Import only user-selected inputs, through Eden's native installers. */
export async function configureEden(device: DeviceTransport, files: readonly File[], options: EdenConfigurationOptions = {}): Promise<EdenConfigurationResult> {
  const inputs = await validateEdenInputs(files, options.signal);
  return runEden(device, options, async (context) => {
    const workspace = workspacePaths(primaryStorageForUser(context.user), options.folders);
    let snapshot = await launch(context, true);
    let selectedExact = false;
    if (dataPage(snapshot) && dataStatus(snapshot).library !== "accepted") {
      options.onStatus?.("Connecting Eden to the Switch game folder…");
      await selectLibrary(context, snapshot, `${workspace.roms}/switch`);
      snapshot = await launch(context, true);
      selectedExact = true;
    }
    const queue = [...inputs];
    if (dataPage(snapshot)) {
      const state = dataStatus(snapshot);
      queue.sort((left, right) => Number(state[left.kind === "keys" ? "keys" : "firmware"] === "accepted")
        - Number(state[right.kind === "keys" ? "keys" : "firmware"] === "accepted"));
    }
    const total = inputs.reduce((sum, input) => sum + input.file.size, 0);
    let transferred = 0;
    for (const input of queue) {
      if (dataPage(snapshot) && dataStatus(snapshot)[input.kind === "keys" ? "keys" : "firmware"] === "accepted") {
        snapshot = await finishSetup(context, snapshot);
      }
      options.onStatus?.(`Uploading ${input.file.name}…`);
      const staging = `${workspace.bios}/switch/import_${crypto.randomUUID().replaceAll("-", "")}`;
      await uploadMediaStoreFile(context.device, context.user, staging, input.file, {
        signal: context.signal, onProgress: (bytes) => options.onProgress?.(transferred + bytes, total),
      });
      transferred += input.file.size;
      options.onStatus?.(`Importing ${input.file.name} in Eden…`);
      const item = { kind: input.kind, name: input.file.name };
      await openImport(context, item, snapshot);
      await selectAndroidDocument(context, PACKAGE, `${staging}/${input.file.name}`, false,
        (view, node) => handoffNativeImport(context, item, view, node, options));
      snapshot = await launch(context, true);
    }
    options.onStatus?.("Restarting Eden and checking its native setup status…");
    let result = await verifyAfterRestart(context);
    if (result.keys === "accepted" && result.firmware === "accepted" && result.library === "accepted") {
      const current = await waitEmulatorUi(context, (value) => isEden(value) && dataPage(value) ? value : undefined);
      await finishSetup(context, current);
      result = { ...result, contentVerified: true };
    }
    if (result.keys === "accepted" && result.firmware === "accepted" && !dataPage(await launch(context))) {
      await ensureNativeLibrary(context, `${workspace.roms}/switch`);
      await verifyNativeContent(context, await launch(context, true));
      return { ...result, library: "accepted", contentVerified: true };
    }
    if (!selectedExact || !await hasAndroidTreeReadGrant(context, PACKAGE, `${workspace.roms}/switch`)) result = { ...result, library: "unverified" };
    return result;
  });
}

async function verifyAfterRestart(context: EmulatorUiContext): Promise<EdenConfigurationResult> {
  const { snapshot, keys } = await launchWithStatus(context, true);
  if (dataPage(snapshot)) return dataStatus(snapshot);
  const firmware = await inspectNativeFirmware(context, snapshot);
  // Keep later imports on the real library screen. A plain activity launch can
  // bring the diagnostic setup page forward instead of recreating MainActivity.
  await navigateEden(context, "gamesFragment", "settings_button");
  return { keys, firmware, library: "unverified", contentVerified: false };
}

/** Connect uploaded games through a real persisted SAF grant, without launching a game. */
export async function connectEdenLibrary(device: DeviceTransport, options: EdenConfigurationOptions = {}): Promise<void> {
  await runEden(device, options, async (context) => {
    const workspace = workspacePaths(primaryStorageForUser(context.user), options.folders);
    await ensureNativeLibrary(context, `${workspace.roms}/switch`);
  });
}

async function inspectSetup(context: EmulatorUiContext, folders?: LibraryFolderOptions): Promise<EdenConfigurationResult> {
  const { snapshot, keys } = await launchWithStatus(context, true);
  // Onboarding reports native acceptance, but its folder flag does not identify
  // the exact requested library or prove that initial setup has been completed.
  if (dataPage(snapshot)) return { ...dataStatus(snapshot), library: "unverified" };
  const firmware = await inspectNativeFirmware(context, snapshot);
  const workspace = workspacePaths(primaryStorageForUser(context.user), folders);
  const state = await inspectNativeLibrary(context, snapshot, `${workspace.roms}/switch`);
  return { keys, firmware, library: state === "connected" ? "accepted" : "unverified", contentVerified: false };
}

export async function verifyEden(device: DeviceTransport, options: EdenConfigurationOptions = {}): Promise<EdenConfigurationResult> {
  options.onStatus?.("Checking Eden's keys, firmware and game folder…");
  return runEden(device, options, (context) => inspectSetup(context, options.folders));
}

/** Complete missing setup using support files already supplied on this device. */
export async function repairEden(device: DeviceTransport, options: EdenConfigurationOptions = {}): Promise<EdenConfigurationResult> {
  return runEden(device, options, async (context) => {
    options.onStatus?.("Checking what Eden still needs…");
    const workspace = workspacePaths(primaryStorageForUser(context.user), options.folders);
    const result = await verifyAfterRestart(context);
    const needed = [
      ...(result.keys === "missing" ? ["keys" as const] : []),
      ...(result.firmware === "missing" ? ["firmware" as const] : []),
    ];
    if (result.keys === "unverified" || result.firmware === "unverified") throw new Error("Eden's missing support items could not be identified. Check its setup again.");
    const inputs = await findEdenDeviceInputs(context, workspace.bios, needed);
    let snapshot = await launch(context);
    if (dataPage(snapshot) && dataStatus(snapshot).library !== "accepted") {
      options.onStatus?.("Connecting Eden to the Switch game folder…");
      await selectLibrary(context, snapshot, `${workspace.roms}/switch`);
      snapshot = await launch(context);
    }
    for (const input of inputs) {
      options.onStatus?.(`Importing ${input.name} already on the device…`);
      await openImport(context, input, snapshot);
      await selectAndroidDocument(context, PACKAGE, input.path, false,
        (view, node) => handoffNativeImport(context, input, view, node, options));
      snapshot = await launch(context);
    }
    if (dataPage(snapshot)) await finishSetup(context, snapshot);
    options.onStatus?.("Saving Eden's game folder…");
    await ensureNativeLibrary(context, `${workspace.roms}/switch`);
    options.onStatus?.("Checking the completed setup…");
    return inspectSetup(context, options.folders);
  });
}
