import { readAndroidPackage } from "./android-package";
import { selectAndroidDocument } from "./android-document-picker";
import { withAndroidUiDump } from "./android-ui-dump";
import type { AndroidUiNode, AndroidUiSnapshot } from "./android-ui";
import { readAndroidUser, userScopedDevice } from "./android-user";
import { withAwakeDevice } from "./device-awake";
import { keepDeviceAwake } from "./device-keep-awake";
import type { ConfigurationItemState, EmulatorConfigurationOptions } from "./emulator-configuration-types";
import { restartEmulator, tapEmulatorNode, waitEmulatorUi } from "./emulator-ui";
import { prepareEmulatorSupport } from "./emulator-support";
import { shellCommand, type DeviceTransport } from "./transport";
import { VITA3K_FONT_FILENAME } from "./vita3k-inputs";
import { prepareVita3kStorage } from "./vita3k-storage";
import { findVita3kCard, isVita3k, launchVita3k, openVita3kFirmware, openVita3kImport, readVita3kFirmware, readVita3kLabels, resolveModernVita3k, tapVita3k, vita3kNode, waitVita3kLibrary, VITA3K_PACKAGE, type Vita3kUiContext } from "./vita3k-navigation";

export type Vita3kConfigurationOptions = EmulatorConfigurationOptions;

export interface Vita3kConfigurationResult {
  vitaFirmware: ConfigurationItemState;
  vitaFonts: ConfigurationItemState;
  setupComplete: boolean;
  contentVerified: boolean;
}

async function finishNativeInstall(context: Vita3kUiContext): Promise<void> {
  await waitEmulatorUi(context, async (snapshot) => {
    if (!isVita3k(snapshot)) return undefined;
    if (vita3kNode(context, snapshot, "install_result_failed_title") || vita3kNode(context, snapshot, "install_result_partial_title")) {
      throw new Error("Vita3K did not accept the selected firmware package. Check its native installation report on the device.");
    }
    if (!vita3kNode(context, snapshot, "install_result_success_title")) return undefined;
    // Delete-source checkboxes are unchecked by default. Confirm without
    // selecting any: the user's staged firmware must remain untouched.
    if (snapshot.nodes.some((node) => node.checked === true)) {
      throw new Error("Vita3K's result dialog has selected options. Review it on the device before continuing.");
    }
    await tapVita3k(context, "action_ok", snapshot);
    return true;
  }, 300_000);
  await waitEmulatorUi(context, (snapshot) => isVita3k(snapshot)
    && !vita3kNode(context, snapshot, "install_progress_title")
    && !vita3kNode(context, snapshot, "install_result_success_title") ? true : undefined);
}

/** Keep cancellation deferred only while the app owns a noncancellable install. */
async function withNativeInstall(
  context: Vita3kUiContext, options: Vita3kConfigurationOptions, handoff?: { snapshot: AndroidUiSnapshot; node: AndroidUiNode },
): Promise<void> {
  const transport = context.device.restorationDevice ?? context.device;
  let dispatched = !handoff;
  const cancellation = new AbortController();
  const signal = handoff ? cancellation.signal : undefined;
  const abortHandoff = (): void => cancellation.abort(context.signal?.reason);
  const boundary: DeviceTransport = {
    androidUser: transport.androidUser,
    restorationDevice: transport,
    shell(command) {
      if (handoff && !dispatched && command.startsWith(`${shellCommand("input", "tap")} `)
        && /^'input' 'tap' '\d+' '\d+'$/.test(command)) {
        context.signal?.throwIfAborted();
        dispatched = true;
        context.signal?.removeEventListener("abort", abortHandoff);
        options.onNativeInstallPhase?.(true);
      }
      return transport.shell(command);
    },
    push: (data, path, transferOptions) => transport.push(data, path, transferOptions),
    writeContent: (data, uri, user, transferOptions) => transport.writeContent(data, uri, user, transferOptions),
    install: (apk, user, installerPackageName) => transport.install(apk, user, installerPackageName),
  };
  const device = userScopedDevice(boundary, context.user, signal);
  try {
    if (handoff) {
      context.signal?.addEventListener("abort", abortHandoff, { once: true });
      if (context.signal?.aborted) abortHandoff();
    }
    await withAwakeDevice(device, context.user, { signal, onUnlockRequired: options.onUnlockRequired }, (ensureUnlocked) =>
      withAndroidUiDump(device, signal, async () => {
        const native: Vita3kUiContext = { device, user: context.user, signal, ensureUnlocked, labels: context.labels };
        if (!handoff) options.onNativeInstallPhase?.(true);
        try {
          if (handoff) {
            try {
              // Keep cancellation active throughout validation, including the
              // final snapshot and foreground-user checks before dispatch.
              await tapEmulatorNode({ ...native, signal: context.signal }, handoff.snapshot, handoff.node);
            } catch (error) {
              if (!dispatched) throw error;
              // The tap's post-dispatch abort check must not abandon an install
              // that Vita3K may already own. Settle it before surfacing the error.
              await finishNativeInstall(native);
              throw error;
            }
          }
          await finishNativeInstall(native);
        } finally {
          if (dispatched) options.onNativeInstallPhase?.(false);
        }
      }));
  } finally {
    context.signal?.removeEventListener("abort", abortHandoff);
  }
  context.signal?.throwIfAborted();
}

