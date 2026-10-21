import { hasAndroidTreeReadGrant, selectAndroidDocument } from "./android-document-picker";
import { AndroidUiStateChangedError, androidUiForeground } from "./android-ui";
import { androidUserProcessPid, assertAndroidUser, primaryStorageForUser } from "./android-user";
import type { EmulatorConfigurationOptions } from "./emulator-configuration-types";
import { EMULATORS } from "./emulators";
import { EmulatorSettingsAccessError, readEmulatorSettings } from "./emulator-settings";
import { restartEmulator, type EmulatorUiContext } from "./emulator-ui";
import { runGameFolderConfiguration, type GameFolderConfigurationResult } from "./game-folder-configuration";
import { trimNativeIniWhitespace } from "./ini-text";
import { createMediaStoreFolders } from "./media-store";
import { uploadMediaStoreFile } from "./media-store-upload";
import { statMediaStoreFile } from "./media-store-file-stat";
import { sharedStorageReadable } from "./shared-storage-text";
import { checkActivityStart, shellCommand, type DeviceTransport } from "./transport";
import { workspacePaths } from "./workspace";

const PPSSPP_PACKAGE = EMULATORS.ppsspp.packages[0];
const ACTIVITY = `${PPSSPP_PACKAGE}/${PPSSPP_PACKAGE}.PpssppActivity`;
const PICKER = /documentsui.*\/com\.android\.documentsui\.picker\.PickActivity$/u;

/** PPSSPP's settings live in ppsspp.ini at the PSP memory stick root. The
 * memory stick is the shared psp ROM folder, so games stay at its root and the
 * emulator reads the lowercase folder directly. */
function ppssppIniPath(root: string): string {
  // SAF-based memory sticks never use the uppercase "PSP" name shortcut, so
  // PPSSPP places PSP data in a PSP subfolder of the granted tree.
  return `${root}/PSP/SYSTEM/ppsspp.ini`;
}

function ppssppTreeUri(primaryStorage: string, directory: string): string {
  const encoded = encodeURIComponent(`primary:${directory.slice(primaryStorage.length + 1)}`);
  return `content://com.android.externalstorage.documents/tree/${encoded}/document/${encoded}`;
}

function readSettings(context: EmulatorUiContext, root: string): Promise<string | undefined> {
  return readEmulatorSettings(context, ppssppIniPath(root));
}

/** Observe PPSSPP rewriting its native marker in the active memory stick.
 * An old INI and a surviving SAF grant alone are not setup evidence. */
async function nativeFolderVersion(context: EmulatorUiContext, root: string): Promise<string | undefined> {
  const path = `${root}/PSP/SYSTEM/.nomedia`;
  if (!await sharedStorageReadable(context.device, context.user, context.signal)) {
    const stat = await statMediaStoreFile(context.device, context.user, path, context.signal);
    if (stat === undefined) return undefined;
    if (stat.bytes !== 0) throw new Error("PPSSPP's native data-folder marker is invalid.");
    return String(stat.modifiedSeconds);
  }
  const output = (await context.device.shell(shellCommand("sh", "-c",
    `if ${shellCommand("test", "-f", path)}; then ${shellCommand("stat", "-c", "%Y|%s", path)}; fi`))).trim();
  if (!output) return undefined;
  const match = /^(\d+)\|0$/.exec(output);
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    throw new Error("Android could not inspect PPSSPP's native data-folder marker.");
  }
  return match[1];
}

async function waitDeviceClockTick(context: EmulatorUiContext, version: string): Promise<void> {
  // fstat exposes seconds. Observe the device clock advancing before PPSSPP
  // writes again, rather than depending on filesystem subsecond precision.
  const deadline = Date.now() + 3_000;
  for (;;) {
    context.signal?.throwIfAborted();
    const now = (await context.device.shell(shellCommand("date", "+%s"))).trim();
    if (!/^\d+$/.test(now) || !Number.isSafeInteger(Number(now))) throw new Error("Android's clock could not be confirmed.");
    if (now !== version) return;
    if (Date.now() >= deadline) throw new Error("Android's clock did not advance for PPSSPP's native folder check.");
  }
}

