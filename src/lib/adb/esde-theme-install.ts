import { userScopedDevice } from "./android-user";
import { createBrowserDownloader } from "./download";
import { applyEsdeConfigFiles } from "./esde-config-import";
import { contentCommand, cleanQueryOutput, queryMediaStoreFiles } from "./media-store";
import { uploadMediaStoreFile } from "./media-store-upload";
import { mergeEsdeSettings, parseEsdeSettings } from "./esde-profile";
import { launchEsde, stopEsde, verifyEsdeStartup, type EsdeStartup } from "./esde-runtime";
import { readSharedStorageText, writeSharedStorageText } from "./shared-storage-text";
import { shellCommand } from "./transport";
import { ELEMENTERIAL_THEME } from "./esde-theme-source";
import { esdeThemeStartupScript } from "./esde-theme-script";
import type { EsdeConfigurationProfile } from "./esde-profile";
import type { EsdeContext } from "./esde-types";

class NativeThemeDownloadError extends Error {}

function discovered(log: string): boolean {
  return [...log.matchAll(/Added theme "([^"\r\n]+)"/g)].some((match) => match[1]?.split("/").at(-1) === ELEMENTERIAL_THEME.directory);
}

async function waitThemeInstallation(context: EsdeContext, journal: string, token: string, nativeDownload: boolean): Promise<void> {
  const deadline = Date.now() + 240_000;
  let previous = "";
  while (Date.now() < deadline) {
    context.signal?.throwIfAborted();
    const text = await readSharedStorageText(context.device, context.user, journal, 4096, context.signal);
    if (text === undefined) continue;
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || !("schema" in value) || value.schema !== 1
      || !("token" in value) || value.token !== token || !("phase" in value) || typeof value.phase !== "string"
      || !["downloading", "checking", "extracting", "publishing", "complete", "failed"].includes(value.phase)) {
      throw new Error("ES-DE returned an invalid theme installation status.");
    }
    if (value.phase === "failed") {
      const step = "step" in value && typeof value.step === "string" && /^[a-z]+$/.test(value.step) ? value.step : "unknown";
      if (step === "downloading" && nativeDownload) throw new NativeThemeDownloadError("ES-DE could not download the theme directly on Android.");
      throw new Error(`ES-DE's native theme installation failed during ${step}. Its original settings were retained.`);
    }
    if (value.phase === "complete") return;
    if (value.phase !== previous) {
      previous = value.phase;
      const labels: Record<string, string> = {
        downloading: "ES-DE is downloading Elementerial directly on Android (82 MB)…",
        checking: "ES-DE is checking the Elementerial archive…",
        extracting: "ES-DE is unpacking Elementerial…", publishing: "ES-DE is finishing the theme installation…",
      };
      context.options.onStatus?.(labels[value.phase] ?? "Preparing Elementerial…");
    }
  }
  throw new Error("ES-DE did not finish its native theme installation in time.");
}

async function browserArchive(context: EsdeContext, token: string): Promise<string> {
  context.options.onStatus?.("Downloading Elementerial through the browser (82 MB)…");
  const download = createBrowserDownloader({ requestUrl(url, route) {
    if (route !== "artifact" || url !== ELEMENTERIAL_THEME.url) throw new Error("Invalid ES-DE theme download source.");
    return `/api/esde-theme/artifact?url=${encodeURIComponent(url)}`;
  } }, { signal: context.signal, maxBytes: ELEMENTERIAL_THEME.bytes });
  const artifact = await download.file?.(ELEMENTERIAL_THEME.url);
  if (!artifact) throw new Error("The theme downloader could not create its temporary file.");
  const name = `elementerial-${token}.zip`;
  try {
    await uploadMediaStoreFile(context.device, context.user, `${context.workspace.setup}/esde`,
      new File([artifact.file], name), { signal: context.signal });
  } finally { await artifact.dispose(); }
  return `${context.workspace.setup}/esde/${name}`;
}

/** ES-DE's native startup event downloads and unpacks in the app's storage
 * context. Only a small script crosses USB; no theme-specific DEX is involved. */
