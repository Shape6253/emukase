import type { LibraryFolderOptions } from "./workspace";

export interface EmulatorConfigurationOptions {
  folders?: LibraryFolderOptions;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
  onProgress?: (bytes: number, total: number) => void;
  onUnlockRequired?: (required: boolean) => void;
  onNativeInstallPhase?: (installing: boolean) => void;
}

export type ConfigurationItemState = "accepted" | "missing" | "unverified";
