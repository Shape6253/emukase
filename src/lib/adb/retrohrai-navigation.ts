import { AndroidUiStateChangedError, assertAndroidUiSnapshot, type AndroidUiNode, type AndroidUiSnapshot } from "./android-ui";
import { readAndroidResourceLabels, type AndroidResourceLabels } from "./android-resource-labels";
import { emulatorNodeVisible, restartEmulator, scrollEmulatorList, tapEmulatorNode, uiWithin, waitEmulatorUi, type EmulatorUiContext } from "./emulator-ui";
import { RETROHRAI_PACKAGE } from "./retrohrai-types";
import { checkActivityStart, shellCommand } from "./transport";

const RESOURCES = [
  "onboarding_welcome_title", "onboarding_start_setup", "setup_assets_title", "setup_assets_choose_location",
  "setup_migration_title", "setup_migration_skip_button", "setup_scraper_title",
  "setup_scraper_skip_button", "setup_scraper_skip_step_button", "setup_scraper_ready_title",
  "onboarding_library_source_title", "onboarding_library_choose_folder", "onboarding_library_choose_different_folder",
  "onboarding_library_add_another_folder", "onboarding_library_use_folders",
  "onboarding_library_folder_needs_access", "setup_rom_roots_remove", "onboarding_platform_existing_title",
  "setup_platform_title", "setup_platform_select_all", "setup_platform_deselect_all", "setup_platform_add_selected",
  "onboarding_browsing_style_title", "onboarding_choose_style", "onboarding_start_browsing", "onboarding_tour_skip",
  "onboarding_initial_scan_title", "setup_detecting_title", "settings_title", "settings_section_platforms",
  "settings_general_tab", "settings_rom_folders_add", "settings_backup_tab", "settings_backup_export", "settings_backup_import",
  "settings_backup_restore_dialog_title", "settings_backup_restore_confirm",
  "settings_backup_restore_mode_overwrite",
  "settings_backup_restore_create_before", "settings_backup_restore_summary_title", "settings_backup_restore_summary_dismiss",
  "home_no_roms_title", "home_no_platforms_title", "action_open_virtual_screen", "action_swap_screens",
  "scraping_assets_title", "scraping_assets_current", "scraping_select_folder", "scraping_change_folder", "settings_general_subtitle",
  "settings_rom_root_scanning", "settings_platforms_auto_setup", "setup_assets_choose_different",
] as const;

export type RetroHraiLabel = typeof RESOURCES[number];
export interface RetroHraiContext extends EmulatorUiContext {
  sdk: number;
  labels: AndroidResourceLabels;
}

export function retroHraiString(context: RetroHraiContext, node: AndroidUiNode, key: RetroHraiLabel): string | undefined {
  if (node.packageName !== RETROHRAI_PACKAGE) return undefined;
  for (const label of context.labels.get(key) ?? []) {
    const parts = label.split("%1$s");
    if (parts.length !== 2) continue;
    const [prefix = "", suffix = ""] = parts;
    if (node.text.startsWith(prefix) && node.text.endsWith(suffix) && node.text.length > prefix.length + suffix.length) {
      return node.text.slice(prefix.length, suffix ? -suffix.length : undefined);
    }
  }
  return undefined;
}

export function isRetroHrai(snapshot: AndroidUiSnapshot): boolean {
  return snapshot.component === `${RETROHRAI_PACKAGE}/${RETROHRAI_PACKAGE}.MainActivity`;
}

export async function readRetroHraiLabels(context: EmulatorUiContext): Promise<AndroidResourceLabels> {
  return readAndroidResourceLabels(context.device, context.user, RETROHRAI_PACKAGE, RESOURCES, context.signal);
}

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim().replace(/\s+/g, " ");
}

export function retroHraiMatches(context: RetroHraiContext, node: AndroidUiNode, key: RetroHraiLabel, args: readonly string[] = []): boolean {
  if (node.packageName !== RETROHRAI_PACKAGE) return false;
  return [...(context.labels.get(key) ?? [])].some((label) => {
    const formatted = label.replace(/%(\d+)\$[ds]/g, (token, index: string) => args[Number(index) - 1] ?? token);
    return [node.text, node.description].some((value) => normalize(value) === normalize(formatted));
  });
}

