import { readAndroidPackage } from "./android-package";
import { EMULATORS } from "./emulators";
import { applyEsdeFile, readEsdeText } from "./esde-files";
import type { EsdeContext } from "./esde-types";
import { shellCommand } from "./transport";

/** Standard native-app descriptors, not games or proof of emulator setup. Never
 * enumerate arbitrary personal apps or overwrite edited/customer descriptors. */
export async function prepareEsdeAppMenu(context: EsdeContext): Promise<{ paths: readonly string[]; created: readonly string[] }> {
  const installed = (await context.device.shell(shellCommand("pm", "list", "packages", "-e", "--user", String(context.user)))).trim().split(/\r?\n/);
  if (installed.some((line) => !/^package:[\w.]+$/.test(line))) throw new Error("Android's enabled-app listing could not be confirmed.");
  const packages = new Set(installed.map((line) => line.slice("package:".length)));
  const created: string[] = [];
  const paths: string[] = [];
  for (const app of Object.values(EMULATORS)) {
    for (const packageName of app.packages) {
      if (!packages.has(packageName)) continue;
      const info = await readAndroidPackage(context.device, packageName, context.user, context.signal);
      if (!info) continue;
      const output = await context.device.shell(shellCommand("cmd", "package", "resolve-activity", "--brief", "--user", String(context.user),
        "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-p", packageName));
      const launchers = output.trim().split(/\r?\n/).filter((line) => /^[\w.]+\/[\w.$]+$/.test(line));
      if (!launchers.length && /^No activity found\.?\s*$/i.test(output.trim())) continue;
      if (launchers.length !== 1 || !launchers[0]?.startsWith(`${packageName}/`)) throw new Error("An emulator's native-app launcher is ambiguous.");
      context.options.onStatus?.(`Preparing ES-DE app menu: ${app.name}…`);
      const path = `${context.workspace.roms}/androidapps/Emukase - ${app.name} - ${packageName}.app`;
      paths.push(path);
      const original = await readEsdeText(context, path);
      if (original !== undefined) {
        if (original !== packageName) throw new Error("An Emukase app descriptor was edited; it was preserved instead of overwritten.");
        continue;
      }
      await applyEsdeFile(context, { path, original, applied: packageName });
      created.push(path);
    }
  }
  return { paths, created };
}
