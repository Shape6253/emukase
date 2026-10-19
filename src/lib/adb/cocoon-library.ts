import { hasAndroidTreeReadGrant, selectAndroidDocument } from "./android-document-picker";
import { primaryStorageForUser } from "./android-user";
import { AndroidUiStateChangedError, type AndroidUiNode, type AndroidUiSnapshot } from "./android-ui";
import { uiWithin } from "./emulator-ui";
import { activateCocoon, activateCocoonControl, cocoonAction, cocoonHas, cocoonMatches, cocoonTextAction,
  isCocoon, pressCocoonKey, scrollCocoonList, waitCocoonUi, COCOON_PACKAGE, type CocoonUiContext } from "./cocoon-navigation";
import { findCocoonListItem, findCocoonSetting, openCocoonTab } from "./cocoon-settings";
import { cocoonPlatformNames, type CocoonPlatformPlan } from "./cocoon-platforms";
import type { CocoonPlatformConfiguration } from "./cocoon-types";
import type { ConfigurationItemState } from "./emulator-configuration-types";

function directoryId(context: CocoonUiContext, directory: string): string {
  const prefix = `${primaryStorageForUser(context.user)}/`;
  if (!directory.startsWith(prefix)) throw new Error("Cocoon's folder belongs to another Android profile.");
  return `primary:${directory.slice(prefix.length)}`;
}

function rowHasText(snapshot: AndroidUiSnapshot, row: AndroidUiNode | undefined, text: string): boolean {
  return !!row && snapshot.nodes.some((node) => node.packageName === COCOON_PACKAGE && node.text === text && uiWithin(snapshot, node, row));
}

export async function cocoonRootConnected(context: CocoonUiContext, directory: string, configure: boolean): Promise<ConfigurationItemState> {
  const opened = await openCocoonTab(context, "settings_tab_library");
  let snapshot = await findCocoonSetting(context, "settings_library_title_rom_folder", opened);
  const connected = (value: AndroidUiSnapshot): boolean => rowHasText(value,
    cocoonAction(context, value, "settings_library_title_rom_folder"), directory.slice(directory.lastIndexOf("/") + 1));
  let granted = await hasAndroidTreeReadGrant(context, COCOON_PACKAGE, directory);
  if ((!connected(snapshot) || !granted) && configure) {
    context.onMutation?.();
    await activateCocoon(context, "settings_library_title_rom_folder", (value) => !isCocoon(value), snapshot);
    await selectAndroidDocument(context, COCOON_PACKAGE, directory, true, undefined, { keyboardNavigation: false });
    snapshot = await waitCocoonUi(context, (value) => connected(value) ? value : undefined);
    if (!granted) granted = await hasAndroidTreeReadGrant(context, COCOON_PACKAGE, directory);
  }
  // This native setting displays only a basename. The individual platform
  // sources below expose complete document IDs and provide the exact-path check.
  return connected(snapshot) && granted ? "unverified" : "missing";
}

function platformOpen(context: CocoonUiContext, snapshot: AndroidUiSnapshot, plan: CocoonPlatformPlan): boolean {
  return cocoonHas(context, snapshot, "settings_dialog_platform_title_emulator") && snapshot.nodes.some((node) =>
    node.packageName === COCOON_PACKAGE && cocoonPlatformNames(plan).includes(node.text) && !node.clickable);
}

async function openPlatform(context: CocoonUiContext, plan: CocoonPlatformPlan): Promise<AndroidUiSnapshot> {
  const control = (value: AndroidUiSnapshot): AndroidUiNode | undefined => cocoonPlatformNames(plan)
    .map((name) => cocoonTextAction(context, value, name)).find((node) => node !== undefined);
  const snapshot = await findCocoonListItem(context, (value) => !!control(value), "down");
  if (!snapshot) throw new Error(`Cocoon's ${plan.name} platform was not found. Refresh its public platform database in Library settings.`);
  return activateCocoonControl(context, control,
    (value) => platformOpen(context, value, plan), snapshot);
}

