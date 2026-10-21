import { AndroidUiStateChangedError, readAndroidUi, type AndroidUiNode, type AndroidUiSnapshot } from "./android-ui";
import { assertAndroidUser } from "./android-user";
import { readAndroidResourceLabels, type AndroidResourceLabels } from "./android-resource-labels";
import { emulatorNodeVisible, restartEmulator, tapEmulatorNode, uiWithin, waitEmulatorUi, type EmulatorUiContext } from "./emulator-ui";
import { checkAbort } from "./setup-events";
import { checkActivityStart, shellCommand } from "./transport";

export const COCOON_PACKAGE = "rip.moth.cocoonshell";
export const COCOON_MAIN_ACTIVITY = `${COCOON_PACKAGE}/.MainActivity`;
export const COCOON_ONBOARDING_ACTIVITY = `${COCOON_PACKAGE}/${COCOON_PACKAGE}.ui.activity.onboarding.OnboardingV2Activity`;
export const COCOON_SETTINGS_ACTIVITY = `${COCOON_PACKAGE}/${COCOON_PACKAGE}.ui.activity.SettingsActivity`;

const RESOURCES = [
  "common_settings", "common_cocoon_settings", "common_search",
  "onboarding_v2_button_continue", "onboarding_v2_button_ok", "onboarding_v2_button_skip",
  "onboarding_v2_welcome_title", "onboarding_v2_screen_check_title", "onboarding_v2_default_launcher_title",
  "onboarding_v2_usage_title", "onboarding_v2_storage_title", "onboarding_v2_data_dir_title",
  "onboarding_v2_data_dir_choose", "onboarding_v2_data_dir_error_perm", "onboarding_v2_data_dir_error_write",
  "onboarding_v2_personalize_title", "onboarding_v2_org_mode_title", "onboarding_v2_smart_folders",
  "onboarding_v2_login_title", "onboarding_v2_restore_title", "onboarding_v2_restore_continue_without",
  "onboarding_v2_platform_title", "onboarding_v2_platform_download_now", "onboarding_v2_platform_finish",
  "onboarding_v2_platform_error_generic", "onboarding_v2_rom_title", "onboarding_v2_rom_select",
  "onboarding_v2_rom_error_generic", "onboarding_v2_game_players_title", "onboarding_v2_game_players_load_error",
  "onboarding_v2_game_players_save_error", "onboarding_v2_scrape_title", "onboarding_v2_complete_title",
  "onboarding_v2_complete_start", "onboarding_v2_zoom_title", "settings_tab_library", "settings_tab_system",
  "settings_library_title_rom_folder", "settings_dialog_platform_title_emulator", "settings_dialog_platform_add_folder",
  "settings_system_title_language", "language_settings_title", "language_system_default",
  "settings_system_title_single_screen", "single_screen_mode_title", "single_screen_mode_main",
  "settings_library_cd_add_platform", "settings_dialog_title_add_platforms", "settings_dialog_title_import_platform",
] as const;

export type CocoonLabel = typeof RESOURCES[number];
export interface CocoonUiContext extends EmulatorUiContext {
  sdk: number;
  labels: AndroidResourceLabels;
  onMutation?: () => void;
}

export async function readCocoonLabels(context: EmulatorUiContext): Promise<AndroidResourceLabels> {
  return readAndroidResourceLabels(context.device, context.user, COCOON_PACKAGE, RESOURCES, context.signal);
}

export function isCocoon(snapshot: AndroidUiSnapshot): boolean {
  return snapshot.component.startsWith(`${COCOON_PACKAGE}/`);
}

