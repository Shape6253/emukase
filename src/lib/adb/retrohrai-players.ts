export interface RetroHraiUserPlayer {
  platformKey: string;
  uniqueId: string;
  name: string;
  emulatorPackage: string;
  amStartArguments: string;
  acceptedFilenameRegex: string;
}

export function readRetroHraiUserPlayers(value: unknown): readonly RetroHraiUserPlayer[] {
  if (!Array.isArray(value) || value.length > 4096) throw new Error("RetroHrai exported an invalid custom-player list.");
  const players = value.map((entry: unknown): RetroHraiUserPlayer => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("Invalid RetroHrai custom player.");
    const fields = entry as Record<string, unknown>;
    for (const key of ["platformKey", "uniqueId", "name", "emulatorPackage", "amStartArguments", "acceptedFilenameRegex"]) {
      const text = fields[key];
      if (typeof text !== "string" || !text.trim() || text.length > 65_536 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
        throw new Error("Invalid RetroHrai custom-player field.");
      }
    }
    if (Object.keys(fields).length !== 6 || typeof fields.platformKey !== "string" || !/^[a-z0-9_]+$/.test(fields.platformKey)
      || typeof fields.uniqueId !== "string" || !/^[\w.-]+$/.test(fields.uniqueId)
      || typeof fields.emulatorPackage !== "string" || !/^[A-Za-z][\w]*(?:\.[\w]+)+$/.test(fields.emulatorPackage)) {
      throw new Error("Invalid RetroHrai custom-player identity.");
    }
    return { platformKey: fields.platformKey, uniqueId: fields.uniqueId, emulatorPackage: fields.emulatorPackage,
      name: String(fields.name), amStartArguments: String(fields.amStartArguments), acceptedFilenameRegex: String(fields.acceptedFilenameRegex) };
  });
  if (new Set(players.map((player) => player.uniqueId)).size !== players.length) throw new Error("RetroHrai exported duplicate custom players.");
  return players;
}

export function sameRetroHraiUserPlayer(left: RetroHraiUserPlayer, right: RetroHraiUserPlayer): boolean {
  return left.platformKey === right.platformKey && left.uniqueId === right.uniqueId && left.name === right.name
    && left.emulatorPackage === right.emulatorPackage && left.amStartArguments === right.amStartArguments
    && left.acceptedFilenameRegex === right.acceptedFilenameRegex;
}
