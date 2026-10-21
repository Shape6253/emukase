import { assertAndroidUser } from "./android-user";
import { EMULATORS } from "./emulators";
import { applyEsdeConfigFiles } from "./esde-config-import";
import { readEsdeTexts } from "./esde-files";
import { withEsdeHelper } from "./esde-helper";
import type { EsdeContext, EsdeFileChange } from "./esde-types";
import { cleanQueryOutput } from "./media-store";
import { shellCommand } from "./transport";

/** Resolve only known emulator launchers. The enabled-package listing already
 * establishes installation; full package/version/permission dumps add no evidence. */
async function menuLaunchers(context: EsdeContext, packages: readonly string[]): Promise<ReadonlySet<string>> {
  if (!packages.length) return new Set();
  const marker = `emukase-esde-menu-${crypto.randomUUID()}`;
  const commands = packages.map((name, index) => [
    shellCommand("printf", `\n${marker}:${index}\n`),
    `${shellCommand("cmd", "package", "resolve-activity", "--brief", "--user", String(context.user),
      "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-p", name)} 2>&1 || :`,
  ].join("\n"));
  const output = await context.device.shell(shellCommand("sh", "-c", [
    "set -eu", ...commands, shellCommand("printf", `\n${marker}:end\n`),
  ].join("\n")));
  await assertAndroidUser(context.device, context.user, context.signal);
  const sections = output.replaceAll("\r\n", "\n").split(`\n${marker}:`);
  if (sections.shift() !== "" || sections.pop() !== "end\n" || sections.length !== packages.length) {
    throw new Error("Android did not finish resolving the ES-DE app menu launchers.");
  }
  const launchers = new Set<string>();
  for (const [index, name] of packages.entries()) {
    const section = sections[index];
    if (!section?.startsWith(`${index}\n`)) throw new Error("Android returned an unexpected launcher result.");
    const result = cleanQueryOutput(section.slice(`${index}\n`.length));
    if (/^No activity found\.?\s*$/i.test(result)) continue;
    const components = result.split("\n").filter((line) => /^[\w.]+\/[\w.$]+$/.test(line));
    if (/Error:|Exception|Permission Denial/i.test(result) || components.length !== 1 || !components[0]?.startsWith(`${name}/`)) {
      throw new Error("An emulator's native-app launcher is ambiguous.");
    }
    launchers.add(name);
  }
  return launchers;
}

/** Standard native-app descriptors, not games or proof of emulator setup. */
export async function prepareEsdeAppMenu(context: EsdeContext): Promise<{ paths: readonly string[]; created: readonly string[] }> {
  return withEsdeHelper(context, async () => {
    context.options.onStatus?.("Checking installed emulator launchers for ES-DE's app menu…");
    const installed = (await context.device.shell(shellCommand("pm", "list", "packages", "-e", "--user", String(context.user)))).trim().split(/\r?\n/);
    if (installed.some((line) => !/^package:[\w.]+$/.test(line))) throw new Error("Android's enabled-app listing could not be confirmed.");
    const packages = new Set(installed.map((line) => line.slice("package:".length)));
    const apps = Object.values(EMULATORS).flatMap((app) => app.packages
      .filter((name) => packages.has(name)).map((packageName) => ({ name: app.name, packageName })));
    const launchers = await menuLaunchers(context, apps.map((app) => app.packageName));
    const entries = apps.filter((app) => launchers.has(app.packageName)).map((app) => ({
      ...app, path: `${context.workspace.roms}/androidapps/Emukase - ${app.name} - ${app.packageName}.app`,
    }));
    const paths = entries.map((entry) => entry.path);
    context.options.onStatus?.(`Checking ES-DE's app menu files (${paths.length})…`);
    const originals = await readEsdeTexts(context, paths);
    const changes: EsdeFileChange[] = [];
    for (const { path, packageName } of entries) {
      const original = originals.get(path);
      if (original !== undefined && original !== packageName) {
        throw new Error("An Emukase app descriptor was edited; it was preserved instead of overwritten.");
      }
      if (original === undefined) changes.push({ path, original, applied: packageName });
    }
    await applyEsdeConfigFiles(context, changes);
    return { paths, created: changes.map((change) => change.path) };
  });
}
