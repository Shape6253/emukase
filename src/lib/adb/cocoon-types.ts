import type { EmulatorConfigurationOptions, ConfigurationItemState } from "./emulator-configuration-types";

export interface CocoonSetupOptions extends Pick<EmulatorConfigurationOptions, "folders" | "signal" | "onStatus" | "onUnlockRequired"> {
  log?: (message: string) => void;
}

export interface CocoonConfigurationResult {
  setupComplete: boolean;
  system: CocoonSystemConfiguration;
  /** The native root setting exposes only its basename, so exact verification may be unavailable. */
  defaultGamesFolder: ConfigurationItemState;
  library: ConfigurationItemState;
  romDirectory: string;
}

export interface CocoonSystemConfiguration {
  language: ConfigurationItemState;
  screenMode: ConfigurationItemState;
  physicalDisplays: number;
  singleScreen: boolean | null;
}
