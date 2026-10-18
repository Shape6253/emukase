import { sha256 } from "@noble/hashes/sha2.js";
import type { RetroHraiPlatformPlan } from "./retrohrai-platforms";

export interface RetroHraiSavedEmulator {
  platformKey: string;
  emulatorPackage: string;
  coreName?: string;
  playerUniqueId?: string;
  isPrimary: boolean;
}

export interface RetroHraiSavedProfile {
  version: string;
  platforms: readonly { internalName: string; displayName: string }[];
  emulators: readonly RetroHraiSavedEmulator[];
  artworkUri?: string;
  romRoots: readonly string[];
  preservedFingerprint: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProfile(text: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch { throw new SyntaxError("RetroHrai's JSON backup is incomplete or invalid."); }
}

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new Error("RetroHrai's backup nesting exceeds its limit.");
  if (Array.isArray(value)) return value.map((entry: unknown) => canonical(entry, depth + 1))
    .sort((left: unknown, right: unknown) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], depth + 1)]));
  return value;
}

function fingerprint(value: unknown): string {
  return Array.from(sha256(new TextEncoder().encode(JSON.stringify(canonical(value)))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Read only setup evidence; unrelated preferences, accounts and game metadata stay opaque. */
export function readRetroHraiProfile(text: string): RetroHraiSavedProfile {
  if (!text || text.length > 16_777_216) throw new Error("RetroHrai's configuration export has an unsupported size.");
  const value = parseProfile(text);
  if (!record(value) || !record(value.meta) || value.meta.schemaVersion !== 1 || typeof value.meta.appVersion !== "string"
    || !Array.isArray(value.platforms) || !Array.isArray(value.platformEmulators) || !record(value.nonPortableHints)) {
    throw new Error("This RetroHrai backup schema is unsupported.");
  }
  const platforms = value.platforms.map((entry: unknown) => {
    if (!record(entry) || typeof entry.internalName !== "string" || !/^[\w.-]+$/.test(entry.internalName)
      || typeof entry.displayName !== "string" || !entry.displayName.trim()) throw new Error("RetroHrai exported an invalid platform.");
    return { internalName: entry.internalName, displayName: entry.displayName };
  });
  if (new Set(platforms.map((platform) => platform.internalName)).size !== platforms.length) throw new Error("RetroHrai exported duplicate platform identities.");
  const emulators = value.platformEmulators.map((entry: unknown): RetroHraiSavedEmulator => {
    if (!record(entry) || typeof entry.platformKey !== "string" || typeof entry.emulatorPackage !== "string"
      || !/^[A-Za-z][\w]*(?:\.[\w]+)+$/.test(entry.emulatorPackage) || typeof entry.isPrimary !== "boolean"
      || entry.coreName !== undefined && entry.coreName !== null && (typeof entry.coreName !== "string" || !/^[a-z0-9_]+$/.test(entry.coreName))
      || entry.playerUniqueId !== undefined && entry.playerUniqueId !== null && typeof entry.playerUniqueId !== "string") {
      throw new Error("RetroHrai exported an invalid emulator selection.");
    }
    return { platformKey: entry.platformKey, emulatorPackage: entry.emulatorPackage, isPrimary: entry.isPrimary,
      coreName: typeof entry.coreName === "string" ? entry.coreName : undefined,
      playerUniqueId: typeof entry.playerUniqueId === "string" ? entry.playerUniqueId : undefined };
  });
  const roots = value.nonPortableHints.romRoots;
  const artwork = value.nonPortableHints.assetsBasePath;
  if (!Array.isArray(roots) || roots.some((root: unknown) => typeof root !== "string")
    || artwork !== undefined && artwork !== null && typeof artwork !== "string") throw new Error("RetroHrai exported invalid storage hints.");
  return { version: value.meta.appVersion, platforms, emulators, romRoots: roots,
    artworkUri: typeof artwork === "string" ? artwork : undefined,
    preservedFingerprint: fingerprint(Object.fromEntries(Object.entries(value).filter(([key]) => !["meta", "platformEmulators"].includes(key)))) };
}

export function assertRetroHraiPreserved(before: RetroHraiSavedProfile, after: RetroHraiSavedProfile, plans: readonly RetroHraiPlatformPlan[]): void {
  const targets = new Set(plans.map((plan) => plan.platformKey));
  if (before.preservedFingerprint !== after.preservedFingerprint || fingerprint(before.emulators.filter((entry) => !targets.has(entry.platformKey)))
    !== fingerprint(after.emulators.filter((entry) => !targets.has(entry.platformKey)))) {
    throw new Error("RetroHrai's unrelated configuration changed during import. The original native backup has been kept.");
  }
}

/** Overwrite is allowed only for the narrow file shape generated below. */
export function validateRetroHraiImport(text: string): void {
  if (!text || text.length > 2_097_152) throw new Error("RetroHrai's emulator import has an invalid size.");
  const value = parseProfile(text);
  if (!record(value) || !record(value.meta) || value.meta.schemaVersion !== 1 || !record(value.settings)
    || Object.keys(value.settings).length !== 1 || !Array.isArray(value.settings.preferences) || value.settings.preferences.length
    || !record(value.nonPortableHints) || Object.keys(value.nonPortableHints).some((key) => !["romRoots", "ignoredRomRoots"].includes(key))
    || Object.values(value.nonPortableHints).some((entry) => !Array.isArray(entry) || entry.length)
    || ["platforms", "androidAppOverrides", "collectionMemberships", "collections", "romMetadata", "userPlayers"].some((key) =>
      !Array.isArray(value[key]) || value[key].length) || !Array.isArray(value.platformEmulators) || !value.platformEmulators.length) {
    throw new Error("Only an emulator-only RetroHrai profile can be applied automatically.");
  }
  const allowed = ["meta", "settings", "nonPortableHints", "platforms", "platformEmulators", "androidAppOverrides", "collectionMemberships", "collections", "romMetadata", "userPlayers"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("RetroHrai's emulator import contains unsupported sections.");
  const counts = new Map<string, number>();
  for (const entry of value.platformEmulators) {
    if (!record(entry) || typeof entry.platformKey !== "string" || !/^[a-z0-9_]+$/.test(entry.platformKey)
      || typeof entry.emulatorPackage !== "string" || !/^[A-Za-z][\w]*(?:\.[\w]+)+$/.test(entry.emulatorPackage)
      || typeof entry.isPrimary !== "boolean" || entry.coreName !== undefined && (typeof entry.coreName !== "string" || !/^[a-z0-9_]+$/.test(entry.coreName))
      || entry.playerUniqueId !== undefined && typeof entry.playerUniqueId !== "string") throw new Error("Invalid RetroHrai import player.");
    counts.set(entry.platformKey, (counts.get(entry.platformKey) ?? 0) + Number(entry.isPrimary));
  }
  if ([...counts.values()].some((count) => count !== 1)) throw new Error("RetroHrai requires one primary emulator per imported system.");
}

export function retroHraiPlayerSaved(profile: RetroHraiSavedProfile, plan: RetroHraiPlatformPlan): boolean {
  const primary = profile.emulators.filter((entry) => entry.platformKey === plan.platformKey && entry.isPrimary);
  return primary.length === 1 && primary[0]?.emulatorPackage === plan.emulatorPackage
    && primary[0]?.playerUniqueId === plan.playerId && primary[0]?.coreName === plan.coreId;
}

/** Native Overwrite replaces emulator groups included in this file. Preserve their
 * alternative players; leave preferences, platform properties and game data out. */
export function createRetroHraiProfile(profile: RetroHraiSavedProfile, plans: readonly RetroHraiPlatformPlan[]): string {
  if (!profile.version.trim() || !plans.length || new Set(plans.map((plan) => plan.platformKey)).size !== plans.length) {
    throw new Error("RetroHrai's import requires a version and distinct platforms.");
  }
  const emulators = plans.flatMap((plan) => {
    if (!profile.platforms.some((entry) => entry.internalName === plan.platformKey)) {
      throw new Error(`Add RetroHrai's ${plan.platformKey} system before importing its emulator selection.`);
    }
    const alternatives = profile.emulators.filter((entry) => entry.platformKey === plan.platformKey
      && !(entry.emulatorPackage === plan.emulatorPackage && entry.coreName === plan.coreId)).map((entry) => ({ ...entry, isPrimary: false }));
    return [...alternatives, { platformKey: plan.platformKey, emulatorPackage: plan.emulatorPackage,
      coreName: plan.coreId, playerUniqueId: plan.playerId, isPrimary: true }];
  });
  const text = JSON.stringify({
    meta: { schemaVersion: 1, appVersion: profile.version, createdAt: Date.now(), includeScrapedMetadata: false },
    nonPortableHints: { romRoots: [], ignoredRomRoots: [] }, settings: { preferences: [] }, platforms: [], platformEmulators: emulators,
    androidAppOverrides: [], collectionMemberships: [], collections: [], romMetadata: [], userPlayers: [],
  });
  validateRetroHraiImport(text);
  return text;
}