export async function waitCocoonUi<T>(
  context: CocoonUiContext, inspect: (snapshot: AndroidUiSnapshot) => T | undefined | Promise<T | undefined>, timeoutMs = 30_000,
): Promise<T> {
  return waitEmulatorUi(context, async (snapshot) => {
    const controller = snapshot.component.split("/")[0];
    if (["com.android.permissioncontroller", "com.google.android.permissioncontroller"].includes(controller ?? "")
      && snapshot.component.endsWith(".permission.ui.GrantPermissionsActivity")) {
      const activity = await context.device.shell(shellCommand("dumpsys", "activity", "activities"));
      const records = activity.split(/(?=^\s*\* Hist\s+#\d+:)/m).filter((record) =>
        record.includes(`mActivityComponent=${snapshot.component}`) && /^\s+state=RESUMED\b/m.test(record));
      const record = records[0];
      if (records.length === 0) throw new AndroidUiStateChangedError("Cocoon's permission prompt changed before inspection.");
      if (records.length !== 1 || !record || !record.includes(`launchedFromPackage=${COCOON_PACKAGE} `)
        || !new RegExp(`\\buserId=${context.user}\\r?\\n`).test(record)) throw new Error("Cocoon's permission prompt caller could not be confirmed.");
      const deny = snapshot.nodes.filter((node) => node.packageName === controller
        && ["com.android.permissioncontroller:id/permission_deny_button",
          "com.android.permissioncontroller:id/permission_deny_and_dont_ask_again_button"].includes(node.resourceId) && node.enabled && node.clickable);
      if (!deny.length) return undefined;
      if (deny.length !== 1 || !deny[0]) throw new Error("Cocoon's optional permission prompt could not be dismissed.");
      if (!emulatorNodeVisible(snapshot, deny[0])) return undefined;
      await tapEmulatorNode(context, snapshot, deny[0]);
      return undefined;
    }
    return inspect(snapshot);
  }, timeoutMs);
}

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim().replace(/\s+/g, " ");
}

export function cocoonMatches(context: CocoonUiContext, node: AndroidUiNode, key: CocoonLabel): boolean {
  if (node.packageName !== COCOON_PACKAGE) return false;
  const labels = context.labels.get(key);
  return !!labels && [node.text, node.description].some((value) => value.split(/\r?\n/)
    .some((line) => [...labels].some((label) => normalize(line) === normalize(label))));
}

export function cocoonHas(context: CocoonUiContext, snapshot: AndroidUiSnapshot, key: CocoonLabel): boolean {
  return isCocoon(snapshot) && snapshot.nodes.some((node) => cocoonMatches(context, node, key)
    && node.bounds[0] >= 0 && node.bounds[1] >= 0 && node.bounds[2] > node.bounds[0] && node.bounds[3] > node.bounds[1]);
}

function controlBounds(context: CocoonUiContext, snapshot: AndroidUiSnapshot, node: AndroidUiNode): readonly [number, number, number, number] {
  let [left, top, right, bottom] = node.bounds;
  let parent = node.parent;
  while (parent !== null) {
    const ancestor = snapshot.nodes[parent];
    if (!ancestor) break;
    if (ancestor.scrollable || ancestor.className === "android.widget.ScrollView") {
      left = Math.max(left, ancestor.bounds[0]);
      top = Math.max(top, ancestor.bounds[1]);
      right = Math.min(right, ancestor.bounds[2]);
      bottom = Math.min(bottom, ancestor.bounds[3]);
    }
    parent = ancestor.parent;
  }
  const headings = snapshot.nodes.filter((entry) => cocoonMatches(context, entry, "common_settings"));
  for (const heading of headings) {
    const bar = heading.parent === null ? undefined : snapshot.nodes[heading.parent];
    if (bar && bar.bounds[1] === 0 && !uiWithin(snapshot, node, bar)
      && bar.bounds[0] <= left && bar.bounds[2] >= right) top = Math.max(top, bar.bounds[3]);
  }
  return [left, top, right, bottom];
}

function controlVisible(context: CocoonUiContext, snapshot: AndroidUiSnapshot, node: AndroidUiNode): boolean {
  const [left, top, right, bottom] = controlBounds(context, snapshot, node);
  return emulatorNodeVisible(snapshot, node) && left >= 0 && top >= 0 && right > left && bottom > top;
}

