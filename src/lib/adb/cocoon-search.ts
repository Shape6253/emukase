import { AndroidUiStateChangedError, type AndroidUiNode, type AndroidUiSnapshot } from "./android-ui";
import { activateCocoon, activateCocoonControl, cocoonAction, cocoonMatches, cocoonTextAction, pressCocoonKey,
  tapCocoonNode, waitCocoonUi, COCOON_PACKAGE, COCOON_SETTINGS_ACTIVITY, type CocoonUiContext } from "./cocoon-navigation";
import { uiWithin } from "./emulator-ui";

export type CocoonSearchSetting = "settings_library_title_rom_folder" | "settings_system_title_language"
  | "settings_system_title_single_screen" | "settings_library_cd_add_platform";

// Cocoon 3.07 searches a fixed English index, regardless of its display locale.
// Platform names are absent from that index and must use the library list.
const QUERIES: Readonly<Record<CocoonSearchSetting, string>> = {
  settings_library_title_rom_folder: "rom",
  settings_system_title_language: "lan",
  settings_system_title_single_screen: "dual",
  settings_library_cd_add_platform: "console",
};

export function isCocoonSearchSetting(key: string): key is CocoonSearchSetting {
  return Object.hasOwn(QUERIES, key);
}

function searchField(context: CocoonUiContext, snapshot: AndroidUiSnapshot): AndroidUiNode | undefined {
  if (snapshot.component !== COCOON_SETTINGS_ACTIVITY || snapshot.user !== context.user) return undefined;
  const headings = snapshot.nodes.filter((node) => cocoonMatches(context, node, "common_settings") && node.parent !== null);
  if (!headings.length) return undefined;
  if (headings.length !== 1 || !headings[0]) throw new Error("Cocoon's settings toolbar is ambiguous.");
  const fields = snapshot.nodes.filter((node) => node.parent === headings[0]?.parent
    && node.packageName === COCOON_PACKAGE && node.clickable && node.enabled);
  if (fields.length > 1) throw new Error("Cocoon's settings search field is ambiguous.");
  return fields[0];
}

function searchText(context: CocoonUiContext, snapshot: AndroidUiSnapshot): string | undefined {
  const field = searchField(context, snapshot);
  if (!field) return undefined;
  const texts = snapshot.nodes.filter((node) => node.packageName === COCOON_PACKAGE
    && node.className === "android.widget.TextView" && node.text && uiWithin(snapshot, node, field));
  if (texts.length > 1) throw new Error("Cocoon's settings search query is ambiguous.");
  return texts[0]?.text;
}

function searchKeyboard(context: CocoonUiContext, snapshot: AndroidUiSnapshot): boolean {
  return !!searchField(context, snapshot) && !!cocoonTextAction(context, snapshot, "backspace")
    && !!cocoonTextAction(context, snapshot, "q") && !!cocoonTextAction(context, snapshot, "z");
}

async function enterSearchCharacter(
  context: CocoonUiContext, initial: AndroidUiSnapshot, prefix: string, letter: string,
): Promise<AndroidUiSnapshot> {
  let snapshot = initial;
  const expected = prefix + letter;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!searchKeyboard(context, snapshot)) throw new Error("Cocoon's settings search keyboard closed before typing finished.");
    const query = searchText(context, snapshot);
    if (query === expected) return snapshot;
    // An empty query uses a visual placeholder, whose wording is not a selector.
    if (prefix && query !== prefix) throw new Error("Cocoon's settings search query changed before typing finished.");
    const control = cocoonTextAction(context, snapshot, letter);
    if (!control) throw new Error("Cocoon's settings search keyboard does not offer the required Latin key.");
    try {
      await tapCocoonNode(context, snapshot, control);
      return await waitCocoonUi(context, (value) => searchKeyboard(context, value)
        && searchText(context, value) === expected ? value : undefined);
    } catch (error) {
      if (!(error instanceof AndroidUiStateChangedError) || attempt === 7) throw error;
      snapshot = await waitCocoonUi(context, (value) => searchKeyboard(context, value) ? value : undefined);
    }
  }
  throw new Error("Cocoon's settings search could not enter its query.");
}

/** Open a static setting from an already-open Settings tab with Search closed.
 * Returns the actual settings row after activating the result and clearing Search.
 * Cocoon's custom keyboard accepts its visible keys instead of Android input text.
 */
export async function findCocoonSettingBySearch(
  context: CocoonUiContext, key: CocoonSearchSetting, initial?: AndroidUiSnapshot,
): Promise<AndroidUiSnapshot> {
  if (!Object.hasOwn(QUERIES, key)) throw new Error("Cocoon's requested setting does not support search.");
  let snapshot = initial?.component === COCOON_SETTINGS_ACTIVITY && initial.user === context.user ? initial : await waitCocoonUi(context,
    (value) => value.component === COCOON_SETTINGS_ACTIVITY && value.user === context.user ? value : undefined);
  if (!cocoonAction(context, snapshot, "common_search") || searchKeyboard(context, snapshot)) {
    throw new Error("Open a Cocoon settings tab with Search closed before finding a setting.");
  }
  if (cocoonAction(context, snapshot, key)) return snapshot;
  snapshot = await activateCocoon(context, "common_search", (value) => searchKeyboard(context, value), snapshot);
  const query = QUERIES[key];
  let prefix = "";
  for (const letter of query) {
    snapshot = await enterSearchCharacter(context, snapshot, prefix, letter);
    prefix += letter;
  }
  snapshot = await activateCocoonControl(context,
    (value) => searchKeyboard(context, value) && searchText(context, value) === query ? searchField(context, value) : undefined,
    (value) => !searchKeyboard(context, value) && searchText(context, value) === query && !!cocoonAction(context, value, key),
    snapshot, (value) => pressCocoonKey(context, "KEYCODE_BUTTON_START", value));
  return activateCocoon(context, key, (value) => value.component === COCOON_SETTINGS_ACTIVITY
    && !searchKeyboard(context, value) && !!cocoonAction(context, value, "common_search") && !!cocoonAction(context, value, key), snapshot);
}
