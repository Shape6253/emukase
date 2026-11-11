import type { DeviceTransport } from "./transport";
import { shellCommand } from "./transport";
import { readAndroidUser, assertAndroidUser, primaryStorageForUser, userScopedDevice } from "./android-user";
import { ESDE_ANDROID_SYSTEM_DIRECTORIES } from "./esde-systems";
import { workspacePaths } from "./workspace";
import type { LibraryFolderOptions, WorkspacePaths } from "./workspace";
import { hasContentCommand, queryMediaStoreFolders, readMediaStoreFolders, createMediaStoreFolders } from "./media-store";
import { MEDIA_STORE_PROVIDER_MIN_SDK } from "./media-store-provider-entries";
import { readAndroidSdk } from "./android-version";
import { createDirectFolders, verifyDirectFolders } from "./directories";
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
  directStorage: boolean;
}

function plannedLibraryDirectories(workspace: WorkspacePaths): string[] {
  return [...new Set([
    workspace.root, workspace.roms, workspace.bios, workspace.esde,
    workspace.media, workspace.saves, workspace.states, workspace.setup,
    ...ESDE_ANDROID_SYSTEM_DIRECTORIES.map((system) => `${workspace.roms}/${system}`),
  ])];
}

async function libraryContext(device: DeviceTransport, signal: AbortSignal | undefined, options: LibraryFolderOptions): Promise<LibraryContext> {
  const user = await readAndroidUser(device, signal);
  const scoped = userScopedDevice(device, user, signal);
  const version = await readAndroidSdk(scoped, signal);
  if (version < 23) {
    throw new Error("Android version was not confirmed or is older than Android 6.");
  }
  if (version >= 29) {
    const state = (await scoped.shell(shellCommand("am", "get-started-user-state", String(user)))).trim();
    if (state !== "RUNNING_UNLOCKED") throw new Error("Unlock the current Android user before accessing the library folders.");
  }
  const directStorage = version < 29 || (version < MEDIA_STORE_PROVIDER_MIN_SDK && !(await hasContentCommand(scoped, user, signal)));
  if (directStorage) {
    await verifyDirectFolders(scoped, [primaryStorageForUser(user)], signal);
  }
  checkAbort(signal);
  return { device: scoped, directStorage, user, workspace: workspacePaths(primaryStorageForUser(user), options) };
}

/** Inspect storage and the existing workspace without creating files or records. */
export async function inspectWorkspace(device: DeviceTransport, signal?: AbortSignal, options: LibraryFolderOptions = {}): Promise<WorkspaceInspection> {
  const context = await libraryContext(device, signal, options);
  if (!context.directStorage) {
    const roots = [...new Set([context.workspace.root, context.workspace.roms, context.workspace.bios])];
    const records = await queryMediaStoreFolders(context.device, context.user, roots, signal);
    await readMediaStoreFolders(context.device, context.user, records, signal);
  }
  await assertAndroidUser(context.device, context.user, signal);
  return { user: context.user, workspace: context.workspace };
}

async function verifiedFolders(context: LibraryContext, signal?: AbortSignal): Promise<LibraryVerification> {
  const { device, user, workspace, directStorage } = context;
  const plan = plannedLibraryDirectories(workspace);
  if (directStorage) {
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
  const { device: scoped, directStorage, ...inspected } = context;
  const plan = plannedLibraryDirectories(inspected.workspace);
  if (directStorage) {
    log?.(`Android user ${inspected.user}. Creating shared folder paths directly.`);
    await createDirectFolders(scoped, plan, signal, (completed) => {
      log?.(`Created ${completed}/${plan.length} folder paths.`);
    });
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
