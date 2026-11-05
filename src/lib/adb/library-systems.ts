import { LIBRARY_PLATFORMS, type LibraryPlatform } from "./library-catalog";
import { ESDE_ANDROID_SYSTEM_DIRECTORIES } from "./esde-systems";
import { normalizeStorageFolder } from "./workspace";

/** ROM-only systems deliberately have no emulator or setup requirements. */
interface RomOnlySystem {
  id: string;
  name: string;
  emulator: undefined;
  emulatorPackages: readonly string[];
  cores: readonly string[];
  requirements: LibraryPlatform["requirements"];
}

export type LibrarySystem = LibraryPlatform | RomOnlySystem;

const ADDITIONAL_SYSTEM_NAMES: Readonly<Record<string, string>> = {
  "3do": "3DO",
  adam: "Coleco Adam",
  ags: "Adventure Game Studio",
  amiga: "Commodore Amiga",
  amiga1200: "Commodore Amiga 1200",
  amiga600: "Commodore Amiga 600",
  amigacd32: "Commodore Amiga CD32",
  amstradcpc: "Amstrad CPC",
  android: "Android",
  androidapps: "Android apps",
  androidgames: "Android games",
  apple2: "Apple II",
  apple2gs: "Apple IIGS",
  arcadia: "Emerson Arcadia 2001",
  archimedes: "Acorn Archimedes",
  arduboy: "Arduboy",
  astrocde: "Bally Astrocade",
  atari2600: "Atari 2600",
  atari5200: "Atari 5200",
  atari7800: "Atari 7800",
  atari800: "Atari 800",
  atarijaguar: "Atari Jaguar",
  atarijaguarcd: "Atari Jaguar CD",
  atarilynx: "Atari Lynx",
  atarist: "Atari ST",
  atarixe: "Atari XE",
  atomiswave: "Sammy Atomiswave",
  bbcmicro: "BBC Micro",
  c64: "Commodore 64",
  cdimono1: "Philips CD-i",
  cdtv: "Commodore CDTV",
  channelf: "Fairchild Channel F",
  coco: "Tandy Color Computer",
  colecovision: "ColecoVision",
  cps: "Capcom Play System",
  cps1: "Capcom Play System I",
  cps2: "Capcom Play System II",
  cps3: "Capcom Play System III",
  daphne: "Daphne",
  doom: "Doom",
  dos: "DOS",
  dragon32: "Dragon 32",
  dreamcast: "Sega Dreamcast",
  easyrpg: "EasyRPG",
  electron: "Acorn Electron",
  famicom: "Nintendo Famicom",
  fba: "FinalBurn Alpha",
  fbneo: "FinalBurn Neo",
  fds: "Nintendo Famicom Disk System",
  flash: "Adobe Flash",
  fm7: "Fujitsu FM-7",
  fmtowns: "Fujitsu FM Towns",
  gameandwatch: "Nintendo Game & Watch",
  gamecom: "Tiger Game.com",
  genesis: "Sega Genesis",
  gx4000: "Amstrad GX4000",
  intellivision: "Mattel Intellivision",
  j2me: "Java mobile games",
  mame: "MAME",
  mark3: "Sega Mark III",
  megacdjp: "Sega Mega-CD (Japan)",
  megadrivejp: "Sega Mega Drive (Japan)",
  megaduck: "Mega Duck",
  msx: "MSX",
  msx1: "MSX1",
  msx2: "MSX2",
  msxturbor: "MSX Turbo R",
  n64: "Nintendo 64",
  n64dd: "Nintendo 64DD",
  naomi: "Sega Naomi",
  naomi2: "Sega Naomi 2",
  naomigd: "Sega Naomi GD-ROM",
  neogeocd: "SNK Neo Geo CD",
  neogeocdjp: "SNK Neo Geo CD (Japan)",
  ngage: "Nokia N-Gage",
  ngp: "SNK Neo Geo Pocket",
  ngpc: "SNK Neo Geo Pocket Color",
  odyssey2: "Magnavox Odyssey 2",
  openbor: "OpenBOR",
  pc88: "NEC PC-8800",
  pc98: "NEC PC-9800",
  pcfx: "NEC PC-FX",
  pico8: "PICO-8",
  plus4: "Commodore Plus/4",
  pokemini: "Pokémon Mini",
  ports: "Ports",
  ps3: "PlayStation 3",
  ps4: "PlayStation 4",
  quake: "Quake",
  satellaview: "Nintendo Satellaview",
  saturn: "Sega Saturn",
  saturnjp: "Sega Saturn (Japan)",
  scummvm: "ScummVM",
  sega32xjp: "Sega Super 32X (Japan)",
  sega32xna: "Sega 32X (North America)",
  segacd: "Sega CD",
  sfc: "Nintendo Super Famicom",
  "sg-1000": "Sega SG-1000",
  sgb: "Nintendo Super Game Boy",
  snesna: "Super Nintendo (North America)",
  solarus: "Solarus",
  stv: "Sega ST-V",
  sufami: "Nintendo Sufami Turbo",
  supergrafx: "NEC SuperGrafx",
  supervision: "Watara Supervision",
  tg16: "NEC TurboGrafx-16",
  "tg-cd": "NEC TurboGrafx-CD",
  ti99: "Texas Instruments TI-99",
  tic80: "TIC-80",
  vectrex: "Vectrex",
  vic20: "Commodore VIC-20",
  videopac: "Philips Videopac",
  virtualboy: "Nintendo Virtual Boy",
  wiiu: "Nintendo Wii U",
  wonderswan: "Bandai WonderSwan",
  wonderswancolor: "Bandai WonderSwan Color",
  x68000: "Sharp X68000",
  xbox360: "Xbox 360",
  xboxone: "Xbox One",
  zx81: "Sinclair ZX81",
  zxnext: "ZX Spectrum Next",
  zxspectrum: "ZX Spectrum",
};

