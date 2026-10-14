import type { ApplicationExtraStep } from "./application-install";
import type { ObtainiumRelease } from "./obtainium-release";
import { prepareObtainium, OBTAINIUM_PACKAGE } from "./obtainium-ui";
import { createRetroArchObtainiumApp, getObtainiumTrackedApps } from "./obtainium-catalog";
import { importObtainiumApps } from "./obtainium-import";
import { assertAndroidUser } from "./android-user";
import { loadAndroidUiDump } from "./android-ui-dump";
import { shellCommand } from "./transport";

export const OBTAINIUM_SETUP_STAGES = [
  { id: "obtainium-prepare", label: "Confirm Obtainium dialogs" },
  { id: "updates", label: "Import sources and refresh the app list" },
] as const;

export function createObtainiumSteps(): readonly ApplicationExtraStep<ObtainiumRelease>[] {
  return [
    {
      ...OBTAINIUM_SETUP_STAGES[0],
      async preflight(context) {
        if (context.release.packageName !== OBTAINIUM_PACKAGE) throw new Error("Obtainium setup requires the Obtainium package.");
        if (context.release.version !== "1.6.17") {
          throw new Error("This Obtainium version has not been qualified for automatic setup.");
        }
        const sdk = (await context.device.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
        if (!/^[1-9]\d*$/.test(sdk) || !Number.isSafeInteger(Number(sdk)) || Number(sdk) < 26) {
          throw new Error("Obtainium requires Android 8 or newer.");
        }
        const tool = (await context.device.shell(shellCommand("sh", "-c", "command -v uiautomator"))).trim();
        if (!/^\/[^\s]+\/uiautomator$/.test(tool)) throw new Error("Android UI automation is unavailable on this device.");
        await loadAndroidUiDump(context.signal);
      },
      async run(context) {
        try {
          context.log("Preparing Obtainium…");
          await prepareObtainium(context);
          context.log("Obtainium's first-launch dialogs are confirmed.");
        } catch (error) {
          const cleanup = context.device.restorationDevice ?? context.device;
          try {
            await assertAndroidUser(cleanup, context.user);
            await cleanup.shell(shellCommand("am", "force-stop", "--user", String(context.user), OBTAINIUM_PACKAGE));
          } catch { /* Preserve the setup error if USB is gone or the profile changed. */ }
          throw error;
        }
      },
    },
    {
      ...OBTAINIUM_SETUP_STAGES[1],
      async run(context) {
        try {
          const apps = [createRetroArchObtainiumApp(context.release.abi), ...getObtainiumTrackedApps(context.release.abi)];
          await importObtainiumApps(context, apps);
          context.log(`Configured updates: ${apps.map((app) => app.name).join(", ")}.`);
        } catch (error) {
          const cleanup = context.device.restorationDevice ?? context.device;
          try {
            await assertAndroidUser(cleanup, context.user);
            await cleanup.shell(shellCommand("am", "force-stop", "--user", String(context.user), OBTAINIUM_PACKAGE));
          } catch { /* Preserve the setup error if USB is gone or the profile changed. */ }
          throw error;
        }
      },
    },
  ];
}
