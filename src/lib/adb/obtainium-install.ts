import { AndroidUiStateChangedError, pressAndroidUiKey, tapAndroidUi, type AndroidUiNode, type AndroidUiSnapshot } from "./android-ui";
import { withAndroidUiDump } from "./android-ui-dump";
import { clickAndroidUiNode } from "./android-ui-action";
import { readAndroidPackage } from "./android-package";
import { assertAndroidUser, readAndroidUser, userScopedDevice } from "./android-user";
import type { Abi } from "./catalog";
import { libraryPlatform } from "./library-catalog";
import { createRetroArchObtainiumApp, getObtainiumTrackedApps, type ObtainiumAppImport } from "./obtainium-catalog";
import { obtainiumInstallAction } from "./obtainium-install-anchors";
import { readObtainiumInstallLabels } from "./obtainium-labels";
import { importObtainiumApps, validateObtainiumApps } from "./obtainium-import";
import { isObtainium, openObtainiumUri, uiLabel, waitObtainiumState, withObtainiumAwake, type ObtainiumContext } from "./obtainium-ui";
import { OBTAINIUM_PACKAGE, obtainiumDialog } from "./obtainium-ui-anchors";
import { checkAbort } from "./setup-events";
import { shellCommand, type DeviceTransport } from "./transport";

export interface ObtainiumInstallOptions {
  signal?: AbortSignal;
  reportStatus: ObtainiumContext["reportStatus"];
  log?: (message: string) => void;
  importSource?: boolean;
}

export class ObtainiumNotInstalledError extends Error {
  constructor() {
    super("Obtainium is not installed in this Android profile.");
    this.name = "ObtainiumNotInstalledError";
  }
}

function androidInstallAction(snapshot: AndroidUiSnapshot, app: ObtainiumAppImport): AndroidUiNode | undefined {
  const owner = snapshot.component.split("/")[0];
  if (!["com.google.android.packageinstaller", "com.android.packageinstaller"].includes(owner ?? "")
    || snapshot.component !== `${owner}/com.android.packageinstaller.PackageInstallerActivity`) return undefined;
  const names = app.id === "com.retroarch.aarch64" ? ["RetroArch (AArch64)"]
    : app.id === "com.retroarch.ra32" ? ["RetroArch (32-bit)"]
    : app.id === "org.dolphinemu.dolphinemu" ? [app.name, "Dolphin Emulator"]
    : app.id === "rip.moth.cocoonshell" ? [app.name, "Cocoon"] : [app.name];
  const nodes = snapshot.nodes.filter((node) => node.packageName === owner);
  const titles = nodes.filter((node) => ["android:id/alertTitle", "com.android.packageinstaller:id/app_name"].includes(node.resourceId)
    && names.includes(uiLabel(node)));
  const title = titles[0];
  if (titles.length !== 1 || !title
    || nodes.filter((node) => node.resourceId === "com.android.packageinstaller:id/install_confirm_question").length !== 1) return undefined;
  const id = title.resourceId === "android:id/alertTitle" ? "android:id/button1" : "com.android.packageinstaller:id/ok_button";
  const buttons = nodes.filter((node) => node.resourceId === id && node.className === "android.widget.Button"
    && node.enabled && node.clickable && node.focusable);
  return buttons.length === 1 ? buttons[0] : undefined;
}

export async function installEmulatorViaObtainium(
  device: DeviceTransport, platformId: string, abi: Abi, options: ObtainiumInstallOptions,
): Promise<string> {
  const platform = libraryPlatform(platformId);
  const app = [createRetroArchObtainiumApp(abi), ...getObtainiumTrackedApps(abi)]
    .find((entry) => platform.emulatorPackages.includes(entry.id));
  if (!app) throw new Error(`${platform.emulator} is not supported on this device's architecture.`);
  return installApplicationViaObtainium(device, app, options);
}

