import { hasAndroidTreeReadGrant, selectAndroidDocument } from "./android-document-picker";
import { primaryStorageForUser } from "./android-user";
import { AndroidUiStateChangedError, pressAndroidUiKey, type AndroidUiNode, type AndroidUiSnapshot } from "./android-ui";
import { DAIJISHO_PACKAGE, daijishoId, daijishoLabel, findDaijishoControl, isDaijisho, openDaijishoInspector, openDaijishoLibrarySettings,
  openDaijishoTab, tapDaijisho, type DaijishoUiContext } from "./daijisho-navigation";
import type { DaijishoProfile } from "./daijisho-profiles";
import { uiDescendant, uiNode, uiWithin, waitEmulatorUi } from "./emulator-ui";

interface ProfileInspection { exists: boolean; accepted: boolean; reason?: string }

async function fieldsMatch(context: DaijishoUiContext, fields: Readonly<Record<string, string | boolean>>): Promise<boolean> {
  let matches = true;
  for (const [name, expected] of Object.entries(fields)) {
    const snapshot = await findDaijishoControl(context, (value) => uiNode(value, daijishoId(name)));
    if (!snapshot) throw new Error(`Daijishō does not expose its ${name} setting.`);
    const node = uiNode(snapshot, daijishoId(name));
    matches = matches && !!node && (typeof expected === "boolean" ? node.checked === expected : node.text === expected);
  }
  return matches;
}

async function closeEditor(context: DaijishoUiContext, field: string): Promise<void> {
  await tapDaijisho(context, (value) => uiNode(value, "android:id/button2"),
    (value) => isDaijisho(value) && !uiNode(value, daijishoId(field)));
}

function playerChoiceName(value: string): string | undefined {
  return /^(?:0|[1-9]\d*) - ([\s\S]+)$/.exec(value)?.[1];
}

function playerChoices(snapshot: AndroidUiSnapshot): readonly AndroidUiNode[] {
  const lists = snapshot.nodes.filter((node) => node.packageName === DAIJISHO_PACKAGE && node.className === "android.widget.ListView");
  if (lists.length > 1) throw new Error("Daijishō's default-player choices are ambiguous.");
  const list = lists[0];
  return list ? snapshot.nodes.filter((node) => node.packageName === DAIJISHO_PACKAGE
    && uiWithin(snapshot, node, list) && playerChoiceName(node.text) !== undefined) : [];
}

/** Open the associated player's native editor, never a same-named global player. */
async function inspectDefaultPlayer(context: DaijishoUiContext, profile: DaijishoProfile): Promise<boolean> {
  const field = (value: AndroidUiSnapshot): AndroidUiNode | undefined => uiNode(value, daijishoId("platform_default_player_select"));
  const editor = await findDaijishoControl(context, field);
  if (!editor) throw new Error("Daijishō does not expose its default player.");
  const selected = field(editor)?.text;
  if (!selected || playerChoiceName(selected) !== profile.playerName) return false;
  const opened = await tapDaijisho(context, field, (value) => playerChoices(value).length > 0, editor);
  // Indices distinguish entries even when same-named choices are on different pages.
  let duplicate = false;
  await findDaijishoControl(context, (value) => {
    const other = playerChoices(value).find((node) => playerChoiceName(node.text) === profile.playerName && node.text !== selected);
    duplicate ||= other !== undefined;
    return other;
  }, opened);
  for (let attempt = 0; attempt < 4; attempt++) {
    const popup = await waitEmulatorUi(context, (value) => isDaijisho(value) && playerChoices(value).length ? value : undefined);
    try { await pressAndroidUiKey(context.device, context.user, popup, "KEYCODE_BACK", context.signal); break; }
    catch (error) { if (!(error instanceof AndroidUiStateChangedError) || attempt === 3) throw error; }
  }
  const returned = await waitEmulatorUi(context, (value) => isDaijisho(value) && field(value) ? value : undefined);
  if (duplicate || field(returned)?.text !== selected) return false;

  const playerChip = (value: AndroidUiSnapshot): AndroidUiNode | undefined => {
    const chips = value.nodes.filter((node) => node.packageName === DAIJISHO_PACKAGE && node.text === profile.playerName
      && node.enabled && node.clickable && uiDescendant(value, node, daijishoId("platform_players_chip_group")));
    if (chips.length > 1) throw new Error("Daijishō's associated player is ambiguous.");
    return chips[0];
  };
  const linked = await findDaijishoControl(context, playerChip, returned);
  if (!linked) throw new Error("Daijishō does not expose the associated default player.");
  await tapDaijisho(context, playerChip, (value) => !!uiNode(value, daijishoId("player_am_start_arguments_edit_text")), linked);
  const matches = await fieldsMatch(context, { player_am_start_arguments_edit_text: profile.arguments,
    player_accepted_filename_regex_edit_text: profile.regex, player_kill_package_processes_switch: false });
  await closeEditor(context, "player_am_start_arguments_edit_text");
  return matches;
}