export function cocoonAction(
  context: CocoonUiContext, snapshot: AndroidUiSnapshot, key: CocoonLabel, scope?: AndroidUiNode,
): AndroidUiNode | undefined {
  if (!isCocoon(snapshot)) return undefined;
  const targets = new Set<AndroidUiNode>();
  for (const node of snapshot.nodes.filter((entry) => cocoonMatches(context, entry, key) && (!scope || uiWithin(snapshot, entry, scope)))) {
    let target: AndroidUiNode | undefined = node;
    while (target && !target.clickable) target = target.parent === null ? undefined : snapshot.nodes[target.parent];
    if (target?.enabled && target.packageName === COCOON_PACKAGE && (!scope || uiWithin(snapshot, target, scope))
      && controlVisible(context, snapshot, target)) targets.add(target);
  }
  if (targets.size > 1) throw new Error(`Cocoon's ${key} action is ambiguous.`);
  return [...targets][0];
}

/** Platform and player names come from Cocoon's public platform database. */
export function cocoonTextAction(context: CocoonUiContext, snapshot: AndroidUiSnapshot, text: string, scope?: AndroidUiNode): AndroidUiNode | undefined {
  if (!isCocoon(snapshot)) return undefined;
  const targets = new Set<AndroidUiNode>();
  for (const node of snapshot.nodes.filter((entry) => entry.packageName === COCOON_PACKAGE && normalize(entry.text) === normalize(text)
    && (!scope || uiWithin(snapshot, entry, scope)))) {
    let target: AndroidUiNode | undefined = node;
    while (target && !target.clickable) target = target.parent === null ? undefined : snapshot.nodes[target.parent];
    if (target?.enabled && target.packageName === COCOON_PACKAGE && (!scope || uiWithin(snapshot, target, scope))
      && controlVisible(context, snapshot, target)) targets.add(target);
  }
  if (targets.size > 1) throw new Error("Cocoon's named control is ambiguous.");
  return [...targets][0];
}

export async function tapCocoon(context: CocoonUiContext, key: CocoonLabel, initial?: AndroidUiSnapshot): Promise<void> {
  let snapshot = initial ?? await waitCocoonUi(context, (value) => cocoonAction(context, value, key) ? value : undefined);
  for (let attempt = 0; attempt < 8; attempt++) {
    const target = cocoonAction(context, snapshot, key);
    if (!target) throw new Error(`Cocoon's ${key} action is unavailable.`);
    try { await tapCocoonNode(context, snapshot, target); return; }
    catch (error) {
      if (!(error instanceof AndroidUiStateChangedError) || attempt === 7) throw error;
      const component = snapshot.component;
      snapshot = await waitCocoonUi(context, (value) => value.component === component && cocoonAction(context, value, key) ? value : undefined);
    }
  }
}

/** Some native settings controls focus on the first tap and activate on the next. */
export async function activateCocoon(
  context: CocoonUiContext, key: CocoonLabel, ready: (snapshot: AndroidUiSnapshot) => boolean,
  initial?: AndroidUiSnapshot,
  action?: (snapshot: AndroidUiSnapshot) => Promise<void>,
): Promise<AndroidUiSnapshot> {
  return activateCocoonControl(context, (value) => cocoonAction(context, value, key), ready, initial, action);
}

