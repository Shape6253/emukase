import { assertAndroidUser, primaryStorageForUser, readAndroidUser, userScopedDevice } from "./android-user";
import { libraryPlatform } from "./library-catalog";
import { shellCommand, type DeviceTransport } from "./transport";
import { workspacePaths, type LibraryFolderOptions } from "./workspace";
import { queryMediaStoreFiles } from "./media-store";
import { recoverMediaStoreUploads, uploadMediaStoreFile } from "./media-store-upload";

export interface RomUploadProgress {
  filename: string;
  fileIndex: number;
  fileCount: number;
  transferredBytes: number;
  totalBytes: number;
}

export interface RomUploadOptions {
  folders?: LibraryFolderOptions;
  signal?: AbortSignal;
  onProgress?: (progress: RomUploadProgress) => void;
}

export interface RomUploadResult {
  uploaded: number;
  skipped: number;
}

function validateFiles(files: readonly File[]): number {
  if (!files.length) throw new Error("Choose at least one ROM file.");
  const names = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (!(file instanceof File) || !file.name || file.name === "." || file.name === ".." ||
      /[\u0000-\u001f\u007f/\\"*:<>?|]/.test(file.name) || new TextEncoder().encode(file.name).length > 255) {
      throw new Error("ROM file names must be valid Android file names, without paths or control characters.");
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error(`The file ${file.name} is empty or has an invalid size.`);
    const name = file.name.toLowerCase();
    if (names.has(name)) throw new Error(`More than one selected file is named ${file.name}. Upload them separately.`);
    names.add(name);
    total += file.size;
    if (!Number.isSafeInteger(total)) throw new Error("The selected files are too large to track their size accurately.");
  }
  return total;
}

/** File slices flow directly to ADB; ROM size never determines browser memory use. */
export async function uploadPlatformRoms(
  device: DeviceTransport, platformId: string, files: readonly File[], options: RomUploadOptions = {},
): Promise<RomUploadResult> {
  const platform = libraryPlatform(platformId);
  const totalBytes = validateFiles(files);
  const user = await readAndroidUser(device, options.signal);
  const scoped = userScopedDevice(device, user, options.signal);
  const sdk = (await scoped.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
  if (!/^\d+$/.test(sdk) || !Number.isSafeInteger(Number(sdk))) throw new Error("Android version was not confirmed for ROM uploads.");
  if (Number(sdk) < 29) throw new Error("ROM uploads through MediaStore require Android 10 or newer.");
  const workspace = workspacePaths(primaryStorageForUser(user), options.folders);
  const directory = `${workspace.roms}/${platform.id}`;
  await recoverMediaStoreUploads(scoped, user, directory, options.signal);
  const existingFiles = await queryMediaStoreFiles(scoped, user, directory, options.signal);
  const existingNames = new Set(existingFiles.map((entry) => entry.path.toLowerCase()));
  const result: RomUploadResult = { uploaded: 0, skipped: 0 };
  let completedBytes = 0;
  for (const [index, file] of files.entries()) {
    options.signal?.throwIfAborted();
    const destination = `${directory}/${file.name}`;
    const progress = (bytes: number): void => options.onProgress?.({
      filename: file.name, fileIndex: index + 1, fileCount: files.length,
      transferredBytes: completedBytes + bytes, totalBytes,
    });
    progress(0);
    if (existingNames.has(destination.toLowerCase())) {
      result.skipped++;
    } else {
      await uploadMediaStoreFile(scoped, user, directory, file, { signal: options.signal, onProgress: progress });
      result.uploaded++;
    }
    completedBytes += file.size;
    progress(0);
  }
  await assertAndroidUser(scoped, user, options.signal);
  return result;
}
