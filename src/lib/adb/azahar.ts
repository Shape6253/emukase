import { grantPackagePermissions, readAndroidPackage } from "./android-package";
import { hasAndroidTreeReadGrant, selectAndroidDocument } from "./android-document-picker";
import { hasAndroidAllFilesAccess, prepareAndroidAllFilesAccess } from "./android-storage-access";
import { AndroidUiStateChangedError, type AndroidUiNode, type AndroidUiSnapshot } from "./android-ui";
import { primaryStorageForUser } from "./android-user";
import { DeviceUnlockRequiredError } from "./device-awake";
import type { EmulatorConfigurationOptions } from "./emulator-configuration-types";
import { EMULATORS } from "./emulators";
import { androidResourceText, emulatorNodeVisible, restartEmulator, scrollEmulatorList, tapEmulatorNode, uiWithin, waitEmulatorUi, type EmulatorUiContext } from "./emulator-ui";
import { runGameFolderConfiguration, type GameFolderConfigurationResult } from "./game-folder-configuration";
import { prepareEmulatorFolders } from "./media-store";
import { checkActivityStart, shellCommand, type DeviceTransport } from "./transport";
import { readAndroidSdk } from "./android-version";
import { workspacePaths } from "./workspace";

const PACKAGE = EMULATORS.azahar.packages[0];
const ACTIVITY = `${PACKAGE}/org.citra.citra_emu.ui.main.MainActivity`;
const id = (name: string): string => `${PACKAGE}:id/${name}`;
const DATA_FOLDER = `${PACKAGE}:string/select_citra_user_folder`;
const GAME_FOLDER = `${PACKAGE}:string/games`;
const PICKER_OPTIONS = { directoryNavigation: "scroll-first" } as const;

interface AzaharContext extends EmulatorUiContext {
  text: (name: string) => Promise<string>;
}

function node(snapshot: AndroidUiSnapshot, resource: string, within?: AndroidUiNode): AndroidUiNode | undefined {
  const window = snapshot.nodes[0];
  if (!window) return undefined;
  // ViewPager retains adjacent setup pages. Ignore controls outside the window
  // instead of mistaking an outgoing page for the current onboarding step.
  const matches = snapshot.nodes.filter((node) => node.resourceId === resource && node.bounds[2] > node.bounds[0] && node.bounds[3] > node.bounds[1]
    && node.bounds[0] >= window.bounds[0] && node.bounds[1] >= window.bounds[1]
    && node.bounds[2] <= window.bounds[2] && node.bounds[3] <= window.bounds[3]
    && (!within || uiWithin(snapshot, node, within)));
  if (matches.length > 1) throw new AndroidUiStateChangedError(`Azahar is changing its ${resource} controls.`);
  return matches[0];
}

function control(snapshot: AndroidUiSnapshot, resource: string): AndroidUiNode | undefined {
  const target = node(snapshot, resource);
  return target?.enabled && emulatorNodeVisible(snapshot, target) ? target : undefined;
}

async function tapReviewedControl(
  context: AzaharContext, initial: AndroidUiSnapshot, review: (snapshot: AndroidUiSnapshot) => AndroidUiNode | undefined,
): Promise<void> {
  const act = async (snapshot: AndroidUiSnapshot): Promise<true | undefined> => {
    const target = snapshot.component === ACTIVITY ? review(snapshot) : undefined;
    if (!target) return undefined;
    await tapEmulatorNode(context, snapshot, target, { retryStale: false });
    return true;
  };
  try {
    if (await act(initial)) return;
  } catch (error) {
    if (error instanceof DeviceUnlockRequiredError) await context.ensureUnlocked();
    else if (!(error instanceof AndroidUiStateChangedError)) throw error;
  }
  // Animations may change unrelated nodes before dispatch. Recheck the
  // caller's page or dialog conditions, not just the button's identity.
  await waitEmulatorUi(context, act);
}

function setupControl(snapshot: AndroidUiSnapshot, title: string, resource: string): AndroidUiNode | undefined {
  return node(snapshot, id("setup_root")) && node(snapshot, id("text_title"))?.text === title ? control(snapshot, resource) : undefined;
}

