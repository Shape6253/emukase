import { scopeAndroidLaunchArguments, scopeRetroArchLaunchArguments } from "./android-launch-arguments";
import { libraryPlatform } from "./library-catalog";
import { downloadText } from "./download";

// Only upstream filenames live here; systems, packages and core choices belong to the shared catalog.
const PLATFORMS: Readonly<Record<string, string>> = {
  nes: "NintendoEntertainmentSystem", snes: "NintendoSNES",
  gb: "NintendoGameBoy", gbc: "NintendoGameBoyColor", gba: "NintendoGameBoyAdvance",
  megadrive: "SegaGenesis", mastersystem: "SegaMasterSystem", gamegear: "SegaGameGear",
  megacd: "SegaCD", sega32x: "Sega32X", pcengine: "TurboGrafx16", pcenginecd: "TurboGrafxCD",
  psx: "SonyPlayStation", arcade: "ArcadeFinalBurnNeo", neogeo: "NeoGeo", psp: "SonyPSP",
  gc: "NintendoGameCube", wii: "NintendoWii", n3ds: "Nintendo3DS", nds: "NintendoDS",
  ps2: "SonyPlayStation2", switch: "NintendoSwitch", psvita: "SonyPSVita",
};

export interface DaijishoProfile {
  emulatorPackage: string;
  coreId?: string;
  user: number;
  name: string;
  shortname: string;
  arguments: string;
  regex: string;
  platformRegex: string;
  component: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Daijishō platform definition.");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 65_536 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) {
    throw new Error("Invalid Daijishō platform field.");
  }
  return value;
}

export function validateDaijishoPlatformIds(ids: readonly string[] | undefined): void {
  if (ids === undefined) return;
  if (!Array.isArray(ids) || !ids.length || ids.length > Object.keys(PLATFORMS).length || new Set(ids).size !== ids.length) {
    throw new Error("Select distinct Library platforms for Daijishō.");
  }
  for (const id of ids) {
    libraryPlatform(id);
    if (!Object.hasOwn(PLATFORMS, id)) throw new Error(`Daijishō has no platform definition for ${id}.`);
  }
}

/** Validate upstream routing for the native Pegasus import. */
export function daijishoProfile(
  definition: unknown, platformId: string, emulatorPackage: string, user: number, coreId?: string,
): DaijishoProfile {
  validateDaijishoPlatformIds([platformId]);
  const system = libraryPlatform(platformId);
  if (!system.emulatorPackages.includes(emulatorPackage) || (system.cores.length > 0
    ? !coreId || !system.cores.includes(coreId) : coreId !== undefined)) throw new Error("Daijishō emulator/core does not match the Library platform.");
  const source = object(definition);
  const platform = object(source.platform);
  if (!Number.isSafeInteger(source.databaseVersion) || Number(source.databaseVersion) < 1
    || !Array.isArray(source.playerList) || source.playerList.length > 256) throw new Error("Invalid Daijishō portable schema.");
  for (const key of ["name", "uniqueId", "shortname", "acceptedFilenameRegex"]) text(platform[key]);
  if (!Array.isArray(platform.scraperSourceList) || platform.scraperSourceList.some((entry) => typeof entry !== "string")
    || (platform.retroAchievementsConsoleIdList !== undefined && (!Array.isArray(platform.retroAchievementsConsoleIdList)
      || platform.retroAchievementsConsoleIdList.some((entry) => !Number.isSafeInteger(entry) || entry < 0)))) {
    throw new Error("Invalid Daijishō platform metadata.");
  }
  const players = source.playerList.map(object).filter((player) => {
    const args = text(player.amStartArguments);
    const component = /(?:^|\s)-n\s+([\w.]+)\/([\w.$]+)(?=\s|$)/.exec(args);
    return component?.[1] === emulatorPackage && (!coreId
      || /(?:^|\s)(?:-e|--es)\s+LIBRETRO\s+([\w]+)(?=\s|$)/.exec(args)?.[1] === coreId);
  });
  const selected = players[0];
  if (players.length !== 1 || !selected) throw new Error(`Daijishō's upstream definition has no unique player for ${system.name} / ${coreId ?? emulatorPackage}.`);
  const sourceArgs = text(selected.amStartArguments);
  const args = coreId ? scopeRetroArchLaunchArguments(sourceArgs, emulatorPackage, user) : scopeAndroidLaunchArguments(sourceArgs, user);
  const rawComponent = /(?:^|\s)-n\s+([\w.]+)\/([\w.$]+)(?=\s|$)/.exec(args);
  const activity = rawComponent?.[2];
  if (!activity) throw new Error("Daijishō's player does not expose an explicit Android activity.");
  text(selected.uniqueId);
  return { emulatorPackage, coreId, user, name: text(platform.name), shortname: text(platform.shortname),
    arguments: args, regex: text(selected.acceptedFilenameRegex), platformRegex: text(platform.acceptedFilenameRegex),
    component: `${emulatorPackage}/${activity.startsWith(".") ? emulatorPackage + activity : activity}` };
}

/** Public upstream JSON is CORS-enabled; no APK proxy or release/version pin is needed. */
export async function loadDaijishoProfile(platformId: string, emulatorPackage: string, user: number, coreId?: string, signal?: AbortSignal): Promise<DaijishoProfile> {
  validateDaijishoPlatformIds([platformId]);
  const url = `https://raw.githubusercontent.com/TapiocaFox/Daijishou/main/platforms/${PLATFORMS[platformId]}.json`;
  const json = await downloadText({ requestUrl: (value) => value }, url, { signal, maxBytes: 262_144 });
  return daijishoProfile(JSON.parse(json) as unknown, platformId, emulatorPackage, user, coreId);
}