export async function prepareEsdeTheme(
  context: EsdeContext, profile: EsdeConfigurationProfile, startup: EsdeStartup,
): Promise<{ startup: EsdeStartup; restartRequired: boolean }> {
  if (parseEsdeSettings(profile.settings ?? "").get("Theme")?.value !== ELEMENTERIAL_THEME.directory || discovered(startup.log)) {
    return { startup, restartRequired: false };
  }
  try {
    return await installEsdeTheme(context, false);
  } catch (error) {
    // Only an explicit download failure before extraction permits the browser
    // route. An uncertain response or publication is never retried.
    if (!(error instanceof NativeThemeDownloadError) || context.signal?.aborted) throw error;
    context.options.onStatus?.("Direct Android download is unavailable; downloading the theme through the browser…");
    return installEsdeTheme(context, true);
  }
}

async function installEsdeTheme(
  context: EsdeContext, throughBrowser: boolean,
): Promise<{ startup: EsdeStartup; restartRequired: boolean }> {
  await stopEsde(context);
  const settingsPath = `${context.workspace.esde}/settings/es_settings.xml`;
  const original = await readSharedStorageText(context.device, context.user, settingsPath, 2_097_152, context.signal);
  if (original === undefined) throw new Error("ES-DE must generate its native settings before installing a theme.");
  const scripting = parseEsdeSettings(original).get("CustomEventScripts");
  if (scripting?.type !== "bool") throw new Error("This ES-DE installation does not expose native event scripts.");
  if (scripting.value === "false" && (await queryMediaStoreFiles(context.device, context.user, `${context.workspace.esde}/scripts`, context.signal)).length) {
    throw new Error("ES-DE has existing disabled event scripts. Install Elementerial through ES-DE's theme downloader before configuring this installation automatically.");
  }
  const tools = (await context.device.shell(shellCommand("sh", "-c", [
    "command -v unzip >/dev/null || exit 1", "command -v sha256sum >/dev/null || exit 1",
    "if command -v curl >/dev/null; then printf native; else printf browser; fi",
  ].join("\n")))).trim();
  if (!["native", "browser"].includes(tools)) throw new Error("Android does not provide the native archive tools required by ES-DE's theme installer.");
  const token = crypto.randomUUID();
  const script = `${context.workspace.esde}/scripts/startup/emukase-elementerial-${token}.sh`;
  // ES-DE wraps event-script paths in double quotes before passing them to sh.
  // Its native wrapper does not escape shell expansions in directory names.
  if (/[`$"\\]/.test(script)) throw new Error("ES-DE's native event scripts require a library folder without shell expansion characters.");
  const journal = `${context.workspace.setup}/esde/theme-${token}.json`;
  let archive: string | undefined;
  let enabled = false;
  let installed: EsdeStartup | undefined;
  try {
    if (throughBrowser || tools === "browser") archive = await browserArchive(context, token);
    await writeSharedStorageText(context.device, context.user, script, esdeThemeStartupScript(context, token, script, journal, archive), { signal: context.signal });
    if (scripting.value === "false") {
      // Reuse the normal XML writer's backups and compare-before-write guard.
      enabled = true;
      await applyEsdeConfigFiles(context, [{ path: settingsPath, original,
        applied: mergeEsdeSettings(original, '<bool name="CustomEventScripts" value="true" />') }]);
    }
    context.options.onStatus?.("Installing the Elementerial theme in ES-DE…");
    const launch = await launchEsde(context);
    await waitThemeInstallation(context, journal, token, archive === undefined);
    installed = await verifyEsdeStartup(context, launch);
    if (!discovered(installed.log)) throw new Error("ES-DE did not discover Elementerial after its native installer completed.");
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
    const paths = [script, ...(archive ? [archive] : [])];
    const where = paths.map((path) => `_data='${path.replaceAll("'", "''")}'`).join(" OR ");
    const removed = cleanQueryOutput(await contentCommand(recovery.device, context.user, ["delete", "--where", where]));
    if (removed) throw new Error("Android did not confirm cleanup of ES-DE's temporary theme installer.");
  }
  if (!installed) throw new Error("ES-DE's native theme installation was not verified.");
  return { startup: installed, restartRequired: true };
}
