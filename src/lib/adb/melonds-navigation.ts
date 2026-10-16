import { AndroidUiStateChangedError, pressAndroidUiKey, type AndroidUiNode, type AndroidUiSnapshot } from "./android-ui";
import { DeviceUnlockRequiredError } from "./device-awake";
import { androidResourceText, emulatorNodeVisible, restartEmulator, scrollEmulatorList, tapEmulatorNode, uiNode, uiWithin, waitEmulatorUi, type EmulatorUiContext } from "./emulator-ui";
import { EMULATORS } from "./emulators";
import { checkActivityStart, shellCommand } from "./transport";

export const MELONDS_PACKAGE = EMULATORS.melonds.packages[0];
const MAIN = `${MELONDS_PACKAGE}/.ui.romlist.RomListActivity`;
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
  const { snapshot, row } = await melonDsPreference(context, resource, initial);
  await tapEmulatorNode(context, snapshot, row);
}

/** SettingsActivity is not exported in 2.0.1; its main activity offers no settings deep link. */
export async function openMelonDsMenu(context: EmulatorUiContext, resource: "settings" | "dsiware_manager"): Promise<void> {
  await context.ensureUnlocked();
  checkActivityStart(await context.device.shell(shellCommand("am", "start", "--user", String(context.user), "--display", "0", "-W",
    "-f", "0x10008000", "-n", MAIN)));
  const overflow = await melonDsText(context, "abc_action_menu_overflow_description");
  const main = await waitEmulatorUi(context, (snapshot) => snapshot.component.startsWith(`${MELONDS_PACKAGE}/`)
    && uiNode(snapshot, id("toolbar")) && snapshot.nodes.some((node) => node.description === overflow) ? snapshot : undefined);
  const toolbar = uiNode(main, id("toolbar"));
  const buttons = main.nodes.filter((node) => node.clickable && node.description === overflow && toolbar && uiWithin(main, node, toolbar));
  if (buttons.length !== 1 || !buttons[0]) throw new Error("melonDS's settings menu is unavailable.");
  await tapEmulatorNode(context, main, buttons[0]);
  const settings = await melonDsText(context, resource);
  const menu = await waitEmulatorUi(context, (value) => uiNode(value, id("title"), settings) ? value : undefined);
  const item = uiNode(menu, id("title"), settings);
  if (!item) throw new Error("melonDS's settings action is unavailable.");
  await tapEmulatorNode(context, menu, item);
}

export async function openMelonDsPreferences(context: EmulatorUiContext, page: "firmware" | "roms"): Promise<AndroidUiSnapshot> {
  await openMelonDsMenu(context, "settings");
  const enter = async (resource: string, initial?: AndroidUiSnapshot): Promise<AndroidUiSnapshot> => {
    const title = await melonDsText(context, resource);
    await tapMelonDsPreference(context, resource, initial);
    return waitEmulatorUi(context, (snapshot) => {
      const toolbar = uiNode(snapshot, id("toolbar"));
      return snapshot.component === SETTINGS && toolbar && snapshot.nodes.some((node) => node.text === title && uiWithin(snapshot, node, toolbar)) ? snapshot : undefined;
    });
  };
  const category = await enter(page === "roms" ? "category_roms" : "category_system");
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