function playerControls(context: CocoonUiContext, snapshot: AndroidUiSnapshot): { field: AndroidUiNode; menu?: AndroidUiNode } | undefined {
  const row = cocoonAction(context, snapshot, "settings_dialog_platform_title_emulator");
  if (!row) return undefined;
  const index = snapshot.nodes.indexOf(row);
  const fields = snapshot.nodes.filter((node) => node.parent === index && node.clickable && node.enabled);
  const menus = snapshot.nodes.filter((node) => node.parent === index && node.scrollable && node.enabled);
  if (fields.length !== 1 || !fields[0] || menus.length > 1) throw new Error("Cocoon's default player controls are ambiguous.");
  return { field: fields[0], menu: menus[0] };
}

function playerSelected(context: CocoonUiContext, snapshot: AndroidUiSnapshot, name: string): boolean {
  return rowHasText(snapshot, playerControls(context, snapshot)?.field, name);
}

async function selectPlayer(context: CocoonUiContext, plan: CocoonPlatformPlan, initial: AndroidUiSnapshot): Promise<AndroidUiSnapshot> {
  let snapshot = await findCocoonSetting(context, "settings_dialog_platform_title_emulator", initial);
  if (playerSelected(context, snapshot, plan.playerName)) {
    if (playerControls(context, snapshot)?.menu) {
      await pressCocoonKey(context, "KEYCODE_BACK", snapshot);
      snapshot = await waitCocoonUi(context, (value) => playerSelected(context, value, plan.playerName) && !playerControls(context, value)?.menu ? value : undefined);
    }
    return snapshot;
  }
  if (!playerControls(context, snapshot)?.menu) {
    snapshot = await activateCocoonControl(context, (value) => playerControls(context, value)?.field,
      (value) => !!playerControls(context, value)?.menu, snapshot);
  }
  let previous = "";
  let repeated = 0;
  let atTop = false;
  for (let step = 0; step < 60; step++) {
    const menu = playerControls(context, snapshot)?.menu;
    if (!menu) throw new Error("Cocoon closed its player list before selecting the emulator.");
    const option = cocoonTextAction(context, snapshot, plan.playerName, menu);
    if (option) {
      snapshot = await activateCocoonControl(context, (value) => {
        const scope = playerControls(context, value)?.menu;
        return scope ? cocoonTextAction(context, value, plan.playerName, scope) : undefined;
      }, (value) => playerSelected(context, value, plan.playerName), snapshot);
      // Cocoon keeps this custom dropdown open after changing the value.
      if (playerControls(context, snapshot)?.menu) {
        await pressCocoonKey(context, "KEYCODE_BACK", snapshot);
        snapshot = await waitCocoonUi(context, (value) => playerSelected(context, value, plan.playerName)
          && !playerControls(context, value)?.menu ? value : undefined);
      }
      return snapshot;
    }
    const signature = JSON.stringify(snapshot.nodes.filter((node) => uiWithin(snapshot, node, menu) && node.text)
      .map((node) => [node.text, node.bounds]));
    repeated = signature === previous ? repeated + 1 : 0;
    if (repeated >= 2) {
      if (atTop) throw new Error(`Cocoon does not offer ${plan.playerName}. Check its platform database and installed emulator.`);
      atTop = true;
      previous = "";
      repeated = 0;
    } else previous = signature;
    try { await scrollCocoonList(context, snapshot, menu, atTop ? "down" : "up"); }
    catch (error) { if (!(error instanceof AndroidUiStateChangedError)) throw error; }
    snapshot = await waitCocoonUi(context, (value) => platformOpen(context, value, plan) ? value : undefined);
  }
  throw new Error("Cocoon's player list navigation exceeded its limit.");
}

