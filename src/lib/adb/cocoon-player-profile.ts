import { sha256 } from "@noble/hashes/sha2.js";
import { scopeRetroArchLaunchArguments } from "./android-launch-arguments";
import { cocoonPlatformNames, type CocoonPlatformPlan } from "./cocoon-platforms";

const TEMPLATES: Readonly<Record<string, readonly [string, string]>> = {
  nes: ["nes", "NintendoEntertainmentSystem"], snes: ["snes", "SuperNintendoEntertainmentSystem"],
  gb: ["gb", "GameBoy"], gbc: ["gbc", "GameBoyColor"], gba: ["gba", "GameBoyAdvance"],
  megadrive: ["genesis", "SegaGenesis"], mastersystem: ["mastersystem", "SegaMasterSystem"],
  gamegear: ["gamegear", "SegaGameGear"], megacd: ["segacd", "SegaCD"], sega32x: ["sega32x", "Sega32X"],
  pcengine: ["tg16", "TurboGrafx16"], pcenginecd: ["tg-cd", "TurboGrafxCD"],
  psx: ["psx", "SonyPlayStation"], arcade: ["fbneo", "FinalBurnNeo"], neogeo: ["neogeo", "NeoGeo"],
};

export function cocoonRetroArchTemplate(plan: CocoonPlatformPlan): readonly [string, string] {
  const template = Object.hasOwn(TEMPLATES, plan.platformId) ? TEMPLATES[plan.platformId] : undefined;
  if (!plan.coreId || !template) throw new Error("No Cocoon RetroArch template is available for this platform.");
  return template;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Add a content-addressed copy, leaving upstream and unrelated custom players intact.
 * Cocoon's native platform import merges these players with existing database rows. */
export function cocoonProfilePlayer(source: string, plan: CocoonPlatformPlan, user: number, savedPath: string): CocoonPlatformPlan {
  const [key] = cocoonRetroArchTemplate(plan);
  if (!plan.coreId || !/^[a-z0-9_]+$/.test(plan.coreId) || !/^com\.retroarch(?:\.(?:aarch64|ra32))?$/.test(plan.emulatorPackage)) {
    throw new Error("Invalid Cocoon RetroArch package or core.");
  }
  if (!source || source.length > 1_048_576) throw new Error("Cocoon's platform definition has an unsupported size.");
  const value: unknown = JSON.parse(source);
  if (!record(value) || !record(value.platform) || value.platform.uniqueId !== key
    || typeof value.platform.name !== "string" || !cocoonPlatformNames(plan).includes(value.platform.name)
    || !Number.isSafeInteger(value.revisionNumber) || Number(value.revisionNumber) < 1
    || !Array.isArray(value.playerList) || !value.playerList.length || value.playerList.length > 256) {
    throw new Error(`Cocoon's ${plan.name} platform definition is unsupported.`);
  }
  const players = value.playerList;
  const ids = new Set<string>();
  for (const player of players) {
    if (!record(player) || typeof player.uniqueId !== "string" || !/^[\w.-]+$/.test(player.uniqueId)
      || ids.has(player.uniqueId) || typeof player.name !== "string" || !player.name.trim()
      || typeof player.amStartArguments !== "string" || !player.amStartArguments.trim()) {
      throw new Error("Cocoon's platform contains invalid or duplicate player identities.");
    }
    ids.add(player.uniqueId);
  }
  const selected: unknown = players.find((player: unknown) => record(player) && player.uniqueId === plan.playerId);
  if (!record(selected) || typeof selected.amStartArguments !== "string" || typeof selected.name !== "string"
    || typeof selected.acceptedFilenameRegex !== "string") throw new Error(`Cocoon's ${plan.name} RetroArch player is unavailable.`);
  const args = selected.amStartArguments;
  const components = [...args.matchAll(/(?:^|\s)-n\s+([\w.]+)\/([\w.$]+)(?=\s|$)/g)];
  const cores = [...args.matchAll(/(?:^|\s)(?:-e|--es)\s+LIBRETRO\s+(\S+)(?=\s|$)/g)];
  const core = cores[0]?.[1];
  if (components.length !== 1 || components[0]?.[1] !== plan.emulatorPackage
    || components[0]?.[2] !== "com.retroarch.browser.retroactivity.RetroActivityFuture"
    || cores.length !== 1 || !core || !new RegExp(`^/data/(?:data|user/\\d+)/${plan.emulatorPackage.replaceAll(".", "\\.")}/cores/${plan.coreId}_libretro_android\\.so$`).test(core)) {
    throw new Error("Cocoon's RetroArch player does not match the selected package and core.");
  }
  const scoped = scopeRetroArchLaunchArguments(args, plan.emulatorPackage, user);
  const fingerprint = Array.from(sha256(new TextEncoder().encode(JSON.stringify({ ...selected, amStartArguments: scoped }))),
    (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
  const playerId = `custom.emukase.u${user}.${plan.playerId}.${fingerprint}`;
  const playerName = `Emukase u${user}: ${selected.name} [${fingerprint}]`;
  const player = { ...selected, uniqueId: playerId, name: playerName, amStartArguments: scoped };
  const existing: unknown = players.find((entry: unknown) => record(entry) && entry.uniqueId === playerId);
  if (existing === undefined && players.length >= 256) throw new Error("Cocoon's platform has reached the custom-player limit.");
  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(player)) {
    throw new Error("Cocoon's generated player identity conflicts with an existing player. Existing players were preserved.");
  }
  if (players.some((entry: unknown) => record(entry) && entry.name === playerName && entry.uniqueId !== playerId)) {
    throw new Error("Cocoon's generated player name conflicts with an existing player.");
  }
  return { ...plan, playerId, playerName, profilePlayer: { savedPath, retained: existing !== undefined,
    document: JSON.stringify({ ...value, playerList: existing ? players : [...players, player] }) } };
}
