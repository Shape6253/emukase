import { grantPackagePermissions, readAndroidPackage } from "./android-package";
import { hasAndroidTreeReadGrant, selectAndroidDocument } from "./android-document-picker";
import { hasAndroidAllFilesAccess, prepareAndroidAllFilesAccess } from "./android-storage-access";
import { AndroidUiStateChangedError, type AndroidUiNode, type AndroidUiSnapshot } from "./android-ui";
import { primaryStorageForUser } from "./android-user";
import type { EmulatorConfigurationOptions } from "./emulator-configuration-types";
import { EMULATORS } from "./emulators";
import { androidResourceText, emulatorNodeVisible, restartEmulator, scrollEmulatorList, tapEmulatorNode, uiWithin, waitEmulatorUi, type EmulatorUiContext } from "./emulator-ui";
import { runGameFolderConfiguration, type GameFolderConfigurationResult } from "./game-folder-configuration";
import { createMediaStoreFolders } from "./media-store";
import { checkActivityStart, shellCommand, type DeviceTransport } from "./transport";
import { workspacePaths } from "./workspace";

const PACKAGE = EMULATORS.azahar.packages[0];
const ACTIVITY = `${PACKAGE}/org.citra.citra_emu.ui.main.MainActivity`;
const id = (name: string): string => `${PACKAGE}:id/${name}`;

interface AzaharContext extends EmulatorUiContext {
  text: (name: string) => Promise<string>;
}

function node(snapshot: AndroidUiSnapshot, resource: string): AndroidUiNode | undefined {
  const window = snapshot.nodes[0];
  if (!window) return undefined;
  // ViewPager retains adjacent setup pages. Ignore controls outside the window
  // instead of mistaking an outgoing page for the current onboarding step.
  const matches = snapshot.nodes.filter((node) => node.resourceId === resource && node.bounds[2] > node.bounds[0] && node.bounds[3] > node.bounds[1]
    && node.bounds[0] >= window.bounds[0] && node.bounds[1] >= window.bounds[1]
    && node.bounds[2] <= window.bounds[2] && node.bounds[3] <= window.bounds[3]);
  if (matches.length > 1) throw new AndroidUiStateChangedError(`Azahar is changing its ${resource} controls.`);
  return matches[0];
}

async function tap(context: AzaharContext, resource: string): Promise<void> {
  const found = await waitEmulatorUi(context, (snapshot) => {
    if (snapshot.component !== ACTIVITY) return undefined;
    const target = node(snapshot, resource);
    return target?.enabled && emulatorNodeVisible(snapshot, target) ? { snapshot, target } : undefined;
  });
  await tapEmulatorNode(context, found.snapshot, found.target);
}

function treePath(context: EmulatorUiContext, directory: string): string {
  return `/tree/primary:${directory.slice(primaryStorageForUser(context.user).length + 1)}`;
}

