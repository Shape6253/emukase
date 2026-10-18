import { hasAndroidTreeReadGrant, selectAndroidDocument } from "./android-document-picker";
import { AndroidUiStateChangedError, type AndroidUiSnapshot } from "./android-ui";
import { scrollEmulatorList, uiWithin } from "./emulator-ui";
import { activateRetroHrai, activateRetroHraiControl, isRetroHrai, openRetroHraiGeneral, retroHraiAction, retroHraiCount, retroHraiHas,
  retroHraiMatches, retroHraiString, waitRetroHraiUi, type RetroHraiContext, type RetroHraiLabel } from "./retrohrai-navigation";
import { RETROHRAI_PACKAGE } from "./retrohrai-types";

export function retroHraiTreeUri(user: number, path: string): string {
  const prefix = `/storage/emulated/${user}/`;
  if (!path.startsWith(prefix) || !path.slice(prefix.length) || /[\x00-\x1f\x7f]/.test(path)
    || path.slice(prefix.length).split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Invalid RetroHrai storage folder.");
  return `content://com.android.externalstorage.documents/tree/${encodeURIComponent(`primary:${path.slice(prefix.length)}`)}`;
}

export function retroHraiTreePath(user: number, uri: string): string {
  const match = /^content:\/\/com\.android\.externalstorage\.documents\/tree\/([^/]+)$/.exec(uri);
  const id = match?.[1] ? decodeURIComponent(match[1]) : undefined;
  if (!id?.startsWith("primary:")) throw new Error("Automatic RetroHrai configuration requires an artwork folder in this profile's internal storage.");
  const path = `/storage/emulated/${user}/${id.slice("primary:".length)}`;
  retroHraiTreeUri(user, path);
  return path;
}

export async function openRetroHraiStorage(context: RetroHraiContext): Promise<AndroidUiSnapshot> {
  const snapshot = await openRetroHraiGeneral(context);
  if (retroHraiHas(context, snapshot, "settings_general_subtitle")) return snapshot;
  const backupLabel = snapshot.nodes.find((node) => retroHraiMatches(context, node, "settings_backup_tab"));
  const tab = backupLabel?.parent === null || backupLabel?.parent === undefined ? undefined : snapshot.nodes[backupLabel.parent];
  const strip = tab?.parent === null || tab?.parent === undefined ? undefined : snapshot.nodes[tab.parent];
  if (!strip) throw new Error("RetroHrai's General settings tabs could not be identified.");
  return activateRetroHraiControl(context, (value) => {
    const label = value.nodes.find((node) => retroHraiMatches(context, node, "settings_backup_tab"));
    const button = label?.parent === null || label?.parent === undefined ? undefined : value.nodes[label.parent];
    const parent = button?.parent === null || button?.parent === undefined ? undefined : value.nodes[button.parent];
    return parent ? retroHraiAction(context, value, "settings_general_tab", [], parent) : undefined;
  }, (value) => retroHraiHas(context, value, "settings_general_subtitle"), snapshot);
}

async function findStorageAction(context: RetroHraiContext, key: RetroHraiLabel): Promise<AndroidUiSnapshot> {
  let snapshot = await openRetroHraiStorage(context);
  for (let attempt = 0; attempt < 16; attempt++) {
    if (retroHraiAction(context, snapshot, key)) return snapshot;
    const lists = snapshot.nodes.filter((list) => list.scrollable && !snapshot.nodes.some((node) =>
      retroHraiMatches(context, node, "settings_section_platforms") && uiWithin(snapshot, node, list)));
    if (lists.length !== 1 || !lists[0]) throw new Error("RetroHrai's storage settings list is ambiguous.");
    try { await scrollEmulatorList(context, snapshot, lists[0]); }
    catch (error) { if (!(error instanceof AndroidUiStateChangedError)) throw error; }
    snapshot = await waitRetroHraiUi(context, (value) => retroHraiHas(context, value, "settings_general_subtitle") ? value : undefined);
  }
  throw new Error("RetroHrai's ROM folder control was not found.");
}

export async function ensureRetroHraiArtwork(context: RetroHraiContext, fallback: string, configure: boolean): Promise<string> {
  let snapshot = await openRetroHraiStorage(context);
  const uris = snapshot.nodes.map((node) => retroHraiString(context, node, "scraping_assets_current")).filter((uri) => uri !== undefined);
  if (uris.length > 1) throw new Error("RetroHrai's artwork folder is ambiguous.");
  const current = uris[0];
  const directory = current ? retroHraiTreePath(context.user, current) : fallback;
  if (current && await hasAndroidTreeReadGrant(context, RETROHRAI_PACKAGE, directory, true)) return directory;
  if (!configure) throw new Error("RetroHrai's saved artwork folder or its persisted write access is missing.");
  const action = current ? "scraping_change_folder" : "scraping_select_folder";
  snapshot = await activateRetroHrai(context, action, (value) => !isRetroHrai(value), snapshot);
  await selectAndroidDocument(context, RETROHRAI_PACKAGE, directory, true, undefined, { keyboardNavigation: false });
  await waitRetroHraiUi(context, (value) => value.nodes.some((node) =>
    retroHraiMatches(context, node, "scraping_assets_current", [retroHraiTreeUri(context.user, directory)])) ? true : undefined);
  if (!await hasAndroidTreeReadGrant(context, RETROHRAI_PACKAGE, directory, true)) throw new Error("RetroHrai did not retain write access to its artwork folder.");
  return directory;
}

/** The native scanner connects platform folders; select every detected system in one action. */
export async function selectAllRetroHraiSystems(context: RetroHraiContext, initial: AndroidUiSnapshot): Promise<AndroidUiSnapshot> {
  let snapshot = initial;
  if (retroHraiAction(context, snapshot, "setup_platform_select_all")) {
    snapshot = await activateRetroHrai(context, "setup_platform_select_all", (value) => !!retroHraiAction(context, value, "setup_platform_deselect_all"), snapshot);
  }
  const count = snapshot.nodes.map((node) => retroHraiCount(context, node, "setup_platform_add_selected")).find((value) => value !== undefined);
  if (!count) throw new Error("RetroHrai did not detect any compatible systems to add.");
  return activateRetroHrai(context, "setup_platform_add_selected", (value) => isRetroHrai(value)
    && !retroHraiHas(context, value, "setup_platform_title") && !retroHraiHas(context, value, "onboarding_platform_existing_title"), snapshot, [String(count)]);
}

export async function connectRetroHraiRoot(context: RetroHraiContext, directory: string): Promise<void> {
  const snapshot = await findStorageAction(context, "settings_rom_folders_add");
  await activateRetroHrai(context, "settings_rom_folders_add", (value) => !isRetroHrai(value), snapshot);
  await selectAndroidDocument(context, RETROHRAI_PACKAGE, directory, true, undefined, { keyboardNavigation: false });
  const next = await waitRetroHraiUi(context, (value) => isRetroHrai(value) && (retroHraiHas(context, value, "setup_platform_title")
    || retroHraiHas(context, value, "onboarding_platform_existing_title") || retroHraiHas(context, value, "settings_general_subtitle")
      && !retroHraiHas(context, value, "settings_rom_root_scanning")) ? value : undefined, 180_000);
  if (retroHraiHas(context, next, "setup_platform_title") || retroHraiHas(context, next, "onboarding_platform_existing_title")) {
    await selectAllRetroHraiSystems(context, next);
  }
}

export async function detectRetroHraiSystems(context: RetroHraiContext): Promise<void> {
  const snapshot = await openRetroHraiGeneral(context);
  const platforms = await activateRetroHrai(context, "settings_section_platforms", (value) => !!retroHraiAction(context, value, "settings_platforms_auto_setup"), snapshot);
  const selection = await activateRetroHrai(context, "settings_platforms_auto_setup", (value) => retroHraiHas(context, value, "setup_platform_title")
    || retroHraiHas(context, value, "onboarding_platform_existing_title"), platforms);
  await selectAllRetroHraiSystems(context, selection);
}
