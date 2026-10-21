import { userScopedDevice } from "./android-user";
import { applyEsdeConfigFiles } from "./esde-config-import";
import { contentCommand, cleanQueryOutput, queryMediaStoreFiles } from "./media-store";
import { mergeEsdeSettings, parseEsdeSettings } from "./esde-profile";
import { launchEsde, stopEsde, verifyEsdeStartup, type EsdeStartup } from "./esde-runtime";
import { readSharedStorageText, writeSharedStorageText } from "./shared-storage-text";
import { shellCommand } from "./transport";
import { ESDE_THEME } from "./esde-theme-source";
import { esdeThemeDiscovered } from "./esde-theme";
import type { EsdeThemeTransfer } from "./esde-theme-transfer";
import { esdeThemeStartupScript } from "./esde-theme-script";
import type { EsdeConfigurationProfile } from "./esde-profile";
import type { EsdeContext } from "./esde-types";

async function waitThemeInstallation(context: EsdeContext, journal: string, token: string): Promise<void> {
  const deadline = Date.now() + 240_000;
  let previous = "";
  while (Date.now() < deadline) {
    context.signal?.throwIfAborted();
    const text = await readSharedStorageText(context.device, context.user, journal, 4096, context.signal);
    if (text === undefined) continue;
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || !("schema" in value) || value.schema !== 1
      || !("token" in value) || value.token !== token || !("phase" in value) || typeof value.phase !== "string"
      || !["checking", "extracting", "publishing", "complete", "failed"].includes(value.phase)) {
      throw new Error("ES-DE returned an invalid theme installation status.");
    }
    if (value.phase === "failed") {
      const step = "step" in value && typeof value.step === "string" && /^[a-z]+$/.test(value.step) ? value.step : "unknown";
      throw new Error(`ES-DE's native theme installation failed during ${step}. Its original settings were retained.`);
    }
    if (value.phase === "complete") return;
    if (value.phase !== previous) {
      previous = value.phase;
      const labels: Record<string, string> = {
        checking: `ES-DE is checking the ${ESDE_THEME.name} archive…`,
        extracting: `ES-DE is unpacking ${ESDE_THEME.name}…`, publishing: "ES-DE is finishing the theme installation…",
      };
      context.options.onStatus?.(labels[value.phase] ?? `Preparing ${ESDE_THEME.name}…`);
    }
  }
  throw new Error("ES-DE did not finish its native theme installation in time.");
}

/** The site downloads and uploads in the background. ES-DE's startup event
 * only authenticates and unpacks that completed archive in the app's context. */
export async function prepareEsdeTheme(
  context: EsdeContext, profile: EsdeConfigurationProfile, startup: EsdeStartup, transfer?: EsdeThemeTransfer,
): Promise<{ startup: EsdeStartup; restartRequired: boolean }> {
  if (parseEsdeSettings(profile.settings ?? "").get("Theme")?.value !== ESDE_THEME.directory || esdeThemeDiscovered(startup.log)) {
    return { startup, restartRequired: false };
  }
  if (!transfer || transfer.user !== context.user || transfer.dataDirectory !== context.workspace.esde) {
    throw new Error("The background theme transfer does not belong to this ES-DE library.");
  }
  context.options.onStatus?.(`Waiting for the background ${ESDE_THEME.name} download and transfer…`);
  const archive = await transfer.ready;
  if (!archive) throw new Error("The previously discovered ES-DE theme is missing. Inspect its theme folder before retrying.");
  context.signal?.throwIfAborted();
  return installEsdeTheme(context, archive);
}

async function installEsdeTheme(
  context: EsdeContext, archive: string,
): Promise<{ startup: EsdeStartup; restartRequired: boolean }> {
  await stopEsde(context);
  const settingsPath = `${context.workspace.esde}/settings/es_settings.xml`;
  const original = await readSharedStorageText(context.device, context.user, settingsPath, 2_097_152, context.signal);
  if (original === undefined) throw new Error("ES-DE must generate its native settings before installing a theme.");
  const scripting = parseEsdeSettings(original).get("CustomEventScripts");
  if (scripting?.type !== "bool") throw new Error("This ES-DE installation does not expose native event scripts.");
  if (scripting.value === "false" && (await queryMediaStoreFiles(context.device, context.user, `${context.workspace.esde}/scripts`, context.signal)).length) {
    throw new Error(`ES-DE has existing disabled event scripts. Install ${ESDE_THEME.name} through ES-DE's theme downloader before configuring this installation automatically.`);
  }
  const tools = (await context.device.shell(shellCommand("sh", "-c", [
    "command -v unzip >/dev/null || exit 1", "command -v sha256sum >/dev/null || exit 1",
    "printf ready",
  ].join("\n")))).trim();
  if (tools !== "ready") throw new Error("Android does not provide the native archive tools required by ES-DE's theme installer.");
  const token = crypto.randomUUID();
  const script = `${context.workspace.esde}/scripts/startup/emukase-theme-${token}.sh`;
  // ES-DE wraps event-script paths in double quotes before passing them to sh.
  // Its native wrapper does not escape shell expansions in directory names.
  if (/[`$"\\]/.test(script)) throw new Error("ES-DE's native event scripts require a library folder without shell expansion characters.");
  const journal = `${context.workspace.setup}/esde/theme-${token}.json`;
  let enabled = false;
  let installed: EsdeStartup | undefined;
  try {
    await writeSharedStorageText(context.device, context.user, script, esdeThemeStartupScript(context, token, script, journal, archive), { signal: context.signal });
    if (scripting.value === "false") {
      // Reuse the normal XML writer's backups and compare-before-write guard.
      enabled = true;
      await applyEsdeConfigFiles(context, [{ path: settingsPath, original,
        applied: mergeEsdeSettings(original, '<bool name="CustomEventScripts" value="true" />') }]);
    }
    context.options.onStatus?.(`Installing the ${ESDE_THEME.name} theme in ES-DE…`);
    const launch = await launchEsde(context);
    await waitThemeInstallation(context, journal, token);
    installed = await verifyEsdeStartup(context, launch);
    if (!esdeThemeDiscovered(installed.log)) throw new Error(`ES-DE did not discover ${ESDE_THEME.name} after its native installer completed.`);
  } finally {
    // Restore the original switch even on cancellation. The script also removes
    // itself on-device, so a lost host response never replays the installer.
    const recovery: EsdeContext = { ...context, signal: undefined,
      device: userScopedDevice(context.device.restorationDevice ?? context.device, context.user),
      options: {}, ensureUnlocked: async () => true };
    await stopEsde(recovery);
    if (enabled) {
      const current = await readSharedStorageText(recovery.device, context.user, settingsPath, 2_097_152);
      if (current === undefined) throw new Error("ES-DE's event-script setting could not be restored; its XML backup was retained.");
      const restored = mergeEsdeSettings(current, '<bool name="CustomEventScripts" value="false" />');
      if (restored !== current) await applyEsdeConfigFiles(recovery, [{ path: settingsPath, original: current, applied: restored }]);
    }
    const where = `_data='${script.replaceAll("'", "''")}'`;
    const removed = cleanQueryOutput(await contentCommand(recovery.device, context.user, ["delete", "--where", where]));
    if (removed) throw new Error("Android did not confirm cleanup of ES-DE's temporary theme installer.");
  }
  if (!installed) throw new Error("ES-DE's native theme installation was not verified.");
  return { startup: installed, restartRequired: true };
}
