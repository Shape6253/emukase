import { AndroidUiStateChangedError, pressAndroidUiKey, type AndroidUiNode, type AndroidUiSnapshot } from "./android-ui";
import { readAndroidResourceLabels, type AndroidResourceLabels } from "./android-resource-labels";
import { emulatorNodeVisible, restartEmulator, scrollEmulatorList, tapEmulatorNode, uiDescendant, uiNode, waitEmulatorUi, type EmulatorUiContext } from "./emulator-ui";
import { checkActivityStart, shellCommand } from "./transport";

export const DAIJISHO_PACKAGE = "com.magneticchen.daijishou";
export const daijishoId = (name: string): string => `${DAIJISHO_PACKAGE}:id/${name}`;
const RESOURCES = ["settings", "platforms", "library", "library_settings_title", "download_platforms_title", "import_platform_title",
  "inspect_platforms_title", "inspect_players_title", "platform_list_title", "player_list_title", "replace_platform_warning_title", "synchronization_paths_title"] as const;
type DaijishoLabel = typeof RESOURCES[number];
const settingsOpen = (snapshot: AndroidUiSnapshot): boolean => snapshot.nodes.some((node) => node.resourceId === daijishoId("settings_nav_container"));

export interface DaijishoUiContext extends EmulatorUiContext {
  labels: AndroidResourceLabels;
  onMutation?: () => void;
}

export async function readDaijishoLabels(context: EmulatorUiContext): Promise<AndroidResourceLabels> {
  return readAndroidResourceLabels(context.device, context.user, DAIJISHO_PACKAGE, RESOURCES, context.signal);
}

export function isDaijisho(snapshot: AndroidUiSnapshot): boolean {
  return snapshot.component.startsWith(`${DAIJISHO_PACKAGE}/`);
}

export function daijishoLabel(context: DaijishoUiContext, snapshot: AndroidUiSnapshot, key: DaijishoLabel, resourceId?: string, scope?: string): AndroidUiNode | undefined {
  if (!isDaijisho(snapshot)) return undefined;
  const matches = snapshot.nodes.filter((node) => node.packageName === DAIJISHO_PACKAGE && context.labels.get(key)?.has(node.text)
    && (resourceId === undefined || node.resourceId === resourceId) && (!scope || uiDescendant(snapshot, node, scope))
    && node.enabled && node.bounds[2] > node.bounds[0] && node.bounds[3] > node.bounds[1]);
  if (matches.length > 1) throw new Error(`Daijishō's ${key} control is ambiguous.`);
  return matches[0];
}

export async function launchDaijisho(context: DaijishoUiContext): Promise<AndroidUiSnapshot> {
  await context.ensureUnlocked();
  const output = await context.device.shell(shellCommand("cmd", "package", "resolve-activity", "--brief", "--user", String(context.user),
    "-a", "android.intent.action.MAIN", "-c", "android.intent.category.HOME", "-p", DAIJISHO_PACKAGE));
  const candidates = output.trim().split(/\r?\n/).filter((line) => line.startsWith(`${DAIJISHO_PACKAGE}/`));
  const component = candidates[0];
  if (candidates.length !== 1 || !component || !/^[\w.]+\/[\w.$]+$/.test(component)) throw new Error("Daijishō's launcher activity is unavailable.");
  checkActivityStart(await context.device.shell(shellCommand("am", "start", "--user", String(context.user), "--display", "0", "-W", "-n", component)));
  return waitEmulatorUi(context, (snapshot) => isDaijisho(snapshot) && uiNode(snapshot, daijishoId("tab_layout")) ? snapshot : undefined);
}

export async function restartDaijisho(context: DaijishoUiContext): Promise<void> {
  // HOME may itself be Daijishō; Settings reliably runs the app's stop/save callbacks.
  await restartEmulator(context, DAIJISHO_PACKAGE, "Daijishō", async () => {
    checkActivityStart(await context.device.shell(shellCommand("am", "start", "--user", String(context.user), "--display", "0", "-W", "-a", "android.settings.SETTINGS")));
  });
  await launchDaijisho(context);
}

export async function tapDaijisho(
  context: DaijishoUiContext, control: (snapshot: AndroidUiSnapshot) => AndroidUiNode | undefined,
  ready: (snapshot: AndroidUiSnapshot) => boolean, initial?: AndroidUiSnapshot,
): Promise<AndroidUiSnapshot> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const snapshot = initial ?? await waitEmulatorUi(context, (value) => isDaijisho(value) && control(value) ? value : undefined);
    initial = undefined;
    const node = control(snapshot);
    if (!isDaijisho(snapshot) || !node) throw new Error("Daijishō's requested action is unavailable.");
    try { await tapEmulatorNode(context, snapshot, node); }
    catch (error) {
      if (!(error instanceof AndroidUiStateChangedError) || attempt === 3) throw error;
      continue;
    }
    return waitEmulatorUi(context, (value) => ready(value) ? value : undefined);
  }
  throw new Error("Daijishō's interface changed before the action.");
}

