import { hasAndroidTreeReadGrant, selectAndroidDocument } from "./android-document-picker";
import type { AndroidUiNode, AndroidUiSnapshot } from "./android-ui";
import { primaryStorageForUser } from "./android-user";
import type { EmulatorConfigurationOptions } from "./emulator-configuration-types";
import { EMULATORS } from "./emulators";
import { androidResourceText, emulatorNodeVisible, restartEmulator, tapEmulatorNode, waitEmulatorUi, type EmulatorUiContext } from "./emulator-ui";
import { runGameFolderConfiguration, type GameFolderConfigurationResult } from "./game-folder-configuration";
import { createMediaStoreFolders } from "./media-store";
import { checkActivityStart, shellCommand, type DeviceTransport } from "./transport";
import { workspacePaths } from "./workspace";

const PACKAGE = EMULATORS.hakux.packages[0];
const ACTIVITY = `${PACKAGE}/${PACKAGE}.LauncherActivity`;

interface HakuxContext extends EmulatorUiContext {
  text: (name: string) => Promise<string>;
}

// Compose exposes translated text/content descriptions, but no view IDs or
// exported settings deep links. Resolve selectors from the installed resources.
function labeled(snapshot: AndroidUiSnapshot, label: string): AndroidUiNode | undefined {
  const matches = snapshot.nodes.filter((node) => (node.text === label || node.description === label)
    && node.enabled && emulatorNodeVisible(snapshot, node));
  if (matches.length > 1) throw new Error("hakuX's control is ambiguous.");
  return matches[0];
}

async function tap(context: HakuxContext, name: string): Promise<void> {
  const label = await context.text(name);
  const found = await waitEmulatorUi(context, (snapshot) => {
    if (snapshot.component !== ACTIVITY) return undefined;
    const target = labeled(snapshot, label);
    return target ? { snapshot, target } : undefined;
  });
  await tapEmulatorNode(context, found.snapshot, found.target);
}

async function open(context: HakuxContext): Promise<"setup" | "library"> {
  await context.ensureUnlocked();
  checkActivityStart(await context.device.shell(shellCommand("am", "start", "--user", String(context.user), "--display", "0", "-W",
    "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", ACTIVITY)));
  const [pick, settings, later] = await Promise.all([
    context.text("setup_pick_disc"), context.text("settings_title"), context.text("turnip_note_later"),
  ]);
  return waitEmulatorUi(context, async (snapshot) => {
    if (snapshot.component !== ACTIVITY) return undefined;
    const note = labeled(snapshot, later);
    if (note) {
      await tapEmulatorNode(context, snapshot, note);
      return undefined;
    }
    if (labeled(snapshot, pick)) return "setup" as const;
    if (labeled(snapshot, settings)) return "library" as const;
    return undefined;
  });
}

async function settings(context: HakuxContext): Promise<AndroidUiSnapshot> {
  const [title, later] = await Promise.all([context.text("settings_title"), context.text("turnip_note_later")]);
  // The recommendation can appear when Finish opens the library for the first
  // time too. Never tap the settings icon underneath its modal dialog.
  const found = await waitEmulatorUi(context, async (snapshot) => {
    if (snapshot.component !== ACTIVITY) return undefined;
    const note = labeled(snapshot, later);
    if (note) {
      await tapEmulatorNode(context, snapshot, note);
      return undefined;
    }
    const target = labeled(snapshot, title);
    return target ? { snapshot, target } : undefined;
  });
  await tapEmulatorNode(context, found.snapshot, found.target);
  const add = await context.text("settings_games_folder_add");
  return waitEmulatorUi(context, (snapshot) => snapshot.component === ACTIVITY && labeled(snapshot, add) ? snapshot : undefined);
}

async function folderAccepted(context: HakuxContext, snapshot: AndroidUiSnapshot, directory: string): Promise<boolean> {
  const relative = directory.slice(primaryStorageForUser(context.user).length + 1);
  const place = `${await context.text("storage_internal")} › ${relative}`;
  // Settings lists the app's actual folders, not every surviving SAF grant.
  const saved = snapshot.nodes.some((node) => node.text.split("\n").includes(place));
  return saved && await hasAndroidTreeReadGrant(context, PACKAGE, directory);
}

export async function verifyHakux(
  device: DeviceTransport, options: EmulatorConfigurationOptions = {},
): Promise<GameFolderConfigurationResult> {
  return runGameFolderConfiguration(device, PACKAGE, "hakuX", options, async (base) => {
    const labels = new Map<string, string>();
    const context: HakuxContext = { ...base, async text(name) {
      let value = labels.get(name);
      if (value === undefined) {
        value = await androidResourceText(base, PACKAGE, `${PACKAGE}:string/${name}`);
        labels.set(name, value);
      }
      return value;
    } };
    const directory = `${workspacePaths(primaryStorageForUser(context.user), options.folders).roms}/xbox`;
    const missing: GameFolderConfigurationResult = { library: "missing", setupComplete: false, contentVerified: false };
    options.onStatus?.("Opening hakuX's game folders…");
    await restartEmulator(context, PACKAGE, "hakuX");
    const screen = await open(context);
    if (screen === "setup") {
      if (options.inspectOnly) return missing;
      await createMediaStoreFolders(context.device, context.user, [directory], context.signal);
      options.onStatus?.("Selecting hakuX's Xbox game folder…");
      await tap(context, "setup_pick_disc");
      await selectAndroidDocument(context, PACKAGE, directory, true, undefined, { keyboardNavigation: true });
      await tap(context, "setup_finish");
    }
    let snapshot = await settings(context);
    if (await folderAccepted(context, snapshot, directory)) {
      return { library: "accepted", setupComplete: true, contentVerified: false };
    }
    if (options.inspectOnly) return missing;
    // Add the shared folder without replacing an existing library or moving games.
    await createMediaStoreFolders(context.device, context.user, [directory], context.signal);
    options.onStatus?.("Connecting hakuX to the shared Xbox game folder…");
    await tap(context, "settings_games_folder_add");
    await selectAndroidDocument(context, PACKAGE, directory, true, undefined, { keyboardNavigation: true });
    const add = await context.text("settings_games_folder_add");
    await waitEmulatorUi(context, (value) => value.component === ACTIVITY && labeled(value, add) ? true : undefined);
    options.onStatus?.("Restarting hakuX and checking its saved Xbox folder…");
    await restartEmulator(context, PACKAGE, "hakuX");
    if (await open(context) !== "library") throw new Error("hakuX did not retain its Xbox game folder.");
    snapshot = await settings(context);
    const accepted = await folderAccepted(context, snapshot, directory);
    return { library: accepted ? "accepted" : "unverified", setupComplete: accepted, contentVerified: false };
  });
}

export function configureHakux(
  device: DeviceTransport, files: readonly File[], options: EmulatorConfigurationOptions = {},
): Promise<GameFolderConfigurationResult> {
  if (files.length) throw new Error("hakuX does not require BIOS or other support files.");
  return verifyHakux(device, { ...options, inspectOnly: false });
}
