import { readEsdeBundledSystems } from "./esde-environment";
import { readEsdeText, readEsdeTexts } from "./esde-files";
import { esdeDefinesSystem, esdeEmulatorLabels, esdeSystemPath, esdeUsesExclusiveSystems, mergeEsdeAlternativeEmulator, mergeEsdeDefinitions, mergeEsdeInput, mergeEsdeSettings, parseEsdeSettings } from "./esde-profile";
import type { EsdeConfigurationProfile } from "./esde-profile";
import type { EsdeContext, EsdeFileChange } from "./esde-types";
import { assertAndroidUserPaths, primaryStorageForUser } from "./android-user";
import { esdeXmlDirectText, parseEsdeXml, type EsdeXmlNode } from "./esde-xml";

function assertEsdeProfilePaths(source: string, user: number): void {
  assertAndroidUserPaths(source, user);
  const checkNode = (node: EsdeXmlNode): void => {
    for (const value of Object.values(node.attributes)) assertAndroidUserPaths(value, user);
    assertAndroidUserPaths(esdeXmlDirectText(source, node), user);
    node.children.forEach(checkNode);
  };
  parseEsdeXml(source).forEach(checkNode);
}

function verifyTheme(log: string, theme: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(theme) || theme.includes("..")) throw new Error("Invalid ES-DE theme directory name.");
  const installed = [...log.matchAll(/Added theme "([^"\r\n]+)"/g)]
    .map((match) => match[1]?.replace(/\/$/, "").split("/").at(-1));
  if (!installed.includes(theme)) throw new Error("The imported theme was not discovered by the installed ES-DE application.");
}

export async function planEsdeConfigFiles(
  context: EsdeContext, profile: EsdeConfigurationProfile, startupLog: string,
  firstChangeOnly: boolean = false,
): Promise<EsdeFileChange[]> {
  const changes: EsdeFileChange[] = [];
  // A single plan may resolve modern/legacy paths before importing the same
  // file. Reuse that read only within this plan, never across stop or restart.
  const reads = new Map<string, Promise<string | undefined>>();
  const read = (path: string): Promise<string | undefined> => {
    let pending = reads.get(path);
    if (!pending) {
      pending = readEsdeText(context, path);
      reads.set(path, pending);
    }
    return pending;
  };
  for (const imported of [profile.settings, profile.customSystems, profile.findRules]) {
    if (imported !== undefined) assertEsdeProfilePaths(imported, context.user);
  }
  const settingsPath = `${context.workspace.esde}/settings/es_settings.xml`;
  const settings = await read(settingsPath);
  if (settings === undefined) throw new Error("ES-DE must generate its active settings before an import.");
  let effectiveSettings = settings;
  if (profile.settings !== undefined) {
    const theme = parseEsdeSettings(profile.settings).get("Theme")?.value;
    if (theme !== undefined) verifyTheme(startupLog, theme);
    const applied = mergeEsdeSettings(settings, profile.settings, context.options.controllerNavigationVerified);
    effectiveSettings = applied;
    if (applied !== settings) {
      changes.push({ path: settingsPath, original: settings, applied });
      if (firstChangeOnly) return changes;
    }
  }

  const systemsPath = `${context.workspace.esde}/custom_systems/es_systems.xml`;
  let systems = profile.customSystems !== undefined || Object.keys(profile.alternativeEmulators ?? {}).length
    ? await read(systemsPath) : undefined;
  for (const [kind, path, imported] of [
    ["systems", systemsPath, profile.customSystems],
    ["rules", `${context.workspace.esde}/custom_systems/es_find_rules.xml`, profile.findRules],
  ] as const) {
    if (imported === undefined) continue;
    const original = kind === "systems" ? systems : await read(path);
    const applied = mergeEsdeDefinitions(original ?? (kind === "systems" ? "<systemList />" : "<ruleList />"), imported, kind);
    if (kind === "systems") systems = applied;
    if (applied !== original) {
      changes.push({ path, original, applied });
      if (firstChangeOnly) return changes;
    }
  }

  const selections = Object.entries(profile.alternativeEmulators ?? {});
  if (selections.length) {
    let bundled: string | undefined;
    const legacy = parseEsdeSettings(effectiveSettings).get("LegacyGamelistFileLocation");
    if (legacy !== undefined && legacy.type !== "bool") throw new Error("Invalid ES-DE legacy gamelist setting type.");
    if (legacy?.value !== "true") {
      const paths = selections.map(([system]) => `${context.workspace.esde}/gamelists/${system}/gamelist.xml`);
      const originals = await readEsdeTexts(context, paths);
      for (const path of paths) reads.set(path, Promise.resolve(originals.get(path)));
    }
    for (const [system, label] of selections) {
      let definitions = systems;
      if (definitions === undefined || !esdeDefinesSystem(definitions, system)) {
        if (definitions !== undefined && esdeUsesExclusiveSystems(definitions)) {
          throw new Error(`The exclusive ES-DE configuration does not define system ${system}.`);
        }
        bundled ??= await readEsdeBundledSystems(context);
        definitions = bundled;
      }
      if (!esdeEmulatorLabels(definitions, system).has(label)) throw new Error(`The effective ES-DE system ${system} does not define emulator ${label}.`);
      const modern = `${context.workspace.esde}/gamelists/${system}/gamelist.xml`;
      let path = modern;
      if (legacy?.type === "bool" && legacy.value === "true"
        || legacy === undefined && await read(modern) === undefined) {
        const configured = esdeSystemPath(definitions, system);
        const directory = (configured === "%ROMPATH%" || configured.startsWith("%ROMPATH%/")
          ? context.workspace.roms + configured.slice("%ROMPATH%".length) : configured).replace(/\/+$/, "");
        const storage = primaryStorageForUser(context.user);
        if (directory !== storage && !directory.startsWith(`${storage}/`) || /%[A-Za-z_]+%/.test(directory)) {
          throw new Error(`Cannot resolve the legacy gamelist path for ${system} in this Android profile's shared storage.`);
        }
        const old = `${directory}/gamelist.xml`;
        if (await read(old) !== undefined) path = old;
      }
      const original = await read(path);
      const applied = mergeEsdeAlternativeEmulator(original ?? "<gameList />", label);
      if (applied !== original) {
        changes.push({ path, original, applied });
        if (firstChangeOnly) return changes;
      }
    }
  }
  if (profile.input !== undefined) {
    const path = `${context.workspace.esde}/settings/es_input.xml`;
    const original = await read(path);
    if (original === undefined) throw new Error("Configure the controller in ES-DE once before importing matching GUID mappings.");
    const applied = mergeEsdeInput(original, profile.input);
    if (applied !== original) changes.push({ path, original, applied });
  }
  return changes;
}
