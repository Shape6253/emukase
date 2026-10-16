import { assertAndroidUser, primaryStorageForUser, readAndroidUser, userScopedDevice } from "./android-user";
import { libraryPlatform } from "./library-catalog";
import { shellCommand, type DeviceTransport } from "./transport";
import { workspacePaths, type LibraryFolderOptions } from "./workspace";
import { queryMediaStoreFiles } from "./media-store";
import { recoverMediaStoreUploads, uploadMediaStoreFile } from "./media-store-upload";
import { connectEdenLibrary } from "./eden";
import { readAndroidPackage } from "./android-package";
import { EMULATORS } from "./emulators";
import { cachedEmulatorConfiguration, forgetEmulatorConfiguration, rememberEmulatorConfiguration } from "./emulator-configuration";

export interface LibraryUploadProgress {
  filename: string;
  fileIndex: number;
  fileCount: number;
  transferredBytes: number;
  totalBytes: number;
}

export type RomUploadProgress = LibraryUploadProgress;

export interface LibraryUploadOptions {
  folders?: LibraryFolderOptions;
  signal?: AbortSignal;
  onProgress?: (progress: LibraryUploadProgress) => void;
  onStatus?: (message: string) => void;
}

export interface RomUploadOptions extends LibraryUploadOptions {
  connectEmulator?: boolean;
  onUnlockRequired?: (required: boolean) => void;
}

export interface LibraryUploadResult {
  uploaded: number;
  skipped: number;
}

export type RomUploadResult = LibraryUploadResult;

function validateFiles(files: readonly File[]): number {
  if (!files.length) throw new Error("Choose at least one file.");
  const names = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (!(file instanceof File) || !file.name || file.name === "." || file.name === ".." ||
      /[\u0000-\u001f\u007f/\\"*:<>?|]/.test(file.name) || new TextEncoder().encode(file.name).length > 255) {
      throw new Error("File names must be valid Android file names, without paths or control characters.");
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

async function destinationExists(device: DeviceTransport, path: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const marker = `__emukase_rom_exists_${crypto.randomUUID()}__`;
  // An ADB-copied file can exist before MediaStore indexes it. A failed test
  // can also mean storage is hidden from shell, so keep the index fallback.
  const script = [
    `if [ -e ${shellCommand(path)} ] || [ -L ${shellCommand(path)} ]; then`,
    `printf '%s:yes\\n' ${shellCommand(marker)}`,
    "else",
    `printf '%s:unknown\\n' ${shellCommand(marker)}`,
    "fi",
  ].join("\n");
  const output = (await device.shell(shellCommand("sh", "-c", script))).trim();
  signal?.throwIfAborted();
  if (output === `${marker}:yes`) return true;
  if (output === `${marker}:unknown`) return false;
  throw new Error("Android did not confirm the upload destination check.");
}

/** File slices flow directly to ADB; file size never determines browser memory use. */
async function uploadPlatformFiles(
  device: DeviceTransport, platformId: string, files: readonly File[], target: "roms" | "bios", options: LibraryUploadOptions,
): Promise<{ result: LibraryUploadResult; scoped: DeviceTransport; user: number }> {
  const platform = libraryPlatform(platformId);
  const totalBytes = validateFiles(files);
  const user = await readAndroidUser(device, options.signal);
  const scoped = userScopedDevice(device, user, options.signal);
  const sdk = (await scoped.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
  if (!/^\d+$/.test(sdk) || !Number.isSafeInteger(Number(sdk))) throw new Error("Android version was not confirmed for file uploads.");
  // API 29 skips shell callers' publication rename and size refresh.
  if (Number(sdk) < 30) throw new Error("File uploads through MediaStore require Android 11 or newer.");
  const workspace = workspacePaths(primaryStorageForUser(user), options.folders);
  const directory = `${workspace[target]}/${platform.id}`;
  await recoverMediaStoreUploads(scoped, user, directory, options.signal);
  const existingFiles = await queryMediaStoreFiles(scoped, user, directory, options.signal);
  const existingNames = new Set(existingFiles.map((entry) => entry.path.toLowerCase()));
  const result: LibraryUploadResult = { uploaded: 0, skipped: 0 };
  let completedBytes = 0;
  for (const [index, file] of files.entries()) {
    options.signal?.throwIfAborted();
    const destination = `${directory}/${file.name}`;
    const progress = (bytes: number): void => options.onProgress?.({
      filename: file.name, fileIndex: index + 1, fileCount: files.length,
      transferredBytes: completedBytes + bytes, totalBytes,
    });
    progress(0);
    if (existingNames.has(destination.toLowerCase()) || await destinationExists(scoped, destination, options.signal)) {
      result.skipped++;
    } else {
      await uploadMediaStoreFile(scoped, user, directory, file, { signal: options.signal, onProgress: progress });
      result.uploaded++;
    }
    completedBytes += file.size;
    progress(0);
  }
  await assertAndroidUser(scoped, user, options.signal);
  return { result, scoped, user };
}

/** Store support files in the shared library without opening an emulator. */
export async function uploadPlatformSupportFiles(
  device: DeviceTransport, platformId: string, requirementId: string, files: readonly File[], options: LibraryUploadOptions = {},
): Promise<LibraryUploadResult> {
  const platform = libraryPlatform(platformId);
  const requirement = platform.requirements.find((entry) => entry.id === requirementId);
  if (!requirement) throw new Error("The support requirement is unavailable for this platform.");
  for (const file of files) {
    if (!(file instanceof File) || !requirement.matches(`${platform.id}/${file.name}`)) {
      throw new Error(`Choose ${requirement.expected}.`);
    }
  }
  const { result } = await uploadPlatformFiles(device, platformId, files, "bios", options);
  return result;
}

export async function uploadPlatformRoms(
  device: DeviceTransport, platformId: string, files: readonly File[], options: RomUploadOptions = {},
): Promise<RomUploadResult> {
  const { result, scoped, user } = await uploadPlatformFiles(device, platformId, files, "roms", options);
  const platform = libraryPlatform(platformId);
  if (options.connectEmulator !== false && platform.id === "switch" && await readAndroidPackage(scoped, EMULATORS.eden.packages[0], user, options.signal)) {
    options.onStatus?.("ROM files are ready. Connecting the game folder in Eden…");
    const previous = cachedEmulatorConfiguration(device, platform.id, options.folders);
    forgetEmulatorConfiguration(device, platform.id);
    try {
      await connectEdenLibrary(scoped, {
        folders: options.folders, signal: options.signal, onUnlockRequired: options.onUnlockRequired,
      });
      options.signal?.throwIfAborted();
      if (previous) rememberEmulatorConfiguration(device, platform.id, { ...previous, library: "accepted" }, options.folders);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`ROM files have been kept on the device, but Eden's game folder could not be configured: ${reason}`, { cause: error });
    }
  }
  return result;
}
