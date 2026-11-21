import { readAndroidPackage } from "./android-package";
import { selectAndroidDocument } from "./android-document-picker";
import { withAndroidUiDump } from "./android-ui-dump";
import { AndroidUiStateChangedError, type AndroidUiNode, type AndroidUiSnapshot } from "./android-ui";
import { readAndroidUser, userScopedDevice } from "./android-user";
import { DeviceUnlockRequiredError, withAwakeDevice } from "./device-awake";
import { keepDeviceAwake } from "./device-keep-awake";
import type { ConfigurationItemState, EmulatorConfigurationOptions } from "./emulator-configuration-types";
import { emulatorNodeVisible, tapEmulatorNode } from "./emulator-ui";
import { prepareEmulatorSupport } from "./emulator-support";
import { shellCommand, type DeviceTransport } from "./transport";
import { VITA3K_FIRMWARE_FILENAME, VITA3K_FONT_FILENAME } from "./vita3k-inputs";
import { prepareVita3kStorage } from "./vita3k-storage";
import { findVita3kCard, launchVita3k, openVita3kFirmware, openVita3kImport, readVita3kFirmware, readVita3kLabels, resolveModernVita3k, restartVita3k, tapVita3k, vita3kNode, waitVita3kLibrary, waitVita3kUi, VITA3K_PACKAGE, type Vita3kUiContext } from "./vita3k-navigation";

export type Vita3kConfigurationOptions = EmulatorConfigurationOptions;

export interface Vita3kConfigurationResult {
  vitaFirmware: ConfigurationItemState;
  vitaFonts: ConfigurationItemState;
  setupComplete: boolean;
  contentVerified: boolean;
}

async function finishNativeInstall(context: Vita3kUiContext): Promise<AndroidUiSnapshot> {
  await waitVita3kUi(context, async (snapshot) => {
    if (vita3kNode(context, snapshot, "install_result_failed_title") || vita3kNode(context, snapshot, "install_result_partial_title")) {
      throw new Error("Vita3K did not accept the selected firmware package. Check its native installation report on the device.");
    }
    if (!vita3kNode(context, snapshot, "install_result_success_title")) return undefined;
    // Delete-source checkboxes are unchecked by default. Confirm without
    // selecting any: the user's staged firmware must remain untouched.
    if (snapshot.nodes.some((node) => node.checked === true)) {
      throw new Error("Vita3K's result dialog has selected options. Review it on the device before continuing.");
    }
    const ok = vita3kNode(context, snapshot, "action_ok");
    if (!ok || !emulatorNodeVisible(snapshot, ok)) return undefined;
    await tapEmulatorNode(context, snapshot, ok, { retryStale: false });
    return true;
  }, 300_000);
  return waitVita3kUi(context, (snapshot) => !vita3kNode(context, snapshot, "install_progress_title")
    && !vita3kNode(context, snapshot, "install_result_success_title") ? snapshot : undefined);
}

/** Keep cancellation deferred only while the app owns a noncancellable install. */
async function withNativeInstall(
  context: Vita3kUiContext, options: Vita3kConfigurationOptions, handoff?: { snapshot: AndroidUiSnapshot; node: AndroidUiNode },
): Promise<AndroidUiSnapshot | "retry"> {
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
    const snapshot = await withAwakeDevice(device, context.user, { signal, onUnlockRequired: options.onUnlockRequired }, (ensureUnlocked) =>
      withAndroidUiDump(device, signal, async () => {
        const native: Vita3kUiContext = { device, user: context.user, signal, ensureUnlocked, labels: context.labels };
        if (!handoff) options.onNativeInstallPhase?.(true);
        try {
          if (handoff) {
            try {
              // Keep cancellation active throughout validation, including the
              // final snapshot and foreground-user checks before dispatch.
              await tapEmulatorNode({ ...native, signal: context.signal }, handoff.snapshot, handoff.node, { retryStale: false });
            } catch (error) {
              if (!dispatched) throw error;
              // The tap's post-dispatch abort check must not abandon an install
              // that Vita3K may already own. Settle it before surfacing the error.
              await finishNativeInstall(native);
              throw error;
            }
          }
          return await finishNativeInstall(native);
        } finally {
          if (dispatched) options.onNativeInstallPhase?.(false);
        }
      }));
    context.signal?.throwIfAborted();
    return snapshot;
  } catch (error) {
    if (handoff && !dispatched) {
      if (error instanceof DeviceUnlockRequiredError) {
        await context.ensureUnlocked();
        return "retry";
      }
      if (error instanceof AndroidUiStateChangedError) return "retry";
    }
    throw error;
  } finally {
    context.signal?.removeEventListener("abort", abortHandoff);
  }
}

async function restartSafely(context: Vita3kUiContext, options: Vita3kConfigurationOptions, initial?: AndroidUiSnapshot): Promise<void> {
  // Without a snapshot from our own install, bring Vita3K forward to settle
  // any installer left running by a previous session before stopping the app.
  const snapshot = initial ?? await launchVita3k(context);
  if ((["install_progress_title", "install_result_success_title", "install_result_failed_title", "install_result_partial_title"] as const)
    .some((key) => vita3kNode(context, snapshot, key))) {
    await withNativeInstall(context, options);
  }
  await restartVita3k(context);
}

