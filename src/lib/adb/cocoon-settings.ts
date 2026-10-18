import { AndroidUiStateChangedError, type AndroidUiSnapshot } from "./android-ui";
import { findCocoonSettingBySearch } from "./cocoon-search";
import { activateCocoon, cocoonAction, cocoonHas, cocoonTextAction, openCocoonSettings, pressCocoonKey, scrollCocoonList, waitCocoonUi,
  COCOON_PACKAGE, COCOON_SETTINGS_ACTIVITY, type CocoonLabel, type CocoonUiContext } from "./cocoon-navigation";

export async function openCocoonTab(context: CocoonUiContext, tab: "settings_tab_library" | "settings_tab_system"): Promise<AndroidUiSnapshot> {
  let snapshot = await openCocoonSettings(context);
  for (let attempt = 0; !cocoonAction(context, snapshot, tab) && attempt < 6; attempt++) {
    await pressCocoonKey(context, "KEYCODE_BACK", snapshot);
    const identity = JSON.stringify(snapshot.nodes.map((node) => [node.text, node.description]));
    snapshot = await waitCocoonUi(context, (value) => value.component === COCOON_SETTINGS_ACTIVITY
      && JSON.stringify(value.nodes.map((node) => [node.text, node.description])) !== identity ? value : undefined);
  }
  return activateCocoon(context, tab, (value) => value.component === COCOON_SETTINGS_ACTIVITY && !cocoonHas(context, value, tab), snapshot);
}

export async function findCocoonSetting(context: CocoonUiContext, key: CocoonLabel, initial?: AndroidUiSnapshot): Promise<AndroidUiSnapshot> {
  if (key === "settings_library_title_rom_folder" || key === "settings_system_title_language"
    || key === "settings_system_title_single_screen") return findCocoonSettingBySearch(context, key, initial);
  const snapshot = await findCocoonListItem(context, (value) => !!cocoonAction(context, value, key), "up", initial);
  if (!snapshot) throw new Error(`Cocoon's ${[...(context.labels.get(key) ?? [])][0] ?? key} setting was not found.`);
  return snapshot;
}

export async function findCocoonNamedSetting(context: CocoonUiContext, text: string): Promise<AndroidUiSnapshot> {
  const snapshot = await findCocoonListItem(context, (value) => !!cocoonTextAction(context, value, text));
  if (!snapshot) throw new Error("Cocoon's requested platform was not found. Refresh its public platform database in Library settings.");
  return snapshot;
}

export async function findCocoonListItem(
  context: CocoonUiContext, found: (snapshot: AndroidUiSnapshot) => boolean, initialDirection: "down" | "up" = "up",
  initial?: AndroidUiSnapshot,
): Promise<AndroidUiSnapshot | undefined> {
  let previous = "";
  let reversed = false;
  let repeated = 0;
  let snapshot = initial?.component === COCOON_SETTINGS_ACTIVITY && initial.user === context.user ? initial : undefined;
  for (let step = 0; step < 100; step++) {
    snapshot ??= await waitCocoonUi(context, (value) => value.component === COCOON_SETTINGS_ACTIVITY ? value : undefined);
    if (found(snapshot)) return snapshot;
    const lists = snapshot.nodes.filter((node) => node.packageName === COCOON_PACKAGE && node.enabled
      && (node.scrollable || node.className === "android.widget.ScrollView"));
    if (lists.length !== 1 || !lists[0]) throw new Error("Cocoon's settings list is unavailable or ambiguous.");
    if (!lists[0].scrollable) return undefined;
    const signature = JSON.stringify(snapshot.nodes.filter((node) => node.text || node.description || node.scrollable)
      .map((node) => [node.text, node.description, node.bounds]));
    repeated = previous === signature ? repeated + 1 : 0;
    if (repeated >= 2) {
      if (reversed) return undefined;
      reversed = true;
      previous = "";
      repeated = 0;
    } else previous = signature;
    const direction = reversed ? (initialDirection === "up" ? "down" : "up") : initialDirection;
    try { await scrollCocoonList(context, snapshot, lists[0], direction); }
    catch (error) { if (!(error instanceof AndroidUiStateChangedError)) throw error; }
    snapshot = undefined;
  }
  throw new Error("Cocoon's settings navigation exceeded its limit.");
}
