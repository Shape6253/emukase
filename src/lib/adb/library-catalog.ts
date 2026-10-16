import { EMULATORS, type EmulatorId } from "./emulators";
import { melonDsDirectories } from "./melonds-inputs";

export interface LibrarySupportRequirement {
  id: string;
  label: string;
  /** Expected file names, shown while nothing was found. */
  expected: string;
  /** File extensions offered by the support-file picker. */
  accept: string;
  /** Selects candidate files by their path below the shared BIOS folder. */
  matches: (relativePath: string) => boolean;
  /** Bundles must contain every required file in the same directory. */
  complete?: (files: readonly { relativePath: string; bytes: number }[]) => boolean;
}

export interface LibraryPlatform {
  /** ES-DE system folder below the shared ROMs root. */
  id: string;
  name: string;
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
      id: "megacd-bios", label: "Mega-CD BIOS",
      accept: ".bin",
      expected: "bios_CD_E.bin, bios_CD_J.bin or bios_CD_U.bin",
      matches: (path) => /^bios_cd_[eju]\.bin$/.test(basename(path)),
    },
  ]),
  platform("sega32x", "Sega 32X", "retroarch", ["picodrive"]),
  platform("pcengine", "PC Engine", "retroarch", ["mednafen_pce_fast"]),
  platform("pcenginecd", "PC Engine CD", "retroarch", ["mednafen_pce_fast"], [
    {
      id: "pcenginecd-bios", label: "CD system card",
      accept: ".pce",
      expected: "syscard3.pce (or syscard2.pce / syscard1.pce)",
      matches: (path) => /^syscard\d*\.pce$/.test(basename(path)),
    },
  ]),
  platform("psx", "Sony PlayStation", "retroarch", ["swanstation", "pcsx_rearmed"], [
    {
      id: "psx-bios", label: "PlayStation BIOS",
      accept: ".bin",
      expected: "scph5500.bin, scph5501.bin or scph5502.bin",
      matches: (path) => /^scph\d{4}\.bin$/.test(basename(path)) || basename(path) === "psxonpsp660.bin",
    },
  ]),
  platform("arcade", "Arcade", "retroarch", ["fbneo"]),
  platform("neogeo", "SNK Neo Geo", "retroarch", ["fbneo"], [
    {
      id: "neogeo-bios", label: "Neo Geo BIOS",
      accept: ".zip",
      expected: "neogeo.zip",
      matches: (path) => basename(path) === "neogeo.zip",
    },
  ]),
  platform("psp", "PlayStation Portable", "ppsspp"),
  platform("gc", "Nintendo GameCube", "dolphin"),
  platform("wii", "Nintendo Wii", "dolphin"),
  platform("n3ds", "Nintendo 3DS", "azahar"),
  platform("nds", "Nintendo DS / DSi", "melonds", [], [
    {
      id: "nds-dsi", label: "DSi / DSiWare BIOS, firmware and NAND",
      accept: "",
      expected: "DSi/bios7.bin (64 KiB), bios9.bin (64 KiB), firmware.bin (128 KiB) and nand.bin; melonDS also needs a separate DS BIOS folder for DSi / DSiWare",
      matches: (path) => /(?:^|\/)dsi\/(?:[^/]+\/)*(?:bios[79]|firmware|nand)\.bin$/i.test(path),
      complete: (files) => melonDsDirectories("DSi", files).length > 0,
    },
  ]),
  platform("ps2", "PlayStation 2", "armsx2", [], [
    {
      id: "ps2-bios", label: "PlayStation 2 BIOS",
      accept: ".bin",
      expected: "a PS2 BIOS dump, for example scph10000.bin",
      matches: (path) => /^scph[-_]?\d{5}[a-z]?(?:[-_][a-z0-9]+)*\.bin$/.test(basename(path)),
    },
  ]),
  platform("switch", "Nintendo Switch", "eden", [], [
    {
      id: "switch-keys", label: "Switch keys",
      accept: ".keys",
      expected: "prod.keys (title.keys and console.keys are optional)",
      matches: (path) => basename(path) === "prod.keys",
    },
    {
      id: "switch-firmware", label: "Switch firmware",
      accept: ".zip",
      expected: "a firmware ZIP or a dump such as firmware/registered/*.nca",
      matches: (path) => /(?:^|\/)firmware\/(?:registered\/)?[^/]+\.nca$/i.test(path)
        || /^switch\/(?:import_[a-f\d]+\/)?[^/]+\.zip$/i.test(path),
    },
  ]),
  platform("psvita", "PlayStation Vita", "vita3k", [], [
    {
      id: "psvita-firmware", label: "Vita firmware",
      accept: ".pup",
      expected: "PSVUPDAT.PUP (official firmware update)",
      matches: (path) => basename(path) === "psvupdat.pup",
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