/** Read the count from the installed locale's formatted bulk-action label. */
export function retroHraiCount(context: RetroHraiContext, node: AndroidUiNode, key: RetroHraiLabel): number | undefined {
  if (node.packageName !== RETROHRAI_PACKAGE) return undefined;
  for (const label of context.labels.get(key) ?? []) {
    const parts = normalize(label).split("%1$d");
    if (parts.length !== 2) continue;
    const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escape(parts[0] ?? "")}([0-9]+)${escape(parts[1] ?? "")}$`);
    for (const text of [node.text, node.description]) {
      const match = pattern.exec(normalize(text));
      const count = Number(match?.[1]);
      if (match && Number.isSafeInteger(count) && count >= 0 && count <= 4096) return count;
    }
  }
  return undefined;
}

export function retroHraiHas(context: RetroHraiContext, snapshot: AndroidUiSnapshot, key: RetroHraiLabel): boolean {
  return isRetroHrai(snapshot) && snapshot.nodes.some((node) => retroHraiMatches(context, node, key)
    && node.bounds[2] > node.bounds[0] && node.bounds[3] > node.bounds[1]);
}

export function retroHraiControl(
  snapshot: AndroidUiSnapshot, matches: (node: AndroidUiNode) => boolean, scope?: AndroidUiNode,
): AndroidUiNode | undefined {
  if (!isRetroHrai(snapshot)) return undefined;
  const targets = new Set<AndroidUiNode>();
  for (const node of snapshot.nodes.filter((entry) => matches(entry) && entry.packageName === RETROHRAI_PACKAGE
    && entry.bounds[2] > entry.bounds[0] && entry.bounds[3] > entry.bounds[1] && (!scope || uiWithin(snapshot, entry, scope)))) {
    let target: AndroidUiNode | undefined = node;
    while (target && !target.clickable) target = target.parent === null ? undefined : snapshot.nodes[target.parent];
    const content = snapshot.nodes.find((entry) => entry.resourceId === "android:id/content");
    if (target && target.packageName === RETROHRAI_PACKAGE && target.enabled && emulatorNodeVisible(snapshot, target)
      && (!scope || uiWithin(snapshot, target, scope)) && (!content || target.bounds.some((value, index) => value !== content.bounds[index]))) {
      targets.add(target);
    }
  }
  if (targets.size > 1) throw new Error("RetroHrai's requested control is ambiguous.");
  return [...targets][0];
}

export function retroHraiAction(
  context: RetroHraiContext, snapshot: AndroidUiSnapshot, key: RetroHraiLabel, args: readonly string[] = [], scope?: AndroidUiNode,
): AndroidUiNode | undefined {
  return retroHraiControl(snapshot, (node) => retroHraiMatches(context, node, key, args), scope);
}

export async function waitRetroHraiUi<T>(
  context: RetroHraiContext, inspect: (snapshot: AndroidUiSnapshot) => T | undefined | Promise<T | undefined>, timeoutMs = 30_000,
): Promise<T> {
  return waitEmulatorUi(context, inspect, timeoutMs);
}

export async function activateRetroHraiControl(
  context: RetroHraiContext, control: (snapshot: AndroidUiSnapshot) => AndroidUiNode | undefined,
  ready: (snapshot: AndroidUiSnapshot) => boolean, initial?: AndroidUiSnapshot,
  dispatch?: (snapshot: AndroidUiSnapshot, control: AndroidUiNode) => Promise<void>,
): Promise<AndroidUiSnapshot> {
  let snapshot = initial;
  for (let attempt = 0; attempt < 4; attempt++) {
    snapshot ??= await waitRetroHraiUi(context, (value) => ready(value) || control(value) ? value : undefined);
    if (ready(snapshot)) return snapshot;
    const target = control(snapshot);
    if (!target) throw new Error("RetroHrai's requested action is unavailable.");
    try {
      if (dispatch) await dispatch(snapshot, target);
      else await tapEmulatorNode(context, snapshot, target);
    }
    catch (error) {
      if (!(error instanceof AndroidUiStateChangedError)) throw error;
      snapshot = undefined;
      continue;
    }
    return waitRetroHraiUi(context, (value) => ready(value) ? value : undefined);
  }
  throw new Error("RetroHrai's controls changed repeatedly before the action.");
}

/** Use the app's displayed controller binding, not touch coordinates, for bulk
 * actions. The prompt and complete foreground snapshot are checked first. */
export async function activateRetroHraiShortcut(
  context: RetroHraiContext, key: "KEYCODE_BUTTON_Y" | "KEYCODE_BUTTON_X", label: RetroHraiLabel,
  ready: (snapshot: AndroidUiSnapshot) => boolean, initial?: AndroidUiSnapshot, args: readonly string[] = [],
): Promise<AndroidUiSnapshot> {
  const prompt = key === "KEYCODE_BUTTON_Y" ? "Y" : "X";
  return activateRetroHraiControl(context, (value) => retroHraiAction(context, value, label, args), ready, initial, async (snapshot, control) => {
    if (!snapshot.nodes.some((node) => uiWithin(snapshot, node, control) && (node.text === prompt || node.description === prompt))) {
      throw new Error(`RetroHrai's ${prompt} shortcut is not exposed for the requested action.`);
    }
    await pressRetroHraiKey(context, key, snapshot);
  });
}

