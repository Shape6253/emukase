import { configureEden, repairEden, verifyEden, type EdenConfigurationResult } from "./eden";
import { configureMelonDs, repairMelonDs, verifyMelonDs, type MelonDsConfigurationResult } from "./melonds";
import { configureArmsx2, repairArmsx2, verifyArmsx2, type Armsx2ConfigurationResult } from "./armsx2";
import type { EmulatorConfigurationOptions } from "./emulator-configuration-types";
import type { DeviceTransport } from "./transport";
import type { LibraryFolderOptions } from "./workspace";

export type { EmulatorConfigurationOptions } from "./emulator-configuration-types";
export type EmulatorConfigurationResult = EdenConfigurationResult | MelonDsConfigurationResult | Armsx2ConfigurationResult;

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
  repair: (device: DeviceTransport, options: EmulatorConfigurationOptions) => Promise<EmulatorConfigurationResult>;
  verify: (device: DeviceTransport, options: EmulatorConfigurationOptions) => Promise<EmulatorConfigurationResult>;
}

const adapters: Readonly<Record<string, EmulatorConfigurationAdapter>> = {
  switch: { configure: configureEden, repair: repairEden, verify: verifyEden },
  nds: { configure: configureMelonDs, repair: repairMelonDs, verify: verifyMelonDs },
  ps2: { configure: configureArmsx2, repair: repairArmsx2, verify: verifyArmsx2 },
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

export async function repairEmulatorConfiguration(
  device: DeviceTransport, platformId: string, options: EmulatorConfigurationOptions = {},
): Promise<EmulatorConfigurationResult> {
  forgetEmulatorConfiguration(device, platformId);
  const result = await adapterFor(platformId).repair(device, options);
  options.signal?.throwIfAborted();
  rememberEmulatorConfiguration(device, platformId, result, options.folders);
  return result;
}
