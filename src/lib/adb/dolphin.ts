import { hasAndroidTreeReadGrant, selectAndroidDocument } from "./android-document-picker";
import type { AndroidUiSnapshot } from "./android-ui";
import { primaryStorageForUser } from "./android-user";
import type { EmulatorConfigurationOptions } from "./emulator-configuration-types";
import { EMULATORS } from "./emulators";
import { EmulatorSettingsAccessError, readEmulatorSettings } from "./emulator-settings";
import { androidResourceText, emulatorNodeVisible, restartEmulator, tapEmulatorNode, uiNode, waitEmulatorUi, type EmulatorUiContext } from "./emulator-ui";
import { runGameFolderConfiguration, type GameFolderConfigurationResult } from "./game-folder-configuration";
import { trimNativeIniWhitespace } from "./ini-text";
import { createMediaStoreFolders } from "./media-store";
import { checkActivityStart, shellCommand, type DeviceTransport } from "./transport";
import { workspacePaths } from "./workspace";

const PACKAGE = EMULATORS.dolphin.packages[0];
const ACTIVITY = `${PACKAGE}/.ui.main.MainActivity`;
const ADD_DIRECTORY = `${PACKAGE}:id/button_add_directory`;

interface DolphinAdapter {
  configure: (device: DeviceTransport, files: readonly File[], options: EmulatorConfigurationOptions) => Promise<GameFolderConfigurationResult>;
  verify: (device: DeviceTransport, options: EmulatorConfigurationOptions) => Promise<GameFolderConfigurationResult>;
}

async function readDolphinSettings(context: EmulatorUiContext): Promise<string | undefined> {
  const storage = primaryStorageForUser(context.user);
  let accessError: EmulatorSettingsAccessError | undefined;
  try {
    const text = await readEmulatorSettings(context, `${storage}/Android/data/${PACKAGE}/files/Config/Dolphin.ini`);
    // Dolphin prefers a populated app directory over its legacy directory.
    if (text !== undefined) return text;
  } catch (error) {
    if (!(error instanceof EmulatorSettingsAccessError)) throw error;
    accessError = error;
  }
  if (await readEmulatorSettings(context, `${storage}/dolphin-emu/Config/Dolphin.ini`) !== undefined) {
    throw new Error("Dolphin's legacy dolphin-emu user directory is not supported by automatic setup. Add the shared GameCube or Wii game folder in Dolphin on the device.");
  }
  if (accessError) throw accessError;
  return undefined;
}