async function launch(context: AzaharContext): Promise<AndroidUiSnapshot> {
  await context.ensureUnlocked();
  checkActivityStart(await context.device.shell(shellCommand("am", "start", "--user", String(context.user), "--display", "0", "-W",
    "-f", "0x10008000", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", ACTIVITY)));
  const initial = await waitEmulatorUi(context, (snapshot) => snapshot.component === ACTIVITY
    && (node(snapshot, id("setup_root")) && node(snapshot, id("text_title"))
      || node(snapshot, id("grid_games")) && node(snapshot, id("homeSettingsFragment"))
      || node(snapshot, id("scroll_view_settings"))) ? snapshot : undefined);
  // Settings constructs the GPU driver model, which requires the user folder
  // selected during onboarding. A deep link before that selection crashes Azahar.
  if (node(initial, id("setup_root")) || node(initial, id("scroll_view_settings"))) return initial;
  await tap(context, id("homeSettingsFragment"));
  return waitEmulatorUi(context, (snapshot) => snapshot.component === ACTIVITY
    && (node(snapshot, id("setup_root")) && node(snapshot, id("text_title"))
      || node(snapshot, id("scroll_view_settings"))) ? snapshot : undefined);
}

async function storageAccess(context: AzaharContext, inspectOnly: boolean): Promise<boolean> {
  const installed = await readAndroidPackage(context.device, PACKAGE, context.user, context.signal);
  if (!installed) throw new Error("Azahar is no longer installed in this Android profile.");
  const sdk = (await context.device.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
  if (!/^[1-9]\d*$/.test(sdk) || !Number.isSafeInteger(Number(sdk))) throw new Error("Android's version could not be confirmed.");
  if (Number(sdk) >= 30) {
    if (installed.requestedPermissions.includes("android.permission.MANAGE_EXTERNAL_STORAGE")) {
      if (inspectOnly) return hasAndroidAllFilesAccess(context, PACKAGE);
      await prepareAndroidAllFilesAccess(context, PACKAGE, "Azahar");
    }
  } else {
    const required = installed.requestedPermissions.filter((permission) => [
      "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE",
    ].includes(permission));
    const missing = required.filter((permission) => !installed.grantedPermissions.has(permission));
    if (inspectOnly) return missing.length === 0;
    if (missing.length) await grantPackagePermissions(context.device, PACKAGE, context.user, missing, context.signal);
  }
  return true;
}

async function nextSetupPage(context: AzaharContext, previous: string): Promise<AndroidUiSnapshot> {
  await tap(context, id("button_next"));
  const skip = await context.text("warning_skip");
  return waitEmulatorUi(context, async (snapshot) => {
    if (snapshot.component !== ACTIVITY) return undefined;
    const positive = node(snapshot, "android:id/button1");
    // Skip only Azahar's optional-permission warning, not an arbitrary dialog.
    if (positive?.text === skip && node(snapshot, "android:id/button2")) {
      await tapEmulatorNode(context, snapshot, positive);
      return undefined;
    }
    const title = node(snapshot, id("text_title"));
    return title && title.text !== previous ? snapshot : undefined;
  });
}

async function chooseDataFolder(context: AzaharContext, directory: string): Promise<void> {
  await tap(context, `${PACKAGE}:string/select_citra_user_folder`);
  await selectAndroidDocument(context, PACKAGE, directory, true, undefined, { keyboardNavigation: true });
  const confirmation = await waitEmulatorUi(context, (snapshot) => snapshot.component === ACTIVITY
    && node(snapshot, id("path"))?.text === treePath(context, directory) ? snapshot : undefined);
  if (node(confirmation, id("checkBox"))?.checked) throw new Error("Azahar requested moving existing data. No move was confirmed.");
  const ok = node(confirmation, "android:id/button1");
  if (!ok?.enabled) throw new Error("Azahar's data-folder confirmation is unavailable.");
  await tapEmulatorNode(context, confirmation, ok);
  await waitEmulatorUi(context, async (snapshot) => snapshot.component === ACTIVITY && !node(snapshot, id("path"))
    && await hasAndroidTreeReadGrant(context, PACKAGE, directory, true) ? true : undefined);
}

async function finishSetup(context: AzaharContext, options: EmulatorConfigurationOptions, initial: AndroidUiSnapshot): Promise<void> {
  const workspace = workspacePaths(primaryStorageForUser(context.user), options.folders);
  const data = `${workspace.root}/Azahar`;
  const games = `${workspace.roms}/n3ds`;
  const permissions = await context.text("permissions");
  const directories = await context.text("select_emulator_data_folders");
  const welcome = await context.text("welcome");
  let snapshot = initial;
  for (let step = 0; step < 6; step++) {
    snapshot = await waitEmulatorUi(context, (value) => {
      if (value.component !== ACTIVITY) return undefined;
      if (!node(value, id("setup_root"))) return value;
      const title = node(value, id("text_title"))?.text;
      const action = title === welcome ? node(value, `${PACKAGE}:string/get_started`)
        : title === permissions || title === directories ? node(value, id("button_next"))
        : node(value, `${PACKAGE}:string/text_continue`);
      return action?.enabled && emulatorNodeVisible(value, action) ? value : undefined;
    });
    if (!node(snapshot, id("setup_root"))) return;
    const title = node(snapshot, id("text_title"))?.text;
    if (title === welcome && node(snapshot, `${PACKAGE}:string/get_started`)) {
      await tap(context, `${PACKAGE}:string/get_started`);
      snapshot = await waitEmulatorUi(context, (value) => value.component === ACTIVITY && node(value, id("text_title"))?.text === permissions ? value : undefined);
    } else if (title === permissions) {
      // Camera, microphone and notification access are optional; don't grant them.
      snapshot = await nextSetupPage(context, permissions);
    } else if (title === directories) {
      const userFolder = node(snapshot, `${PACKAGE}:string/select_citra_user_folder`);
      if (userFolder?.enabled) {
        options.onStatus?.("Selecting Azahar's data folder…");
        await createMediaStoreFolders(context.device, context.user, [data], context.signal);
        await chooseDataFolder(context, data);
      }
      const current = await waitEmulatorUi(context, (value) => value.component === ACTIVITY ? value : undefined);
      if (node(current, `${PACKAGE}:string/games`)?.enabled) {
        options.onStatus?.("Connecting Azahar to the Nintendo 3DS game folder…");
        await createMediaStoreFolders(context.device, context.user, [games], context.signal);
        await tap(context, `${PACKAGE}:string/games`);
        await selectAndroidDocument(context, PACKAGE, games, true, undefined, { keyboardNavigation: true });
        await waitEmulatorUi(context, async (value) => value.component === ACTIVITY
          && await hasAndroidTreeReadGrant(context, PACKAGE, games) ? true : undefined);
      }
      snapshot = await nextSetupPage(context, directories);
    } else if (node(snapshot, `${PACKAGE}:string/text_continue`)) {
      await tap(context, `${PACKAGE}:string/text_continue`);
      snapshot = await waitEmulatorUi(context, (value) => value.component === ACTIVITY && !node(value, id("setup_root")) ? value : undefined);
    } else {
      throw new Error("Azahar's initial setup page is unsupported. Complete it on the device, then check again.");
    }
  }
  throw new Error("Azahar did not finish its initial setup.");
}

async function gameFolderOption(context: AzaharContext): Promise<{ snapshot: AndroidUiSnapshot; title: AndroidUiNode; path: string | undefined }> {
  const label = await context.text("select_games_folder");
  let previous = "";
  for (let attempt = 0; attempt < 24; attempt++) {
    const snapshot = await waitEmulatorUi(context, (value) => value.component === ACTIVITY && node(value, id("scroll_view_settings")) ? value : undefined);
    const titles = snapshot.nodes.filter((entry) => entry.resourceId === id("option_title") && entry.text === label);
    const title = titles[0];
    if (titles.length > 1) throw new Error("Azahar's game-folder option is ambiguous.");
    if (title && emulatorNodeVisible(snapshot, title)) {
      let card: AndroidUiNode | undefined = title;
      while (card && card.resourceId !== id("option_card")) card = card.parent === null ? undefined : snapshot.nodes[card.parent];
      if (!card) throw new Error("Azahar's game-folder settings row is unavailable.");
      const details = snapshot.nodes.filter((entry) => entry.resourceId === id("option_detail") && uiWithin(snapshot, entry, card));
      if (details.length > 1) throw new Error("Azahar's saved game folder is ambiguous.");
      return { snapshot, title, path: details[0]?.text };
    }
    const signature = JSON.stringify(snapshot.nodes.map((entry) => [entry.resourceId, entry.text, entry.bounds]));
    if (signature === previous) break;
    previous = signature;
    const scroll = node(snapshot, id("scroll_view_settings"));
    if (!scroll?.scrollable) break;
    await scrollEmulatorList(context, snapshot, scroll);
  }
  throw new Error("Azahar's game-folder setting was not found.");
}

async function folderResult(context: AzaharContext, directory: string, path: string | undefined): Promise<GameFolderConfigurationResult> {
  const grant = await hasAndroidTreeReadGrant(context, PACKAGE, directory);
  const connected = path === treePath(context, directory) && grant;
  return { library: connected ? "accepted" : grant ? "unverified" : "missing", setupComplete: connected, contentVerified: false };
}

export async function verifyAzahar(device: DeviceTransport, options: EmulatorConfigurationOptions = {}): Promise<GameFolderConfigurationResult> {
  return runGameFolderConfiguration(device, PACKAGE, "Azahar", options, async (base) => {
    const labels = new Map<string, string>();
    const context: AzaharContext = { ...base, async text(name) {
      let value = labels.get(name);
      if (value === undefined) { value = await androidResourceText(base, PACKAGE, `${PACKAGE}:string/${name}`); labels.set(name, value); }
      return value;
    } };
    const directory = `${workspacePaths(primaryStorageForUser(context.user), options.folders).roms}/n3ds`;
    if (!await storageAccess(context, options.inspectOnly === true)) {
      return { library: "unverified", setupComplete: false, contentVerified: false };
    }
    options.onStatus?.("Opening Azahar's saved setup…");
    await restartEmulator(context, PACKAGE, "Azahar");
    const initial = await launch(context);
    if (node(initial, id("setup_root"))) {
      if (options.inspectOnly) return { library: "unverified", setupComplete: false, contentVerified: false };
      options.onStatus?.("Completing Azahar's initial setup…");
      await finishSetup(context, options, initial);
      options.onStatus?.("Restarting Azahar and checking its saved setup…");
      await restartEmulator(context, PACKAGE, "Azahar");
      await launch(context);
    }
    const option = await gameFolderOption(context);
    const state = await folderResult(context, directory, option.path);
    if (options.inspectOnly || state.library === "accepted") return state;
    options.onStatus?.("Connecting Azahar to the Nintendo 3DS game folder…");
    await createMediaStoreFolders(context.device, context.user, [directory], context.signal);
    await tapEmulatorNode(context, option.snapshot, option.title);
    await selectAndroidDocument(context, PACKAGE, directory, true, undefined, { keyboardNavigation: true });
    await waitEmulatorUi(context, (value) => value.component === ACTIVITY
      && value.nodes.some((entry) => entry.resourceId === id("option_detail") && entry.text === treePath(context, directory)) ? true : undefined);
    options.onStatus?.("Restarting Azahar and checking its saved game folder…");
    await restartEmulator(context, PACKAGE, "Azahar");
    await launch(context);
    return folderResult(context, directory, (await gameFolderOption(context)).path);
  });
}

export function configureAzahar(device: DeviceTransport, files: readonly File[], options: EmulatorConfigurationOptions = {}): Promise<GameFolderConfigurationResult> {
  if (files.length) throw new Error("Azahar does not import support files for this platform.");
  return verifyAzahar(device, { ...options, inspectOnly: false });
}
