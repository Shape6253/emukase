import { hasAndroidTreeReadGrant, selectAndroidDocument } from "./android-document-picker";
import { primaryStorageForUser } from "./android-user";
import type { AndroidUiNode, AndroidUiSnapshot } from "./android-ui";
import { DAIJISHO_PACKAGE, daijishoId, daijishoLabel, findDaijishoControl, isDaijisho, openDaijishoInspector, openDaijishoLibrarySettings,
  openDaijishoTab, tapDaijisho, type DaijishoUiContext } from "./daijisho-navigation";
import type { DaijishoProfile } from "./daijisho-profiles";
import { uiNode, waitEmulatorUi } from "./emulator-ui";

interface ProfileInspection { exists: boolean; accepted: boolean; reason?: string }

async function fieldsMatch(context: DaijishoUiContext, fields: Readonly<Record<string, string | boolean>>): Promise<boolean> {
  let matches = true;
  for (const [name, expected] of Object.entries(fields)) {
    const snapshot = await findDaijishoControl(context, (value) => uiNode(value, daijishoId(name)));
    if (!snapshot) throw new Error(`Daijishō does not expose its ${name} setting.`);
    const node = uiNode(snapshot, daijishoId(name));
    // The default-player dropdown prefixes its player name with a list index.
    const actual = name === "platform_default_player_select" ? node?.text.replace(/^(?:0|[1-9]\d*) - /, "") : node?.text;
    matches = matches && !!node && (typeof expected === "boolean" ? node.checked === expected : actual === expected);
  }
  return matches;
}

async function closeEditor(context: DaijishoUiContext, field: string): Promise<void> {
  await tapDaijisho(context, (value) => uiNode(value, "android:id/button2"),
    (value) => isDaijisho(value) && !uiNode(value, daijishoId(field)));
}

/** Inspect native settings without saving edits or replacing an existing platform/player. */
export async function inspectDaijishoProfile(context: DaijishoUiContext, profile: DaijishoProfile): Promise<ProfileInspection> {
  const platformRow = (value: AndroidUiSnapshot): AndroidUiNode | undefined => uiNode(value, daijishoId("list_item_platform_first_line"), profile.name);
  const platforms = await findDaijishoControl(context, platformRow, await openDaijishoInspector(context, "platforms"));
  if (!platforms) return { exists: false, accepted: false, reason: "Platform has not been imported." };
  await tapDaijisho(context, platformRow, (value) => !!uiNode(value, daijishoId("platform_name_edit_text")), platforms);
  const platformMatches = await fieldsMatch(context, {
    platform_name_edit_text: profile.name, platform_shortname_edit_text: profile.shortname,
    platform_accepted_filename_regex_edit_text: profile.platformRegex, platform_default_player_select: profile.playerName,
  });
  await closeEditor(context, "platform_name_edit_text");
  if (!platformMatches) return { exists: true, accepted: false, reason: "Existing platform/default player differs; no settings were overwritten." };
  const playerRow = (value: AndroidUiSnapshot): AndroidUiNode | undefined => uiNode(value, daijishoId("list_item_player_first_line"), profile.playerName);
  const players = await findDaijishoControl(context, playerRow, await openDaijishoInspector(context, "players"));
  if (!players) return { exists: true, accepted: false, reason: "The configured player is missing." };
  await tapDaijisho(context, playerRow, (value) => !!uiNode(value, daijishoId("player_am_start_arguments_edit_text")), players);
  const playerMatches = await fieldsMatch(context, { player_am_start_arguments_edit_text: profile.arguments,
    player_accepted_filename_regex_edit_text: profile.regex, player_kill_package_processes_switch: false });
  await closeEditor(context, "player_am_start_arguments_edit_text");
  return { exists: true, accepted: playerMatches,
    ...(!playerMatches ? { reason: "Existing player arguments differ; no settings were overwritten." } : {}) };
}

export async function importDaijishoProfile(context: DaijishoUiContext, path: string): Promise<void> {
  const control = (value: AndroidUiSnapshot): AndroidUiNode | undefined => daijishoLabel(context, value, "import_platform_title", "android:id/title");
  const snapshot = await findDaijishoControl(context, control, await openDaijishoLibrarySettings(context));
  if (!snapshot) throw new Error("Daijishō does not expose its JSON platform importer.");
  await tapDaijisho(context, control, (value) => /documentsui.*\/com.android.documentsui.picker.PickActivity$/.test(value.component), snapshot);
  // Use the app's own activity result, not a fabricated URI permission or direct database write.
  context.onMutation?.();
  await selectAndroidDocument(context, DAIJISHO_PACKAGE, path, false, undefined, { action: "GET_CONTENT", keyboardNavigation: false });
  const returned = await waitEmulatorUi(context, (value) => isDaijisho(value) ? value : undefined);
  if (daijishoLabel(context, returned, "replace_platform_warning_title") || uiNode(returned, "android:id/button1")) {
    throw new Error("Daijishō reported a conflicting import. Replacement was not authorized; resolve its dialog before retrying.");
  }
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
}

