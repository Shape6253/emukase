import type { DeviceTransport } from "./transport";
import { shellCommand } from "./transport";
import { readAndroidUser, assertAndroidUser, primaryStorageForUser, userScopedDevice } from "./android-user";
import { ESDE_ANDROID_SYSTEM_DIRECTORIES } from "./esde-systems";
import { workspacePaths } from "./workspace";
import type { LibraryFolderOptions, WorkspacePaths } from "./workspace";
import { queryMediaStoreFolders, readMediaStoreFolders, createMediaStoreFolders } from "./media-store";
import { checkAbort } from "./setup-events";

export interface WorkspaceInspection {
  user: number;
  workspace: WorkspacePaths;
}

export interface LibraryVerification extends WorkspaceInspection {
  systemCount: number;
}

interface LibraryContext extends WorkspaceInspection {
  device: DeviceTransport;
  legacyStorage: boolean;
}

const DIRECT_FOLDER_BATCH_SIZE = 32;

function plannedLibraryDirectories(workspace: WorkspacePaths): string[] {
  return [...new Set([
    workspace.root, workspace.roms, workspace.bios, workspace.esde,
    workspace.media, workspace.saves, workspace.states, workspace.setup,
    ...ESDE_ANDROID_SYSTEM_DIRECTORIES.map((system) => `${workspace.roms}/${system}`),
  ])];
}

async function verifyDirectFolders(device: DeviceTransport, paths: readonly string[], signal?: AbortSignal): Promise<void> {
  for (let offset = 0; offset < paths.length; offset += DIRECT_FOLDER_BATCH_SIZE) {
    checkAbort(signal);
    const batch = paths.slice(offset, offset + DIRECT_FOLDER_BATCH_SIZE);
    const marker = `__emukase_direct_folders_${crypto.randomUUID()}__`;
    const script = [
      `for path in ${shellCommand(...batch)}; do`,
      "if [ ! -d \"$path\" ] || [ ! -r \"$path\" ] || [ ! -w \"$path\" ] || [ ! -x \"$path\" ]; then",
      "  printf 'Folder is missing or inaccessible: %s\\n' \"$path\" >&2; exit 1",
      "fi",
      "done",
      `printf '%s\\n' ${shellCommand(marker)}`,
    ].join("\n");
    const output = await device.shell(shellCommand("sh", "-c", script));
    checkAbort(signal);
    if (output.trim() !== marker) throw new Error("Android did not confirm direct folder access.");
  }
}

async function libraryContext(device: DeviceTransport, signal: AbortSignal | undefined, options: LibraryFolderOptions): Promise<LibraryContext> {
  const user = await readAndroidUser(device, signal);
  const scoped = userScopedDevice(device, user, signal);
  const sdk = (await scoped.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
  if (!/^[1-9]\d*$/.test(sdk) || !Number.isSafeInteger(Number(sdk)) || Number(sdk) < 23) {
    throw new Error("Android version was not confirmed or is older than Android 6.");
  }
  // MediaStore's relative_path insertion requires API 29. Older releases use
  // shell storage access, which also confirms availability without newer am commands.
  const legacyStorage = Number(sdk) < 29;
  if (legacyStorage) {
    await verifyDirectFolders(scoped, [primaryStorageForUser(user)], signal);
  } else {
    const state = (await scoped.shell(shellCommand("am", "get-started-user-state", String(user)))).trim();
    if (state !== "RUNNING_UNLOCKED") throw new Error("Unlock the current Android user before accessing the library folders.");
  }
  checkAbort(signal);
  return { device: scoped, legacyStorage, user, workspace: workspacePaths(primaryStorageForUser(user), options) };
}

/** Inspect storage and the existing workspace without creating files or records. */
export async function inspectWorkspace(device: DeviceTransport, signal?: AbortSignal, options: LibraryFolderOptions = {}): Promise<WorkspaceInspection> {
  const context = await libraryContext(device, signal, options);
  if (!context.legacyStorage) {
    const roots = [...new Set([context.workspace.root, context.workspace.roms, context.workspace.bios])];
    const records = await queryMediaStoreFolders(context.device, context.user, roots, signal);
    await readMediaStoreFolders(context.device, context.user, records, signal);
  }
  await assertAndroidUser(context.device, context.user, signal);
  return { user: context.user, workspace: context.workspace };
}

async function verifiedFolders(context: LibraryContext, signal?: AbortSignal): Promise<LibraryVerification> {
  const { device, user, workspace, legacyStorage } = context;
  const plan = plannedLibraryDirectories(workspace);
  if (legacyStorage) {
    await verifyDirectFolders(device, plan, signal);
  } else {
    const records = await queryMediaStoreFolders(device, user, plan, signal);
    const confirmed = await readMediaStoreFolders(device, user, records, signal);
    const missing = plan.find((path) => !confirmed.has(path));
    if (missing) throw new Error(`Folder is missing or not indexed by MediaStore: ${missing}. Run Create folders to repair it.`);
  }
  await assertAndroidUser(device, user, signal);
  return { user, workspace, systemCount: ESDE_ANDROID_SYSTEM_DIRECTORIES.length };
}

/** Check both the complete directory plan and the physical directories, read-only. */
export async function verifySharedLibraryFolders(device: DeviceTransport, signal?: AbortSignal, options: LibraryFolderOptions = {}): Promise<LibraryVerification> {
  return verifiedFolders(await libraryContext(device, signal, options), signal);
}

/** Create folders using the version's storage API; existing library files are preserved. */
export async function ensureSharedLibraryFolders(device: DeviceTransport, signal?: AbortSignal,
  log?: (message: string) => void, options: LibraryFolderOptions = {}): Promise<LibraryVerification> {
  const context = await libraryContext(device, signal, options);
  const { device: scoped, legacyStorage, ...inspected } = context;
  const plan = plannedLibraryDirectories(inspected.workspace);
  if (legacyStorage) {
    log?.(`Android user ${inspected.user}. Creating shared folder paths directly.`);
    for (let offset = 0; offset < plan.length; offset += DIRECT_FOLDER_BATCH_SIZE) {
      checkAbort(signal);
      await scoped.shell(shellCommand("mkdir", "-p", ...plan.slice(offset, offset + DIRECT_FOLDER_BATCH_SIZE)));
    }
    return verifiedFolders(context, signal);
  }
  const records = await queryMediaStoreFolders(scoped, inspected.user, plan, signal);
  const confirmed = await readMediaStoreFolders(scoped, inspected.user, records, signal);
  const missing = plan.filter((path) => !confirmed.has(path));
  // Inserting in a leaf creates its ancestors too. Still repair an unindexed
  // parent when all of its children already have valid records.
  const leaves = missing.filter((path) => !missing.some((other) => other.startsWith(`${path}/`)));
  log?.(`Android user ${inspected.user}. Creating ${leaves.length} missing folder paths through MediaStore.`);
  if (!leaves.length) {
    await assertAndroidUser(scoped, inspected.user, signal);
    return { ...inspected, systemCount: ESDE_ANDROID_SYSTEM_DIRECTORIES.length };
  }
  await createMediaStoreFolders(scoped, inspected.user, leaves, signal, (completed) => {
    log?.(`Created ${completed}/${leaves.length} folder paths. Temporary records removed.`);
  });
  log?.("Verifying the complete shared folder structure…");
  return verifiedFolders(context, signal);
}
