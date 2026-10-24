import { hasAndroidTreeReadGrant, selectAndroidDocument } from "./android-document-picker";
import { primaryStorageForUser } from "./android-user";
import type { AndroidUiNode, AndroidUiSnapshot } from "./android-ui";
import { DAIJISHO_PACKAGE, daijishoId, daijishoLabel, findDaijishoControl, isDaijisho, openDaijishoLibrarySettings,
  tapDaijisho, type DaijishoUiContext } from "./daijisho-navigation";
import { readDaijishoPlatformIdentity } from "./daijisho-platforms";
import { uiNode, waitEmulatorUi } from "./emulator-ui";

export async function importDaijishoPegasus(context: DaijishoUiContext, path: string): Promise<void> {
  const control = (value: AndroidUiSnapshot): AndroidUiNode | undefined => daijishoLabel(context, value, "import_from_pegasus_title", "android:id/title");
  const snapshot = await findDaijishoControl(context, control, await openDaijishoLibrarySettings(context), "down");
  if (!snapshot) throw new Error("Daijishō does not expose its native Pegasus importer.");
  await tapDaijisho(context, control, (value) => /documentsui.*\/com.android.documentsui.picker.PickActivity$/.test(value.component), snapshot);
  // Use the app's own activity result, not a fabricated URI permission or direct database write.
  await selectAndroidDocument(context, DAIJISHO_PACKAGE, path, false, undefined, { action: "GET_CONTENT", keyboardNavigation: false });
  const returned = await waitEmulatorUi(context, (value) => isDaijisho(value) ? value : undefined);
  if (daijishoLabel(context, returned, "replace_platform_warning_title") || uiNode(returned, "android:id/button1")) {
    throw new Error("Daijishō reported a conflicting import. Replacement was not authorized; resolve its dialog before retrying.");
  }
}

function pathsButton(snapshot: AndroidUiSnapshot): AndroidUiNode | undefined {
  const buttons = ["wallpaper", "thumbnails"].flatMap((layout) => {
    const node = uiNode(snapshot, daijishoId(`library_collection_${layout}_view_platform_add_sync_trees_button`));
    return node ? [node] : [];
  });
  if (buttons.length > 1) throw new Error("Daijishō's platform path controls are ambiguous.");
  return buttons[0];
}

function pathsDialogOpen(context: DaijishoUiContext, snapshot: AndroidUiSnapshot): boolean {
  // An empty ListView has no visible accessibility node; identify its dialog instead.
  return !!daijishoLabel(context, snapshot, "synchronization_paths_title")
    && !!uiNode(snapshot, "android:id/button2") && !!uiNode(snapshot, "android:id/button3");
}

/** Add only a missing path. Existing paths and working persisted grants are never reselected. */
export async function configureDaijishoFolder(context: DaijishoUiContext, directory: string, platform: AndroidUiSnapshot): Promise<boolean> {
  const identity = readDaijishoPlatformIdentity(platform);
  if (!identity) throw new Error("Daijishō's current platform could not be identified before configuring its ROM folder.");
  const primary = primaryStorageForUser(context.user);
  if (!directory.startsWith(`${primary}/`)) throw new Error("Daijishō's ROM folder belongs to another Android profile.");
  const wanted = `/tree/primary:${directory.slice(primary.length + 1)}`;
  const row = (value: AndroidUiSnapshot): AndroidUiNode | undefined => uiNode(value, daijishoId("list_item_theme_pack_choice_title"), wanted);
  const control = (value: AndroidUiSnapshot): AndroidUiNode | undefined =>
    readDaijishoPlatformIdentity(value)?.name === identity.name ? pathsButton(value) : undefined;
  const opened = await tapDaijisho(context, control, (value) => pathsDialogOpen(context, value), platform);
  const selected = await findDaijishoControl(context, row, opened);
  let connected = !!selected;
  if (!connected) {
    await tapDaijisho(context, (value) => uiNode(value, "android:id/button3"),
      (value) => /documentsui.*\/com.android.documentsui.picker.PickActivity$/.test(value.component));
    await selectAndroidDocument(context, DAIJISHO_PACKAGE, directory, true, undefined, { directoryNavigation: "text-first" });
    const returned = await waitEmulatorUi(context, (value) => pathsDialogOpen(context, value) ? value : undefined);
    connected = !!await findDaijishoControl(context, row, returned);
  }
  // Daijishō does not renew permissions when re-adding an existing URI. Never delete it to work around that.
  await tapDaijisho(context, (value) => uiNode(value, "android:id/button2"),
    (value) => isDaijisho(value) && !pathsDialogOpen(context, value));
  return connected && await hasAndroidTreeReadGrant(context, DAIJISHO_PACKAGE, directory, true);
}
