import type { LibraryFolderOptions } from "./workspace";
import type { EmulatorSupportPreparation } from "./emulator-support";

export interface EmulatorConfigurationOptions {
  folders?: LibraryFolderOptions;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
  onProgress?: (bytes: number, total: number) => void;
  onUnlockRequired?: (required: boolean) => void;
  onNativeInstallPhase?: (installing: boolean) => void;
  /** Read-only inspection: never launch the automatic connection flow. */
  inspectOnly?: boolean;
  /** Completed or in-flight support uploads owned by this setup run. */
  supportPreparation?: EmulatorSupportPreparation;
}

export type ConfigurationItemState = "accepted" | "missing" | "unverified";
