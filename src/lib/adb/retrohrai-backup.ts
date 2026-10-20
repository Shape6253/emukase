import { hasAndroidTreeReadGrant, selectAndroidDocument } from "./android-document-picker";
import type { AndroidUiSnapshot } from "./android-ui";
import { tapEmulatorNode, uiWithin } from "./emulator-ui";
import { queryMediaStoreFiles } from "./media-store";
import { uploadMediaStoreFile } from "./media-store-upload";
import { activateRetroHrai, isRetroHrai, openRetroHraiGeneral, retroHraiAction, retroHraiHas, retroHraiMatches,
  waitRetroHraiUi, type RetroHraiContext } from "./retrohrai-navigation";
import { readRetroHraiProfile, validateRetroHraiImport, type RetroHraiSavedProfile } from "./retrohrai-profile";
import { RETROHRAI_PACKAGE } from "./retrohrai-types";
import { shellCommand } from "./transport";

export interface RetroHraiExport {
  path: string;
  profile: RetroHraiSavedProfile;
}

export async function openRetroHraiBackups(context: RetroHraiContext): Promise<AndroidUiSnapshot> {
  const general = await openRetroHraiGeneral(context);
  return activateRetroHrai(context, "settings_backup_tab", (value) => !!retroHraiAction(context, value, "settings_backup_export"), general);
}

async function backupFiles(context: RetroHraiContext, directory: string): Promise<ReadonlySet<string>> {
  const output = context.sdk >= 29 ? undefined : await context.device.shell(shellCommand("sh", "-c",
    `if ${shellCommand("test", "-d", directory)}; then ${shellCommand("find", directory, "-maxdepth", "1", "-type", "f")}; fi`));
  const indexed = output === undefined ? await queryMediaStoreFiles(context.device, context.user, directory, context.signal) : undefined;
  const files = indexed ? indexed.map((file) => file.path).filter((path) => !path.slice(directory.length + 1).includes("/"))
    : output?.trim() ? output.trim().split(/\r?\n/) : [];
  if (output !== undefined && output.length > 2_097_152 || files.length > 4096) throw new Error("RetroHrai's backup listing is too large.");
  const prefix = `${directory}/`;
  if (files.some((file) => !file.startsWith(prefix) || file.slice(prefix.length).includes("/"))) {
    throw new Error("RetroHrai's backup listing could not be read.");
  }
  return new Set(files.filter((file) => /^retrobackup_\d{8}_\d{6}\.retrobackup$/.test(file.slice(prefix.length))));
}

/** The shell cannot traverse secondary-user storage on some Android builds.
 * Read app exports and staged imports through that user's provider instead. */
async function readProfileText(context: RetroHraiContext, path: string): Promise<string> {
  if (context.sdk < 29) return context.device.shell(shellCommand("cat", path));
  const directory = path.slice(0, path.lastIndexOf("/"));
  const records = (await queryMediaStoreFiles(context.device, context.user, directory, context.signal)).filter((file) => file.path === path);
  const record = records[0];
  if (records.length > 1) throw new Error("RetroHrai's profile file identity is ambiguous.");
  if (!record || !record.bytes) return "";
  const maxBytes = 16_777_216;
  if (record.bytes > maxBytes) throw new Error("RetroHrai's profile file is too large.");
  const read = shellCommand("content", "read", "--user", String(context.user), "--uri", `content://media/external/file/${record.id}`);
  const text = await context.device.shell(`${read} 2>/dev/null | ${shellCommand("head", "-c", String(maxBytes + 1))}`);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > maxBytes) throw new Error("RetroHrai's profile file is too large.");
  // Native exports may be visible while the writer and provider metadata are
  // still changing. Let the caller retry rather than accepting partial JSON.
  return bytes === record.bytes ? text : "";
}