export async function activateCocoonControl(
  context: CocoonUiContext, control: (snapshot: AndroidUiSnapshot) => AndroidUiNode | undefined,
  ready: (snapshot: AndroidUiSnapshot) => boolean, initial?: AndroidUiSnapshot,
  action?: (snapshot: AndroidUiSnapshot) => Promise<void>,
): Promise<AndroidUiSnapshot> {
  let snapshot = initial;
  for (let attempt = 0; attempt < 12; attempt++) {
    snapshot ??= await waitCocoonUi(context, (value) => ready(value) || control(value) ? value : undefined);
    if (ready(snapshot)) return snapshot;
    const target = control(snapshot);
    if (!target) throw new Error("Cocoon's requested control is unavailable.");
    try {
      if (action) await action(snapshot);
      else await tapCocoonNode(context, snapshot, target);
    }
    catch (error) {
      if (!(error instanceof AndroidUiStateChangedError)) throw error;
      snapshot = undefined;
      continue;
    }
    let previous = "";
    let stable = 0;
    const result = await waitCocoonUi(context, (value) => {
      if (ready(value)) return { ready: true, snapshot: value };
      const contents = interactionIdentity(value);
      stable = contents === previous ? stable + 1 : 0;
      previous = contents;
      return stable >= 2 && control(value) ? { ready: false, snapshot: value } : undefined;
    });
    if (result.ready) return result.snapshot;
    snapshot = result.snapshot;
  }
  throw new Error("Cocoon's requested control did not activate.");
}

function interactionIdentity(snapshot: AndroidUiSnapshot): string {
  return JSON.stringify({ ...snapshot, nodes: snapshot.nodes.map((node) => {
    // Cocoon animates its mascot and focus outlines continuously. Keep every
    // control, text node, ancestry and state checked, excluding decoration bounds.
    const decoration = node.className === "android.view.View" && !node.resourceId && !node.text && !node.description
      && !node.clickable && !node.focusable && !node.scrollable && !node.checked && !node.selected;
    return decoration ? { ...node, bounds: undefined } : node;
  }) });
}

async function assertCocoonInteraction(context: CocoonUiContext, snapshot: AndroidUiSnapshot): Promise<void> {
  if (!isCocoon(snapshot) || snapshot.user !== context.user) throw new Error("Cocoon is not in the selected Android profile.");
  const current = await readAndroidUi(context.device, context.user, context.signal);
  if (interactionIdentity(current) !== interactionIdentity(snapshot)) {
    throw new AndroidUiStateChangedError("Cocoon's controls changed before the action.");
  }
  await assertAndroidUser(context.device, context.user, context.signal);
}

export async function tapCocoonNode(context: CocoonUiContext, snapshot: AndroidUiSnapshot, node: AndroidUiNode): Promise<void> {
  if (!isCocoon(snapshot) || snapshot.user !== context.user || !snapshot.nodes.includes(node)
    || node.packageName !== COCOON_PACKAGE || !node.enabled || !node.clickable) {
    throw new Error("Cocoon action is not an enabled control in the selected profile.");
  }
  await assertCocoonInteraction(context, snapshot);
  const [left, top, right, bottom] = controlBounds(context, snapshot, node);
  if (left < 0 || top < 0 || right <= left || bottom <= top) throw new Error("Cocoon's action is outside the visible screen.");
  const output = await context.device.shell(shellCommand("input", "tap", String(Math.floor((left + right) / 2)), String(Math.floor((top + bottom) / 2))));
  if (/Error:|Exception|Permission Denial/i.test(output)) throw new Error("Cocoon's Android UI action failed.");
  checkAbort(context.signal);
}

export async function scrollCocoonList(
  context: CocoonUiContext, snapshot: AndroidUiSnapshot, list: AndroidUiNode, direction: "down" | "up",
): Promise<void> {
  if (!snapshot.nodes.includes(list) || list.packageName !== COCOON_PACKAGE || !list.scrollable || !list.enabled) {
    throw new Error("Cocoon's scroll target is unavailable.");
  }
  await assertCocoonInteraction(context, snapshot);
  const [left, top, right, bottom] = list.bounds;
  if (left < 0 || top < 0 || right <= left || bottom <= top) throw new Error("Cocoon's list is outside the visible screen.");
  const x = Math.floor((left + right) / 2);
  const margin = Math.floor((bottom - top) / 5);
  const from = direction === "down" ? bottom - margin : top + margin;
  const to = direction === "down" ? top + margin : bottom - margin;
  const output = await context.device.shell(shellCommand("input", "swipe", String(x), String(from), String(x), String(to), "250"));
  if (/Error:|Exception|Permission Denial/i.test(output)) throw new Error("Cocoon's list scroll failed.");
  checkAbort(context.signal);
}

