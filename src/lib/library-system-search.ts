import { LIBRARY_SYSTEM_OPTIONS, MAIN_LIBRARY_PLATFORMS, librarySystem, type LibrarySystem } from "./adb/library-systems";

const SEARCH_ALIASES: Readonly<Record<string, readonly string[]>> = {
  nes: ["NES", "Famicom", "Dendy"],
  snes: ["SNES", "Super Famicom", "SFC"],
  gb: ["Gameboy", "GB"],
  gbc: ["Gameboy Color", "GBC"],
  gba: ["Gameboy Advance", "GBA"],
  megadrive: ["Mega Drive", "Genesis", "MD"],
  mastersystem: ["Master System", "SMS"],
  megacd: ["Mega CD", "Sega CD"],
  pcengine: ["PC Engine", "TurboGrafx 16", "TG16"],
  pcenginecd: ["PC Engine CD", "TurboGrafx CD"],
  psx: ["PS1", "PS One", "PSX", "PlayStation 1"],
  ps2: ["PS2", "PlayStation 2"],
  psp: ["PSP"],
  psvita: ["PS Vita", "PSV"],
  gc: ["GameCube", "GC", "NGC"],
  nds: ["Nintendo DS", "DS", "DSi"],
  n3ds: ["Nintendo 3DS", "3DS"],
  n64: ["Nintendo 64", "N64"],
  xbox: ["Original Xbox", "Xbox original", "Xbox OG"],
  neogeo: ["Neo Geo", "AES", "MVS"],
  arcade: ["Arcade", "FinalBurn Neo", "FBNeo"],
};

function normalizeSearch(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function rankSystem(system: LibrarySystem, query: string): number | undefined {
  const aliases = Object.hasOwn(SEARCH_ALIASES, system.id) ? SEARCH_ALIASES[system.id] ?? [] : [];
  const id = normalizeSearch(system.id);
  const name = normalizeSearch(system.name);
  const alternativeNames = aliases.map(normalizeSearch);
  if (id === query) return 0;
  if (name === query) return 1;
  if (alternativeNames.includes(query)) return 2;
  const fields = [id, name, ...alternativeNames, normalizeSearch(system.emulator ?? "")];
  const tokens = query.split(" ");
  if (!tokens.every((token) => fields.some((field) => field.includes(token)))) return undefined;
  if (name.startsWith(query) || (tokens.length > 1 && tokens.every((token) =>
    fields.some((field) => field.split(" ").some((word) => word.startsWith(token)))))) return 3;
  if (fields.some((field) => field.startsWith(query))) return 4;
  return 5;
}

/** Empty search is curated; typed searches include every known or added system. */
export function searchLibrarySystems(value: string, addedIds: readonly string[], selectedId: string): readonly LibrarySystem[] {
  const ids = [...new Set([...addedIds, ...(selectedId ? [selectedId] : [])])];
  const query = normalizeSearch(value);
  const systems = new Map<string, LibrarySystem>();
  for (const option of query ? LIBRARY_SYSTEM_OPTIONS : MAIN_LIBRARY_PLATFORMS) {
    systems.set(option.id, librarySystem(option.id));
  }
  for (const id of ids) systems.set(id, librarySystem(id));
  if (!value.trim()) return [...systems.values()].sort((left, right) => left.name.localeCompare(right.name));
  if (!query) return [];
  return [...systems.values()].flatMap((system) => {
    const rank = rankSystem(system, query);
    return rank === undefined ? [] : [{ system, rank }];
  }).sort((left, right) => left.rank - right.rank
    || Number(right.system.emulator !== undefined) - Number(left.system.emulator !== undefined)
    || left.system.name.localeCompare(right.system.name)).map(({ system }) => system);
}