function setupFolderState(snapshot: AndroidUiSnapshot, title: string): { needsData: boolean; needsGames: boolean } | undefined {
  if (snapshot.component !== ACTIVITY || !node(snapshot, id("setup_root"))) return undefined;
  const heading = node(snapshot, id("text_title"));
  const pager = node(snapshot, id("viewPager2"));
  if (heading?.text !== title || !pager) return undefined;
  // The landscape layout places the title and controls in separate columns
  // inside the same RecyclerView item.
  let page = heading;
  while (page.parent !== null) {
    const parent = snapshot.nodes[page.parent];
    if (!parent || parent === pager) return undefined;
    if (parent.parent !== null && snapshot.nodes[parent.parent] === pager) break;
    page = parent;
  }
  if (page.parent === null) return undefined;
  const data = node(snapshot, DATA_FOLDER, page);
  const games = node(snapshot, GAME_FOLDER, page);
  if (data && games) return { needsData: data.enabled, needsGames: games.enabled };
  // Azahar hides the folder buttons on completion. Require its confirmation
  // so a ViewPager transition cannot count as a completed step.
  if (!data?.enabled && !games?.enabled && node(snapshot, id("text_confirmation"), page)) {
    return { needsData: false, needsGames: false };
  }
  return undefined;
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
      || node(snapshot, id("grid_games")) && control(snapshot, id("homeSettingsFragment"))
      || node(snapshot, id("scroll_view_settings"))) ? snapshot : undefined);
  // Settings constructs the GPU driver model, which requires the user folder
  // selected during onboarding. A deep link before that selection crashes Azahar.
  if (node(initial, id("setup_root")) || node(initial, id("scroll_view_settings"))) return initial;
  await tapReviewedControl(context, initial, (snapshot) =>
    node(snapshot, id("grid_games")) ? control(snapshot, id("homeSettingsFragment")) : undefined);
  return waitEmulatorUi(context, (snapshot) => snapshot.component === ACTIVITY
    && (node(snapshot, id("setup_root")) && node(snapshot, id("text_title"))
      || node(snapshot, id("scroll_view_settings"))) ? snapshot : undefined);
}

