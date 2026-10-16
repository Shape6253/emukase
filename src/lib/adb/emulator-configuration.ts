import { configureEden, verifyEden, type EdenConfigurationOptions, type EdenConfigurationResult } from "./eden";
import type { DeviceTransport } from "./transport";

export type EmulatorConfigurationOptions = EdenConfigurationOptions;
export type EmulatorConfigurationResult = EdenConfigurationResult;

interface EmulatorConfigurationAdapter {
  configure: (device: DeviceTransport, files: readonly File[], options: EmulatorConfigurationOptions) => Promise<EmulatorConfigurationResult>;
  verify: (device: DeviceTransport, options: EmulatorConfigurationOptions) => Promise<EmulatorConfigurationResult>;
}

const adapters: Readonly<Record<string, EmulatorConfigurationAdapter>> = {
  switch: { configure: configureEden, verify: verifyEden },
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
  return adapterFor(platformId).configure(device, files, options);
}

export async function verifyEmulatorConfiguration(
  device: DeviceTransport, platformId: string, options: EmulatorConfigurationOptions = {},
): Promise<EmulatorConfigurationResult> {
  return adapterFor(platformId).verify(device, options);
}
