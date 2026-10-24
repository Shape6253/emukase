import { primaryStorageForUser, readAndroidUser, userScopedDevice } from "./android-user";
import { libraryPlatform } from "./library-catalog";
import { cleanQueryOutput, contentCommand } from "./media-store";
import { shellCommand, type DeviceTransport } from "./transport";
import { workspacePaths, type LibraryFolderOptions } from "./workspace";

export interface RomFileOptions {
  folders?: LibraryFolderOptions;
  signal?: AbortSignal;
}

interface RomFileContext {
  device: DeviceTransport;
  user: number;
  path: string;
  signal?: AbortSignal;
}

interface RomRecord {
  id: string;
  path: string;
}

const FILES_URI = "content://media/external/file";

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function validateRomFilename(name: string): void {
  if (!name || name !== name.trim() || name === "." || name === ".." || name.toLowerCase() === ".nomedia"
    || /[\u0000-\u001f\u007f/\\"*:<>?|]/.test(name) || new TextEncoder().encode(name).length > 255) {
    throw new Error("Enter a valid file name of up to 255 UTF-8 bytes, without paths or control characters.");
  }
}

async function romFileContext(
  device: DeviceTransport, platformId: string, relativePath: string, options: RomFileOptions,
): Promise<RomFileContext> {
  const platform = libraryPlatform(platformId);
  if (!relativePath || /[\u0000-\u001f\u007f\\]/.test(relativePath)
    || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Choose a file inside the selected platform's ROM folder.");
  }
  const user = await readAndroidUser(device, options.signal);
  const workspace = workspacePaths(primaryStorageForUser(user), options.folders);
  return {
    device: userScopedDevice(device, user, options.signal), user,
    path: `${workspace.roms}/${platform.id}/${relativePath}`, signal: options.signal,
  };
}

async function readRomRecord(context: RomFileContext, where: string): Promise<RomRecord | undefined> {
  const output = cleanQueryOutput(await contentCommand(context.device, context.user, [
    "query", "--projection", "_id:_data", "--where", `(${where}) AND (format IS NULL OR format != 12289)`,
  ], context.signal));
  if (output === "No result found.") return undefined;
  const match = /^Row: 0 _id=([1-9]\d{0,18}), _data=([^\r\n]+)$/.exec(output);
  if (!match?.[1] || !match[2]) throw new Error("Android did not confirm a unique ROM file. Refresh the library and try again.");
  return { id: match[1], path: match[2] };
}

async function runFileScript(context: RomFileContext, lines: readonly string[]): Promise<void> {
  const marker = `__emukase_rom_${crypto.randomUUID()}__`;
  const script = [...lines, `printf '%s\\n' ${shellCommand(marker)}`].join("\n");
  const output = (await context.device.shell(shellCommand("sh", "-c", script))).trim();
  if (output !== marker) throw new Error(output || "Android did not complete the ROM file operation.");
}

async function renameRecord(context: RomFileContext, record: RomRecord, name: string): Promise<RomRecord> {
  const destination = `${record.path.slice(0, record.path.lastIndexOf("/") + 1)}${name}`;
  // FUSE-created files can remain pending after their writer closes. Publish
  // the rename too, so Android does not hide it behind a .pending file name.
  await contentCommand(context.device, context.user, [
    "update", "--bind", `_display_name:s:${name}`, "--bind", "is_pending:i:0", "--where", `_data=${sqlString(record.path)}`,
  ], context.signal, `${FILES_URI}/${record.id}`);
  const renamed = await readRomRecord(context, `_id=${record.id}`);
  if (renamed?.path !== destination) throw new Error("Android did not confirm the requested file name. Refresh the library before trying again.");
  return renamed;
}

async function renameCaseOnly(context: RomFileContext, record: RomRecord, name: string): Promise<void> {
  const originalName = record.path.slice(record.path.lastIndexOf("/") + 1);
  const extension = /\.[^.]+$/.exec(originalName)?.[0] ?? "";
  const temporaryName = `emukase-rename-${crypto.randomUUID()}${extension}`;
  const temporaryPath = `${record.path.slice(0, record.path.lastIndexOf("/") + 1)}${temporaryName}`;
  try {
    // MediaProvider can treat a change of case as an unchanged filesystem path.
    const temporary = await renameRecord(context, record, temporaryName);
    await renameRecord(context, temporary, name);
  } catch (error) {
    const cleanup = { ...context, device: context.device.restorationDevice ?? context.device, signal: undefined };
    try {
      const destination = `${record.path.slice(0, record.path.lastIndexOf("/") + 1)}${name}`;
      const current = await readRomRecord(cleanup, `_id=${record.id}`);
      if (!current || ![record.path, temporaryPath, destination].includes(current.path)) {
        throw new Error("The original ROM could not be located for restoration.");
      }
      if (current.path !== record.path) await renameRecord(cleanup, current, originalName);
    } catch (restoreError) {
      throw new Error("The rename stopped and the original file name could not be restored. Refresh the library before trying again.", {
        cause: new AggregateError([error, restoreError]),
      });
    }
    throw error;
  }
}

/** Direct operations must stay inside the selected ROM directory. */
function directFileGuard(path: string): string[] {
  return [
    `if ! [ -f ${shellCommand(path)} ] || [ -L ${shellCommand(path)} ] || [ "$( ${shellCommand("readlink", "-f", path)} )" != ${shellCommand(path)} ]; then`,
    "printf '%s\\n' 'The ROM file is missing or inaccessible. Refresh the library and try again.'; exit 1",
    "fi",
  ];
}

function moveFile(source: string, destination: string): string[] {
  return [
    `${shellCommand("mv", "-n", source, destination)} 2>&1 || return 1`,
    `if [ -e ${shellCommand(source)} ] || [ -L ${shellCommand(source)} ] || ! [ -f ${shellCommand(destination)} ]; then`,
    "printf '%s\\n' 'The ROM could not be renamed. The destination may already exist.'; return 1",
    "fi",
  ];
}

async function renameDirect(context: RomFileContext, destination: string, caseOnly: boolean, sdk: number): Promise<void> {
  const directory = context.path.slice(0, context.path.lastIndexOf("/") + 1);
  const extension = /\.[^.]+$/.exec(context.path.slice(directory.length))?.[0] ?? "";
  const temporary = `${directory}emukase-rename-${crypto.randomUUID()}${extension}`;
  await runFileScript(context, [
    ...directFileGuard(context.path),
    "move_rom() {",
    ...moveFile(caseOnly ? temporary : context.path, destination),
    "}",
    ...(caseOnly ? [
      "stage_rom() {",
      ...moveFile(context.path, temporary),
      "}",
      "if ! stage_rom || ! move_rom; then",
      `if [ -f ${shellCommand(temporary)} ]; then`,
      `${shellCommand("mv", "-n", temporary, context.path)} 2>&1`,
      `if [ -e ${shellCommand(temporary)} ] || ! [ -f ${shellCommand(context.path)} ]; then`,
      "printf '%s\\n' 'The rename stopped and the original file name could not be restored. Refresh the library before trying again.'",
      "fi",
      "fi",
      "exit 1",
      "fi",
    ] : ["move_rom || exit 1"]),
    // Older storage drivers do not update MediaStore on filesystem renames.
    // Request a scan, but scanner availability must not undo a successful mv.
    ...(sdk < 30 ? [context.path, destination].map((path) =>
      `${shellCommand("am", "broadcast", "--user", String(context.user), "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
        "-d", `file://${path.split("/").map(encodeURIComponent).join("/")}`)} >/dev/null 2>&1 || :`) : []),
  ]);
}

/** Rename the file in its existing directory; an existing destination is never replaced. */
export async function renamePlatformRom(
  device: DeviceTransport, platformId: string, relativePath: string, name: string, options: RomFileOptions = {},
): Promise<string> {
  validateRomFilename(name);
  const context = await romFileContext(device, platformId, relativePath, options);
  const slash = context.path.lastIndexOf("/");
  const destination = `${context.path.slice(0, slash + 1)}${name}`;
  if (destination === context.path) return relativePath;
  const rawSdk = (await context.device.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
  if (!/^\d+$/.test(rawSdk) || !Number.isSafeInteger(Number(rawSdk))) throw new Error("Android version was not confirmed for file renaming.");
  const sdk = Number(rawSdk);
  const caseOnly = destination.toLowerCase() === context.path.toLowerCase();
  const record = await readRomRecord(context, `_data=${sqlString(context.path)}`);
  const collision = await readRomRecord(context, `_data=${sqlString(destination)} COLLATE NOCASE`);
  if (collision && collision.id !== record?.id) throw new Error("A file with this name already exists. Choose another name.");
  // The filesystem can contain a destination that has not been indexed yet.
  if (!collision || sdk < 30) await runFileScript(context, [
    `if [ -e ${shellCommand(destination)} ] || [ -L ${shellCommand(destination)} ]; then`,
    ...(caseOnly ? [`if ! [ ${shellCommand(context.path)} -ef ${shellCommand(destination)} ]; then`] : []),
    "printf '%s\\n' 'A file with this name already exists. Choose another name.'; exit 1",
    ...(caseOnly ? ["fi"] : []),
    "fi",
  ]);
  // Android 10 skips physical publication renames for shell callers; older
  // providers also lack is_pending. Use the filesystem on those releases.
  if (record && sdk >= 30) {
    if (caseOnly) await renameCaseOnly(context, record, name);
    else await renameRecord(context, record, name);
  } else {
    await renameDirect(context, destination, caseOnly, sdk);
  }
  return `${relativePath.slice(0, relativePath.lastIndexOf("/") + 1)}${name}`;
}

/** Delete one ROM file, using MediaStore when indexed so Android's listing stays current. */
export async function deletePlatformRom(
  device: DeviceTransport, platformId: string, relativePath: string, options: RomFileOptions = {},
): Promise<void> {
  const context = await romFileContext(device, platformId, relativePath, options);
  const record = await readRomRecord(context, `_data=${sqlString(context.path)}`);
  if (record) {
    await contentCommand(context.device, context.user, [
      "delete", "--where", `_data=${sqlString(context.path)}`,
    ], context.signal, `${FILES_URI}/${record.id}`);
    if (await readRomRecord(context, `_id=${record.id}`)) throw new Error("Android could not delete this ROM file.");
  } else {
    await runFileScript(context, [
      ...directFileGuard(context.path),
      `${shellCommand("rm", context.path)} 2>&1 || exit 1`,
    ]);
  }
}
