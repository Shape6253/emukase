import type { AndroidUiNode, AndroidUiSnapshot } from "./android-ui";
import { androidResourceText, emulatorNodeVisible, restartEmulator, scrollEmulatorList, tapEmulatorNode, uiNode, uiWithin, waitEmulatorUi, type EmulatorUiContext } from "./emulator-ui";
import { EMULATORS } from "./emulators";
import { checkActivityStart, shellCommand } from "./transport";

export const MELONDS_PACKAGE = EMULATORS.melonds.packages[0];
const MAIN = `${MELONDS_PACKAGE}/.ui.romlist.RomListActivity`;
const SETTINGS = `${MELONDS_PACKAGE}/${MELONDS_PACKAGE}.ui.settings.SettingsActivity`;
const id = (name: string): string => `${MELONDS_PACKAGE}:id/${name}`;

export function melonDsText(context: EmulatorUiContext, resource: string): Promise<string> {
  return androidResourceText(context, MELONDS_PACKAGE, `${MELONDS_PACKAGE}:string/${resource}`);
}

export interface MelonDsPreference {
  snapshot: AndroidUiSnapshot;
  row: AndroidUiNode;
  children: readonly AndroidUiNode[];
}

export async function melonDsPreference(context: EmulatorUiContext, resource: string): Promise<MelonDsPreference> {
  const label = await melonDsText(context, resource);
  let previous = "";
  let direction: "down" | "up" = "down";
  for (let attempt = 0; attempt < 24; attempt++) {
    const snapshot = await waitEmulatorUi(context, (value) => value.component === SETTINGS
      && uiNode(value, id("recycler_view")) ? value : undefined);
    const title = uiNode(snapshot, "android:id/title", label);
    if (title && emulatorNodeVisible(snapshot, title)) {
      let row: AndroidUiNode | undefined = title;
      while (row && !row.clickable) row = row.parent === null ? undefined : snapshot.nodes[row.parent];
      if (!row) throw new Error("melonDS's preference action is unavailable.");
      const selected = row;
      return { snapshot, row: selected, children: snapshot.nodes.filter((node) => uiWithin(snapshot, node, selected)) };
    }
    const list = uiNode(snapshot, id("recycler_view"));
    const signature = JSON.stringify(snapshot.nodes.map((node) => [node.resourceId, node.text, node.bounds]));
    if (!list?.scrollable) break;
    if (signature === previous) {
      if (direction === "up") break;
      direction = "up";
    }
    previous = signature;
    await scrollEmulatorList(context, snapshot, list, direction);
  }
  throw new Error(`melonDS's ${resource} preference was not found.`);
}

export async function tapMelonDsPreference(context: EmulatorUiContext, resource: string): Promise<void> {
  const { snapshot, row } = await melonDsPreference(context, resource);
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

export async function openMelonDsPreferences(context: EmulatorUiContext, page: "firmware" | "roms"): Promise<void> {
  await openMelonDsMenu(context, "settings");
  const enter = async (resource: string): Promise<void> => {
    const title = await melonDsText(context, resource);
    await tapMelonDsPreference(context, resource);
    await waitEmulatorUi(context, (snapshot) => {
      const toolbar = uiNode(snapshot, id("toolbar"));
      return snapshot.component === SETTINGS && toolbar && snapshot.nodes.some((node) => node.text === title && uiWithin(snapshot, node, toolbar)) ? true : undefined;
    });
  };
  await enter(page === "roms" ? "category_roms" : "category_system");
  if (page === "firmware") await enter("custom_bios_firmware");
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