async function folderSelected(
  context: CocoonUiContext, directory: string, rootGranted: boolean, initial: AndroidUiSnapshot,
): Promise<{ connected: boolean; snapshot: AndroidUiSnapshot }> {
  const id = directoryId(context, directory);
  let latest = initial;
  const snapshot = await findCocoonListItem(context, (value) => {
    latest = value;
    return value.nodes.some((node) => node.packageName === COCOON_PACKAGE && node.text === id && node.bounds[3] > node.bounds[1]);
  }, "down", initial);
  return { connected: !!snapshot && (rootGranted || await hasAndroidTreeReadGrant(context, COCOON_PACKAGE, directory)),
    snapshot: snapshot ?? latest };
}

export async function inspectCocoonPlatform(
  context: CocoonUiContext, plan: CocoonPlatformPlan, directory: string, installed: boolean, configure: boolean,
  rootGranted?: boolean,
): Promise<CocoonPlatformConfiguration> {
  if (!installed) return { platformId: plan.platformId, emulatorPackage: plan.emulatorPackage, coreId: plan.coreId,
    playerId: plan.playerId, state: "missing", folder: "unverified", player: "missing", romDirectory: directory };
  let phase = "open its platform settings";
  try {
    const parentGranted = rootGranted ?? await hasAndroidTreeReadGrant(context, COCOON_PACKAGE, directory.slice(0, directory.lastIndexOf("/")));
    let snapshot = await openPlatform(context, plan);
    let changed = configure && !playerSelected(context, snapshot, plan.playerName);
    phase = "select its default player";
    if (configure) snapshot = await selectPlayer(context, plan, snapshot);
    phase = "read its default player";
    const player = playerSelected(context, snapshot, plan.playerName) ? "accepted" : "missing";
    phase = "read its ROM folders";
    let folder = await folderSelected(context, directory, parentGranted, snapshot);
    snapshot = folder.snapshot;
    let connected = folder.connected;
    if (!connected && configure) {
      changed = true;
      // Cocoon's root scan registers only folders containing games. Empty
      // platform folders still need this native registration and callback.
      phase = "open its ROM folder picker";
      snapshot = await findCocoonSetting(context, "settings_dialog_platform_add_folder", snapshot);
      await activateCocoon(context, "settings_dialog_platform_add_folder", (value) => !isCocoon(value), snapshot);
      phase = "choose its ROM folder";
      await selectAndroidDocument(context, COCOON_PACKAGE, directory, true);
      phase = "read its selected ROM folder";
      snapshot = await waitCocoonUi(context, (value) => isCocoon(value) && value.nodes.some((node) => node.text === directoryId(context, directory)) ? value : undefined);
      folder = await folderSelected(context, directory, parentGranted, snapshot);
      snapshot = folder.snapshot;
      connected = folder.connected;
      if (!connected) throw new Error(`Cocoon did not retain ${plan.name}'s selected ROM folder.`);
    }
    phase = changed ? "save its platform settings" : "close its platform settings";
    if (changed) context.onMutation?.();
    // Y commits this native dialog. Back discards its temporary player choices.
    await activateCocoonControl(context, (value) => value.nodes.find((node) => node.packageName === COCOON_PACKAGE
      && cocoonPlatformNames(plan).includes(node.text) && !node.clickable),
      (value) => isCocoon(value) && !value.nodes.some((node) => cocoonMatches(context, node, "settings_dialog_platform_title_emulator")
        || cocoonMatches(context, node, "settings_dialog_platform_add_folder")
        || (node.packageName === COCOON_PACKAGE && node.className === "android.widget.ImageView" && node.description === "Y")),
      snapshot, (value) => pressCocoonKey(context, changed ? "KEYCODE_BUTTON_Y" : "KEYCODE_BACK", value));
    return { platformId: plan.platformId, emulatorPackage: plan.emulatorPackage, coreId: plan.coreId, playerId: plan.playerId,
      romDirectory: directory, state: connected && player === "accepted" ? "accepted" : "missing",
      folder: connected ? "accepted" : "missing", player };
  } catch (error) {
    context.signal?.throwIfAborted();
    throw new Error(`Cocoon could not ${phase} for ${plan.name}. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
