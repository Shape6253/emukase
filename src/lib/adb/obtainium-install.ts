import { AndroidUiStateChangedError, tapAndroidUi, type AndroidUiNode, type AndroidUiSnapshot } from "./android-ui";
import { withAndroidUiDump } from "./android-ui-dump";
import { readAndroidPackage } from "./android-package";
import { assertAndroidUser, readAndroidUser, userScopedDevice } from "./android-user";
import type { Abi } from "./catalog";
import { libraryPlatform } from "./library-catalog";
import { createRetroArchObtainiumApp, getObtainiumTrackedApps, type ObtainiumAppImport } from "./obtainium-catalog";
import { isObtainium, obtainiumHome, openObtainiumUri, uiLabel, waitObtainiumState, withObtainiumAwake, type ObtainiumContext } from "./obtainium-ui";
import { OBTAINIUM_PACKAGE, isUiDescendant, obtainiumDialog } from "./obtainium-ui-anchors";
import { shellCommand, type DeviceTransport } from "./transport";

export interface ObtainiumInstallOptions {
  signal?: AbortSignal;
  reportStatus: ObtainiumContext["reportStatus"];
}

export class ObtainiumNotInstalledError extends Error {
  constructor() {
    super("Obtainium is not installed in this Android profile.");
    this.name = "ObtainiumNotInstalledError";
  }
}

function appDetail(
  snapshot: AndroidUiSnapshot, app: ObtainiumAppImport,
): { pane: AndroidUiNode; scroll: AndroidUiNode } | undefined {
  if (!isObtainium(snapshot) || obtainiumDialog(snapshot)) return undefined;
  const owned = snapshot.nodes.filter((node) => node.packageName === OBTAINIUM_PACKAGE);
  const details: { pane: AndroidUiNode; scroll: AndroidUiNode }[] = [];
  for (const scroll of owned.filter((node) => node.className === "android.widget.ScrollView")) {
    const parent = scroll.parent === null ? undefined : snapshot.nodes[scroll.parent];
    const pane = parent?.parent === null || parent?.parent === undefined ? undefined : snapshot.nodes[parent.parent];
    if (!pane) continue;
    // The list search remains mounted beside the details in Obtainium's two-pane layout.
    const contents = owned.filter((node) => isUiDescendant(snapshot, node, pane));
    if (contents.filter((node) => node.className === "android.widget.ScrollView").length !== 1
      || contents.some((node) => ["android.widget.EditText", "android.webkit.WebView"].includes(node.className))) continue;
    // The add URI selects the tracked source by URL; that URL may be below the viewport.
    if (contents.some((node) => uiLabel(node) === app.name && isUiDescendant(snapshot, node, scroll))) {
      details.push({ pane, scroll });
    }
  }
  return details.length === 1 ? details[0] : undefined;
}

function installAction(snapshot: AndroidUiSnapshot, app: ObtainiumAppImport): AndroidUiNode | undefined {
  const detail = appDetail(snapshot, app);
  if (!detail) return undefined;
  const { pane, scroll } = detail;
  const buttons = snapshot.nodes.filter((node) => node.packageName === OBTAINIUM_PACKAGE
    && node.parent === snapshot.nodes.indexOf(pane) && node.className === "android.widget.Button");
  const actions = buttons.filter((node) => node.bounds[1] >= scroll.bounds[3]);
  const primary = buttons.at(-1);
  // Obtainium 1.6.17 places its primary action last in the footer's semantic order, including RTL.
  // Its download-size label can make it taller than the neighboring icon buttons.
  if (actions.length < 2 || !primary || !actions.includes(primary) || !primary.enabled || !primary.clickable || !primary.focusable
    || primary.bounds[2] <= primary.bounds[0] || primary.bounds[3] <= primary.bounds[1]
    || Math.max(...actions.map((node) => node.bounds[1])) >= Math.min(...actions.map((node) => node.bounds[3]))) return undefined;
  return primary;
}

