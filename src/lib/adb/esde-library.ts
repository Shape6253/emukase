import { installedAndroidPackages } from "./android-package";
import { selectAbi, selectCores, type Abi } from "./catalog";
import { retroArchPackageName } from "./emulators";
import { readEsdeBundledFindRules, readEsdeBundledSystems } from "./esde-environment";
import { readEsdeText } from "./esde-files";
import { esdeEmulatorLabels, esdeSystemPath, esdeUsesExclusiveSystems, mergeEsdeDefinitions } from "./esde-profile";
import type { EsdeConfigurationProfile } from "./esde-profile";
import type { EsdeContext } from "./esde-types";
import { esdeXmlRoot, esdeXmlText, parseEsdeXml } from "./esde-xml";
import { LIBRARY_PLATFORMS } from "./library-catalog";
import { shellCommand } from "./transport";

export interface EsdeLibraryPlatform {
  platformId: string;
  emulatorPackage: string;
  coreId?: string;
  label: string;
}

const STANDALONE_TOKENS: Readonly<Record<string, string>> = {
  psp: "PPSSPP", gc: "DOLPHIN", wii: "DOLPHIN", n3ds: "AZAHAR", nds: "MELONDS",
  ps2: "ARMSX2", switch: "EDEN", psvita: "VITA3K",
};

/** Select native commands by their emulator/core, using labels from the installed APK. */
export function planEsdeLibrary(
  abi: Abi, packages: ReadonlySet<string>, systems: string, rules: string, romDirectory: string,
): readonly EsdeLibraryPlatform[] {
  const retroarchAbi = !packages.has(retroArchPackageName(abi)) && packages.has("com.retroarch.ra32")
    ? (abi === "x86_64" ? "x86" : "armeabi-v7a") : abi;
  const cores = selectCores(retroarchAbi);
  esdeUsesExclusiveSystems(systems);
  const definitions = parseEsdeXml(systems).find((node) => node.name === "systemList");
  if (!definitions) throw new Error("ES-DE's systems definition is unavailable.");
  const findRules = esdeXmlRoot(rules, "ruleList");
  const plans: EsdeLibraryPlatform[] = [];
  for (const platform of LIBRARY_PLATFORMS) {
    const emulatorPackage = platform.cores.length ? retroArchPackageName(retroarchAbi)
      : platform.emulatorPackages.find((entry) => packages.has(entry));
    if (!emulatorPackage || !packages.has(emulatorPackage)) continue;
    const core = platform.cores.length ? cores.find((entry) => platform.cores.includes(entry.id)) : undefined;
    if (platform.cores.length && !core) throw new Error(`No setup core is available for ${platform.name}.`);
    const token = core ? "RETROARCH" : STANDALONE_TOKENS[platform.id];
    if (!token) throw new Error(`ES-DE has no setup emulator for ${platform.name}.`);
    const matches = definitions.children.filter((node) => node.name === "system" && node.children.some((child) =>
      child.name === "name" && esdeXmlText(systems, child).trim() === platform.id));
    const system = matches[0];
    if (matches.length !== 1 || !system) throw new Error(`ES-DE must define one Library system: ${platform.id}.`);
    const path = esdeSystemPath(systems, platform.id).replace(/^%ROMPATH%(?=\/|$)/, () => romDirectory);
    if (path !== `${romDirectory}/${platform.id}`) throw new Error(`ES-DE's ${platform.id} system does not use the shared Library folder.`);
    const labels = esdeEmulatorLabels(systems, platform.id);
    const commands = system.children.filter((node) => {
      if (node.name !== "command") return false;
      const command = esdeXmlText(systems, node).trim();
      return command.startsWith(`%EMULATOR_${token}% `)
        && (!core || `${command} `.includes(`/cores/${core.id}_libretro_android.so `));
    });
    const label = commands[0]?.attributes.label;
    if (commands.length !== 1 || !label || !labels.has(label)) throw new Error(`ES-DE does not define an unambiguous setup command for ${platform.id}.`);
    const emulators = findRules.children.filter((node) => node.name === "emulator" && node.attributes.name === token);
    if (emulators.length !== 1) throw new Error(`ES-DE's ${token} package detection is ambiguous or unavailable.`);
    const entries = emulators[0]?.children.filter((node) => node.name === "rule" && node.attributes.type === "androidpackage")
      .flatMap((node) => node.children.filter((child) => child.name === "entry").map((child) => esdeXmlText(rules, child).trim())) ?? [];
    const selected = entries.find((entry) => packages.has(entry.split("/")[0] ?? ""));
    if (selected?.split("/")[0] !== emulatorPackage) throw new Error(`ES-DE's ${token} detection does not select ${emulatorPackage}.`);
    plans.push({ platformId: platform.id, emulatorPackage, coreId: core?.id, label });
  }
  if (!plans.length) throw new Error("Install a supported Library emulator before configuring ES-DE.");
  return plans;
}

export async function esdeLibraryProfile(context: EsdeContext, profile: EsdeConfigurationProfile): Promise<EsdeConfigurationProfile> {
  const packages = await installedAndroidPackages(context.device, context.user, context.signal);
  const abi = selectAbi((await context.device.shell(shellCommand("getprop", "ro.product.cpu.abilist"))).trim().split(","));
  const definitions = async (kind: "systems" | "rules", imported: string | undefined): Promise<string> => {
    const name = kind === "systems" ? "es_systems.xml" : "es_find_rules.xml";
    const original = await readEsdeText(context, `${context.workspace.esde}/custom_systems/${name}`);
    const custom = imported === undefined ? original : mergeEsdeDefinitions(original ?? (kind === "systems" ? "<systemList />" : "<ruleList />"), imported, kind);
    if (kind === "systems" && custom !== undefined && esdeUsesExclusiveSystems(custom)) return custom;
    const bundled = kind === "systems" ? await readEsdeBundledSystems(context) : await readEsdeBundledFindRules(context);
    return custom === undefined ? bundled : mergeEsdeDefinitions(bundled, custom, kind);
  };
  const systems = await definitions("systems", profile.customSystems);
  const rules = await definitions("rules", profile.findRules);
  const plans = planEsdeLibrary(abi, packages, systems, rules, context.workspace.roms);
  context.options.onStatus?.(`Connecting ES-DE's ${plans.length} installed Library systems…`);
  return { ...profile, alternativeEmulators: { ...Object.fromEntries(plans.map((plan) => [plan.platformId, plan.label])), ...profile.alternativeEmulators } };
}
