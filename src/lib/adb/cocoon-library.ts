import { hasAndroidTreeReadGrant, selectAndroidDocument } from "./android-document-picker";
import type { AndroidUiNode, AndroidUiSnapshot } from "./android-ui";
import { uiWithin } from "./emulator-ui";
import { activateCocoon, cocoonAction, isCocoon, waitCocoonUi, COCOON_PACKAGE, type CocoonUiContext } from "./cocoon-navigation";
import { findCocoonSetting, openCocoonTab } from "./cocoon-settings";
import type { ConfigurationItemState } from "./emulator-configuration-types";

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
    await activateCocoon(context, "settings_library_title_rom_folder", (value) => !isCocoon(value), snapshot);
    await selectAndroidDocument(context, COCOON_PACKAGE, directory, true, undefined, { keyboardNavigation: true });
    snapshot = await waitCocoonUi(context, (value) => connected(value) ? value : undefined);
    if (!granted) granted = await hasAndroidTreeReadGrant(context, COCOON_PACKAGE, directory);
  }
  // The native setting exposes only a basename, so the exact saved path remains unverified.
  return connected(snapshot) && granted ? "unverified" : "missing";
}
