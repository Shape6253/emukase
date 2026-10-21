import { selectAndroidDocument, hasAndroidTreeReadGrant } from "./android-document-picker";
import { primaryStorageForUser } from "./android-user";
import { downloadText } from "./download";
import { queryMediaStoreFile } from "./media-store";
import { uploadMediaStoreFile } from "./media-store-upload";
import { activateCocoon, cocoonAction, cocoonHas, isCocoon, waitCocoonUi, COCOON_PACKAGE, type CocoonUiContext } from "./cocoon-navigation";
import { cocoonProfilePlayer, cocoonRetroArchTemplate } from "./cocoon-player-profile";
import type { CocoonPlatformPlan } from "./cocoon-platforms";
import { findCocoonListItem, findCocoonSetting, openCocoonTab } from "./cocoon-settings";
import { shellCommand } from "./transport";
import { normalizeStorageFolder } from "./workspace";

/** Read shared app exports through the selected profile's provider, not /sdcard. */
async function readDefinition(context: CocoonUiContext, path: string, pending = false): Promise<string | undefined> {
  const storage = primaryStorageForUser(context.user);
  const relative = path.slice(storage.length + 1, path.lastIndexOf("/"));
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!path.startsWith(`${storage}/`) || normalizeStorageFolder(relative) !== relative || !/^[A-Za-z0-9_-]+\.json$/.test(name)) {
    throw new Error("Cocoon's player file must be in the selected profile's storage.");
  }
  const maxBytes = 1_048_576;
  if (context.sdk < 29) {
    const output = await context.device.shell(shellCommand("sh", "-c",
      `if ${shellCommand("test", "-f", path)}; then ${shellCommand("head", "-c", String(maxBytes + 1), path)}; fi`));
    if (!output) return undefined;
    if (new TextEncoder().encode(output).length > maxBytes) throw new Error("Cocoon's player file is too large.");
    return output;
  }
  const file = await queryMediaStoreFile(context.device, context.user, path, context.signal);
  if (!file) return undefined;
  if (!file.bytes && pending) return undefined;
  if (!file.bytes || file.bytes > maxBytes) throw new Error("Cocoon's player file has an unsupported size.");
  const command = shellCommand("content", "read", "--user", String(context.user), "--uri", `content://media/external/file/${file.id}`);
  const text = await context.device.shell(`${command} 2>/dev/null | ${shellCommand("head", "-c", String(maxBytes + 1))}`);
  if (new TextEncoder().encode(text).length !== file.bytes) {
    if (pending) return undefined;
    throw new Error("Cocoon's player file could not be read completely.");
  }
  return text;
}

async function importPlayer(context: CocoonUiContext, plan: CocoonPlatformPlan, directory: string): Promise<void> {
  const profile = plan.profilePlayer;
  if (!profile) throw new Error("Cocoon's profile-local player is unavailable.");
  if (!await hasAndroidTreeReadGrant(context, COCOON_PACKAGE, directory, true)) {
    throw new Error(`Cocoon needs write access to ${directory} to import and verify its profile-local players.`);
  }
  const name = `emukase-player-${crypto.randomUUID()}.json`;
  const path = `${directory}/${name}`;
  if (context.sdk < 29) await context.device.push(new TextEncoder().encode(profile.document), path, { signal: context.signal });
  else await uploadMediaStoreFile(context.device, context.user, directory, new File([profile.document], name, { type: "application/json" }),
    { signal: context.signal, mimeType: "application/json" });
  if (await readDefinition(context, path) !== profile.document) throw new Error("Cocoon's player import failed staging readback.");
  // Open Add Platform, never Refetch Platforms: refreshing would also replace
  // definitions for unrelated systems.
  const library = await openCocoonTab(context, "settings_tab_library");
  const row = await findCocoonSetting(context, "settings_library_cd_add_platform", library);
  const chooser = await activateCocoon(context, "settings_library_cd_add_platform", (value) => cocoonHas(context, value, "settings_dialog_title_add_platforms"), row);
  const control = await findCocoonListItem(context, (value) => !!cocoonAction(context, value, "settings_dialog_title_import_platform"), "down", chooser);
  if (!control) throw new Error("Cocoon's native custom-platform import is unavailable.");
  context.onMutation?.();
  await activateCocoon(context, "settings_dialog_title_import_platform", (value) => !isCocoon(value), control);
  await selectAndroidDocument(context, COCOON_PACKAGE, path, false, undefined, { keyboardNavigation: false });
  await waitCocoonUi(context, async (value) => {
    if (!isCocoon(value)) return undefined;
    return await readDefinition(context, profile.savedPath, true) === profile.document ? value : undefined;
  });
  profile.retained = true;
}

/** Native imports preserve existing players by ID and affect only this platform.
 * A unique content-addressed name is then selected and checked after restart. */
export async function prepareCocoonProfilePlayers(
  context: CocoonUiContext, plans: readonly CocoonPlatformPlan[], packages: ReadonlySet<string>, directory: string, configure: boolean,
  onStatus?: (message: string) => void,
): Promise<readonly CocoonPlatformPlan[]> {
  if (context.user === 0) return plans;
  const result: CocoonPlatformPlan[] = [];
  for (const plan of plans) {
    if (!plan.coreId || !packages.has(plan.emulatorPackage)) { result.push(plan); continue; }
    context.signal?.throwIfAborted();
    onStatus?.(`${configure ? "Preparing" : "Checking"} Cocoon's Android ${context.user} player: ${plan.name}…`);
    const [key, asset] = cocoonRetroArchTemplate(plan);
    const savedPath = `${directory}/platforms/${key}.json`;
    const saved = await readDefinition(context, savedPath);
    if (!saved && !configure) throw new Error(`Cocoon has no saved Android ${context.user} player definition for ${plan.name}. Run its configuration first.`);
    const source = saved ?? await downloadText({ requestUrl: (url) => url },
      `https://raw.githubusercontent.com/inssekt/CocoonFE/main/platforms/${asset}.json`, { signal: context.signal, maxBytes: 1_048_576 });
    const scoped = cocoonProfilePlayer(source, plan, context.user, savedPath);
    if (configure && !scoped.profilePlayer?.retained) await importPlayer(context, scoped, directory);
    result.push(scoped);
  }
  return result;
}

export async function cocoonProfilePlayerRetained(context: CocoonUiContext, plan: CocoonPlatformPlan): Promise<boolean> {
  const profile = plan.profilePlayer;
  if (!profile) return true;
  const text = await readDefinition(context, profile.savedPath);
  return profile.retained && text !== undefined && JSON.stringify(JSON.parse(text) as unknown) === profile.document;
}