/** Keep the setup catalog complete while presenting a smaller default selector. */
const EXTRA_PLATFORM_IDS = new Set(["mastersystem", "gamegear", "megacd", "sega32x", "pcengine", "pcenginecd"]);

export const MAIN_LIBRARY_PLATFORMS: readonly LibraryPlatform[] = LIBRARY_PLATFORMS.filter((platform) => !EXTRA_PLATFORM_IDS.has(platform.id));

function systemName(id: string): string {
  return Object.hasOwn(ADDITIONAL_SYSTEM_NAMES, id) ? ADDITIONAL_SYSTEM_NAMES[id] ?? id : id;
}

export const LIBRARY_SYSTEM_OPTIONS: readonly { id: string; name: string }[] = ESDE_ANDROID_SYSTEM_DIRECTORIES.map((id) => ({
  id,
  name: LIBRARY_PLATFORMS.find((platform) => platform.id === id)?.name ?? systemName(id),
})).sort((left, right) => left.name.localeCompare(right.name));

/** One folder below the ROM root, never an absolute path or a nested path. */
export function validateLibrarySystemId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,254}$/.test(id)) {
    throw new Error("Use a folder name of up to 255 characters with letters, numbers, hyphens or underscores. Do not enter dots or a path.");
  }
  normalizeStorageFolder(id);
}

export function librarySystem(id: string): LibrarySystem {
  validateLibrarySystemId(id);
  const platform = LIBRARY_PLATFORMS.find((entry) => entry.id === id);
  if (platform) return platform;
  return {
    id, name: systemName(id),
    emulator: undefined, emulatorPackages: [], cores: [], requirements: [],
  };
}

/** Resolve suggested names and known folder ids without rewriting custom folders. */
export function librarySystemFromInput(value: string): LibrarySystem {
  const input = value.trim();
  const option = LIBRARY_SYSTEM_OPTIONS.find((entry) => entry.id.toLowerCase() === input.toLowerCase() || entry.name.toLowerCase() === input.toLowerCase());
  return librarySystem(option?.id ?? input);
}
