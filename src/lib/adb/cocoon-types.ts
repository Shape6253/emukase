import type { EmulatorConfigurationOptions, ConfigurationItemState } from "./emulator-configuration-types";

export interface CocoonSetupOptions extends Pick<EmulatorConfigurationOptions, "folders" | "signal" | "onStatus" | "onUnlockRequired"> {
  log?: (message: string) => void;
  /** Library platform IDs to configure; omitted means the supported installed emulators. */
  platformIds?: readonly string[];
}

export interface CocoonPlatformConfiguration {
  platformId: string;
  /** Accepted means the saved folder and default-player selection were observed. */
  state: ConfigurationItemState;
  folder: ConfigurationItemState;
  player: ConfigurationItemState;
  emulatorPackage: string;
  coreId?: string;
  playerId?: string;
  romDirectory: string;
}

export interface CocoonConfigurationResult {
  setupComplete: boolean;
  system: CocoonSystemConfiguration;
  /** The native root setting exposes only its basename, so exact verification may be unavailable. */
  defaultGamesFolder: ConfigurationItemState;
  library: ConfigurationItemState;
  romDirectory: string;
  platforms: readonly CocoonPlatformConfiguration[];
}

export interface CocoonSystemConfiguration {
  language: ConfigurationItemState;
  screenMode: ConfigurationItemState;
  physicalDisplays: number;
  singleScreen: boolean | null;
}
