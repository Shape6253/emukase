import { EMULATORS, type EmulatorId } from "./emulators";

/** Shared Emukase library description: one ROM folder per platform plus the BIOS,
 * keys and firmware files its emulators need. Folder names follow ES-DE's Android
 * system ids so one tree can serve ES-DE, RetroArch and the standalone emulators. */
export type LibrarySupportKind = "bios" | "keys" | "firmware";

export interface LibrarySupportRequirement {
  id: string;
  kind: LibrarySupportKind;
  /** Row title on the library page. */
  label: string;
  /** Expected file names, shown while nothing was found. */
  expected: string;
  /** Selects candidate files by their path below the shared BIOS folder. */
  matches: (relativePath: string) => boolean;
  /** Defaults to: any matched file satisfies the requirement. */
  satisfied?: (matchedPaths: readonly string[]) => boolean;
}

export interface LibraryPlatform {
  /** ES-DE system folder below the shared ROMs root. */
  id: string;
  name: string;
  /** Emulator the setup flow provisions for this platform. */
  emulator: string;
  /** Android packages of that emulator; RetroArch ships one per architecture. */
  emulatorPackages: readonly string[];
  /** Libretro core ids when the platform runs in RetroArch; empty for standalone apps. */
  cores: readonly string[];
  requirements: readonly LibrarySupportRequirement[];
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).toLowerCase();
}

function platform(
  id: string,
  name: string,
  emulatorId: EmulatorId,
  cores: readonly string[] = [],
  requirements: readonly LibrarySupportRequirement[] = [],
): LibraryPlatform {
  const emulator = EMULATORS[emulatorId];
  return { id, name, emulator: emulator.name, emulatorPackages: emulator.packages, cores, requirements };
}

/** Optional support files (GBA, DS and 3DS firmware dumps) are intentionally not
 * listed: their emulators run without them for the supported game formats. */
export const LIBRARY_PLATFORMS: readonly LibraryPlatform[] = [
  platform("nes", "Nintendo Entertainment System", "retroarch", ["fceumm"]),
  platform("snes", "Super Nintendo Entertainment System", "retroarch", ["snes9x"]),
  platform("gb", "Game Boy", "retroarch", ["gambatte"]),
  platform("gbc", "Game Boy Color", "retroarch", ["gambatte"]),
  platform("gba", "Game Boy Advance", "retroarch", ["mgba"]),
  platform("megadrive", "Sega Mega Drive", "retroarch", ["genesis_plus_gx"]),
  platform("mastersystem", "Sega Master System", "retroarch", ["genesis_plus_gx"]),
  platform("gamegear", "Sega Game Gear", "retroarch", ["genesis_plus_gx"]),
  platform("megacd", "Sega Mega-CD", "retroarch", ["genesis_plus_gx"], [
    {
      id: "megacd-bios", kind: "bios", label: "Mega-CD BIOS",
      expected: "bios_CD_E.bin, bios_CD_J.bin or bios_CD_U.bin",
      matches: (path) => /^bios_cd_[eju]\.bin$/.test(basename(path)),
    },
  ]),
  platform("sega32x", "Sega 32X", "retroarch", ["picodrive"]),
  platform("pcengine", "PC Engine", "retroarch", ["mednafen_pce_fast"]),
  platform("pcenginecd", "PC Engine CD", "retroarch", ["mednafen_pce_fast"], [
    {
      id: "pcenginecd-bios", kind: "bios", label: "CD system card",
      expected: "syscard3.pce (or syscard2.pce / syscard1.pce)",
      matches: (path) => /^syscard\d*\.pce$/.test(basename(path)),
    },
  ]),
  platform("psx", "Sony PlayStation", "retroarch", ["swanstation", "pcsx_rearmed"], [
    {
      id: "psx-bios", kind: "bios", label: "PlayStation BIOS",
      expected: "scph5500.bin, scph5501.bin or scph5502.bin",
      matches: (path) => /^scph\d{4}\.bin$/.test(basename(path)) || basename(path) === "psxonpsp660.bin",
    },
  ]),
  platform("arcade", "Arcade", "retroarch", ["fbneo"]),
  platform("neogeo", "SNK Neo Geo", "retroarch", ["fbneo"], [
    {
      id: "neogeo-bios", kind: "bios", label: "Neo Geo BIOS",
      expected: "neogeo.zip",
      matches: (path) => basename(path) === "neogeo.zip",
    },
  ]),
  platform("psp", "PlayStation Portable", "ppsspp"),
  platform("gc", "Nintendo GameCube", "dolphin"),
  platform("wii", "Nintendo Wii", "dolphin"),
  platform("n3ds", "Nintendo 3DS", "azahar"),
  platform("nds", "Nintendo DS", "melonds"),
  platform("ps2", "PlayStation 2", "armsx2", [], [
    {
      id: "ps2-bios", kind: "bios", label: "PlayStation 2 BIOS",
      expected: "a PS2 BIOS dump, for example scph10000.bin",
      matches: (path) => /^scph\d{4,5}[a-z]?\.bin$/.test(basename(path)),
    },
  ]),
  platform("switch", "Nintendo Switch", "eden", [], [
    {
      id: "switch-keys", kind: "keys", label: "Switch keys",
      expected: "prod.keys (title.keys and console.keys are optional)",
      matches: (path) => basename(path).endsWith(".keys"),
      satisfied: (paths) => paths.some((path) => basename(path) === "prod.keys"),
    },
    {
      id: "switch-firmware", kind: "firmware", label: "Switch firmware",
      expected: "a firmware dump, for example firmware/registered/*.nca",
      matches: (path) => /(?:^|\/)firmware(?:[./]|$)/i.test(path) || /\.nca$/i.test(basename(path)),
    },
  ]),
  platform("psvita", "PlayStation Vita", "vita3k", [], [
    {
      id: "psvita-firmware", kind: "firmware", label: "Vita firmware",
      expected: "PSVUPDAT.PUP (official firmware update)",
      matches: (path) => /\.pup$/i.test(basename(path)),
    },
  ]),
];

export function libraryPlatform(id: string): LibraryPlatform {
  const platform = LIBRARY_PLATFORMS.find((entry) => entry.id === id);
  if (!platform) throw new Error(`Unknown library platform: ${id}.`);
  return platform;
}

export function libraryPlatformGroups(): readonly { emulator: string; platforms: readonly LibraryPlatform[] }[] {
  const groups: { emulator: string; platforms: LibraryPlatform[] }[] = [];
  for (const platform of LIBRARY_PLATFORMS) {
    const group = groups.find((entry) => entry.emulator === platform.emulator);
    if (group) group.platforms.push(platform);
    else groups.push({ emulator: platform.emulator, platforms: [platform] });
  }
  return groups;
}
