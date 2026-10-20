import { selectCores, type Abi } from "./catalog";
import { retroArchPackageName } from "./emulators";
import { LIBRARY_PLATFORMS, libraryPlatform } from "./library-catalog";
import { scopeAndroidLaunchArguments, scopeRetroArchLaunchArguments } from "./android-launch-arguments";
import type { RetroHraiUserPlayer } from "./retrohrai-players";
import { RETROHRAI_PACKAGE } from "./retrohrai-types";
import { shellCommand, type DeviceTransport } from "./transport";

export interface RetroHraiPlatformPlan {
  platformId: string;
  platformKey: string;
  emulatorPackage: string;
  coreId?: string;
  playerId: string;
  userPlayer?: RetroHraiUserPlayer;
}

const ASSETS: Readonly<Record<string, string>> = {
  nes: "NintendoEntertainmentSystem", snes: "SuperNintendoEntertainmentSystem", gb: "NintendoGameBoy",
  gbc: "NintendoGameBoyColor", gba: "NintendoGameBoyAdvance", megadrive: "SegaGenesis", mastersystem: "SegaMasterSystem",
  gamegear: "SegaGameGear", megacd: "SegaCD", sega32x: "Sega32X", pcengine: "PCEngine", pcenginecd: "TurboGrafxCD",
  psx: "SonyPlayStation", arcade: "ArcadeFinalBurnNeo", neogeo: "NeoGeo", psp: "PlayStationPortable", gc: "NintendoGameCube",
  wii: "NintendoWii", n3ds: "Nintendo3DS", nds: "NintendoDS", ps2: "SonyPlayStation2", switch: "NintendoSwitch", psvita: "SonyPSVita",
};

export function validateRetroHraiPlatformIds(platformIds: readonly string[] | undefined): void {
  if (platformIds === undefined) return;
  if (!Array.isArray(platformIds) || !platformIds.length || platformIds.length > LIBRARY_PLATFORMS.length
    || new Set(platformIds).size !== platformIds.length) throw new Error("Select distinct Library platforms for RetroHrai.");
  for (const id of platformIds) libraryPlatform(id);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve player IDs from this installation's own templates, never a copied player database. */
export function parseRetroHraiPlatformPlan(text: string, platformId: string, abi: Abi, user: number): RetroHraiPlatformPlan {
  const platform = libraryPlatform(platformId);
  if (!text || text.length > 262_144) throw new Error(`RetroHrai's ${platform.name} template has an invalid size.`);
  const value: unknown = JSON.parse(text);
  if (!record(value) || !record(value.platform) || !Array.isArray(value.playerList)
    || typeof value.platform.uniqueId !== "string" || !/^[a-z0-9_]+$/.test(value.platform.uniqueId)) {
    throw new Error(`RetroHrai's ${platform.name} template is invalid.`);
  }
  const core = platform.cores.length ? selectCores(abi).find((entry) => platform.cores.includes(entry.id)) : undefined;
  const emulatorPackage = core ? retroArchPackageName(abi) : platform.emulatorPackages[0];
  if (!emulatorPackage || platform.cores.length && !core) throw new Error(`No setup emulator is available for ${platform.name}.`);
  const players = value.playerList.filter((player: unknown) => {
    if (!record(player) || typeof player.uniqueId !== "string" || typeof player.amStartArguments !== "string") return false;
    const target = /(?:^|\s)-n\s+([\w.]+)\/[\w.$]+(?:\s|$)/.exec(player.amStartArguments)?.[1];
    const libretro = /(?:^|\s)(?:-e|--es)\s+LIBRETRO\s+([a-z0-9_]+)(?:\s|$)/.exec(player.amStartArguments)?.[1];
    return target === emulatorPackage && libretro === core?.id;
  });
  const player: unknown = players[0];
  if (players.length !== 1 || !record(player) || typeof player.uniqueId !== "string" || !/^[\w.-]+$/.test(player.uniqueId)) {
    throw new Error(`This RetroHrai installation does not expose an unambiguous ${platform.name} player for ${emulatorPackage}.`);
  }
  if (typeof player.amStartArguments !== "string") throw new Error("RetroHrai's player arguments are unavailable.");
  const args = core ? scopeRetroArchLaunchArguments(player.amStartArguments, emulatorPackage, user)
    : scopeAndroidLaunchArguments(player.amStartArguments, user);
  const plan: RetroHraiPlatformPlan = { platformId, platformKey: value.platform.uniqueId, emulatorPackage, coreId: core?.id, playerId: player.uniqueId };
  if (args !== player.amStartArguments) {
    if (typeof player.name !== "string" || !player.name.trim() || typeof player.acceptedFilenameRegex !== "string") {
      throw new Error("RetroHrai's player metadata is unavailable for a profile-local copy.");
    }
    plan.playerId = `custom.emukase.u${user}.${player.uniqueId}`;
    plan.userPlayer = { platformKey: plan.platformKey, uniqueId: plan.playerId, emulatorPackage,
      name: `Emukase: ${player.name} (Android ${user})`, amStartArguments: args, acceptedFilenameRegex: player.acceptedFilenameRegex };
  }
  return plan;
}

export async function readRetroHraiPlatformPlans(
  device: DeviceTransport, user: number, abi: Abi, packages: ReadonlySet<string>, platformIds?: readonly string[],
): Promise<readonly RetroHraiPlatformPlan[]> {
  validateRetroHraiPlatformIds(platformIds);
  const paths = (await device.shell(shellCommand("pm", "path", "--user", String(user), RETROHRAI_PACKAGE))).trim().split(/\r?\n/)
    .map((line) => /^package:(\/[^\r\n]+\.apk)$/.exec(line)?.[1]);
  const bases = paths.filter((path) => path?.endsWith("/base.apk"));
  const apk = paths.length === 1 ? paths[0] : bases.length === 1 ? bases[0] : undefined;
  if (!apk || paths.some((path) => !path)) throw new Error("RetroHrai's installed APK could not be located.");
  const ids = platformIds ?? LIBRARY_PLATFORMS.filter((platform) => platform.cores.length
    ? packages.has(retroArchPackageName(abi)) : platform.emulatorPackages.some((name) => packages.has(name))).map((platform) => platform.id);
  const plans: RetroHraiPlatformPlan[] = [];
  for (const id of ids) {
    const asset = Object.hasOwn(ASSETS, id) ? ASSETS[id] : undefined;
    if (!asset) throw new Error(`No RetroHrai template is supported for ${id}.`);
    const text = await device.shell(shellCommand("unzip", "-p", apk, `assets/platforms/${asset}.json`));
    plans.push(parseRetroHraiPlatformPlan(text, id, abi, user));
  }
  return plans;
}
