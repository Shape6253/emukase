import type { DaijishoProfile } from "./daijisho-profiles";

// Daijishō's Pegasus importer uses these display names, not upstream player names.
const PLAYER_NAMES: Readonly<Record<string, string>> = {
  "com.retroarch": "RetroArch", "com.retroarch.aarch64": "RetroArch 64",
  "org.ppsspp.ppsspp": "PPSSPP", "org.ppsspp.ppssppgold": "PPSSPP Gold",
};
const PLATFORM_REGEX = "^(?!(?:\\._|\\.).*).*$";

/** Only invert the upstream's explicit extension-alternation grammar, never arbitrary regex. */
export function daijishoPegasusExtensions(regex: string): readonly string[] {
  const match = /^\^\(\.\*\)(?:\\\.|\.)\(\?:([a-zA-Z0-9]+(?:\|[a-zA-Z0-9]+)*)\)\$$/.exec(regex);
  if (!match?.[1]) throw new Error("The upstream filename filter cannot be represented by Daijishō's Pegasus importer.");
  const extensions = match[1].split("|");
  if (new Set(extensions).size !== extensions.length) throw new Error("The upstream filename filter contains duplicate extensions.");
  return extensions;
}

function collectionExtensions(profile: DaijishoProfile): readonly string[] {
  const extensions = daijishoPegasusExtensions(profile.regex);
  if (profile.platformRegex === PLATFORM_REGEX) return extensions;
  // Upstream disc platforms additionally exclude filename suffixes such as bin.
  // Pegasus has no platform-filter field: preserve that restriction in the player.
  const prefix = PLATFORM_REGEX.slice(0, -1);
  const suffix = profile.platformRegex.startsWith(prefix)
    ? /^\(\?<!(\w+)\)\$$/.exec(profile.platformRegex.slice(prefix.length))?.[1] : undefined;
  if (!suffix) throw new Error("The upstream platform filter cannot be represented by Daijishō's Pegasus importer.");
  const accepted = extensions.filter((extension) => !extension.toLowerCase().endsWith(suffix.toLowerCase()));
  if (!accepted.length) throw new Error("The upstream platform filter excludes every supported player extension.");
  return accepted;
}

function playerName(profile: DaijishoProfile, packageName: string): string {
  const name = PLAYER_NAMES[packageName] ?? packageName;
  return `${profile.shortname} - ${name}${profile.coreId ? ` - ${profile.coreId}` : ""}`;
}

/** Mirror the native importer's player names and launch arguments. */
export function daijishoPegasusRouting(profile: DaijishoProfile): { playerName: string; arguments: string } {
  let args = profile.arguments;
  if (!Number.isSafeInteger(profile.user) || profile.user < 0) throw new Error("Invalid Daijishō Android profile.");
  if (profile.emulatorPackage === "com.dsemu.drastic") {
    throw new Error("Daijishō's Pegasus patcher would replace this player's launch arguments.");
  }
  if (profile.coreId) {
    const matches = [...args.matchAll(/(?:^|\s)(?:-e|--es)\s+LIBRETRO\s+(\w+)(?=\s|$)/g)];
    if (matches.length !== 1 || matches[0]?.[1] !== profile.coreId || !/^com\.retroarch(?:\.(?:aarch64|ra32))?$/.test(profile.emulatorPackage)) {
      throw new Error("The upstream RetroArch core argument cannot be imported through Pegasus.");
    }
    // Pegasus preserves arguments verbatim. Unlike an upstream short core id, this
    // is an actual RetroArch LIBRETRO path in the receiving emulator's Android user.
    args = args.replace(/((?:-e|--es)\s+LIBRETRO\s+)\w+(?=\s|$)/,
      `$1/data/user/${profile.user}/${profile.emulatorPackage}/cores/${profile.coreId}_libretro_android.so`);
  }
  if (/(?:\n\s*){2,}|\r|(?:^|\n)[^\n:]+:/.test(args) || /\bam\s+start\b/.test(args)) {
    throw new Error("The player's arguments cannot be represented safely in a Pegasus collection.");
  }
  const components = [...args.matchAll(/(?:^|\s)-n\s+([\w.]+)\/([\w.$]+)(?=\s|$)/g)];
  if (components.length !== 1 || components[0]?.[1] !== profile.emulatorPackage) throw new Error("Ambiguous Pegasus player activity.");
  // The native importer greedily extracts the package up to the last slash on
  // the -n line. Put arguments on separate lines so paths cannot alter that match.
  const component = components[0]?.[0].trim();
  if (!component) throw new Error("Pegasus requires an explicit player component.");
  args = [component, ...args.replace(/(?:^|\s)-n\s+[\w.]+\/[\w.$]+(?=\s|$)/, "")
    .split("\n").map((line) => line.trim()).filter(Boolean)].join("\n");
  return { playerName: playerName(profile, profile.emulatorPackage), arguments: args };
}

/** One native GET_CONTENT selection can import every missing collection. */
export function daijishoPegasusDocument(profiles: readonly DaijishoProfile[]): string {
  if (!profiles.length) throw new Error("Select missing Daijishō platforms before generating a Pegasus import.");
  const names = new Set<string>();
  const players = new Set<string>();
  // A trailing newline becomes part of the final player's arguments in the
  // native parser, so terminate collections only with the blank-line separator.
  return profiles.map((profile) => {
    if (![profile.name, profile.shortname].every((value) => value.trim() === value && !!value && !/[\r\n\x00-\x1f]/.test(value))
      || names.has(profile.name)) throw new Error("Pegasus collection identities are invalid or duplicated.");
    names.add(profile.name);
    const routing = daijishoPegasusRouting(profile);
    // Name counters are document-local; unrelated existing global players do not
    // matter. The generic RetroArch package also creates a companion 64-bit player.
    const generatedNames = [routing.playerName];
    if (profile.emulatorPackage === "com.retroarch") generatedNames.push(playerName(profile, "com.retroarch.aarch64"));
    for (const name of generatedNames) {
      if (players.has(name)) throw new Error("Pegasus collections would produce colliding player names.");
      players.add(name);
    }
    return [`collection: ${profile.name}`, `shortname: ${profile.shortname}`,
      `extensions: ${collectionExtensions(profile).join(",")}`, `launch: am start ${routing.arguments}`].join("\n");
  }).join("\n\n");
}
