import { AndroidUiStateChangedError, pressAndroidUiKey, type AndroidUiNode, type AndroidUiSnapshot } from "./android-ui";
import { DeviceUnlockRequiredError } from "./device-awake";
import { androidResourceText, emulatorNodeVisible, restartEmulator, scrollEmulatorList, tapEmulatorNode, uiNode, uiWithin, waitEmulatorUi, type EmulatorUiContext } from "./emulator-ui";
import { EMULATORS } from "./emulators";
import { checkActivityStart, shellCommand } from "./transport";

export const MELONDS_PACKAGE = EMULATORS.melonds.packages[0];
const MAIN = `${MELONDS_PACKAGE}/${MELONDS_PACKAGE}.ui.romlist.RomListActivity`;
const SETTINGS = `${MELONDS_PACKAGE}/${MELONDS_PACKAGE}.ui.settings.SettingsActivity`;
const id = (name: string): string => `${MELONDS_PACKAGE}:id/${name}`;
const resourceTexts = new WeakMap<EmulatorUiContext, Map<string, Promise<string>>>();

export async function melonDsText(context: EmulatorUiContext, resource: string): Promise<string> {
  context.signal?.throwIfAborted();
  let texts = resourceTexts.get(context);
  if (!texts) { texts = new Map(); resourceTexts.set(context, texts); }
  let text = texts.get(resource);
  if (!text) {
    text = androidResourceText(context, MELONDS_PACKAGE, `${MELONDS_PACKAGE}:string/${resource}`);
    texts.set(resource, text);
  }
  return text;
}

export interface MelonDsPreference {
  snapshot: AndroidUiSnapshot;
  row: AndroidUiNode;
  children: readonly AndroidUiNode[];
}

export async function melonDsPreference(context: EmulatorUiContext, resource: string, initial?: AndroidUiSnapshot): Promise<MelonDsPreference> {
  if (initial && (initial.user !== context.user || initial.component !== SETTINGS)) throw new Error("melonDS's preference page belongs to another interface or profile.");
  const label = await melonDsText(context, resource);
  let previous = "";
  let direction: "down" | "up" = "down";
  let keyboard = false;
  let snapshot = initial;
  for (let attempt = 0; attempt < 24; attempt++) {
    snapshot ??= await waitEmulatorUi(context, (value) => value.component === SETTINGS
      && uiNode(value, id("recycler_view")) ? value : undefined);
    const title = uiNode(snapshot, "android:id/title", label);
    if (title && emulatorNodeVisible(snapshot, title)) {
      let row: AndroidUiNode | undefined = title;
      while (row && !row.clickable) row = row.parent === null ? undefined : snapshot.nodes[row.parent];
      if (!row) throw new Error("melonDS's preference action is unavailable.");
      const selected = row;
      const current = snapshot;
      return { snapshot: current, row: selected, children: current.nodes.filter((node) => uiWithin(current, node, selected)) };
    }
    const list = uiNode(snapshot, id("recycler_view"));
    const signature = JSON.stringify(snapshot.nodes.map((node) => [node.resourceId, node.text, node.bounds, node.focused, node.selected]));
    if (!list?.scrollable) break;
    if (signature === previous) {
      if (!keyboard) keyboard = true;
      else if (direction === "up") break;
      else direction = "up";
    }
    if (keyboard) {
      // Some native preference lists ignore touch scrolling at compact sizes.
      // Direction keys reveal rows without activating or changing preferences.
      try {
        await pressAndroidUiKey(context.device, context.user, snapshot, direction === "down" ? "KEYCODE_DPAD_DOWN" : "KEYCODE_DPAD_UP", context.signal);
        previous = signature;
      } catch (error) {
        if (error instanceof DeviceUnlockRequiredError) await context.ensureUnlocked();
        else if (!(error instanceof AndroidUiStateChangedError)) throw error;
        previous = "";
      }
    } else previous = await scrollEmulatorList(context, snapshot, list, direction) ? signature : "";
    snapshot = undefined;
  }
  throw new Error(`melonDS's ${resource} preference was not found.`);
}

export async function tapMelonDsPreference(context: EmulatorUiContext, resource: string, initial?: AndroidUiSnapshot): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { snapshot, row } = await melonDsPreference(context, resource, initial);
    initial = undefined;
    try {
      await tapEmulatorNode(context, snapshot, row);
      return;
    } catch (error) {
      // Preference rows are recycled while the settings page settles. A stale
      // pre-input snapshot may be re-resolved by its exact native resource label.
      context.signal?.throwIfAborted();
      if (!(error instanceof AndroidUiStateChangedError)) throw error;
    }
  }
  throw new Error(`melonDS's ${resource} preference did not become ready.`);
}