async function launchAndVerifyFolder(context: EmulatorUiContext, root: string): Promise<boolean> {
  const before = await nativeFolderVersion(context, root);
  if (before !== undefined) await waitDeviceClockTick(context, before);
  await launchPpsspp(context);
  let after = await nativeFolderVersion(context, root);
  if (after !== undefined && after !== before) return true;
  if (before === undefined && !await hasAndroidTreeReadGrant(context, PPSSPP_PACKAGE, root, true)) return false;
  // Foreground readiness can precede native initialization. Give the marker a
  // short bounded chance to update, without waiting on accessibility or falsely
  // sending an already-configured app back through first-run setup.
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    context.signal?.throwIfAborted();
    after = await nativeFolderVersion(context, root);
    if (after !== undefined && after !== before) return true;
  }
  return false;
}

function generalSection(lines: readonly string[]): readonly [number, number] | undefined {
  // Native IniFile uses the first case-insensitive section/key match. Headers
  // must start at column zero, but may have a BOM and trailing comments.
  let start: number | undefined;
  for (let index = 0; index < lines.length; index++) {
    const section = /^\uFEFF?\[([^\]]*)\]/.exec(lines[index] ?? "");
    if (!section) continue;
    if (start !== undefined) return [start, index];
    if (section[1]?.toLowerCase() === "general") start = index;
  }
  return start === undefined ? undefined : [start, lines.length];
}

function ppssppIniValue(text: string): string {
  let value = trimNativeIniWhitespace(text);
  // Native IniFile preserves hashes inside fully quoted values. Otherwise a
  // hash begins a comment unless escaped by the immediately preceding slash.
  if (!(value.length >= 2 && value.startsWith("\"") && value.endsWith("\""))) {
    let parsed = "";
    for (let index = 0; index < value.length; index++) {
      if (value[index] === "#") break;
      if (value[index] === "\\" && value[index + 1] === "#") {
        parsed += "#";
        index++;
      } else parsed += value[index];
    }
    value = trimNativeIniWhitespace(parsed);
  }
  return value.startsWith("\"") && value.endsWith("\"") ? value.slice(1, -1) : value;
}

function currentDirectoryLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const section = generalSection(lines);
  if (!section) return undefined;
  for (const raw of lines.slice(section[0] + 1, section[1])) {
    const entry = /^CurrentDirectory[ \t\r]*=[ \t\r]*(.*)$/i.exec(trimNativeIniWhitespace(raw.replace(/^\uFEFF/, "")));
    if (entry) return ppssppIniValue(entry[1] ?? "");
  }
  return undefined;
}

function withCurrentDirectory(text: string, value: string): string {
  const lines = text.split(/\r?\n/);
  const section = generalSection(lines);
  if (!section) throw new Error("ppsspp.ini has no General section.");
  let replaced = false;
  const body: string[] = [];
  for (const raw of lines.slice(section[0] + 1, section[1])) {
    if (/^CurrentDirectory[ \t\r]*=/i.test(trimNativeIniWhitespace(raw.replace(/^\uFEFF/, "")))) {
      if (!replaced) body.push(`CurrentDirectory = ${value}`);
      replaced = true;
    } else body.push(raw);
  }
  if (!replaced) body.unshift(`CurrentDirectory = ${value}`);
  return [...lines.slice(0, section[0] + 1), ...body, ...lines.slice(section[1])].join(text.includes("\r\n") ? "\r\n" : "\n");
}

async function writeSettings(context: EmulatorUiContext, root: string, original: string, text: string): Promise<void> {
  const path = ppssppIniPath(root);
  await uploadMediaStoreFile(context.device, context.user, path.slice(0, path.lastIndexOf("/")), new File([text], "ppsspp.ini"), {
    replaceExisting: true, signal: context.signal,
    beforePublish: async () => {
      if (await androidUserProcessPid(context.device, PPSSPP_PACKAGE, context.user, context.signal)) {
        throw new Error("PPSSPP must remain stopped while updating its game folder.");
      }
      if (await readSettings(context, root) !== original) throw new Error("PPSSPP's settings changed before import; no replacement was made.");
    },
  });
  if (await readSettings(context, root) !== text) throw new Error("Android did not persist the ppsspp.ini update.");
}