function registeredFolder(text: string, expectedDocumentId: string): boolean {
  let inGeneral = false;
  let count = 0;
  const paths = new Map<number, string>();
  // Unlike PPSSPP, Dolphin strips a BOM only at the beginning of the file.
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (line.startsWith("[")) {
      const section = /^\[([^\]]*)\]/.exec(line);
      if (section) inGeneral = section[1]?.toLowerCase() === "general";
      continue;
    }
    if (!inGeneral) continue;
    // Native keys are case-insensitive, but ISOPath00 is NOT ISOPath0.
    const entry = /^[ \t\r]*(ISOPaths|ISOPath(?:0|[1-9]\d*))[ \t\r]*=[ \t\r]*(.*)$/i.exec(line);
    if (!entry) continue;
    const key = entry[1]?.toLowerCase();
    let value = trimNativeIniWhitespace(entry[2] ?? "");
    if (value.startsWith("\"") && value.endsWith("\"")) value = value.slice(1, -1);
    if (key === "isopaths") {
      // Dolphin's integer reader uses strtoll(base=0), including octal/hex.
      const unsigned = value.replace(/^[ \t\r\n\v\f]*\+?/, "");
      const radix = /^0x[\da-f]+$/i.test(unsigned) ? 16 : /^0[0-7]*$/.test(unsigned) ? 8 : /^[1-9]\d*$/.test(unsigned) ? 10 : 0;
      count = radix ? Number.parseInt(unsigned, radix) : 0;
    } else if (key) paths.set(Number(key.slice("isopath".length)), value);
  }
  if (!Number.isSafeInteger(count) || count < 0 || count > 2_147_483_647) return false;
  return [...paths].some(([index, value]) => {
    if (index >= count) return false;
    const tree = /^content:\/\/com\.android\.externalstorage\.documents\/tree\/([^/?#]+)$/.exec(value)?.[1];
    if (!tree) return false;
    try { return decodeURIComponent(tree) === expectedDocumentId; }
    catch { return false; }
  });
}

async function inspectFolder(context: EmulatorUiContext, directory: string): Promise<GameFolderConfigurationResult> {
  let text: string | undefined;
  try { text = await readDolphinSettings(context); }
  catch (error) { if (!(error instanceof EmulatorSettingsAccessError)) throw error; }
  const relative = directory.slice(primaryStorageForUser(context.user).length + 1);
  const registered = text !== undefined && registeredFolder(text, `primary:${relative}`);
  const grant = await hasAndroidTreeReadGrant(context, PACKAGE, directory);
  return {
    library: registered && grant ? "accepted" : registered || grant ? "unverified" : "missing",
    setupComplete: registered && grant,
    // A saved folder and a persisted grant do not verify any game content.
    contentVerified: false,
  };
}

function mainList(snapshot: AndroidUiSnapshot): boolean {
  return snapshot.component.startsWith(`${PACKAGE}/`)
    && uiNode(snapshot, `${PACKAGE}:id/toolbar_main`) !== undefined;
}

async function launchHome(context: EmulatorUiContext): Promise<void> {
  await context.ensureUnlocked();
  const analytics = await androidResourceText(context, PACKAGE, `${PACKAGE}:string/analytics`);
  checkActivityStart(await context.device.shell(shellCommand("am", "start", "--user", String(context.user),
    "--display", "0", "--activity-clear-task", "-W", "-n", ACTIVITY)));
  await waitEmulatorUi(context, async (snapshot) => {
    if (!snapshot.component.startsWith(`${PACKAGE}/`)) return undefined;
    const title = uiNode(snapshot, `${PACKAGE}:id/alertTitle`);
    if (title?.text === analytics) {
      const no = uiNode(snapshot, "android:id/button2");
      if (no?.enabled && emulatorNodeVisible(snapshot, no)) await tapEmulatorNode(context, snapshot, no);
      return undefined;
    }
    return !title && mainList(snapshot) ? true : undefined;
  });
}

async function pickFolder(context: EmulatorUiContext, directory: string): Promise<void> {
  const snapshot = await waitEmulatorUi(context, (value) => {
    if (!mainList(value)) return undefined;
    const add = uiNode(value, ADD_DIRECTORY);
    return add?.enabled && emulatorNodeVisible(value, add) ? { snapshot: value, add } : undefined;
  });
  await tapEmulatorNode(context, snapshot.snapshot, snapshot.add);
  await selectAndroidDocument(context, PACKAGE, directory, true, undefined, { keyboardNavigation: true });
  await waitEmulatorUi(context, async (value) => {
    if (!value.component.startsWith(`${PACKAGE}/`)) return undefined;
    // An empty folder is still a valid library connection. Dolphin shows a
    // single-button notice before returning to its main list in this case.
    const message = uiNode(value, "android:id/message");
    const ok = uiNode(value, "android:id/button1");
    if (message && ok?.enabled && !uiNode(value, "android:id/button2") && emulatorNodeVisible(value, ok)) {
      await tapEmulatorNode(context, value, ok);
      return undefined;
    }
    // Dolphin takes the grant in its result callback and registers the folder
    // in onResume. Observe both before stopping it to flush its settings.
    return mainList(value) && await hasAndroidTreeReadGrant(context, PACKAGE, directory) ? true : undefined;
  });
}

async function runDolphin(
  device: DeviceTransport, options: EmulatorConfigurationOptions, platform: "gc" | "wii",
): Promise<GameFolderConfigurationResult> {
  return runGameFolderConfiguration(device, PACKAGE, "Dolphin", options, async (context) => {
    const workspace = workspacePaths(primaryStorageForUser(context.user), options.folders);
    const directory = `${workspace.roms}/${platform}`;
    const state = await inspectFolder(context, directory);
    if (options.inspectOnly) return state;
    options.onStatus?.("Opening Dolphin's game library…");
    await restartEmulator(context, PACKAGE, "Dolphin");
    await launchHome(context);
    let connected = false;
    if ((await inspectFolder(context, directory)).library !== "accepted") {
      options.onStatus?.(`Connecting Dolphin to the ${platform === "gc" ? "GameCube" : "Wii"} game folder…`);
      await createMediaStoreFolders(context.device, context.user, [directory], context.signal);
      await pickFolder(context, directory);
      connected = true;
      options.onStatus?.("Restarting Dolphin and checking its saved game folder…");
      await restartEmulator(context, PACKAGE, "Dolphin");
      await launchHome(context);
    }
    const result = await inspectFolder(context, directory);
    if (connected && await hasAndroidTreeReadGrant(context, PACKAGE, directory)) {
      // The native callback plus a fresh launch verifies registration even
      // when Android hides the app's INI from the shell in this profile.
      try { await readDolphinSettings(context); }
      catch (error) {
        if (!(error instanceof EmulatorSettingsAccessError)) throw error;
        return { library: "accepted", setupComplete: true, contentVerified: false };
      }
    }
    return result;
  });
}

function createAdapter(platform: "gc" | "wii"): DolphinAdapter {
  return {
    async configure(device: DeviceTransport, files: readonly File[], options: EmulatorConfigurationOptions): Promise<GameFolderConfigurationResult> {
      if (files.length) throw new Error("Dolphin does not import support files for this platform.");
      return runDolphin(device, { ...options, inspectOnly: false }, platform);
    },
    async verify(device: DeviceTransport, options: EmulatorConfigurationOptions): Promise<GameFolderConfigurationResult> {
      return runDolphin(device, options, platform);
    },
  };
}

export const DOLPHIN_GC_ADAPTER = createAdapter("gc");
export const DOLPHIN_WII_ADAPTER = createAdapter("wii");