function visiblePlatform(snapshot: AndroidUiSnapshot): string {
  for (const layout of ["wallpaper", "thumbnails"]) {
    const prefix = `library_collection_${layout}_view_platform_title_`;
    const names = ["first_text_view", "second_text_view"].map((name) => uiNode(snapshot, daijishoId(prefix + name))?.text ?? "");
    if (names.some(Boolean)) return normalize(names.join(" "));
    const title = uiNode(snapshot, daijishoId(prefix + "text_view"))?.text;
    if (title) return normalize(title);
  }
  return "";
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

async function openPlatformPaths(context: DaijishoUiContext, profile: DaijishoProfile): Promise<AndroidUiSnapshot> {
  await openDaijishoTab(context, "platforms");
  const visited = new Set<string>();
  for (let step = 0; step < 100; step++) {
    const snapshot = await waitEmulatorUi(context, (value) => isDaijisho(value) && visiblePlatform(value) ? value : undefined);
    const current = visiblePlatform(snapshot);
    if (current === normalize(profile.name) && pathsButton(snapshot)) {
      return tapDaijisho(context, pathsButton, (value) => pathsDialogOpen(context, value), snapshot);
    }
    const row = snapshot.nodes.filter((node) => node.resourceId === daijishoId("list_item_library_collection_wallpaper_view_text_view")
      && normalize(node.text) === normalize(profile.name));
    if (row.length > 1) throw new Error("Daijishō's platform name is ambiguous.");
    const target = row[0];
    if (target) {
      await tapDaijisho(context, (value) => uiNode(value, target.resourceId, target.text),
        (value) => visiblePlatform(value) === normalize(profile.name), snapshot);
      continue;
    }
    if (visited.has(current)) throw new Error(`Daijishō's visible platforms do not include ${profile.name}.`);
    visited.add(current);
    if (!uiNode(snapshot, daijishoId("library_collection_wallpaper_view_next_view"))) throw new Error("Daijishō's current platform layout does not expose native carousel navigation.");
    await tapDaijisho(context, (value) => uiNode(value, daijishoId("library_collection_wallpaper_view_next_view")),
      (value) => !!visiblePlatform(value) && visiblePlatform(value) !== current, snapshot);
  }
  throw new Error("Daijishō's platform carousel exceeded its search limit.");
}

/** Add only a missing path. Existing paths and working persisted grants are never reselected. */
export async function inspectDaijishoFolder(context: DaijishoUiContext, profile: DaijishoProfile, directory: string, configure: boolean): Promise<boolean> {
  const primary = primaryStorageForUser(context.user);
  if (!directory.startsWith(`${primary}/`)) throw new Error("Daijishō's ROM folder belongs to another Android profile.");
  const wanted = `/tree/primary:${directory.slice(primary.length + 1)}`;
  const row = (value: AndroidUiSnapshot): AndroidUiNode | undefined => uiNode(value, daijishoId("list_item_theme_pack_choice_title"), wanted);
  const selected = await findDaijishoControl(context, row, await openPlatformPaths(context, profile));
  let granted = await hasAndroidTreeReadGrant(context, DAIJISHO_PACKAGE, directory, true);
  let connected = !!selected;
  if (!connected && configure) {
    context.onMutation?.();
    await tapDaijisho(context, (value) => uiNode(value, "android:id/button3"),
      (value) => /documentsui.*\/com.android.documentsui.picker.PickActivity$/.test(value.component));
    await selectAndroidDocument(context, DAIJISHO_PACKAGE, directory, true);
    const returned = await waitEmulatorUi(context, (value) => pathsDialogOpen(context, value) ? value : undefined);
    connected = !!await findDaijishoControl(context, row, returned);
    granted = await hasAndroidTreeReadGrant(context, DAIJISHO_PACKAGE, directory, true);
  }
  // Daijishō does not renew permissions when re-adding an existing URI. Never delete it to work around that.
  await tapDaijisho(context, (value) => uiNode(value, "android:id/button2"),
    (value) => isDaijisho(value) && !pathsDialogOpen(context, value));
  return connected && granted;
}