async function storageAccess(context: AzaharContext, inspectOnly: boolean): Promise<boolean> {
  const installed = await readAndroidPackage(context.device, PACKAGE, context.user, context.signal);
  if (!installed) throw new Error("Azahar is no longer installed in this Android profile.");
  const sdk = await readAndroidSdk(context.device, context.signal);
  if (sdk >= 30) {
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

async function nextSetupPage(context: AzaharContext, snapshot: AndroidUiSnapshot, previous: string, skip?: string): Promise<AndroidUiSnapshot> {
  await tapReviewedControl(context, snapshot, (value) => setupControl(value, previous, id("button_next")));
  const advanced = (value: AndroidUiSnapshot): AndroidUiSnapshot | undefined => {
    const title = value.component === ACTIVITY ? node(value, id("text_title")) : undefined;
    return title && title.text !== previous ? value : undefined;
  };
  return waitEmulatorUi(context, async (value) => {
    if (value.component !== ACTIVITY) return undefined;
    const positive = control(value, "android:id/button1");
    // Skip only Azahar's optional-permission warning, not an arbitrary dialog.
    if (positive && positive.text === skip && node(value, "android:id/button2")) {
      await tapEmulatorNode(context, value, positive, { retryStale: false });
      return waitEmulatorUi(context, advanced);
    }
    return advanced(value);
  });
}

async function chooseDataFolder(
  context: AzaharContext, snapshot: AndroidUiSnapshot, title: string, directory: string,
): Promise<{ snapshot: AndroidUiSnapshot; needsGames: boolean }> {
  await tapReviewedControl(context, snapshot, (value) => setupControl(value, title, DATA_FOLDER));
  await selectAndroidDocument(context, PACKAGE, directory, true, undefined, PICKER_OPTIONS);
  await waitEmulatorUi(context, async (value) => {
    if (value.component !== ACTIVITY || node(value, id("path"))?.text !== treePath(context, directory)) return undefined;
    if (node(value, id("checkBox"))?.checked) throw new Error("Azahar requested moving existing data. No move was confirmed.");
    const ok = control(value, "android:id/button1");
    if (!ok) return undefined;
    await tapEmulatorNode(context, value, ok, { retryStale: false });
    return true;
  });
  return waitEmulatorUi(context, async (value) => {
    const folders = setupFolderState(value, title);
    return folders && !folders.needsData && !node(value, id("path"))
      && await hasAndroidTreeReadGrant(context, PACKAGE, directory, true) ? { snapshot: value, needsGames: folders.needsGames } : undefined;
  });
}

async function finishSetup(context: AzaharContext, options: EmulatorConfigurationOptions, initial: AndroidUiSnapshot): Promise<void> {
  const workspace = workspacePaths(primaryStorageForUser(context.user), options.folders);
  const data = `${workspace.root}/Azahar`;
  const games = `${workspace.roms}/n3ds`;
  const [permissions, directories, welcome, skip] = await Promise.all([
    context.text("permissions"), context.text("select_emulator_data_folders"), context.text("welcome"), context.text("warning_skip"),
  ]);
  const ready = (value: AndroidUiSnapshot) => {
    if (value.component !== ACTIVITY) return undefined;
    if (!node(value, id("setup_root"))) return { snapshot: value };
    const title = node(value, id("text_title"))?.text;
    if (!title) return undefined;
    const folders = title === directories ? setupFolderState(value, directories) : undefined;
    if (title === directories && !folders) return undefined;
    const resource = title === welcome ? `${PACKAGE}:string/get_started`
      : title === permissions || title === directories ? id("button_next") : `${PACKAGE}:string/text_continue`;
    return control(value, resource) ? { snapshot: value, title, resource, folders } : undefined;
  };
  let snapshot = initial;
  for (let step = 0; step < 6; step++) {
    const page = ready(snapshot) ?? await waitEmulatorUi(context, ready);
    snapshot = page.snapshot;
    if (!page.title) return;
    if (page.title === welcome) {
      await tapReviewedControl(context, snapshot, (value) => setupControl(value, page.title, page.resource));
      snapshot = await waitEmulatorUi(context, (value) => value.component === ACTIVITY && node(value, id("text_title"))?.text === permissions ? value : undefined);
    } else if (page.title === permissions) {
      // Camera, microphone and notification access are optional; don't grant them.
      snapshot = await nextSetupPage(context, snapshot, permissions, skip);
    } else if (page.folders) {
      const { needsData, needsGames } = page.folders;
      let connectGames = needsGames;
      if (needsData) {
        options.onStatus?.("Preparing Azahar's shared folders…");
        await prepareEmulatorFolders(context.device, context.user, needsGames ? [data, games] : [data], context.signal);
        options.onStatus?.("Selecting Azahar's data folder…");
        const selected = await chooseDataFolder(context, snapshot, directories, data);
        snapshot = selected.snapshot;
        connectGames = selected.needsGames;
      }
      if (connectGames) {
        options.onStatus?.("Connecting Azahar to the Nintendo 3DS game folder…");
        if (!needsData || !needsGames) await prepareEmulatorFolders(context.device, context.user, [games], context.signal);
        await tapReviewedControl(context, snapshot, (value) => setupControl(value, directories, GAME_FOLDER));
        await selectAndroidDocument(context, PACKAGE, games, true, undefined, PICKER_OPTIONS);
        snapshot = await waitEmulatorUi(context, async (value) => {
          const folders = setupFolderState(value, directories);
          return folders && !folders.needsGames && control(value, id("button_next"))
            && await hasAndroidTreeReadGrant(context, PACKAGE, games) ? value : undefined;
        });
      }
      snapshot = await nextSetupPage(context, snapshot, directories);
    } else {
      await tapReviewedControl(context, snapshot, (value) => setupControl(value, page.title, page.resource));
      await waitEmulatorUi(context, (value) => value.component === ACTIVITY && !node(value, id("setup_root")) ? true : undefined);
      return;
    }
  }
  throw new Error("Azahar did not finish its initial setup.");
}

async function gameFolderOption(context: AzaharContext, initial: AndroidUiSnapshot): Promise<{ snapshot: AndroidUiSnapshot; title: AndroidUiNode; path: string | undefined }> {
  const label = await context.text("select_games_folder");
  let previous = "";
  let unchanged = 0;
  for (let attempt = 0; attempt < 24; attempt++) {
    const snapshot = attempt === 0 && node(initial, id("scroll_view_settings")) ? initial
      : await waitEmulatorUi(context, (value) => value.component === ACTIVITY && node(value, id("scroll_view_settings")) ? value : undefined);
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
    if (signature === previous) {
      // Accessibility scrolling can return before Android redraws the list.
      if (++unchanged >= 2) break;
      continue;
    }
    unchanged = 0;
    const scroll = node(snapshot, id("scroll_view_settings"));
    if (!scroll?.scrollable) break;
    previous = await scrollEmulatorList(context, snapshot, scroll) ? signature : "";
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
    let initial = await launch(context);
    if (node(initial, id("setup_root"))) {
      if (options.inspectOnly) return { library: "unverified", setupComplete: false, contentVerified: false };
      options.onStatus?.("Completing Azahar's initial setup…");
      await finishSetup(context, options, initial);
      options.onStatus?.("Restarting Azahar and checking its saved setup…");
      await restartEmulator(context, PACKAGE, "Azahar");
      initial = await launch(context);
    }
    const option = await gameFolderOption(context, initial);
    const state = await folderResult(context, directory, option.path);
    if (options.inspectOnly || state.library === "accepted") return state;
    options.onStatus?.("Connecting Azahar to the Nintendo 3DS game folder…");
    await prepareEmulatorFolders(context.device, context.user, [directory], context.signal);
    await tapEmulatorNode(context, option.snapshot, option.title);
    await selectAndroidDocument(context, PACKAGE, directory, true, undefined, PICKER_OPTIONS);
    await waitEmulatorUi(context, (value) => value.component === ACTIVITY
      && value.nodes.some((entry) => entry.resourceId === id("option_detail") && entry.text === treePath(context, directory)) ? true : undefined);
    options.onStatus?.("Restarting Azahar and checking its saved game folder…");
    await restartEmulator(context, PACKAGE, "Azahar");
    return folderResult(context, directory, (await gameFolderOption(context, await launch(context))).path);
  });
}

export function configureAzahar(device: DeviceTransport, files: readonly File[], options: EmulatorConfigurationOptions = {}): Promise<GameFolderConfigurationResult> {
  if (files.length) throw new Error("Azahar does not import support files for this platform.");
  return verifyAzahar(device, { ...options, inspectOnly: false });
}
