import type { AndroidPackage } from "./android-package";
import type { EmulatorConfigurationOptions } from "./emulator-configuration-types";
import type { EmulatorUiContext } from "./emulator-ui";
import type { WorkspacePaths } from "./workspace";

export const ESDE_PACKAGE = "org.es_de.frontend";

export interface EsdeRecoveryRecord {
  schema: 1;
  token: string;
  user: number;
  stage: string;
  phase: "intent" | "verified" | "uncertain";
  details: Readonly<Record<string, string | number | boolean>>;
}

export interface EsdeConfigurationOptions extends EmulatorConfigurationOptions {
  controllerNavigationVerified?: boolean;
  /** Connect the installed Library emulators using this ES-DE installation's commands. */
  connectLibrary?: boolean;
  /** Optional real installed-app shortcuts, never dummy ROMs. */
  createAppMenu?: boolean;
  /** Additional host-side persistence; device-side recovery is always written first. */
  onRecovery?: (record: EsdeRecoveryRecord) => Promise<void>;
}

export interface EsdeContext extends EmulatorUiContext {
  workspace: WorkspacePaths;
  launcher: string;
  installed: AndroidPackage;
  sdk: number;
  home: string;
  options: EsdeConfigurationOptions;
}

export interface EsdeFileChange {
  path: string;
  original: string | undefined;
  applied: string;
  backupPath?: string;
}

export interface EsdeConfigurationResult {
  packageName: typeof ESDE_PACKAGE;
  version: string;
  dataDirectory: string;
  romDirectory: string;
  onboarding: "complete";
  directoryAccess: "persisted-read-write";
  settings: "verified-after-restart";
  library: "loaded" | "empty";
  homeChanged: false;
  changedFiles: readonly string[];
  backups: readonly string[];
  /** Configuration is not an end-to-end game/controller test. */
  gameplayVerified: false;
}