async function inspectPpsspp(context: EmulatorUiContext, root: string, active: boolean): Promise<GameFolderConfigurationResult> {
  const iniText = await readSettings(context, root);
  const grant = await hasAndroidTreeReadGrant(context, PPSSPP_PACKAGE, root, true);
  if (!grant) return { library: "missing", setupComplete: false, contentVerified: false };
  if (!iniText) return { library: "unverified", setupComplete: false, contentVerified: false };
  const browsed = active && currentDirectoryLine(iniText) === ppssppTreeUri(primaryStorageForUser(context.user), root);
  return { library: browsed ? "accepted" : "unverified", setupComplete: browsed, contentVerified: false };
}

async function stopPpsspp(context: EmulatorUiContext): Promise<void> {
  await restartEmulator(context, PPSSPP_PACKAGE, "PPSSPP");
}

function launchCommand(user: number, diagnostic = false): string {
  return shellCommand("am", "start", "--user", String(user), "--display", "0", "--activity-clear-task", "-W", "-n", ACTIVITY,
    ...(diagnostic ? ["--es", "org.ppsspp.ppsspp.Args", "--loglevel=4"] : []));
}

async function launchPpsspp(context: EmulatorUiContext): Promise<void> {
  await context.ensureUnlocked();
  checkActivityStart(await context.device.shell(launchCommand(context.user)));
  // PPSSPP renders natively: an accessibility hierarchy adds no evidence that
  // its data folder is active and may stall while its renderer is starting.
  // Observe the foreground here; folder acceptance still requires a fresh
  // app-owned marker and its saved INI below. Picker input keeps full UI checks.
  await waitPpssppForeground(context);
}

async function waitPpssppForeground(context: EmulatorUiContext, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    context.signal?.throwIfAborted();
    try {
      if (await androidUiForeground(context.device, context.user, context.signal) === ACTIVITY) return;
    } catch (error) {
      if (!(error instanceof AndroidUiStateChangedError)) throw error;
    }
  }
  throw new Error("PPSSPP did not open on the selected Android profile.");
}

async function pressPpssppKey(context: EmulatorUiContext, key: string): Promise<void> {
  // Native-rendered controls expose no accessibility IDs. Recheck foreground
  // and lock state before each key; never send input to another activity.
  await context.ensureUnlocked();
  if (await androidUiForeground(context.device, context.user, context.signal) !== ACTIVITY) {
    throw new AndroidUiStateChangedError("PPSSPP lost focus before keyboard navigation.");
  }
  const output = await context.device.shell(shellCommand("input", "keyevent", key));
  if (/Error:|Exception|Permission Denial/i.test(output)) throw new Error("Android rejected PPSSPP keyboard navigation.");
}

/** Native controls have no accessibility IDs. Require this launch's native
 * first-run screen marker before using its known directional focus order. */