/** Inspect native settings without saving edits or replacing an existing platform/player. */
export async function inspectDaijishoProfile(context: DaijishoUiContext, profile: DaijishoProfile): Promise<ProfileInspection> {
  const platformRow = (value: AndroidUiSnapshot): AndroidUiNode | undefined => uiNode(value, daijishoId("list_item_platform_first_line"), profile.name);
  const platforms = await findDaijishoControl(context, platformRow, await openDaijishoInspector(context, "platforms"));
  if (!platforms) return { exists: false, accepted: false, reason: "Platform has not been imported." };
  await tapDaijisho(context, platformRow, (value) => !!uiNode(value, daijishoId("platform_name_edit_text")), platforms);
  const platformMatches = await fieldsMatch(context, {
    platform_name_edit_text: profile.name, platform_shortname_edit_text: profile.shortname,
    platform_accepted_filename_regex_edit_text: profile.platformRegex,
  });
  const playerMatches = platformMatches && await inspectDefaultPlayer(context, profile);
  await closeEditor(context, "platform_name_edit_text");
  return { exists: true, accepted: platformMatches && playerMatches,
    ...(!platformMatches ? { reason: "Existing platform settings differ; no settings were overwritten." }
      : !playerMatches ? { reason: "The default player is ambiguous or its settings differ; no settings were overwritten." } : {}) };
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

function platformIdentity(snapshot: AndroidUiSnapshot): string {
  return JSON.stringify([snapshot.component, snapshot.rotation, visiblePlatform(snapshot),
    snapshot.nodes.filter((node) => node.focused)
      .map((node) => [node.resourceId, node.className, node.text, node.description, node.bounds])]);
}

async function waitStablePlatform(context: DaijishoUiContext): Promise<AndroidUiSnapshot> {
  let previous = "", repeated = 0;
  return waitEmulatorUi(context, (value) => {
    if (!isDaijisho(value) || !visiblePlatform(value)) return undefined;
    // Decorations do not determine selection. Actions still validate the full snapshot.
    const identity = platformIdentity(value);
    repeated = identity === previous ? repeated + 1 : 0;
    previous = identity;
    return repeated >= 2 ? value : undefined;
  });
}

async function openPlatformPaths(context: DaijishoUiContext, profile: DaijishoProfile): Promise<AndroidUiSnapshot> {
  const wanted = normalize(profile.name);
  const listId = daijishoId("library_collection_thumbnails_view_recycler_view");
  const focused = (value: AndroidUiSnapshot): boolean => value.nodes.some((node) => node.focused && uiDescendant(value, node, listId));
  const visited = new Set<string>();
  let snapshot = await openDaijishoTab(context, "platforms");
  let direction: "left" | "right" = "left";
  for (let step = 0; step < 100; step++) {
    if (!visiblePlatform(snapshot)) snapshot = await waitStablePlatform(context);
    const current = visiblePlatform(snapshot);
    if (current === wanted && pathsButton(snapshot)) {
      return tapDaijisho(context, (value) => visiblePlatform(value) === wanted ? pathsButton(value) : undefined,
        (value) => pathsDialogOpen(context, value), snapshot);
    }
    const thumbnails = !!uiNode(snapshot, listId);
    const onList = focused(snapshot);
    const before = thumbnails ? platformIdentity(snapshot) : current;
    if (visited.has(before)) {
      if (thumbnails && !onList) throw new Error("Daijishō's thumbnail list could not receive keyboard focus.");
      if (!thumbnails || direction === "right") throw new Error(`Daijishō's visible platforms do not include ${profile.name}.`);
      direction = "right";
      visited.clear();
    }
    visited.add(before);
    try {
      if (thumbnails) {
        // Focus selects a thumbnail; clicking the selected one would open its game library.
        await pressAndroidUiKey(context.device, context.user, snapshot,
          !onList ? "KEYCODE_TAB" : direction === "left" ? "KEYCODE_DPAD_LEFT" : "KEYCODE_DPAD_RIGHT", context.signal);
        snapshot = await waitStablePlatform(context);
        if (onList && !focused(snapshot)) throw new Error("Daijishō's keyboard focus left its thumbnail list.");
      } else {
        const next = (value: AndroidUiSnapshot): AndroidUiNode | undefined => uiNode(value, daijishoId("library_collection_wallpaper_view_next_view"));
        if (!next(snapshot)) throw new Error("Daijishō's current platform layout does not expose native carousel navigation.");
        snapshot = await tapDaijisho(context, next,
          (value) => isDaijisho(value) && !!visiblePlatform(value) && visiblePlatform(value) !== current, snapshot);
      }
    } catch (error) {
      if (!(error instanceof AndroidUiStateChangedError)) throw error;
      visited.delete(before);
      snapshot = await waitStablePlatform(context);
    }
  }
  throw new Error("Daijishō's platform search exceeded its limit; absence was not assumed.");
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
