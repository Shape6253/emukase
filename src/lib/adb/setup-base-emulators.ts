import type { Abi } from "./catalog";
import { configureEmulatorLibraries } from "./emulator-configuration";
import type { EmulatorConfigurationOptions } from "./emulator-configuration-types";
import { emulatorConfigurationReady } from "../emulator-configuration-state";
import { libraryPlatform } from "./library-catalog";
import { installEmulatorViaObtainium } from "./obtainium-install";
import { checkAbort, type SetupEvent, type SetupStage } from "./setup-events";
import type { DeviceTransport } from "./transport";

export interface BaseEmulatorSetupOptions extends Pick<EmulatorConfigurationOptions, "folders" | "signal" | "onUnlockRequired"> {
  log?: (message: string) => void;
  onEvent?: (event: SetupEvent) => void;
}

/** An installed APK is not a completed setup. Configure every selected system
 * (including both Dolphin libraries) before releasing the device to the next app. */
export async function setupBaseEmulator(
  device: DeviceTransport, abi: Abi, platformIds: readonly string[], stage: SetupStage,
  options: BaseEmulatorSetupOptions = {},
): Promise<void> {
  const platforms = platformIds.map(libraryPlatform);
  const first = platforms[0];
  if (!first || platforms.some((platform) => platform.emulator !== first.emulator || platform.requirements.length)) {
    throw new Error("Base emulator setup requires systems from one emulator without support-file requirements.");
  }
  const emit = (event: Omit<SetupEvent, "stage">): void => options.onEvent?.({ ...event, stage });
  try {
    checkAbort(options.signal);
    emit({ status: "running", message: `Setting up ${first.emulator}…` });
    await installEmulatorViaObtainium(device, first.id, abi, {
      signal: options.signal,
      log: options.log,
      reportStatus(message, status) {
        if (status?.unlockRequired !== undefined) options.onUnlockRequired?.(status.unlockRequired);
        emit({ status: "running", message });
      },
    });
    emit({ status: "running", message: `Configuring ${first.emulator}'s game folders…` });
    const results = await configureEmulatorLibraries(device, platformIds, {
      folders: options.folders,
      signal: options.signal,
      onStatus: (message) => emit({ status: "running", message }),
      onUnlockRequired: options.onUnlockRequired,
    });
    for (const { platformId, result } of results) {
      const platform = libraryPlatform(platformId);
      checkAbort(options.signal);
      if (!emulatorConfigurationReady(result)) {
        throw new Error(`${platform.emulator}'s ${platform.name} setup could not be verified. Setup stopped before the next emulator.`);
      }
      options.log?.(`Configured ${platform.name} through ${platform.emulator}.`);
    }
    checkAbort(options.signal);
    emit({ status: "complete" });
  } catch (error) {
    emit({ status: "failed", message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    options.onUnlockRequired?.(false);
  }
}