async function inspectSetup(
  context: Vita3kUiContext, options: Vita3kConfigurationOptions, afterImport?: AndroidUiSnapshot,
): Promise<Vita3kConfigurationResult> {
  await restartSafely(context, options, afterImport);
  options.onStatus?.("Opening Vita3K's firmware status…");
  const launched = await launchVita3k(context);
  const fromLibrary = !!vita3kNode(context, launched, "apps_list_cd_more_options");
  const initial = fromLibrary ? await waitVita3kLibrary(context, launched) : launched;
  const opened = await openVita3kFirmware(context, initial);
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
  let contentVerified = status.firmware === "accepted" && status.fonts === "accepted";
  let setupComplete = opened.setupComplete;
  if ((afterImport && contentVerified) || opened.setupComplete) {
    await tapVita3k(context, "initial_setup_open_library", status.snapshot);
    await waitVita3kUi(context, (snapshot) => vita3kNode(context, snapshot, "apps_list_cd_more_options") ? true : undefined);
    setupComplete = true;
    if (afterImport && !opened.setupComplete) {
      // The no-apps message requires both firmware components. A populated
      // library can render even when a required component is missing.
      await restartVita3k(context);
      const library = await waitVita3kLibrary(context, await launchVita3k(context));
      if (!vita3kNode(context, library, "apps_list_empty_no_apps")) {
        options.onStatus?.("Rechecking Vita3K firmware after restarting…");
        const reopened = await openVita3kFirmware(context, library, false);
        status = await readVita3kFirmware(context, reopened.snapshot);
        nativeStateObserved = true;
        await tapVita3k(context, "emulation_exit", status.snapshot);
        const rechecked = await waitVita3kLibrary(context);
        contentVerified = status.firmware === "accepted" && status.fonts === "accepted"
          && !vita3kNode(context, rechecked, "apps_list_empty_firmware_title");
      }
    }
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
  const [labels, lease] = await Promise.allSettled([
    readVita3kLabels(base),
    keepDeviceAwake(scoped, user, { signal: options.signal, log: options.log }),
  ]);
  if (lease.status === "rejected") throw lease.reason;
  try {
    if (labels.status === "rejected") throw labels.reason;
    return await withAwakeDevice(scoped, user, { signal: options.signal, onUnlockRequired: options.onUnlockRequired }, (ensureUnlocked) =>
      withAndroidUiDump(scoped, options.signal, () => action({ ...base, ensureUnlocked, labels: labels.value })));
  } finally {
    await lease.value.release();
  }
}

/** Native games are installed into Vita3K itself, not linked as a ROM library. */
export async function verifyVita3k(device: DeviceTransport, options: Vita3kConfigurationOptions = {}): Promise<Vita3kConfigurationResult> {
  options.onStatus?.("Checking Vita3K's native main firmware and font package…");
  return runVita3k(device, options, (context) => inspectSetup(context, options));
}

/** Install each selected PUP through its own native picker and verify after the last one. */
export async function configureVita3k(device: DeviceTransport, files: readonly File[], options: EmulatorConfigurationOptions = {}): Promise<Vita3kConfigurationResult> {
  const names = [VITA3K_FIRMWARE_FILENAME, VITA3K_FONT_FILENAME];
  const ordered = names.flatMap((name) => files.filter((file) => file instanceof File && file.name === name));
  if (!files.length || ordered.length !== files.length || new Set(ordered.map((file) => file.name)).size !== files.length) {
    throw new Error("Choose an official Vita firmware update (PSVUPDAT.PUP), font package (PSP2UPDAT.PUP), or one of each.");
  }
  return runVita3k(device, options, async (context) => {
    options.onStatus?.("Preparing Vita3K's firmware files…");
    // Match the per-PUP keys used by setup's background uploads.
    const inputs = [];
    const total = ordered.reduce((bytes, file) => bytes + file.size, 0);
    let transferred = 0;
    for (const file of ordered) {
      inputs.push(await prepareEmulatorSupport(context.device, context.user, "psvita", [file], {
        ...options, onProgress: (bytes) => options.onProgress?.(transferred + bytes, total),
      }));
      transferred += file.size;
    }
    options.onStatus?.("Allowing Vita3K filesystem access for its native installer…");
    await prepareVita3kStorage(context);
    await restartSafely(context, options);
    let current: AndroidUiSnapshot | undefined;
    for (const input of inputs) {
      options.onStatus?.(`Importing ${input.file.name} through Vita3K's native firmware installer…`);
      await openVita3kImport(context, input.file.name === VITA3K_FONT_FILENAME ? "initial_setup_font_title" : "initial_setup_main_title", current);
      await selectAndroidDocument(context, VITA3K_PACKAGE, `${input.directory}/${input.file.name}`, false,
        async (snapshot, node) => {
          const result = await withNativeInstall(context, options, { snapshot, node });
          if (result === "retry") return result;
          current = result;
        },
        { action: "GET_CONTENT", directoryNavigation: "scroll-first" });
    }
    if (!current) throw new Error("Vita3K did not return from its firmware installer.");
    options.onStatus?.("Restarting Vita3K and checking main firmware and fonts separately…");
    return inspectSetup(context, options, current);
  });
}
