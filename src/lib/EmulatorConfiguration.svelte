<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { DeviceUnlockRequiredError } from "./adb/device-awake";
  import UnlockSnackbar from "./UnlockSnackbar.svelte";
  import { cachedEmulatorConfiguration, forgetEmulatorConfiguration, configureEmulator, repairEmulatorConfiguration, verifyEmulatorConfiguration, type EmulatorConfigurationCheckRequest, type EmulatorConfigurationOptions, type EmulatorConfigurationResult } from "./adb/emulator-configuration";
  import { emulatorConfigurationReady, type EmulatorConfigurationState } from "./emulator-configuration-state";
  import { libraryPlatform } from "./adb/library-catalog";
  import type { DeviceState } from "./device-state.svelte";
  import type { LibrarySettings } from "./library-settings.svelte";

  let { device, settings, platformId, disabled, inspectDisabled, appInstalled, checkRequest, onStateChange, onComplete }: {
    device: DeviceState;
    settings: LibrarySettings;
    platformId: string;
    disabled: boolean;
    inspectDisabled?: boolean;
    appInstalled: boolean | undefined;
    checkRequest: EmulatorConfigurationCheckRequest;
    onStateChange: (state: EmulatorConfigurationState | undefined) => void;
    onComplete: () => void;
  } = $props();

  let running = $state(false);
  let automaticCheck = $state(false);
  let unlockRequired = $state(false);
  let nativeInstalling = $state(false);
  let status = $state("");
  let errorMessage = $state("");
  let result = $state<EmulatorConfigurationResult>();
  let progress = $state<{ bytes: number; total: number }>();
  let controller: AbortController | undefined;
  let destroyed = false;
  let checkingOnly = false;
  let completedCheckRequest = 0;
  const skippedCheck = new Error("Emulator setup check skipped.");
  const unavailable = $derived(disabled || running || settings.foldersInvalid || !device.connection || appInstalled !== true);
  const inspectionUnavailable = $derived((inspectDisabled ?? disabled) || running || settings.foldersInvalid || !device.connection || appInstalled !== true);
  const ready = $derived(appInstalled === true && result !== undefined && isReady(result));
  const emulatorName = $derived(libraryPlatform(platformId).emulator);

  $effect(() => {
    device.connection;
    settings.libraryFolder;
    settings.romsFolder;
    settings.biosFolder;
    platformId;
    result = undefined;
    status = "";
    errorMessage = "";
    return () => controller?.abort(new Error("The library source changed."));
  });

  $effect(() => {
    if (appInstalled !== false) return;
    result = undefined;
    status = `Install ${emulatorName} before checking its setup.`;
    errorMessage = "";
    const connection = device.connection;
    if (connection) forgetEmulatorConfiguration(connection.transport, platformId);
  });

  $effect(() => {
    if (!checkRequest.id || checkRequest.id === completedCheckRequest || inspectionUnavailable) return;
    completedCheckRequest = checkRequest.id;
    untrack(() => {
      const connection = device.connection;
      if (!connection) return;
      const cached = cachedEmulatorConfiguration(connection.transport, platformId, settings.folderOptions);
      if (cached) showResult(cached);
      else if (checkRequest.inspect && settings.checkEmulatorSetup) void run(undefined, true);
      else {
        result = undefined;
        status = "";
      }
    });
  });

  $effect(() => {
    if (!settings.checkEmulatorSetup && running && automaticCheck) controller?.abort(skippedCheck);
  });

  $effect(() => {
    onStateChange({
      result: result ? { ...result } : undefined,
      running, automaticCheck, nativeInstalling, unavailable, ready, status, errorMessage,
      progress: progress ? { ...progress } : undefined,
      check, configure, repair, skip, cancel,
    });
  });

  function check(): void { void run(); }
  function configure(files: File[]): void { void run(files); }
  function repair(): void { void run(undefined, false, true); }
  function skip(): void { settings.setCheckEmulatorSetup(false); }
  function cancel(): void {
    if (checkingOnly) {
      controller?.abort(skippedCheck);
      return;
    }
    if (nativeInstalling) status = `${emulatorName} is finishing its current import before stopping…`;
    controller?.abort(new Error(`${emulatorName} configuration canceled. Completed imports have been kept.`));
  }

  function isReady(checked: EmulatorConfigurationResult): boolean {
    return emulatorConfigurationReady(checked);
  }

  function showResult(checked: EmulatorConfigurationResult): void {
    result = checked;
    status = isReady(checked)
      ? ""
      : checked.contentVerified
        ? `${emulatorName}'s content check passed. Some setup items still need attention.`
        : `${emulatorName}'s native setup was checked. Some setup items still need attention.`;
  }

  async function run(files?: File[], initialCheck = false, repair = false): Promise<void> {
    const connection = device.connection;
    if ((initialCheck ? inspectionUnavailable : unavailable) || !connection || files?.length === 0) return;
    if (!files && !initialCheck) forgetEmulatorConfiguration(connection.transport, platformId);
    completedCheckRequest = checkRequest.id;
    const abort = new AbortController();
    controller = abort;
    checkingOnly = files === undefined && !repair;
    running = true;
    automaticCheck = initialCheck;
    device.setupRunning = true;
    result = undefined;
    progress = undefined;
    errorMessage = "";
    status = files ? "Checking selected support files…" : `Checking ${emulatorName}…`;
    void connection.disconnected.then(() => abort.abort(new Error("The USB connection was disconnected.")));
    const options: EmulatorConfigurationOptions = {
      folders: settings.folderOptions,
      signal: abort.signal,
      onStatus: (message) => { status = message; progress = undefined; },
      onProgress: (bytes, total) => { progress = { bytes, total }; },
      onUnlockRequired: (required) => { unlockRequired = required; },
      onNativeInstallPhase: (installing) => { nativeInstalling = installing; },
    };
    try {
      const checked = files
        ? await configureEmulator(connection.transport, platformId, files, options)
        : repair
          ? await repairEmulatorConfiguration(connection.transport, platformId, options)
          : await verifyEmulatorConfiguration(connection.transport, platformId, options);
      abort.signal.throwIfAborted();
      if (device.connection !== connection) return;
      showResult(checked);
    } catch (error) {
      if (abort.signal.reason === skippedCheck) {
        status = "Check skipped.";
      } else if (error instanceof DeviceUnlockRequiredError) {
        if (!destroyed && device.connection === connection) status = error.message;
      } else {
        status = "";
        if (!destroyed && device.connection === connection) errorMessage = error instanceof Error ? error.message : String(error);
      }
    } finally {
      controller = undefined;
      checkingOnly = false;
      running = false;
      automaticCheck = false;
      unlockRequired = false;
      nativeInstalling = false;
      device.setupRunning = false;
      if (!destroyed && device.connection === connection && (files || repair)) onComplete();
    }
  }

  onDestroy(() => {
    destroyed = true;
    onStateChange(undefined);
    controller?.abort(new Error("Emulator configuration stopped because the page closed."));
  });
</script>

<UnlockSnackbar visible={running && unlockRequired} message={`Unlock your Android device to continue with ${emulatorName}.`} />