async function confirmInitialSetup(context: EmulatorUiContext, launchedAt: string, pid: string): Promise<void> {
  const sdk = (await context.device.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
  if (!/^[1-9]\d*$/.test(sdk) || !Number.isSafeInteger(Number(sdk))) throw new Error("Android's version could not be confirmed.");
  if (Number(sdk) < 30) {
    throw new Error("PPSSPP uses filesystem-based storage on this Android version. Automatic first-run setup is unavailable. Select the shared PSP folder in PPSSPP's Memory Stick Folder settings on the device.");
  }
  if (!pid || await androidUserProcessPid(context.device, PPSSPP_PACKAGE, context.user, context.signal) !== pid) {
    throw new Error("PPSSPP stopped before its first-run setup could be checked.");
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await waitPpssppForeground(context, deadline - Date.now());
    const log = await context.device.shell(shellCommand("logcat", "-d", "-v", "raw", "-T", launchedAt,
      "--pid", pid, "-s", "PPSSPP:I", "*:S"));
    if (await androidUserProcessPid(context.device, PPSSPP_PACKAGE, context.user, context.signal) !== pid) {
      throw new Error("PPSSPP restarted while its first-run setup was being checked.");
    }
    if (/\bMemStickScreen: initialSetup=1\s*$/m.test(log)
      || /^\[SYSTEM\] No memstick directory! Asking for one to be configured\.\s*$/m.test(log)) {
      return;
    }
  }
  throw new Error("PPSSPP's first-run folder screen could not be confirmed. It may already use a filesystem or app-private folder. Select the shared PSP folder in PPSSPP's Memory Stick Folder settings on the device, then check again.");
}

async function openInitialSetup(context: EmulatorUiContext): Promise<void> {
  await stopPpsspp(context);
  await context.ensureUnlocked();
  const launchedAt = (await context.device.shell(shellCommand("date", "+%s"))).trim();
  if (!/^\d+$/.test(launchedAt) || !Number.isSafeInteger(Number(launchedAt))) throw new Error("Android's clock could not be confirmed.");
  // Release logs default to errors. Some versions also treat Args as a game
  // shortcut: discard this probe before input, including on failure/cancellation.
  const recovery = context.device.restorationDevice ?? context.device;
  await assertAndroidUser(recovery, context.user);
  context.signal?.throwIfAborted();
  let pid: string | undefined;
  try {
    // Capture ownership before consulting cancellation again. The restoration
    // transport finishes the launch even if the operation's signal expires.
    const started = await recovery.shell(launchCommand(context.user, true));
    pid = await androidUserProcessPid(recovery, PPSSPP_PACKAGE, context.user);
    checkActivityStart(started);
    await confirmInitialSetup(context, `${launchedAt}.000`, pid);
  } finally {
    await assertAndroidUser(recovery, context.user);
    pid ??= await androidUserProcessPid(recovery, PPSSPP_PACKAGE, context.user);
    if (pid && await androidUserProcessPid(recovery, PPSSPP_PACKAGE, context.user) === pid) {
      await recovery.shell(shellCommand("am", "force-stop", "--user", String(context.user), PPSSPP_PACKAGE));
      if (await androidUserProcessPid(recovery, PPSSPP_PACKAGE, context.user) === pid) {
        throw new Error("Android did not stop PPSSPP's diagnostic launch.");
      }
    }
  }
  await launchPpsspp(context);
}

async function openMemoryStickPicker(context: EmulatorUiContext): Promise<void> {
  // The first-run browse choice is preselected; directional focus avoids
  // translated labels and fixed screen coordinates.
  for (const key of ["KEYCODE_DPAD_RIGHT", "KEYCODE_DPAD_RIGHT", "KEYCODE_DPAD_RIGHT", "KEYCODE_ENTER"]) {
    await pressPpssppKey(context, key);
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    context.signal?.throwIfAborted();
    try {
      if (PICKER.test(await androidUiForeground(context.device, context.user, context.signal))) return;
    } catch (error) {
      if (!(error instanceof AndroidUiStateChangedError)) throw error;
    }
  }
  throw new Error("PPSSPP did not open Android's folder picker.");
}

/** PPSSPP's confirm screen starts without focus: Down then Enter. */
async function confirmMemoryStick(context: EmulatorUiContext, root: string): Promise<void> {
  const before = await nativeFolderVersion(context, root);
  if (before !== undefined) await waitDeviceClockTick(context, before);
  for (const key of ["KEYCODE_DPAD_DOWN", "KEYCODE_ENTER"]) {
    await pressPpssppKey(context, key);
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await waitPpssppForeground(context, deadline - Date.now());
    const after = await nativeFolderVersion(context, root);
    // The next step stops PPSSPP and reads its persisted INI. Reading it here
    // repeats the slow MediaStore scan without verifying the stopped state.
    if (after !== undefined && after !== before) return;
  }
  throw new Error("PPSSPP did not save its selected PSP data folder.");
}

/** Point PPSSPP's game browser at the memory stick root so the shared ROM
 * folder lists directly. Read the latest settings only after stopping the app. */
async function seedGamesDirectory(
  context: EmulatorUiContext, root: string, options: EmulatorConfigurationOptions,
): Promise<GameFolderConfigurationResult> {
  const expected = ppssppTreeUri(primaryStorageForUser(context.user), root);
  options.onStatus?.("Saving PPSSPP's settings before restart…");
  await stopPpsspp(context);
  options.onStatus?.("Reading PPSSPP's saved game folder…");
  const observed = await readSettings(context, root);
  if (!observed) throw new Error("PPSSPP did not write its settings yet.");
  if (currentDirectoryLine(observed) !== expected) {
    options.onStatus?.("Updating PPSSPP's game browser folder…");
    await writeSettings(context, root, observed, withCurrentDirectory(observed, expected));
  }
  options.onStatus?.("Launching PPSSPP and verifying its active PSP folder…");
  if (!await launchAndVerifyFolder(context, root)) {
    throw new Error("PPSSPP did not confirm the active shared game folder after restart.");
  }
  const result = await inspectPpsspp(context, root, true);
  if (result.library !== "accepted") throw new Error("PPSSPP did not confirm the active shared game folder after restart.");
  return result;
}

async function connectPpsspp(
  context: EmulatorUiContext, options: EmulatorConfigurationOptions, root: string, active: boolean,
): Promise<GameFolderConfigurationResult> {
  if (active) {
    options.onStatus?.("Restarting PPSSPP and checking its saved game folder…");
    return seedGamesDirectory(context, root, options);
  }
  const permissions = await context.device.shell(shellCommand("dumpsys", "activity", "permissions"));
  const otherFolder = permissions.split(/(?=^\s*UriPermission\{)/m).some((block) => {
    if (!block.split(/\r?\n/).some((line) => line.trim() === `targetUserId=${context.user} sourcePkg=com.android.externalstorage targetPkg=${PPSSPP_PACKAGE}`)) return false;
    const modes = /\bpersisted=0x([a-f\d]+)/i.exec(block)?.[1];
    const uri = /content:\/\/com\.android\.externalstorage\.documents\/tree\/([^\s]+)/u.exec(block)?.[1];
    if (!modes || !uri || (Number.parseInt(modes, 16) & 3) !== 3) return false;
    try {
      return decodeURIComponent(uri) !== `primary:${root.slice(primaryStorageForUser(context.user).length + 1)}`;
    } catch { return true; }
  });
  if (otherFolder) {
    throw new Error("PPSSPP already has access to another data folder. Select the shared PSP folder in PPSSPP's Memory Stick Folder settings, then check again. Existing data has not been moved.");
  }
  try {
    const privateRoot = `${primaryStorageForUser(context.user)}/Android/data/${PPSSPP_PACKAGE}/files`;
    if (await readEmulatorSettings(context, ppssppIniPath(privateRoot)) !== undefined) {
      throw new Error("PPSSPP already stores PSP data in its app folder. Select the shared PSP folder in PPSSPP's Memory Stick Folder settings, then check again. Existing data has not been moved.");
    }
  } catch (error) {
    // Secondary profiles can hide app storage even on a fresh installation.
    if (!(error instanceof EmulatorSettingsAccessError)) throw error;
  }
  options.onStatus?.("Opening PPSSPP's PSP data folder selection…");
  await openInitialSetup(context);
  await createMediaStoreFolders(context.device, context.user, [root], context.signal);
  await openMemoryStickPicker(context);
  await selectAndroidDocument(context, PPSSPP_PACKAGE, root, true, undefined, { keyboardNavigation: true });
  options.onStatus?.("Confirming PPSSPP's PSP data folder…");
  await confirmMemoryStick(context, root);
  options.onStatus?.("Restarting PPSSPP and checking its saved game folder…");
  return seedGamesDirectory(context, root, options);
}

export async function configurePpsspp(
  device: DeviceTransport, files: readonly File[], options: EmulatorConfigurationOptions = {},
): Promise<GameFolderConfigurationResult> {
  if (files.length) throw new Error("PPSSPP does not import support files for this platform.");
  return verifyPpsspp(device, { ...options, inspectOnly: false });
}

export async function verifyPpsspp(
  device: DeviceTransport, options: EmulatorConfigurationOptions = {},
): Promise<GameFolderConfigurationResult> {
  return runGameFolderConfiguration(device, PPSSPP_PACKAGE, "PPSSPP", options, async (context) => {
    const storage = primaryStorageForUser(context.user);
    const root = `${workspacePaths(storage, options.folders).roms}/psp`;
    options.onStatus?.("Restarting PPSSPP to verify its active data folder…");
    await stopPpsspp(context);
    const active = await launchAndVerifyFolder(context, root);
    if (options.inspectOnly || active) {
      const state = await inspectPpsspp(context, root, active);
      if (options.inspectOnly || state.library === "accepted") return state;
    }
    return connectPpsspp(context, options, root, active);
  });
}
