import type { ConfigurationItemState, EmulatorConfigurationOptions } from "./emulator-configuration-types";

export const RETROHRAI_PACKAGE = "com.retrohrai.launcher";

export interface RetroHraiSetupOptions extends Pick<EmulatorConfigurationOptions, "folders" | "signal" | "onStatus" | "onUnlockRequired"> {
  log?: (message: string) => void;
  /** Shared Library platform IDs; omitted means supported installed emulators. */
  platformIds?: readonly string[];
}

export interface RetroHraiPlatformConfiguration {
  platformId: string;
  emulatorPackage: string;
  coreId?: string;
  playerId: string;
  romDirectory: string;
  state: ConfigurationItemState;
  player: ConfigurationItemState;
}

export interface RetroHraiConfigurationResult {
  packageName: typeof RETROHRAI_PACKAGE;
  version: string;
  setupComplete: boolean;
  dataDirectory: string;
  romDirectory: string;
  artworkFolder: ConfigurationItemState;
  defaultGamesFolder: ConfigurationItemState;
  library: ConfigurationItemState;
  homeChanged: false;
  /** Native backups expose ROM roots, but omit individual platform folder links. */
  platformFolders: "not-exported";
  profilePath?: string;
  backupPath?: string;
  platforms: readonly RetroHraiPlatformConfiguration[];
  gameplayVerified: false;
}