/** Search observed native lists in both directions, without guessing absence from a scroll budget. */
export async function findDaijishoControl(
  context: DaijishoUiContext, control: (snapshot: AndroidUiSnapshot) => AndroidUiNode | undefined, initial?: AndroidUiSnapshot,
  initialDirection: "up" | "down" = "up",
): Promise<AndroidUiSnapshot | undefined> {
  let previous = "", repeated = 0;
  let direction = initialDirection;
  let reversed = false;
  const component = initial?.component;
  for (let step = 0; step < 100; step++) {
    const snapshot = initial ?? await waitEmulatorUi(context, (value) => isDaijisho(value) ? value : undefined);
    initial = undefined;
    if (component && snapshot.component !== component) throw new Error("Daijishō changed its activity during list navigation.");
    const target = control(snapshot);
    if (target && emulatorNodeVisible(snapshot, target)) return snapshot;
    const lists = snapshot.nodes.filter((node) => node.packageName === DAIJISHO_PACKAGE && node.scrollable && node.enabled
      && node.resourceId !== daijishoId("main_view_pager"));
    if (!lists.length) return undefined;
    if (lists.length !== 1 || !lists[0]) throw new Error("Daijishō's scrollable list is ambiguous.");
    const signature = JSON.stringify(snapshot.nodes.map((node) => [node.resourceId, node.text, node.bounds]));
    repeated = previous === signature ? repeated + 1 : 0;
    previous = signature;
    if (repeated >= 2) {
      if (reversed) return undefined;
      direction = direction === "up" ? "down" : "up";
      reversed = true;
      previous = ""; repeated = 0;
    }
    await scrollEmulatorList(context, snapshot, lists[0], direction);
  }
  throw new Error("Daijishō's list search exceeded its limit; absence was not assumed.");
}

export async function openDaijishoTab(context: DaijishoUiContext, key: "settings" | "platforms"): Promise<AndroidUiSnapshot> {
  const snapshot = await launchDaijisho(context);
  // Never BACK out of or click through an unknown app dialog.
  if (uiNode(snapshot, "android:id/button1") || uiNode(snapshot, "android:id/button2")) throw new Error("Close Daijishō's open dialog before configuring it.");
  const control = (value: AndroidUiSnapshot): AndroidUiNode | undefined => daijishoLabel(context, value, key, undefined, daijishoId("tab_layout"))
    ?? (key === "platforms" ? daijishoLabel(context, value, "library", undefined, daijishoId("tab_layout")) : undefined);
  const selected = (value: AndroidUiSnapshot): boolean => {
    let node = control(value);
    while (node) {
      if (node.selected) return true;
      node = node.parent === null ? undefined : value.nodes[node.parent];
    }
    return false;
  };
  const ready = (value: AndroidUiSnapshot): boolean => isDaijisho(value) && selected(value)
    && (key === "settings" ? settingsOpen(value) : !settingsOpen(value));
  if (ready(snapshot)) return snapshot;
  if (selected(snapshot)) return waitEmulatorUi(context, (value) => ready(value) ? value : undefined);
  return tapDaijisho(context, control, ready, snapshot);
}

export async function openDaijishoLibrarySettings(context: DaijishoUiContext): Promise<AndroidUiSnapshot> {
  let snapshot = await openDaijishoTab(context, "settings");
  for (let depth = 0, retries = 0; depth < 6;) {
    if (daijishoLabel(context, snapshot, "download_platforms_title", "android:id/title")
      || context.labels.get("library_settings_title")?.has(uiNode(snapshot, daijishoId("settings_title_text_view"))?.text ?? "")) return snapshot;
    const library = daijishoLabel(context, snapshot, "library_settings_title", "android:id/title");
    if (library) return tapDaijisho(context, (value) => daijishoLabel(context, value, "library_settings_title", "android:id/title"),
      (value) => !!daijishoLabel(context, value, "download_platforms_title", "android:id/title"), snapshot);
    if (!settingsOpen(snapshot) || uiNode(snapshot, "android:id/button1")) throw new Error("Unexpected Daijishō settings page.");
    try { await pressAndroidUiKey(context.device, context.user, snapshot, "KEYCODE_BACK", context.signal); }
    catch (error) {
      // A rejected snapshot has sent no key; observe the current page before retrying.
      if (!(error instanceof AndroidUiStateChangedError) || ++retries >= 4) throw error;
      snapshot = await waitEmulatorUi(context, (value) => isDaijisho(value) ? value : undefined);
      continue;
    }
    depth++; retries = 0;
    const previous = JSON.stringify(snapshot);
    snapshot = await waitEmulatorUi(context, (value) => isDaijisho(value) && JSON.stringify(value) !== previous ? value : undefined);
  }
  throw new Error("Daijishō's Library settings could not be opened.");
}

export async function openDaijishoInspector(context: DaijishoUiContext, kind: "platforms" | "players"): Promise<AndroidUiSnapshot> {
  const title = kind === "platforms" ? "platform_list_title" : "player_list_title";
  const ready = (value: AndroidUiSnapshot): boolean => isDaijisho(value) && settingsOpen(value)
    && !!daijishoLabel(context, value, title, daijishoId("settings_title_text_view"))
    && !!uiNode(value, daijishoId("fragment_settings_recycler_view"))
    && !["android:id/button1", "android:id/button2", "android:id/button3"].some((resource) => uiNode(value, resource));
  // Editors return to this list. Re-observe its identity instead of reopening Settings.
  const current = await waitEmulatorUi(context, (value) => value);
  if (ready(current)) return current;
  const key = kind === "platforms" ? "inspect_platforms_title" : "inspect_players_title";
  const control = (value: AndroidUiSnapshot): AndroidUiNode | undefined => daijishoLabel(context, value, key, "android:id/title");
  const snapshot = await findDaijishoControl(context, control, await openDaijishoLibrarySettings(context));
  if (!snapshot) throw new Error(`Daijishō's ${kind} inspector is unavailable.`);
  return tapDaijisho(context, control, ready, snapshot);
}
