import { emulatorConfigurationReady } from "../emulator-configuration-state";
import type { EmulatorConfigurationResult } from "./emulator-configuration";
import type { DeviceTransport } from "./transport";
import { normalizeStorageFolder, ROMS_FOLDER, SUPPORT_FOLDER, WORKSPACE_FOLDER, type LibraryFolderOptions } from "./workspace";

const deviceSerials = new WeakMap<DeviceTransport, string>();
const sessionResults = new WeakMap<DeviceTransport, Map<string, Map<string, EmulatorConfigurationResult>>>();

/** Associate reconnectable device identity with the transport used by setup. */
export function registerEmulatorConfigurationDevice(device: DeviceTransport, serial: string): void {
  if (serial) deviceSerials.set(device, serial);
}

function resultKey(folders?: LibraryFolderOptions): string {
  const library = normalizeStorageFolder(folders?.libraryFolder ?? WORKSPACE_FOLDER);
  return JSON.stringify([
    library,
    normalizeStorageFolder(folders?.romsFolder ?? `${library}/${ROMS_FOLDER}`),
    normalizeStorageFolder(folders?.biosFolder ?? `${library}/${SUPPORT_FOLDER}`),
  ]);
}

function storageKey(device: DeviceTransport, platformId: string): string | undefined {
  const serial = deviceSerials.get(device);
  const user = device.androidUser;
  if (!serial || user === undefined || !Number.isSafeInteger(user) || user < 0) return undefined;
  return `emukase.device.emulatorSetup.v2.${encodeURIComponent(serial)}.${user}.${encodeURIComponent(platformId)}`;
}

function isItemState(value: unknown): boolean {
  return value === "accepted" || value === "missing" || value === "unverified";
}

function isResult(platformId: string, value: unknown): value is EmulatorConfigurationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (typeof result.contentVerified !== "boolean") return false;
  if (platformId === "psvita") {
    return isItemState(result.vitaFirmware) && isItemState(result.vitaFonts) && typeof result.setupComplete === "boolean";
  }
  if (result.library !== "accepted" && result.library !== "unverified") return false;
  switch (platformId) {
    case "nds":
      return isItemState(result.ds) && isItemState(result.dsBios) && isItemState(result.dsi)
        && typeof result.customBios === "boolean" && (result.consoleType === "DS" || result.consoleType === "DSi");
    case "switch":
      return isItemState(result.keys) && isItemState(result.firmware);
    case "ps2":
      return isItemState(result.bios) && typeof result.setupComplete === "boolean";
    case "psp":
    case "gc":
    case "wii":
    case "n3ds":
    case "xbox":
      return typeof result.setupComplete === "boolean";
    default:
      return false;
  }
}

function storedResults(key: string): Record<string, unknown> {
  const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function cachedEmulatorConfiguration(device: DeviceTransport, platformId: string, folders?: LibraryFolderOptions): EmulatorConfigurationResult | undefined {
  const folderKey = resultKey(folders);
  const result = sessionResults.get(device)?.get(platformId)?.get(folderKey);
  if (result) return { ...result };
  const key = storageKey(device, platformId);
  if (!key) return undefined;
  try {
    const stored = storedResults(key)[folderKey];
    return isResult(platformId, stored) && emulatorConfigurationReady(stored) ? { ...stored } : undefined;
  } catch {
    return undefined;
  }
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
  const folderKey = resultKey(folders);
  platformResults.set(folderKey, { ...result });
  const key = storageKey(device, platformId);
  if (!key) return;
  try {
    let stored: Record<string, unknown>;
    try { stored = storedResults(key); } catch { stored = {}; }
    if (emulatorConfigurationReady(result)) stored[folderKey] = result;
    else delete stored[folderKey];
    localStorage.setItem(key, JSON.stringify(stored));
  } catch {
    // Browser storage failures must not turn successful emulator setup into an error.
  }
}

/** Manual checks, configuration changes and a missing app invalidate prior success. */
export function forgetEmulatorConfiguration(device: DeviceTransport, platformId: string): void {
  sessionResults.get(device)?.delete(platformId);
  const key = storageKey(device, platformId);
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    // The current session can still check and configure the emulator.
  }
}