/** SettingsActivity is not exported in 2.0.1; its main activity offers no settings deep link. */
export async function openMelonDsMenu(context: EmulatorUiContext, resource: "settings" | "dsiware_manager"): Promise<void> {
  await context.ensureUnlocked();
  checkActivityStart(await context.device.shell(shellCommand("am", "start", "--user", String(context.user), "--display", "0", "-W",
    "-f", "0x10008000", "-n", MAIN)));
  await waitEmulatorUi(context, async (snapshot) => {
    if (snapshot.component !== MAIN || !uiNode(snapshot, id("toolbar"))) return undefined;
    await pressAndroidUiKey(context.device, context.user, snapshot, "KEYCODE_MENU", context.signal);
    return true;
  });
  const settings = await melonDsText(context, resource);
  await waitEmulatorUi(context, async (snapshot) => {
    const item = snapshot.component === MAIN ? uiNode(snapshot, id("title"), settings) : undefined;
    if (!item) return undefined;
    await tapEmulatorNode(context, snapshot, item);
    return true;
  });
}

export async function openMelonDsPreferences(context: EmulatorUiContext, page: "firmware" | "roms"): Promise<AndroidUiSnapshot> {
  const resources = { root: "settings", system: "category_system", firmware: "custom_bios_firmware", roms: "category_roms" } as const;
  type Page = keyof typeof resources;
  const titles = new Map(await Promise.all(Object.entries(resources).map(async ([key, resource]) =>
    [key, await melonDsText(context, resource)] as const)));
  const currentPage = (snapshot: AndroidUiSnapshot): Page | undefined => {
    if (snapshot.component !== SETTINGS || !uiNode(snapshot, id("recycler_view"))) return undefined;
    if (["android:id/button1", "android:id/button2", "android:id/button3", "android:id/alertTitle", id("alertTitle"),
      "android:id/select_dialog_listview", id("select_dialog_listview")].some((resource) => uiNode(snapshot, resource))) {
      throw new Error("Close melonDS's open settings dialog before navigating.");
    }
    const toolbar = uiNode(snapshot, id("toolbar"));
    const matches = Object.keys(resources).filter((key) => toolbar && snapshot.nodes.some((node) =>
      node.text === titles.get(key) && uiWithin(snapshot, node, toolbar)));
    if (matches.length > 1) throw new Error("melonDS's settings page is ambiguous.");
    return matches[0] as Page | undefined;
  };
  let snapshot = await waitEmulatorUi(context, (value) => value);
  // Re-enter unrelated preference lists through Main, without guessing BACK.
  const otherPreferences = snapshot.component === SETTINGS && !currentPage(snapshot)
    && !!uiNode(snapshot, id("toolbar")) && !!uiNode(snapshot, id("recycler_view"));
  if (snapshot.component !== SETTINGS || otherPreferences) {
    await openMelonDsMenu(context, "settings");
    snapshot = await waitEmulatorUi(context, (value) => currentPage(value) === "root" ? value : undefined);
  }
  // Firmware is nested under System; ROMs is directly under the settings root.
  // Reuse only recognized pages, never BACK through an unknown dialog or editor.
  for (let depth = 0, retries = 0; depth < 3;) {
    const current = currentPage(snapshot);
    if (!current) throw new Error("melonDS's current settings page is unsupported.");
    if (current === page) return snapshot;
    if (current === "root" || (current === "system" && page === "firmware")) break;
    try { await pressAndroidUiKey(context.device, context.user, snapshot, "KEYCODE_BACK", context.signal); }
    catch (error) {
      if (!(error instanceof AndroidUiStateChangedError) || ++retries >= 4) throw error;
      snapshot = await waitEmulatorUi(context, (value) => value);
      continue;
    }
    depth++; retries = 0;
    snapshot = await waitEmulatorUi(context, (value) => {
      const next = currentPage(value);
      return (next && next !== current) || (value.component === MAIN && uiNode(value, id("toolbar"))) ? value : undefined;
    });
    // The native DSi setup error can open firmware as the root fragment, with
    // no parent settings page. Re-enter through the exported main activity then.
    if (snapshot.component === MAIN) {
      await openMelonDsMenu(context, "settings");
      snapshot = await waitEmulatorUi(context, (value) => currentPage(value) === "root" ? value : undefined);
    }
  }
  const enter = async (resource: string, initial?: AndroidUiSnapshot): Promise<AndroidUiSnapshot> => {
    const title = await melonDsText(context, resource);
    await tapMelonDsPreference(context, resource, initial);
    return waitEmulatorUi(context, (snapshot) => {
      const toolbar = uiNode(snapshot, id("toolbar"));
      return snapshot.component === SETTINGS && toolbar && snapshot.nodes.some((node) => node.text === title && uiWithin(snapshot, node, toolbar)) ? snapshot : undefined;
    });
  };
  const current = currentPage(snapshot);
  if (current !== "root" && !(current === "system" && page === "firmware")) throw new Error("melonDS's settings root could not be opened.");
  const category = current === "system" ? snapshot : await enter(page === "roms" ? "category_roms" : "category_system", snapshot);
  return page === "firmware" ? enter("custom_bios_firmware", category) : category;
}

export function melonDsSummary(preference: MelonDsPreference): string | undefined {
  const summaries = preference.children.filter((node) => node.resourceId === "android:id/summary");
  if (summaries.length > 1) throw new Error("melonDS reported ambiguous preference values.");
  return summaries[0]?.text;
}

/** HOME completes SharedPreferences writes before the process is stopped. */
export async function restartMelonDs(context: EmulatorUiContext): Promise<void> {
  await restartEmulator(context, MELONDS_PACKAGE, "melonDS");
}
