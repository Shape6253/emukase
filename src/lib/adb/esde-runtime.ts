import { hasAndroidTreeReadGrant } from "./android-document-picker";
import { androidUserProcessPid } from "./android-user";
import { assertEsdeStorageAccess } from "./esde-environment";
import { readEsdeText, recordEsdeRecovery } from "./esde-files";
import { esdeWizardActions } from "./esde-onboarding";
import { parseEsdeSettings } from "./esde-profile";
import { ESDE_PACKAGE } from "./esde-types";
import type { EsdeContext } from "./esde-types";
import { restartEmulator, waitEmulatorUi } from "./emulator-ui";
import { checkActivityStart, shellCommand } from "./transport";

export interface EsdeLaunchEvidence {
  beforePid: string;
  previousLog: string | undefined;
}

export interface EsdeStartup {
  pid: string;
  log: string;
  settings: string;
  library: "loaded" | "empty";
}

export async function stopEsde(context: EsdeContext): Promise<void> {
  if (!await androidUserProcessPid(context.device, ESDE_PACKAGE, context.user, context.signal)) return;
  if (!context.home.startsWith(`${ESDE_PACKAGE}/`)) {
    await restartEmulator(context, ESDE_PACKAGE, "ES-DE");
    return;
  }
  // HOME cannot stop an app that is itself HOME. Open the standard Settings
  // intent to run ES-DE's onStop without assigning another launcher.
  await context.ensureUnlocked();
  checkActivityStart(await context.device.shell(shellCommand("am", "start", "--user", String(context.user), "--display", "0", "-W", "-a", "android.settings.SETTINGS")));
  const deadline = Date.now() + 15_000;
  let stopped = false;
  while (Date.now() < deadline) {
    context.signal?.throwIfAborted();
    const activities = await context.device.shell(shellCommand("dumpsys", "activity", "activities"));
    const records = activities.split(/(?=^\s*\* Hist\s+#\d+:)/m).filter((block) =>
      new RegExp(`^\\s*\\* Hist\\s+#\\d+: ActivityRecord\\{[a-f\\d]+ u${context.user} org\\.es_de\\.frontend/`).test(block));
    if (records.length && records.every((block) => /^\s+state=STOPPED\b/m.test(block) || /^\s+app=null\s*$/m.test(block))) { stopped = true; break; }
  }
  if (!stopped) throw new Error("ES-DE did not finish saving its settings before import.");
  await context.device.shell(shellCommand("am", "force-stop", "--user", String(context.user), ESDE_PACKAGE));
  if (await androidUserProcessPid(context.device, ESDE_PACKAGE, context.user, context.signal)) throw new Error("ES-DE restarted before configuration could be imported.");
}

/** Counts and completion signals are capabilities, not a version or a fixed
 * number of bundled systems. A populated customer library is supported. */
export function esdeStartupState(log: string): "loaded" | "empty" | undefined {
  if (/\b(?:Error|Fatal):/i.test(log)) throw new Error("ES-DE reported a startup/configuration error; its original backups were retained.");
  const games = [...log.matchAll(/Total game count: (\d+)\b/g)];
  const count = games[0]?.[1];
  if (games.length !== 1 || count === undefined || !Number.isSafeInteger(Number(count))) return undefined;
  if (Number(count) === 0 && /No game files were found/.test(log)) return "empty";
  const systems = [...log.matchAll(/Parsed configuration for (\d+) systems?, loaded (\d+) systems?\b/g)];
  if (systems.length === 1 && Number(systems[0]?.[2]) > 0
    && /Finished loading theme "[^"\r\n]+"/.test(log)) return "loaded";
  return undefined;
}

export async function launchEsde(context: EsdeContext): Promise<EsdeLaunchEvidence> {
  await context.ensureUnlocked();
  const beforePid = await androidUserProcessPid(context.device, ESDE_PACKAGE, context.user, context.signal);
  if (beforePid) await stopEsde(context);
  const previousLog = await readEsdeText(context, `${context.workspace.esde}/logs/es_log.txt`);
  checkActivityStart(await context.device.shell(shellCommand("am", "start", "--user", String(context.user), "--display", "0", "-W", "-n", context.launcher)));
  return { beforePid, previousLog };
}

export async function verifyEsdeStartup(context: EsdeContext, launch: EsdeLaunchEvidence): Promise<EsdeStartup> {
  const startup = await waitEmulatorUi(context, async (snapshot) => {
    if (!snapshot.component.startsWith(`${ESDE_PACKAGE}/`)) return undefined;
    if (esdeWizardActions(snapshot, "welcome") || esdeWizardActions(snapshot, "directories")) {
      throw new Error("ES-DE still requires onboarding; no completed configuration was reported.");
    }
    const pid = await androidUserProcessPid(context.device, ESDE_PACKAGE, context.user, context.signal);
    if (!pid || pid === launch.beforePid) return undefined;
    const log = await readEsdeText(context, `${context.workspace.esde}/logs/es_log.txt`);
    if (log === undefined || log === launch.previousLog) return undefined;
    const library = esdeStartupState(log);
    if (!library) return undefined;
    const settings = await readEsdeText(context, `${context.workspace.esde}/settings/es_settings.xml`);
    if (settings === undefined || !parseEsdeSettings(settings).size) throw new Error("ES-DE did not expose its active settings file.");
    return { pid, log, settings, library };
  }, 60_000);
  await assertEsdeStorageAccess(context);
  for (const path of [context.workspace.esde, context.workspace.roms]) {
    if (!await hasAndroidTreeReadGrant(context, ESDE_PACKAGE, path, true)) {
      throw new Error("ES-DE's exact data/ROM folder grant did not survive restart. Reconnect the folders in ES-DE before importing settings.");
    }
  }
  if (await androidUserProcessPid(context.device, ESDE_PACKAGE, context.user, context.signal) !== startup.pid) {
    throw new Error("ES-DE's process changed during configuration verification.");
  }
  await recordEsdeRecovery(context, "startup", "verified", { dataDirectory: context.workspace.esde,
    romDirectory: context.workspace.roms, library: startup.library, version: context.installed.version });
  return startup;
}
