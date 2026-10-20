import { selectCores, type Abi } from "./catalog";
import { retroArchPackageName } from "./emulators";
import { LIBRARY_PLATFORMS, libraryPlatform } from "./library-catalog";

export interface CocoonPlatformPlan {
  platformId: string;
  name: string;
  emulatorPackage: string;
  coreId?: string;
  playerId: string;
  playerName: string;
}

// Names and player IDs belong to Cocoon's public database, not its UI locale.
// https://github.com/inssekt/CocoonFE/tree/main/platforms
const RETROARCH: Readonly<Record<string, readonly [string, string]>> = {
  nes: ["Nintendo Entertainment System", "nes"],
  snes: ["Super Nintendo Entertainment System", "snes"],
  gb: ["Game Boy", "gb"],
  gbc: ["Game Boy Color", "gbc"],
  gba: ["Game Boy Advance", "gba"],
  megadrive: ["Sega Genesis", "genesis"],
  mastersystem: ["Sega Master System", "master"],
  gamegear: ["Sega Game Gear", "gamegear"],
  megacd: ["Sega CD", "segacd"],
  sega32x: ["Sega 32X", "sega32x"],
  pcengine: ["TurboGrafx-16", "tg16"],
  pcenginecd: ["TurboGrafx-CD", "tgcd"],
  psx: ["Sony PlayStation", "psx"],
  arcade: ["Arcade (FinalBurn Neo)", "fbneo"],
  neogeo: ["Neo Geo", "neogeo"],
};

const STANDALONE: Readonly<Record<string, readonly [string, string, string]>> = {
  psp: ["PlayStation Portable", "psp.org.ppsspp.ppsspp", "PPSSPP"],
  gc: ["GameCube", "gc.org.dolphinemu.dolphinemu", "Dolphin Emulator"],
  wii: ["Nintendo Wii", "wii.org.dolphinemu.dolphinemu", "Dolphin Emulator"],
  n3ds: ["Nintendo 3DS", "3ds.azaharnew", "Azahar (New)"],
  nds: ["Nintendo DS", "nds.me.magnum.melonds", "MelonDS"],
  ps2: ["Sony PlayStation 2", "ps2.com.armsx2", "ARMSX2 (Refresh)"],
  switch: ["Nintendo Switch", "switch.dev.eden.eden_emulator", "Eden"],
  psvita: ["Sony PS Vita", "psv.vita3k", "Vita3k"],
};

export function cocoonPlatformNames(plan: CocoonPlatformPlan): readonly string[] {
  const suffixes: Readonly<Record<string, string>> = { gba: "GBA", nds: "NDS", n3ds: "3DS" };
  const suffix = Object.hasOwn(suffixes, plan.platformId) ? suffixes[plan.platformId] : undefined;
  return suffix ? [plan.name, `${plan.name} (${suffix})`] : [plan.name];
}

export function cocoonPlayerNames(plan: CocoonPlatformPlan): readonly string[] {
  return plan.playerId === "gc.org.dolphinemu.dolphinemu" || plan.playerId === "wii.org.dolphinemu.dolphinemu"
    ? [plan.playerName, "Dolphin"] : [plan.playerName];
}

export function validateCocoonPlatformIds(platformIds: readonly string[] | undefined): void {
  if (platformIds === undefined) return;
  if (!Array.isArray(platformIds) || !platformIds.length || platformIds.length > LIBRARY_PLATFORMS.length
    || new Set(platformIds).size !== platformIds.length) throw new Error("Select distinct Library platforms for Cocoon.");
  for (const id of platformIds) libraryPlatform(id);
}

/** Keep the shared ES-DE folder IDs even when Cocoon uses another system name. */
export function cocoonPlatformPlans(abi: Abi, platformIds?: readonly string[]): readonly CocoonPlatformPlan[] {
  const ids = platformIds ?? LIBRARY_PLATFORMS.map((platform) => platform.id);
  validateCocoonPlatformIds(platformIds);
  const cores = selectCores(abi);
  return ids.map((platformId): CocoonPlatformPlan => {
    const platform = libraryPlatform(platformId);
    const retroarch = Object.hasOwn(RETROARCH, platformId) ? RETROARCH[platformId] : undefined;
    if (retroarch) {
      const core = cores.find((entry) => platform.cores.includes(entry.id));
      if (!core) throw new Error(`No setup core is available for ${platform.name}.`);
      const wide = abi === "arm64-v8a" || abi === "x86_64";
      return { platformId, name: retroarch[0], emulatorPackage: retroArchPackageName(abi), coreId: core.id,
        playerId: `${retroarch[1]}.ra${wide ? "64" : "32"}.${core.id}`,
        playerName: `RetroArch (${wide ? "64" : "32"} bits) - ${core.id}` };
    }
    const entry = Object.hasOwn(STANDALONE, platformId) ? STANDALONE[platformId] : undefined;
    const emulatorPackage = platform.emulatorPackages[0];
    if (!entry || !emulatorPackage) throw new Error(`Cocoon does not have a supported player for ${platform.name}.`);
    return { platformId, name: entry[0], emulatorPackage, playerId: entry[1], playerName: entry[2] };
  }).sort((left, right) => left.name.localeCompare(right.name, "en"));
}
