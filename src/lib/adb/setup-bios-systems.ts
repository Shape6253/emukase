import { readAndroidUser } from "./android-user";
import { configureEmulator, type EmulatorConfigurationResult } from "./emulator-configuration";
import { emulatorConfigurationReady, melonDsConsoleReady } from "../emulator-configuration-state";
import { installEmulatorViaObtainium } from "./obtainium-install";
import { libraryPlatform } from "./library-catalog";
import { checkAbort, type SetupEvent, type SetupStage } from "./setup-events";
import type { LibraryFolderOptions } from "./workspace";
import { biosSystemRunIncomplete, type BiosSystemRun } from "./bios-systems";
import type { Abi } from "./catalog";
import { checkActivityStart, shellCommand, type DeviceTransport } from "./transport";

export function biosSystemStage(platformId: string): SetupStage {
  return `extra:bios-${platformId}`;
}

export interface BiosSystemSetupOptions {
  folders?: LibraryFolderOptions;
  signal?: AbortSignal;
  log?: (message: string) => void;
  onEvent?: (event: SetupEvent) => void;
  onUnlockRequired?: (required: boolean) => void;
}

/** Runs one selected system after the base setup: installs its emulator through
 * Obtainium, then imports the picked files through the emulator's native
 * configuration. */
export async function setupBiosSystem(
  device: DeviceTransport, abi: Abi, run: BiosSystemRun, options: BiosSystemSetupOptions = {},
): Promise<void> {
  const platform = libraryPlatform(run.platformId);
  const stage = biosSystemStage(run.platformId);
  const { signal, log = () => {}, onEvent } = options;
  const emit = (event: Omit<SetupEvent, "stage">): void => onEvent?.({ ...event, stage });

  const expected = [...new Set(run.unmatched.map((entry) => entry.expected))].join(" ");
  if (run.unmatched.length) throw new Error(`Expected: ${expected}`);
  if (!run.files.length && run.platformId !== "nds") throw new Error(`No BIOS files were chosen for ${platform.name}.`);
  if (biosSystemRunIncomplete(run)) throw new Error("DSi setup also requires your own DS BIOS and firmware files.");

  emit({ status: "running", message: `Setting up ${platform.emulator}…` });
  await installEmulatorViaObtainium(device, run.platformId, abi, {
    signal,
    log,
    reportStatus(message, status) {
      if (status?.unlockRequired !== undefined) options.onUnlockRequired?.(status.unlockRequired);
      emit({ status: "running", message });
    },
  });
  let result: EmulatorConfigurationResult | undefined;
  const groups = [...run.groups];
  if (run.platformId === "nds" && !run.files.length) groups.push({ slot: "ds", files: [] });
  for (const { slot, files } of groups) {
    checkAbort(signal);
    emit({ status: "running", message: files.length
      ? `Importing ${platform.emulator}'s support files…`
      : "Configuring melonDS with FreeBIOS…" });
    result = await configureEmulator(device, run.platformId, files, {
      folders: options.folders,
      signal,
      onStatus: (message) => emit({ status: "running", message }),
      onUnlockRequired: (required) => options.onUnlockRequired?.(required),
    });
    checkAbort(signal);
    if (run.platformId === "nds" && (slot === "ds" || slot === "dsi")) {
      if (!melonDsConsoleReady(result, slot === "ds" ? "DS" : "DSi")
        || files.length > 0 && (!("dsBios" in result) || result.dsBios !== "accepted" || !result.customBios)) {
        throw new Error(`melonDS's ${slot === "ds" ? "DS" : "DSi"} files and game folder could not be verified. Setup stopped before the next emulator.`);
      }
    }
  }
  if (!result || !emulatorConfigurationReady(result)) {
    throw new Error(`${platform.emulator}'s setup is incomplete. Setup stopped before the next emulator; finish its configuration and retry.`);
  }
  log(`Configured ${platform.name} through ${platform.emulator}.`);
  // The configuration launches the emulator; leave the home screen forward.
  emit({ status: "running", message: "Returning to Android's home screen…" });
  const user = await readAndroidUser(device, signal);
  checkActivityStart(await device.shell(shellCommand(
    "am", "start", "--user", String(user), "-W", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.HOME",
  )));
  checkAbort(signal);
  log("Returned to Android's home screen.");
}