/** Export through the app so private preferences/databases are never written over ADB. */
export async function exportRetroHraiProfile(context: RetroHraiContext, dataDirectory: string): Promise<RetroHraiExport> {
  if (!await hasAndroidTreeReadGrant(context, RETROHRAI_PACKAGE, dataDirectory, true)) {
    throw new Error("RetroHrai needs persisted write access to its artwork folder before exporting settings.");
  }
  const snapshot = await openRetroHraiBackups(context);
  const directory = `${dataDirectory}/Backups`;
  const before = await backupFiles(context, directory);
  // Native backup names have one-second precision. Wait for a free name rather
  // than replacing the previous recovery file on a fast repeated export.
  const slotDeadline = Date.now() + 3_000;
  while (before.size) {
    context.signal?.throwIfAborted();
    const clock = (await context.device.shell(shellCommand("date", "+%Y%m%d_%H%M%S"))).trim();
    if (!/^\d{8}_\d{6}$/.test(clock)) throw new Error("Android's backup timestamp could not be confirmed.");
    if (!before.has(`${directory}/retrobackup_${clock}.retrobackup`)) break;
    if (Date.now() >= slotDeadline) throw new Error("Android's backup timestamp did not advance.");
  }
  const button = retroHraiAction(context, snapshot, "settings_backup_export");
  if (!button) throw new Error("RetroHrai's configuration export is unavailable.");
  await tapEmulatorNode(context, snapshot, button);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    context.signal?.throwIfAborted();
    const added = [...await backupFiles(context, directory)].filter((path) => !before.has(path));
    if (added.length > 1) throw new Error("Multiple RetroHrai backups appeared during export; retry when no other export is running.");
    const path = added[0];
    if (path) {
      const text = await readProfileText(context, path);
      // The app can publish the file before its writer writes any bytes.
      if (!text) continue;
      try { return { path, profile: readRetroHraiProfile(text) }; }
      catch (error) {
        // The app publishes a JSON file before its writer closes. An incomplete
        // JSON document is retried; a complete unsupported schema fails clearly.
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
  }
  throw new Error("RetroHrai did not finish exporting a readable configuration backup.");
}

function checkedSetting(context: RetroHraiContext, snapshot: AndroidUiSnapshot, key: "settings_backup_restore_mode_overwrite" | "settings_backup_restore_create_before"): boolean {
  const labels = snapshot.nodes.filter((node) => retroHraiMatches(context, node, key));
  if (labels.length !== 1 || !labels[0]) throw new Error("RetroHrai's restore controls are ambiguous.");
  let row = labels[0].parent === null ? undefined : snapshot.nodes[labels[0].parent];
  while (row) {
    if (row.checked || row.selected) return true;
    const current = row;
    if (row.clickable || snapshot.nodes.some((node) => (node.className === "android.widget.RadioButton"
      || node.className === "android.widget.CheckBox") && uiWithin(snapshot, node, current))) return false;
    row = row.parent === null ? undefined : snapshot.nodes[row.parent];
  }
  throw new Error("RetroHrai's restore selection could not be confirmed.");
}

/** Import only generated emulator groups; native Overwrite is scoped to those groups. */
export async function importRetroHraiProfile(context: RetroHraiContext, directory: string, profile: string): Promise<string> {
  validateRetroHraiImport(profile);
  const name = `emukase-${crypto.randomUUID()}.retrobackup`;
  const path = `${directory}/${name}`;
  if (context.sdk < 29) await context.device.push(new TextEncoder().encode(profile), path, { signal: context.signal });
  else await uploadMediaStoreFile(context.device, context.user, directory, new File([profile], name, { type: "application/json" }), { signal: context.signal });
  if (await readProfileText(context, path) !== profile) throw new Error("RetroHrai's import file did not pass readback verification.");
  const backup = await openRetroHraiBackups(context);
  await activateRetroHrai(context, "settings_backup_import", (value) => !isRetroHrai(value), backup);
  await selectAndroidDocument(context, RETROHRAI_PACKAGE, path, false, undefined, { keyboardNavigation: false });
  let snapshot = await waitRetroHraiUi(context, (value) => retroHraiHas(context, value, "settings_backup_restore_dialog_title") ? value : undefined);
  if (!checkedSetting(context, snapshot, "settings_backup_restore_mode_overwrite")) {
    snapshot = await activateRetroHrai(context, "settings_backup_restore_mode_overwrite", (value) =>
      retroHraiHas(context, value, "settings_backup_restore_dialog_title") && checkedSetting(context, value, "settings_backup_restore_mode_overwrite"), snapshot);
  }
  if (!checkedSetting(context, snapshot, "settings_backup_restore_create_before")) {
    snapshot = await activateRetroHrai(context, "settings_backup_restore_create_before", (value) =>
      retroHraiHas(context, value, "settings_backup_restore_dialog_title") && checkedSetting(context, value, "settings_backup_restore_create_before"), snapshot);
  }
  snapshot = await activateRetroHrai(context, "settings_backup_restore_confirm", (value) =>
    retroHraiHas(context, value, "settings_backup_restore_summary_title") || !retroHraiHas(context, value, "settings_backup_restore_dialog_title")
      && !!retroHraiAction(context, value, "settings_backup_export"), snapshot);
  if (retroHraiHas(context, snapshot, "settings_backup_restore_summary_title")) {
    await activateRetroHrai(context, "settings_backup_restore_summary_dismiss", (value) => !!retroHraiAction(context, value, "settings_backup_export"), snapshot);
  }
  return path;
}