export async function pressCocoonKey(
  context: CocoonUiContext, key: "KEYCODE_BACK" | "KEYCODE_MENU" | "KEYCODE_BUTTON_START" | "KEYCODE_BUTTON_Y" | "KEYCODE_BUTTON_A"
    | "KEYCODE_DPAD_UP" | "KEYCODE_DPAD_DOWN", initial?: AndroidUiSnapshot,
): Promise<void> {
  if (!["KEYCODE_BACK", "KEYCODE_MENU", "KEYCODE_BUTTON_START", "KEYCODE_BUTTON_Y", "KEYCODE_BUTTON_A",
    "KEYCODE_DPAD_UP", "KEYCODE_DPAD_DOWN"].includes(key)) throw new Error("Unsupported Cocoon navigation key.");
  const snapshot = initial ?? await waitCocoonUi(context, (value) => isCocoon(value) ? value : undefined);
  await assertCocoonInteraction(context, snapshot);
  const output = await context.device.shell(shellCommand("input", "keyevent", key));
  if (/Error:|Exception|Permission Denial/i.test(output)) throw new Error("Cocoon's keyboard navigation failed.");
  checkAbort(context.signal);
}

/** Home can resume Cocoon itself; another activity must stop it before preferences are flushed. */
export async function restartCocoon(context: CocoonUiContext): Promise<void> {
  await restartEmulator(context, COCOON_PACKAGE, "Cocoon", async () => {
    checkActivityStart(await context.device.shell(shellCommand("am", "start", "--user", String(context.user), "--display", "0", "-W",
      "-a", "android.settings.SETTINGS")));
  });
}

export async function launchCocoon(context: CocoonUiContext): Promise<AndroidUiSnapshot> {
  await context.ensureUnlocked();
  checkActivityStart(await context.device.shell(shellCommand("am", "start", "--user", String(context.user), "--display", "0", "-W", "-n", COCOON_MAIN_ACTIVITY)));
  return waitCocoonUi(context, (snapshot) => isCocoon(snapshot) ? snapshot : undefined);
}

/** Cocoon 3.07 does not export SettingsActivity or LanguageSettingsActivity; keep app-owned navigation. */
export async function openCocoonSettings(context: CocoonUiContext, initial?: AndroidUiSnapshot): Promise<AndroidUiSnapshot> {
  let snapshot = initial ?? await waitCocoonUi(context, (value) => value);
  if (!isCocoon(snapshot)) snapshot = await launchCocoon(context);
  for (let attempt = 0; attempt < 6; attempt++) {
    if (snapshot.component === COCOON_SETTINGS_ACTIVITY) return snapshot;
    if (!isCocoon(snapshot) || snapshot.component === COCOON_ONBOARDING_ACTIVITY) {
      throw new Error("Finish Cocoon's initial setup before opening its library settings.");
    }
    try {
      const key = cocoonAction(context, snapshot, "common_cocoon_settings") ? "common_cocoon_settings" : "common_settings";
      if (cocoonAction(context, snapshot, key)) await tapCocoon(context, key, snapshot);
      else await pressCocoonKey(context, "KEYCODE_BUTTON_START", snapshot);
      snapshot = await waitCocoonUi(context, (value) => value.component === COCOON_SETTINGS_ACTIVITY
        || cocoonAction(context, value, "common_cocoon_settings") || cocoonAction(context, value, "common_settings") ? value : undefined);
    } catch (error) {
      if (!(error instanceof AndroidUiStateChangedError)) throw error;
      snapshot = await waitCocoonUi(context, (value) => isCocoon(value) ? value : undefined);
    }
  }
  throw new Error("Cocoon's settings menu did not become available.");
}
