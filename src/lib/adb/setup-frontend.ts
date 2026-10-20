import { withAdbInstallVerifier } from "./adb-install-verifier";
import { readAndroidPackage } from "./android-package";
import { assertAndroidUser, readAndroidUser, userScopedDevice } from "./android-user";
import { configureCocoon, installCocoon } from "./cocoon";
import { configureDaijisho } from "./daijisho";
import { DAIJISHO_PACKAGE } from "./daijisho-navigation";
import { withAwakeDevice } from "./device-awake";
import { keepDeviceAwake } from "./device-keep-awake";
import type { DeviceInfo } from "./device-info";
import { MAX_ARTIFACT_BYTES } from "./download-policy";
import type { EmulatorConfigurationOptions } from "./emulator-configuration-types";
import { configureEsde } from "./esde";
import { ESDE_PACKAGE } from "./esde-types";
import { frontendSetupStages, type FrontendSelection } from "./frontend-catalog";
import { libraryPlatform } from "./library-catalog";
import { getObtainiumTrackedApps } from "./obtainium-catalog";
import { installApplicationViaObtainium } from "./obtainium-install";
import { configureRetroHrai, installRetroHrai } from "./retrohrai";
import type { SetupEvent } from "./setup-events";
import { checkActivityStart, shellCommand, type DeviceTransport } from "./transport";

export interface FrontendSetupOptions extends Pick<EmulatorConfigurationOptions, "folders" | "signal" | "onStatus" | "onUnlockRequired"> {
  log?: (message: string) => void;
  onEvent?: (event: SetupEvent) => void;
}

async function installEsdeApk(device: DeviceTransport, apk: File | undefined, options: FrontendSetupOptions): Promise<void> {
  options.signal?.throwIfAborted();
  if (!(apk instanceof File) || !/\.apk$/i.test(apk.name) || apk.size < 4 || apk.size > MAX_ARTIFACT_BYTES) {
    throw new Error("Choose your licensed ES-DE APK before starting setup.");
  }
  const header = new Uint8Array(await apk.slice(0, 4).arrayBuffer());
  if (header[0] !== 0x50 || header[1] !== 0x4b || header[2] !== 0x03 || header[3] !== 0x04) {
    throw new Error("The selected ES-DE file does not have an APK ZIP header.");
  }
  const user = await readAndroidUser(device, options.signal);
  const scoped = userScopedDevice(device, user, options.signal);
  const awake = await keepDeviceAwake(scoped, user, options);
  try {
    await withAwakeDevice(scoped, user, options, async () => {
      await withAdbInstallVerifier(scoped, user, async () => {
        options.signal?.throwIfAborted();
        await assertAndroidUser(scoped, user, options.signal);
        await scoped.install(apk, user);
        options.signal?.throwIfAborted();
        if (!await readAndroidPackage(scoped, ESDE_PACKAGE, user, options.signal)) {
          throw new Error("Android did not confirm the ES-DE installation. Choose the ES-DE APK.");
        }
      }, options);
    });
  } finally {
    await awake.release();
  }
}

export async function setupFrontend(
  device: DeviceTransport, info: DeviceInfo, selection: FrontendSelection, apk: File | undefined,
  options: FrontendSetupOptions = {},
): Promise<void> {
  if (selection === "android") return;
  const [install, configure, finish] = frontendSetupStages(selection);
  if (!install || !configure || !finish) throw new Error("Frontend setup stages are unavailable.");
  let stage = install.id;
  const emit = (status: SetupEvent["status"], message?: string): void => options.onEvent?.({ stage, status, message });
  const callbacks: FrontendSetupOptions = {
    ...options,
    onStatus(message) {
      options.onStatus?.(message);
      emit("running", message);
    },
  };
  try {
    options.signal?.throwIfAborted();
    emit("running");
    if (selection === "esde") await installEsdeApk(device, apk, callbacks);
    else if (selection === "cocoon") await installCocoon(device, callbacks);
    else if (selection === "retrohrai") await installRetroHrai(device, callbacks);
    else {
      if (info.sdk < 30) throw new Error("Automatic Daijishō setup requires Android 11 or newer.");
      const app = getObtainiumTrackedApps(info.abi, info).find((entry) => entry.id === DAIJISHO_PACKAGE);
      if (!app) throw new Error("Daijishō's official update source does not support this device.");
      await installApplicationViaObtainium(device, app, {
        signal: options.signal, log: options.log, importSource: true,
        reportStatus(message, status) {
          callbacks.onStatus?.(message);
          if (status?.unlockRequired !== undefined) callbacks.onUnlockRequired?.(status.unlockRequired);
        },
      });
    }
    options.signal?.throwIfAborted();
    options.onUnlockRequired?.(false);
    emit("complete");
    stage = configure.id;
    emit("running");
    if (selection === "esde") await configureEsde(device, {}, callbacks);
    else if (selection === "cocoon") await configureCocoon(device, callbacks);
    else if (selection === "retrohrai") await configureRetroHrai(device, callbacks);
    else {
      const result = await configureDaijisho(device, callbacks);
      if (result.library !== "accepted") {
        const reasons = result.platforms.filter((platform) => platform.state !== "accepted").map((platform) =>
          `${libraryPlatform(platform.platformId).name}: ${platform.reason ?? "The launch profile or game folder could not be verified."}`,
        );
        throw new Error(`Daijishō's library setup is incomplete.${reasons.length ? ` ${reasons.join(" ")}` : ""}`);
      }
    }
    options.signal?.throwIfAborted();
    emit("complete");
    stage = finish.id;
    emit("running");
    const user = await readAndroidUser(device, options.signal);
    await assertAndroidUser(device, user, options.signal);
    checkActivityStart(await device.shell(shellCommand(
      "am", "start", "--user", String(user), "-W", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.HOME",
    )));
    options.signal?.throwIfAborted();
    emit("complete");
  } catch (error) {
    emit("failed", error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    options.onUnlockRequired?.(false);
  }
}
