import { AndroidUiStateChangedError, type AndroidUiSnapshot } from "./android-ui";
import { findCocoonSettingBySearch, isCocoonSearchSetting } from "./cocoon-search";
import { activateCocoon, cocoonAction, cocoonHas, cocoonTextAction, openCocoonSettings, pressCocoonKey, scrollCocoonList, waitCocoonUi,
  COCOON_PACKAGE, COCOON_SETTINGS_ACTIVITY, type CocoonLabel, type CocoonUiContext } from "./cocoon-navigation";

export async function openCocoonTab(context: CocoonUiContext, tab: "settings_tab_library" | "settings_tab_system"): Promise<AndroidUiSnapshot> {
  let snapshot = await openCocoonSettings(context);
  for (let attempt = 0; !cocoonAction(context, snapshot, tab) && attempt < 6; attempt++) {
    try {
      await pressCocoonKey(context, "KEYCODE_BACK", snapshot);
      const identity = JSON.stringify(snapshot.nodes.map((node) => [node.text, node.description]));
      snapshot = await waitCocoonUi(context, (value) => value.component === COCOON_SETTINGS_ACTIVITY
        && JSON.stringify(value.nodes.map((node) => [node.text, node.description])) !== identity ? value : undefined);
    } catch (error) {
      if (!(error instanceof AndroidUiStateChangedError)) throw error;
      snapshot = await waitCocoonUi(context, (value) => value.component === COCOON_SETTINGS_ACTIVITY ? value : undefined);
    }
  }
  return activateCocoon(context, tab, (value) => value.component === COCOON_SETTINGS_ACTIVITY && !cocoonHas(context, value, tab), snapshot);
}

export async function findCocoonSetting(context: CocoonUiContext, key: CocoonLabel, initial?: AndroidUiSnapshot): Promise<AndroidUiSnapshot> {
  const snapshot = initial?.component === COCOON_SETTINGS_ACTIVITY && initial.user === context.user ? initial : await waitCocoonUi(context,
    (value) => value.component === COCOON_SETTINGS_ACTIVITY && value.user === context.user ? value : undefined);
  if (cocoonAction(context, snapshot, key)) return snapshot;
  // Search the native index before moving the list. Dialog-only controls and
  // individual platform names are not indexed and still need list navigation.
  if (isCocoonSearchSetting(key) && cocoonAction(context, snapshot, "common_search")) {
    return findCocoonSettingBySearch(context, key, snapshot);
  }
  const found = await findCocoonListItem(context, (value) => !!cocoonAction(context, value, key), "up", snapshot);
  if (found) return found;
  throw new Error(`Cocoon's ${[...(context.labels.get(key) ?? [])][0] ?? key} setting was not found.`);
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
  let scrolled = false;
  const identity = (value: AndroidUiSnapshot): string => JSON.stringify(value.nodes
    .filter((node) => node.text || node.description || node.scrollable)
    .map((node) => [node.text, node.description, node.bounds]));
  let snapshot = initial?.component === COCOON_SETTINGS_ACTIVITY && initial.user === context.user ? initial : undefined;
  for (let step = 0; step < 100; step++) {
    snapshot ??= await waitCocoonUi(context, (value) => value.component === COCOON_SETTINGS_ACTIVITY ? value : undefined);
    if (found(snapshot)) {
      if (!scrolled) return snapshot;
      // A row can pass under the fixed toolbar while a swipe is settling.
      // Confirm its position before handing it to the activation loop.
      const confirmed = await waitCocoonUi(context, (value) => value.component === COCOON_SETTINGS_ACTIVITY ? value : undefined);
      if (found(confirmed) && identity(confirmed) === identity(snapshot)) return confirmed;
      snapshot = confirmed;
      continue;
    }
    const lists = snapshot.nodes.filter((node) => node.packageName === COCOON_PACKAGE && node.enabled
      && (node.scrollable || node.className === "android.widget.ScrollView"));
    if (lists.length !== 1 || !lists[0]) throw new Error("Cocoon's settings list is unavailable or ambiguous.");
    if (!lists[0].scrollable) return undefined;
    const signature = identity(snapshot);
    repeated = previous === signature ? repeated + 1 : 0;
    if (repeated >= 2) {
      if (reversed) return undefined;
      reversed = true;
      previous = "";
      repeated = 0;
    } else previous = signature;
    const direction = reversed ? (initialDirection === "up" ? "down" : "up") : initialDirection;
    try { await scrollCocoonList(context, snapshot, lists[0], direction); scrolled = true; }
    catch (error) { if (!(error instanceof AndroidUiStateChangedError)) throw error; }
    snapshot = undefined;
  }
  throw new Error("Cocoon's settings navigation exceeded its limit.");
}
