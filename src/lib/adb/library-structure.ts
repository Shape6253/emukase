import type { DeviceTransport } from "./transport";
import { shellCommand } from "./transport";
import { readAndroidUser, assertAndroidUser, primaryStorageForUser, userScopedDevice } from "./android-user";
import { ESDE_ANDROID_SYSTEM_DIRECTORIES } from "./esde-systems";
import { workspacePaths } from "./workspace";
import type { WorkspacePaths } from "./workspace";
import { queryMediaStoreFolders, readMediaStoreFolders, createMediaStoreFolder } from "./media-store";
import { checkAbort } from "./setup-events";

export interface WorkspaceInspection {
  user: number;
  workspace: WorkspacePaths;
}

export interface LibraryVerification extends WorkspaceInspection {
  systemCount: number;
}

function plannedLibraryDirectories(workspace: WorkspacePaths): string[] {
  return [
    workspace.root, workspace.roms, workspace.bios, workspace.esde,
    workspace.media, workspace.saves, workspace.states, workspace.setup,
    ...ESDE_ANDROID_SYSTEM_DIRECTORIES.map((system) => `${workspace.roms}/${system}`),
  ];
}

async function libraryContext(device: DeviceTransport, signal?: AbortSignal): Promise<WorkspaceInspection & { device: DeviceTransport }> {
  const user = await readAndroidUser(device, signal);
  const scoped = userScopedDevice(device, user, signal);
  const sdk = (await scoped.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
  if (!/^[1-9]\d*$/.test(sdk) || !Number.isSafeInteger(Number(sdk)) || Number(sdk) < 29) {
    throw new Error("Shared folder creation through MediaStore requires Android 10 or newer.");
  }
  const state = (await scoped.shell(shellCommand("am", "get-started-user-state", String(user)))).trim();
  if (state !== "RUNNING_UNLOCKED") throw new Error("Unlock the current Android user before accessing the library folders.");
  checkAbort(signal);
  return { device: scoped, user, workspace: workspacePaths(primaryStorageForUser(user)) };
}

/** Inspect MediaStore and the existing workspace without creating files or records. */
export async function inspectWorkspace(device: DeviceTransport, signal?: AbortSignal): Promise<WorkspaceInspection> {
  const context = await libraryContext(device, signal);
  const records = await queryMediaStoreFolders(context.device, context.user, [context.workspace.root], signal);
  await readMediaStoreFolders(context.device, context.user, records, signal);
  await assertAndroidUser(context.device, context.user, signal);
  return { user: context.user, workspace: context.workspace };
}

async function verifiedFolders(device: DeviceTransport, inspected: WorkspaceInspection, signal?: AbortSignal): Promise<LibraryVerification> {
  const plan = plannedLibraryDirectories(inspected.workspace);
  const records = await queryMediaStoreFolders(device, inspected.user, plan, signal);
  const confirmed = await readMediaStoreFolders(device, inspected.user, records, signal);
  const missing = plan.find((path) => !confirmed.has(path));
  if (missing) throw new Error(`Folder is missing or not indexed by MediaStore: ${missing}. Run Create folders to repair it.`);
  await assertAndroidUser(device, inspected.user, signal);
  return { ...inspected, systemCount: ESDE_ANDROID_SYSTEM_DIRECTORIES.length };
}

/** Check both the complete directory plan and the physical directories, read-only. */
export async function verifySharedLibraryFolders(device: DeviceTransport, signal?: AbortSignal): Promise<LibraryVerification> {
  const { device: scoped, ...inspected } = await libraryContext(device, signal);
  return verifiedFolders(scoped, inspected, signal);
}

/** Only missing folders receive temporary records; existing library files are preserved. */
export async function ensureSharedLibraryFolders(device: DeviceTransport, signal?: AbortSignal,
  log?: (message: string) => void): Promise<LibraryVerification> {
  const { device: scoped, ...inspected } = await libraryContext(device, signal);
  const plan = plannedLibraryDirectories(inspected.workspace);
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
  let next = 0;
  let completed = 0;
  const failures: unknown[] = [];
  async function worker(): Promise<void> {
    while (!failures.length && next < leaves.length) {
      const path = leaves[next++];
      if (!path) return;
      try {
        checkAbort(signal);
        await createMediaStoreFolder(scoped, inspected.user, path, signal);
        completed++;
        if (completed % 8 === 0 || completed === leaves.length) log?.(`Created ${completed}/${leaves.length} folder paths. Temporary records removed.`);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, leaves.length) }, () => worker()));
  if (failures.length) throw failures[0];
  log?.("Verifying the complete shared folder structure…");
  return verifiedFolders(scoped, inspected, signal);
}