export async function activateRetroHrai(
  context: RetroHraiContext, key: RetroHraiLabel, ready: (snapshot: AndroidUiSnapshot) => boolean,
  initial?: AndroidUiSnapshot, args: readonly string[] = [],
): Promise<AndroidUiSnapshot> {
  return activateRetroHraiControl(context, (value) => retroHraiAction(context, value, key, args), ready, initial);
}

export async function pressRetroHraiKey(
  context: RetroHraiContext, key: "KEYCODE_BACK" | "KEYCODE_BUTTON_START" | "KEYCODE_BUTTON_Y" | "KEYCODE_BUTTON_X", initial?: AndroidUiSnapshot,
): Promise<void> {
  if (!["KEYCODE_BACK", "KEYCODE_BUTTON_START", "KEYCODE_BUTTON_Y", "KEYCODE_BUTTON_X"].includes(key)) throw new Error("Unsupported RetroHrai navigation key.");
  const snapshot = initial ?? await waitRetroHraiUi(context, (value) => isRetroHrai(value) ? value : undefined);
  if (!isRetroHrai(snapshot)) throw new Error("RetroHrai is not in the foreground.");
  await assertAndroidUiSnapshot(context.device, context.user, snapshot, context.signal);
  const source = key === "KEYCODE_BACK" ? [] : ["gamepad", ...(context.sdk >= 29 ? ["-d", "0"] : [])];
  const output = await context.device.shell(shellCommand("input", ...source, "keyevent", key));
  if (/Error:|Exception|Permission Denial/i.test(output)) throw new Error("RetroHrai navigation failed.");
}

export async function launchRetroHrai(context: RetroHraiContext): Promise<AndroidUiSnapshot> {
  await context.ensureUnlocked();
  checkActivityStart(await context.device.shell(shellCommand("am", "start", "--user", String(context.user), "--display", "0", "-W",
    "-n", `${RETROHRAI_PACKAGE}/.MainActivity`)));
  return waitRetroHraiUi(context, (value) => isRetroHrai(value) ? value : undefined);
}

export async function restartRetroHrai(context: RetroHraiContext): Promise<void> {
  await restartEmulator(context, RETROHRAI_PACKAGE, "RetroHrai", async () => {
    checkActivityStart(await context.device.shell(shellCommand("am", "start", "--user", String(context.user), "-W",
      "-a", "android.settings.APPLICATION_DETAILS_SETTINGS", "-d", `package:${RETROHRAI_PACKAGE}`)));
  });
}

export async function openRetroHraiSettings(context: RetroHraiContext, initial?: AndroidUiSnapshot): Promise<AndroidUiSnapshot> {
  let snapshot = initial;
  for (let attempt = 0; attempt < 4; attempt++) {
    snapshot ??= await launchRetroHrai(context);
    if (retroHraiHas(context, snapshot, "settings_title")) return snapshot;
    try { await pressRetroHraiKey(context, "KEYCODE_BUTTON_START", snapshot); }
    catch (error) {
      if (!(error instanceof AndroidUiStateChangedError)) throw error;
      snapshot = undefined;
      continue;
    }
    return waitRetroHraiUi(context, (value) => retroHraiHas(context, value, "settings_title") ? value : undefined);
  }
  throw new Error("RetroHrai's home screen changed repeatedly before opening settings.");
}

export async function openRetroHraiGeneral(context: RetroHraiContext): Promise<AndroidUiSnapshot> {
  let snapshot = await openRetroHraiSettings(context);
  for (let attempt = 0; attempt < 12; attempt++) {
    if (retroHraiHas(context, snapshot, "settings_backup_tab")) return snapshot;
    if (retroHraiAction(context, snapshot, "settings_general_tab")) {
      return activateRetroHrai(context, "settings_general_tab", (value) => retroHraiHas(context, value, "settings_backup_tab"), snapshot);
    }
    const lists = snapshot.nodes.filter((list) => list.scrollable && snapshot.nodes.some((node) =>
      retroHraiMatches(context, node, "settings_section_platforms") && uiWithin(snapshot, node, list)));
    if (lists.length !== 1 || !lists[0]) throw new Error("RetroHrai's settings navigation could not be identified.");
    try { await scrollEmulatorList(context, snapshot, lists[0], "up"); }
    catch (error) { if (!(error instanceof AndroidUiStateChangedError)) throw error; }
    snapshot = await waitRetroHraiUi(context, (value) => retroHraiHas(context, value, "settings_title") ? value : undefined);
  }
  throw new Error("RetroHrai's General settings could not be opened.");
}