async function restartSafely(context: Vita3kUiContext, options: Vita3kConfigurationOptions): Promise<void> {
  // A disconnected session may leave a foreground installer running. Bring its
  // actual UI forward and settle it before ever stopping the application.
  const snapshot = await launchVita3k(context);
  if ((["install_progress_title", "install_result_success_title", "install_result_failed_title", "install_result_partial_title"] as const)
    .some((key) => vita3kNode(context, snapshot, key))) {
    await withNativeInstall(context, options);
  }
  await restartEmulator(context, VITA3K_PACKAGE, "Vita3K");
}

async function inspectSetup(context: Vita3kUiContext, options: Vita3kConfigurationOptions, finishSetup = false): Promise<Vita3kConfigurationResult> {
  await restartSafely(context, options);
  options.onStatus?.("Opening Vita3K's firmware status…");
  const launched = await launchVita3k(context);
  const fromLibrary = !!vita3kNode(context, launched, "apps_list_cd_more_options");
  if (fromLibrary) await waitVita3kLibrary(context, launched);
  const opened = await openVita3kFirmware(context, launched);
  options.onStatus?.("Checking installed Vita firmware and fonts…");
  let status = await readVita3kFirmware(context, opened.snapshot);
  let nativeStateObserved = status.firmware === "accepted" || status.fonts === "accepted";
  if (fromLibrary && opened.setupComplete && !nativeStateObserved) {
    // A direct route creates a new ViewModel whose initial badges are missing.
    // Observe its native library readiness, then reopen setup within that same
    // Activity before accepting both missing badges as a verified result.
    options.onStatus?.("Waiting for Vita3K to finish checking its firmware…");
    await tapVita3k(context, "emulation_exit", status.snapshot);
    const library = await waitVita3kLibrary(context);
    const reopened = await openVita3kFirmware(context, library, false);
    status = await readVita3kFirmware(context, reopened.snapshot);
    nativeStateObserved = true;
  }
  // A published accepted component proves the asynchronous native scan ran.
  // If fonts became accepted between reads, re-read main from that newer state.
  if (status.firmware === "missing" && status.fonts === "accepted") {
    const firmware = await findVita3kCard(context, "initial_setup_main_title");
    status = { ...status, firmware: firmware.state, snapshot: firmware.snapshot };
  }
  // Mainline FirmwareInstallState.hasRequiredComponents is main && fontPackage;
  // its preinstalled component is optional. Do not equate a successful PUP
  // installation (which may be fonts only) with main-firmware readiness.
  const contentVerified = status.firmware === "accepted" && status.fonts === "accepted";
  let setupComplete = opened.setupComplete;
  if ((finishSetup && contentVerified) || opened.setupComplete) {
    await tapVita3k(context, "initial_setup_open_library", status.snapshot);
    await waitEmulatorUi(context, (snapshot) => vita3kNode(context, snapshot, "apps_list_cd_more_options") ? true : undefined);
    setupComplete = true;
    if (finishSetup && !opened.setupComplete) return inspectSetup(context, options);
  }
  return {
    vitaFirmware: nativeStateObserved ? status.firmware : "unverified",
    vitaFonts: nativeStateObserved ? status.fonts : "unverified",
    setupComplete, contentVerified,
  };
}

async function runVita3k<T>(device: DeviceTransport, options: Vita3kConfigurationOptions, action: (context: Vita3kUiContext) => Promise<T>): Promise<T> {
  const user = await readAndroidUser(device, options.signal);
  const scoped = userScopedDevice(device, user, options.signal);
  if (!await readAndroidPackage(scoped, VITA3K_PACKAGE, user, options.signal)) {
    throw new Error("Install modern Vita3K before configuring its firmware.");
  }
  const base = { device: scoped, user, signal: options.signal };
  await resolveModernVita3k(base);
  const lease = await keepDeviceAwake(scoped, user, { signal: options.signal, log: options.log });
  try {
    return await withAwakeDevice(scoped, user, { signal: options.signal, onUnlockRequired: options.onUnlockRequired }, (ensureUnlocked) =>
      withAndroidUiDump(scoped, options.signal, async () => {
        const context = { ...base, ensureUnlocked };
        return action({ ...context, labels: await readVita3kLabels(context) });
      }));
  } finally {
    await lease.release();
  }
}

/** Native games are installed into Vita3K itself, not linked as a ROM library. */
export async function verifyVita3k(device: DeviceTransport, options: Vita3kConfigurationOptions = {}): Promise<Vita3kConfigurationResult> {
  options.onStatus?.("Checking Vita3K's native main firmware and font package…");
  return runVita3k(device, options, (context) => inspectSetup(context, options));
}

/** Accept one user-selected official PUP per call, including a separate fonts PUP. */
export async function configureVita3k(device: DeviceTransport, files: readonly File[], options: Vita3kConfigurationOptions = {}): Promise<Vita3kConfigurationResult> {
  return runVita3k(device, options, async (context) => {
    options.onStatus?.("Preparing Vita3K's firmware files…");
    const input = await prepareEmulatorSupport(context.device, context.user, "psvita", files, options);
    options.onStatus?.("Allowing Vita3K filesystem access for its native installer…");
    await prepareVita3kStorage(context);
    await restartSafely(context, options);
    options.onStatus?.("Importing the PUP through Vita3K's native firmware installer…");
    await openVita3kImport(context, input.file.name === VITA3K_FONT_FILENAME ? "initial_setup_font_title" : "initial_setup_main_title");
    await selectAndroidDocument(context, VITA3K_PACKAGE, `${input.directory}/${input.file.name}`, false,
      (snapshot, node) => withNativeInstall(context, options, { snapshot, node }), { action: "GET_CONTENT" });
    options.onStatus?.("Restarting Vita3K and checking main firmware and fonts separately…");
    return inspectSetup(context, options, true);
  });
}