/** Install a validated catalog application, optionally registering its update source first. */
export async function installApplicationViaObtainium(
  device: DeviceTransport, app: ObtainiumAppImport, options: ObtainiumInstallOptions,
): Promise<string> {
  app = structuredClone(app);
  validateObtainiumApps([app]);
  const { signal, reportStatus } = options;
  const user = await readAndroidUser(device, signal);
  const scoped = userScopedDevice(device, user, signal);
  await reportStatus("Checking Obtainium…");
  const obtainium = await readAndroidPackage(scoped, OBTAINIUM_PACKAGE, user, signal);
  if (!obtainium) throw new ObtainiumNotInstalledError();
  const installedBefore = await readAndroidPackage(scoped, app.id, user, signal);
  if (installedBefore && !options.importSource) return app.id;
  const context: ObtainiumContext = { device: scoped, user, signal, reportStatus };
  let started = false;
  let deferredActions = 0;
  let lastDeferredAction = "";
  let focusSteps = 0;
  const activateWhenReady = async (snapshot: AndroidUiSnapshot, action: AndroidUiNode, keyboardOnly = false): Promise<boolean> => {
    try {
      // Address the installer button first; keyboard focus is only a compatibility fallback.
      const directlyActivated = keyboardOnly && await clickAndroidUiNode(scoped, user, snapshot, action, signal);
      if (keyboardOnly && !directlyActivated) {
        const focused = snapshot.nodes.filter((node) => node.packageName === action.packageName && node.focused && node.clickable);
        if (!action.focused || focused.length !== 1 || focused[0] !== action) {
          if (focusSteps >= 8) throw new Error(`${app.name}'s installation control did not receive keyboard focus.`);
          await pressAndroidUiKey(scoped, user, snapshot, "KEYCODE_TAB", signal);
          focusSteps++;
          return false;
        }
        await pressAndroidUiKey(scoped, user, snapshot, "KEYCODE_ENTER", signal);
      } else if (!keyboardOnly) {
        // Flutter's long detail page can require many TABs; use its reviewed action directly.
        await tapAndroidUi(scoped, user, snapshot, action, signal);
      }
    } catch (error) {
      checkAbort(signal);
      if (!(error instanceof AndroidUiStateChangedError)) throw error;
      lastDeferredAction = error.message;
      if (deferredActions++ === 0) options.log?.(`${app.name}: waiting for a fresh UI before installation. ${lastDeferredAction}`);
      return false;
    }
    if (deferredActions) options.log?.(`${app.name}: UI recovered after ${deferredActions} deferred actions.`);
    deferredActions = 0;
    focusSteps = 0;
    return true;
  };
  try {
    if (options.importSource) {
      await withObtainiumAwake(context, async () => {
        await scoped.shell(shellCommand("am", "force-stop", "--user", String(user), OBTAINIUM_PACKAGE));
        started = true;
        await openObtainiumUri(context);
      });
      await importObtainiumApps({ ...context, log: options.log ?? (() => {}) }, [app], { refresh: false });
    }
    if (installedBefore) return app.id;
    const installLabels = await readObtainiumInstallLabels(scoped, user, signal);
    await withAndroidUiDump(scoped, signal, () => withObtainiumAwake(context, async (ensureUnlocked) => {
      // Import already restarted without a URI. Otherwise discard any stale launch link,
      // then let Obtainium open the requested app directly, including from a cold start.
      if (!options.importSource) {
        await scoped.shell(shellCommand("am", "force-stop", "--user", String(user), OBTAINIUM_PACKAGE));
        started = true;
      }
      await reportStatus(`Opening ${app.name} in Obtainium…`);
      await openObtainiumUri(context, `obtainium://add/${encodeURIComponent(app.url)}`);
      const ready = (value: AndroidUiSnapshot): { snapshot: AndroidUiSnapshot; action: AndroidUiNode } | undefined => {
        if (obtainiumDialog(value)) throw new Error("Obtainium could not open the emulator source. Check it on the device.");
        if (isObtainium(value) && value.nodes.some((node) => node.packageName === OBTAINIUM_PACKAGE
          && node.className === "android.widget.EditText" && uiLabel(node) === app.url)) {
          throw new Error(`${app.name} is not in Obtainium's app list. Run Setup to add its source first.`);
        }
        const action = obtainiumInstallAction(value, app, installLabels);
        return action ? { snapshot: value, action } : undefined;
      };
      await waitObtainiumState(context, ensureUnlocked, async (value) => {
        const target = ready(value);
        return target && await activateWhenReady(target.snapshot, target.action) ? true : undefined;
      }, 120_000);
      await reportStatus(`Installing ${app.name} through Obtainium…`);
      let androidConfirmed = false;
      await waitObtainiumState(context, ensureUnlocked, async (value) => {
        const confirm = androidInstallAction(value, app);
        if (confirm) {
          if (!androidConfirmed) {
            androidConfirmed = await activateWhenReady(value, confirm, true);
          }
          return undefined;
        }
        const installed = await readAndroidPackage(scoped, app.id, user, signal);
        if (installed) {
          if (installed.installer !== OBTAINIUM_PACKAGE) throw new Error(`${app.name} was not installed by Obtainium.`);
          return true;
        }
        if (obtainiumDialog(value)) throw new Error(`Obtainium could not install ${app.name}. Check the message on the device.`);
        if (value.component.endsWith("/com.android.packageinstaller.InstallFailed")) {
          throw new Error(`Android could not install ${app.name}. Check the message on the device.`);
        }
        return undefined;
      }, 600_000);
    }));
  } catch (error) {
    if (deferredActions) options.log?.(`${app.name}: installation stopped after ${deferredActions} deferred UI actions. Last observation: ${lastDeferredAction}`);
    if (started) {
      const cleanup = scoped.restorationDevice ?? scoped;
      try {
        await assertAndroidUser(cleanup, user);
        await cleanup.shell(shellCommand("am", "force-stop", "--user", String(user), OBTAINIUM_PACKAGE));
      } catch { /* Preserve the installation error if the device disconnected or changed profiles. */ }
    }
    throw error;
  }
  return app.id;
}
