import { EMULATORS, type EmulatorId } from "./emulators";
import { melonDsDirectories } from "./melonds-inputs";
import { VITA3K_FIRMWARE_FILENAME, VITA3K_FONT_FILENAME } from "./vita3k-inputs";

export interface LibrarySupportRequirement {
  id: string;
  label: string;
  /** Expected support files, shown alongside their status. */
  expected: string;
  picker: {
    /** File extensions offered by the picker; empty when names can be arbitrary. */
    accept: string;
    multiple: boolean;
    /** Exact number of files when the importer needs a complete set. */
    fileCount?: number;
    /** Exact input names when the native importer requires them. */
    filenames?: readonly string[];
    label: string;
    /** Explain whether files are selected individually, optionally together, or as a complete set. */
    hint?: string;
  };
  /** Selects candidate files by their path below the shared BIOS folder. */
  matches: (relativePath: string) => boolean;
  /** Additional presence checks, such as complete bundles or valid file sizes. */
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

/** Optional GBA and 3DS firmware dumps are omitted. DS dumps are offered
 * separately because melonDS also requires them for DSi setup. */
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
      expected: "bios_CD_E.bin, bios_CD_J.bin or bios_CD_U.bin",
      picker: {
        accept: ".bin", multiple: true, label: "Upload Mega-CD BIOS",
      },
      matches: (path) => /^bios_cd_[eju]\.bin$/.test(basename(path)),
    },
  ]),
  platform("sega32x", "Sega 32X", "retroarch", ["picodrive"]),
  platform("pcengine", "PC Engine", "retroarch", ["mednafen_pce_fast"]),
  platform("pcenginecd", "PC Engine CD", "retroarch", ["mednafen_pce_fast"], [
    {
      id: "pcenginecd-bios", label: "CD system card",
      expected: "syscard3.pce (or syscard2.pce / syscard1.pce)",
      picker: {
        accept: ".pce", multiple: true, label: "Upload CD system card",
      },
      matches: (path) => /^syscard\d*\.pce$/.test(basename(path)),
    },
  ]),
  platform("psx", "Sony PlayStation", "retroarch", ["swanstation", "pcsx_rearmed"], [
    {
      id: "psx-bios", label: "PlayStation BIOS",
      expected: "scph5500.bin, scph5501.bin or scph5502.bin",
      picker: {
        accept: ".bin", multiple: true, label: "Upload PlayStation BIOS",
      },
      matches: (path) => /^scph\d{4}\.bin$/.test(basename(path)) || basename(path) === "psxonpsp660.bin",
    },
  ]),
  platform("arcade", "Arcade", "retroarch", ["fbneo"]),
  platform("neogeo", "SNK Neo Geo", "retroarch", ["fbneo"], [
    {
      id: "neogeo-bios", label: "Neo Geo BIOS",
      expected: "neogeo.zip",
      picker: {
        accept: ".zip", multiple: false, label: "Upload Neo Geo BIOS",
      },
      matches: (path) => basename(path) === "neogeo.zip",
    },
  ]),
  platform("psp", "PlayStation Portable", "ppsspp"),
  platform("gc", "Nintendo GameCube", "dolphin"),
  platform("wii", "Nintendo Wii", "dolphin"),
  platform("n3ds", "Nintendo 3DS", "azahar"),
  platform("nds", "Nintendo DS", "melonds", [], [
    {
      id: "nds-ds", label: "DS BIOS and firmware",
      expected: "bios7.bin, bios9.bin and firmware.bin",
      picker: {
        accept: "", multiple: true, fileCount: 3, label: "Upload DS files",
        hint: "Select 3 files. Optional for DS.",
      },
      matches: (path) => /(?:^|\/)ds\/(?:[^/]+\/)*(?:bios[79]|firmware)\.bin$/i.test(path),
      complete: (files) => melonDsDirectories("DS", files).length > 0,
    },
    {
      id: "nds-dsi", label: "DSi BIOS, firmware and NAND",
      expected: "bios7.bin, bios9.bin, firmware.bin and nand.bin",
      picker: {
        accept: "", multiple: true, fileCount: 4, label: "Upload DSi files",
        hint: "Select 4 files.",
      },
      matches: (path) => /(?:^|\/)dsi\/(?:[^/]+\/)*(?:bios[79]|firmware|nand)\.bin$/i.test(path),
      complete: (files) => melonDsDirectories("DSi", files).length > 0,
    },
  ]),
  platform("ps2", "PlayStation 2", "armsx2", [], [
    {
      id: "ps2-bios", label: "PlayStation 2 BIOS",
      expected: "PS2 BIOS image or ZIP",
      picker: {
        accept: "", multiple: false, label: "Choose BIOS and configure",
      },
      matches: (path) => /^ps2\/[^\x00-\x1f\x7f]+$/i.test(path) || /^scph[-_]?\d{5}[a-z]?(?:[-_][a-z0-9]+)*\.bin$/.test(basename(path)),
      complete: (files) => files.some((file) => file.bytes >= 4 * 1024 * 1024 && file.bytes <= 8 * 1024 * 1024),
    },
  ]),
  platform("switch", "Nintendo Switch", "eden", [], [
    {
      id: "switch-keys", label: "Switch keys",
      expected: "prod.keys (title.keys is optional)",
      picker: {
        accept: ".keys", multiple: true, filenames: ["prod.keys", "title.keys"], label: "Choose keys and install",
        hint: "You can select prod.keys and title.keys together.",
      },
      matches: (path) => basename(path) === "prod.keys",
    },
    {
      id: "switch-firmware", label: "Switch firmware",
      expected: "Switch firmware ZIP",
      picker: {
        accept: ".zip", multiple: false, label: "Choose firmware and install",
      },
      matches: (path) => /(?:^|\/)firmware\/(?:registered\/)?[^/]+\.nca$/i.test(path)
        || /^switch\/(?:import_[a-f\d]+\/)?[^/]+\.zip$/i.test(path),
    },
  ]),
  platform("psvita", "PlayStation Vita", "vita3k", [], [
    {
      id: "psvita-firmware", label: "Vita firmware",
      expected: VITA3K_FIRMWARE_FILENAME,
      picker: {
        accept: ".pup", multiple: false, filenames: [VITA3K_FIRMWARE_FILENAME], label: "Choose Vita firmware and install",
      },
      matches: (path) => basename(path) === VITA3K_FIRMWARE_FILENAME.toLowerCase(),
      complete: (files) => files.some((file) => file.bytes > 0),
    },
    {
      id: "psvita-fonts", label: "Vita fonts",
      expected: VITA3K_FONT_FILENAME,
      picker: {
        accept: ".pup", multiple: false, filenames: [VITA3K_FONT_FILENAME], label: "Choose Vita fonts and install",
      },
      matches: (path) => basename(path) === VITA3K_FONT_FILENAME.toLowerCase(),
      complete: (files) => files.some((file) => file.bytes > 0),
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
