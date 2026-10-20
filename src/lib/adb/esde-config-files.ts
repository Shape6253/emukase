import { readEsdeBundledSystems } from "./esde-environment";
import { readEsdeText } from "./esde-files";
import { esdeDefinesSystem, esdeEmulatorLabels, esdeSystemPath, esdeUsesExclusiveSystems, mergeEsdeAlternativeEmulator, mergeEsdeDefinitions, mergeEsdeInput, mergeEsdeSettings, parseEsdeSettings } from "./esde-profile";
import type { EsdeConfigurationProfile } from "./esde-profile";
import type { EsdeContext, EsdeFileChange } from "./esde-types";
import { assertAndroidUserPaths, primaryStorageForUser } from "./android-user";

function verifyTheme(log: string, theme: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(theme) || theme.includes("..")) throw new Error("Invalid ES-DE theme directory name.");
  const installed = [...log.matchAll(/Added theme "([^"\r\n]+)"/g)]
    .map((match) => match[1]?.replace(/\/$/, "").split("/").at(-1));
  if (!installed.includes(theme)) throw new Error("The imported theme was not discovered by the installed ES-DE application.");
}

export async function planEsdeConfigFiles(
  context: EsdeContext, profile: EsdeConfigurationProfile, startupLog: string,
): Promise<EsdeFileChange[]> {
  const changes: EsdeFileChange[] = [];
  for (const imported of [profile.settings, profile.customSystems, profile.findRules]) {
    if (imported !== undefined) assertAndroidUserPaths(imported, context.user);
  }
  const settingsPath = `${context.workspace.esde}/settings/es_settings.xml`;
  const settings = await readEsdeText(context, settingsPath);
  if (settings === undefined) throw new Error("ES-DE must generate its active settings before an import.");
  let effectiveSettings = settings;
  if (profile.settings !== undefined) {
    const theme = parseEsdeSettings(profile.settings).get("Theme")?.value;
    if (theme !== undefined) verifyTheme(startupLog, theme);
    const applied = mergeEsdeSettings(settings, profile.settings, context.options.controllerNavigationVerified);
    effectiveSettings = applied;
    if (applied !== settings) changes.push({ path: settingsPath, original: settings, applied });
  }

  const systemsPath = `${context.workspace.esde}/custom_systems/es_systems.xml`;
  let systems = profile.customSystems !== undefined || Object.keys(profile.alternativeEmulators ?? {}).length
    ? await readEsdeText(context, systemsPath) : undefined;
  for (const [kind, path, imported] of [
    ["systems", systemsPath, profile.customSystems],
    ["rules", `${context.workspace.esde}/custom_systems/es_find_rules.xml`, profile.findRules],
  ] as const) {
    if (imported === undefined) continue;
    const original = kind === "systems" ? systems : await readEsdeText(context, path);
    const applied = mergeEsdeDefinitions(original ?? (kind === "systems" ? "<systemList />" : "<ruleList />"), imported, kind);
    if (kind === "systems") systems = applied;
    if (applied !== original) changes.push({ path, original, applied });
  }

  const selections = Object.entries(profile.alternativeEmulators ?? {});
  if (selections.length) {
    let bundled: string | undefined;
    const legacy = parseEsdeSettings(effectiveSettings).get("LegacyGamelistFileLocation");
    if (legacy !== undefined && legacy.type !== "bool") throw new Error("Invalid ES-DE legacy gamelist setting type.");
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
        || legacy === undefined && await readEsdeText(context, modern) === undefined) {
        const configured = esdeSystemPath(definitions, system);
        const directory = (configured === "%ROMPATH%" || configured.startsWith("%ROMPATH%/")
          ? context.workspace.roms + configured.slice("%ROMPATH%".length) : configured).replace(/\/+$/, "");
        const storage = primaryStorageForUser(context.user);
        if (directory !== storage && !directory.startsWith(`${storage}/`) || /%[A-Za-z_]+%/.test(directory)) {
          throw new Error(`Cannot resolve the legacy gamelist path for ${system} in this Android profile's shared storage.`);
        }
        const old = `${directory}/gamelist.xml`;
        if (await readEsdeText(context, old) !== undefined) path = old;
      }
      const original = await readEsdeText(context, path);
      const applied = mergeEsdeAlternativeEmulator(original ?? "<gameList />", label);
      if (applied !== original) changes.push({ path, original, applied });
    }
  }
  if (profile.input !== undefined) {
    const path = `${context.workspace.esde}/settings/es_input.xml`;
    const original = await readEsdeText(context, path);
    if (original === undefined) throw new Error("Configure the controller in ES-DE once before importing matching GUID mappings.");
    const applied = mergeEsdeInput(original, profile.input);
    if (applied !== original) changes.push({ path, original, applied });
  }
  return changes;
}
