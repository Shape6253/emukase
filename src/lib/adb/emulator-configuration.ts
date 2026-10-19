import { configureEden, verifyEden, type EdenConfigurationResult } from "./eden";
import { configureMelonDs, verifyMelonDs, type MelonDsConfigurationResult } from "./melonds";
import { configureArmsx2, verifyArmsx2, type Armsx2ConfigurationResult } from "./armsx2";
import { configureVita3k, verifyVita3k, type Vita3kConfigurationResult } from "./vita3k";
import { DOLPHIN_GC_ADAPTER, DOLPHIN_WII_ADAPTER } from "./dolphin";
import { configurePpsspp, verifyPpsspp } from "./ppsspp";
import { configureAzahar, verifyAzahar } from "./azahar";
import type { GameFolderConfigurationResult } from "./game-folder-configuration";
import type { EmulatorConfigurationOptions } from "./emulator-configuration-types";
import type { DeviceTransport } from "./transport";
import type { LibraryFolderOptions } from "./workspace";

export type { EmulatorConfigurationOptions } from "./emulator-configuration-types";
export type EmulatorConfigurationResult =
  EdenConfigurationResult | MelonDsConfigurationResult | Armsx2ConfigurationResult | Vita3kConfigurationResult
  | GameFolderConfigurationResult;

export interface EmulatorConfigurationCheckRequest {
  id: number;
  inspect: boolean;
}

const sessionResults = new WeakMap<DeviceTransport, Map<string, Map<string, EmulatorConfigurationResult>>>();

function resultKey(folders?: LibraryFolderOptions): string {
  return JSON.stringify([folders?.libraryFolder, folders?.romsFolder, folders?.biosFolder]);
}

export function cachedEmulatorConfiguration(device: DeviceTransport, platformId: string, folders?: LibraryFolderOptions): EmulatorConfigurationResult | undefined {
  const result = sessionResults.get(device)?.get(platformId)?.get(resultKey(folders));
  return result ? { ...result } : undefined;
}

export function rememberEmulatorConfiguration(device: DeviceTransport, platformId: string, result: EmulatorConfigurationResult, folders?: LibraryFolderOptions): void {
  let results = sessionResults.get(device);
  if (!results) {
    results = new Map();
    sessionResults.set(device, results);
  }
  let platformResults = results.get(platformId);
  if (!platformResults) {
    platformResults = new Map();
    results.set(platformId, platformResults);
  }
  platformResults.set(resultKey(folders), { ...result });
}

export function forgetEmulatorConfiguration(device: DeviceTransport, platformId: string): void {
  sessionResults.get(device)?.delete(platformId);
}

interface EmulatorConfigurationAdapter {
  configure: (device: DeviceTransport, files: readonly File[], options: EmulatorConfigurationOptions) => Promise<EmulatorConfigurationResult>;
  verify: (device: DeviceTransport, options: EmulatorConfigurationOptions) => Promise<EmulatorConfigurationResult>;
}

const adapters: Readonly<Record<string, EmulatorConfigurationAdapter>> = {
  switch: { configure: configureEden, verify: verifyEden },
  nds: { configure: configureMelonDs, verify: verifyMelonDs },
  ps2: { configure: configureArmsx2, verify: verifyArmsx2 },
  psvita: { configure: configureVita3k, verify: verifyVita3k },
  psp: { configure: configurePpsspp, verify: verifyPpsspp },
  gc: DOLPHIN_GC_ADAPTER,
  wii: DOLPHIN_WII_ADAPTER,
  n3ds: { configure: configureAzahar, verify: verifyAzahar },
};

export function supportsEmulatorConfiguration(platformId: string): boolean {
  return Object.hasOwn(adapters, platformId);
}

function adapterFor(platformId: string): EmulatorConfigurationAdapter {
  if (!supportsEmulatorConfiguration(platformId)) throw new Error("Automatic configuration is not available for this platform yet.");
  const adapter = adapters[platformId];
  if (!adapter) throw new Error("The emulator configuration adapter is unavailable.");
  return adapter;
}

export async function configureEmulator(
  device: DeviceTransport, platformId: string, files: readonly File[], options: EmulatorConfigurationOptions = {},
): Promise<EmulatorConfigurationResult> {
  forgetEmulatorConfiguration(device, platformId);
  const result = await adapterFor(platformId).configure(device, files, options);
  options.signal?.throwIfAborted();
  rememberEmulatorConfiguration(device, platformId, result, options.folders);
  return result;
}

export async function verifyEmulatorConfiguration(
  device: DeviceTransport, platformId: string, options: EmulatorConfigurationOptions = {},
): Promise<EmulatorConfigurationResult> {
  sessionResults.get(device)?.get(platformId)?.delete(resultKey(options.folders));
  const result = await adapterFor(platformId).verify(device, options);
  options.signal?.throwIfAborted();
  rememberEmulatorConfiguration(device, platformId, result, options.folders);
  return result;
}