function androidInstallAction(snapshot: AndroidUiSnapshot, app: ObtainiumAppImport): AndroidUiNode | undefined {
  const owner = snapshot.component.split("/")[0];
  if (!["com.google.android.packageinstaller", "com.android.packageinstaller"].includes(owner ?? "")
    || snapshot.component !== `${owner}/com.android.packageinstaller.PackageInstallerActivity`) return undefined;
  const names = app.id === "com.retroarch.aarch64" ? ["RetroArch (AArch64)"]
    : app.id === "com.retroarch.ra32" ? ["RetroArch (32-bit)"]
    : app.id === "org.dolphinemu.dolphinemu" ? [app.name, "Dolphin Emulator"] : [app.name];
  const nodes = snapshot.nodes.filter((node) => node.packageName === owner);
  const titles = nodes.filter((node) => ["android:id/alertTitle", "com.android.packageinstaller:id/app_name"].includes(node.resourceId)
    && names.includes(uiLabel(node)));
  const title = titles[0];
  if (titles.length !== 1 || !title
    || nodes.filter((node) => node.resourceId === "com.android.packageinstaller:id/install_confirm_question").length !== 1) return undefined;
  const id = title.resourceId === "android:id/alertTitle" ? "android:id/button1" : "com.android.packageinstaller:id/ok_button";
  const buttons = nodes.filter((node) => node.resourceId === id && node.className === "android.widget.Button"
    && node.enabled && node.clickable);
  return buttons.length === 1 ? buttons[0] : undefined;
}

export async function installEmulatorViaObtainium(
  device: DeviceTransport, platformId: string, abi: Abi, options: ObtainiumInstallOptions,
): Promise<void> {
  const platform = libraryPlatform(platformId);
  const app = [createRetroArchObtainiumApp(abi), ...getObtainiumTrackedApps(abi)]
    .find((entry) => platform.emulatorPackages.includes(entry.id));
  if (!app) throw new Error(`${platform.emulator} is not supported on this device's architecture.`);
  const { signal, reportStatus } = options;
  const user = await readAndroidUser(device, signal);
  const scoped = userScopedDevice(device, user, signal);
  await reportStatus("Checking Obtainium…");
  const obtainium = await readAndroidPackage(scoped, OBTAINIUM_PACKAGE, user, signal);
  if (!obtainium) throw new ObtainiumNotInstalledError();
  if (obtainium.version !== "1.6.17") throw new Error("This Obtainium version has not been qualified for automatic installation.");
  if (await readAndroidPackage(scoped, app.id, user, signal)) return;
  const context: ObtainiumContext = { device: scoped, user, signal, reportStatus };
  let started = false;
  try {
    await withAndroidUiDump(scoped, signal, () => withObtainiumAwake(context, async (ensureUnlocked) => {
      // A fresh launch avoids replaying Obtainium's previous import link.
      await scoped.shell(shellCommand("am", "force-stop", "--user", String(user), OBTAINIUM_PACKAGE));
      started = true;
      await openObtainiumUri(context);
      await waitObtainiumState(context, ensureUnlocked, (snapshot) => {
        if (obtainiumDialog(snapshot)) throw new Error("Finish Obtainium setup on the Setup page first.");
        return obtainiumHome(snapshot) ? true : undefined;
      });
      await reportStatus(`Opening ${app.name} in Obtainium…`);
      await openObtainiumUri(context, `obtainium://add/${encodeURIComponent(app.url)}`);
      const ready = (value: AndroidUiSnapshot): { snapshot: AndroidUiSnapshot; action: AndroidUiNode } | undefined => {
        if (obtainiumDialog(value)) throw new Error("Obtainium could not open the emulator source. Check it on the device.");
        if (isObtainium(value) && value.nodes.some((node) => node.packageName === OBTAINIUM_PACKAGE
          && node.className === "android.widget.EditText" && uiLabel(node) === app.url)) {
          throw new Error(`${app.name} is not in Obtainium's app list. Run Setup to add its source first.`);
        }
        const action = installAction(value, app);
        return action ? { snapshot: value, action } : undefined;
      };
      const activate = async (): Promise<void> => {
        const { snapshot, action } = await waitObtainiumState(context, ensureUnlocked, ready, 120_000);
        await tapAndroidUi(scoped, user, snapshot, action, signal);
      };
      try {
        await activate();
      } catch (error) {
        if (!(error instanceof AndroidUiStateChangedError)) throw error;
        await activate();
      }
      await reportStatus(`Installing ${app.name} through Obtainium…`);
      let androidConfirmed = false;
      await waitObtainiumState(context, ensureUnlocked, async (value) => {
        const confirm = androidInstallAction(value, app);
        if (confirm) {
          if (!androidConfirmed) {
            try {
              await tapAndroidUi(scoped, user, value, confirm, signal);
              androidConfirmed = true;
            } catch (error) {
              if (!(error instanceof AndroidUiStateChangedError)) throw error;
            }
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
    if (started) {
      const cleanup = scoped.restorationDevice ?? scoped;
      try {
        await assertAndroidUser(cleanup, user);
        await cleanup.shell(shellCommand("am", "force-stop", "--user", String(user), OBTAINIUM_PACKAGE));
      } catch { /* Preserve the installation error if the device disconnected or changed profiles. */ }
    }
    throw error;
  }
}
