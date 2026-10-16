<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import UnlockSnackbar from "./UnlockSnackbar.svelte";
  import { cachedEmulatorConfiguration, forgetEmulatorConfiguration, configureEmulator, repairEmulatorConfiguration, verifyEmulatorConfiguration, type EmulatorConfigurationCheckRequest, type EmulatorConfigurationOptions, type EmulatorConfigurationResult } from "./adb/emulator-configuration";
  import type { DeviceState } from "./device-state.svelte";
  import type { LibrarySettings } from "./library-settings.svelte";

  let { device, settings, platformId, disabled, inspectDisabled, appInstalled, supportFilesAvailable, checkRequest, onComplete }: {
    device: DeviceState;
    settings: LibrarySettings;
    platformId: string;
    disabled: boolean;
    inspectDisabled?: boolean;
    appInstalled: boolean | undefined;
    supportFilesAvailable: boolean;
    checkRequest: EmulatorConfigurationCheckRequest;
    onComplete: () => void;
  } = $props();

  let input: HTMLInputElement | undefined = $state();
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
  let completedCheckRequest = 0;
  const skippedCheck = new Error("Emulator setup check skipped.");
  const unavailable = $derived(disabled || running || settings.foldersInvalid || !device.connection || appInstalled !== true);
  const inspectionUnavailable = $derived((inspectDisabled ?? disabled) || running || settings.foldersInvalid || !device.connection || appInstalled !== true);
  const ready = $derived(appInstalled === true && result !== undefined && isReady(result));
  const button = "rounded-ui border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";

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
    status = "Install Eden before checking its setup.";
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

  function isReady(checked: EmulatorConfigurationResult): boolean {
    return checked.keys === "accepted" && checked.firmware === "accepted"
      && checked.library === "accepted";
  }

  function showResult(checked: EmulatorConfigurationResult): void {
    result = checked;
    status = isReady(checked)
      ? "Eden's keys, firmware and selected game folder are configured for this connection."
      : checked.contentVerified
        ? "Eden's content check passed. Some setup items still need attention."
        : "Eden's native setup was checked. Complete the items below.";
  }

  async function run(files?: File[], initialCheck = false, repair = false): Promise<void> {
    const connection = device.connection;
    if ((initialCheck ? inspectionUnavailable : unavailable) || !connection || files?.length === 0) return;
    if (!files && !initialCheck) forgetEmulatorConfiguration(connection.transport, platformId);
    completedCheckRequest = checkRequest.id;
    const abort = new AbortController();
    controller = abort;
    running = true;
    automaticCheck = initialCheck;
    device.setupRunning = true;
    result = undefined;
    progress = undefined;
    errorMessage = "";
    status = files ? "Checking selected support files…" : "Checking Eden…";
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
        status = "Setup check skipped. You can check Eden manually.";
      } else {
        status = "";
        if (!destroyed && device.connection === connection) errorMessage = error instanceof Error ? error.message : String(error);
      }
    } finally {
      controller = undefined;
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
    controller?.abort(new Error("Emulator configuration stopped because the page closed."));
  });
</script>

<UnlockSnackbar visible={running && unlockRequired} message="Unlock your Android device to configure Eden." />

<div class="mt-3 rounded-ui border border-zinc-200 p-3 dark:border-zinc-800">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <p class="text-sm font-medium text-zinc-900 dark:text-zinc-50">Eden setup</p>
    <span id="library-support-setup-state" data-setup-state={running ? "checking" : appInstalled === false ? "missing-app" : ready ? "configured" : result ? "incomplete" : "unchecked"} class="rounded-ui px-2 py-1 text-xs font-medium {ready ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400'}">
      {running ? "Checking setup…" : appInstalled === false ? "Not installed" : ready ? "Configured" : result ? "Needs attention" : "Not checked"}
    </span>
  </div>
  <p class="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
    {#if supportFilesAvailable}Complete setup automatically using keys and a firmware ZIP already in your support folder. Missing items are imported and your Switch ROM folder is connected.{/if}
    Choose files below to supply or replace keys and firmware.
  </p>
  <p class="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
    Setup checks read Eden's native status without a full content integrity scan. Check again to read changes made on the device.
  </p>
  <input
    bind:this={input}
    id="library-support-input"
    type="file"
    accept=".keys,.zip"
    multiple
    disabled={unavailable}
    aria-label="Choose Eden keys and firmware"
    class="sr-only"
    tabindex="-1"
    onchange={(event) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      void run(files);
    }}
  />
  <div class="mt-3 flex flex-wrap gap-2">
    {#if supportFilesAvailable}
      <button id="library-support-repair" type="button" disabled={unavailable || ready} onclick={() => void run(undefined, false, true)} class={button}>Complete setup automatically</button>
    {/if}
    <button id="library-support-upload" type="button" disabled={unavailable} onclick={() => input?.click()} class={button}>Choose keys and firmware</button>
    <button id="library-support-verify" type="button" disabled={unavailable} onclick={() => void run()} class={button}>Check existing setup</button>
    {#if running && automaticCheck}
      <button id="library-support-skip" type="button" onclick={() => settings.setCheckEmulatorSetup(false)} class={button}>Skip setup check</button>
    {:else if running}
      <button type="button" onclick={() => {
        if (nativeInstalling) status = "Eden is finishing its current import before stopping…";
        controller?.abort(new Error("Eden configuration canceled. Completed native imports have been kept."));
      }} class={button}>{nativeInstalling ? "Stop after import" : "Cancel"}</button>
    {/if}
  </div>
  {#if running && progress}
    <progress aria-label="Support file upload progress" value={progress.bytes} max={progress.total} class="mt-3 h-1.5 w-full accent-zinc-700 dark:accent-zinc-300"></progress>
  {/if}
  <p id="library-support-status" role="status" aria-live="polite" class="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{status}</p>
  {#if result}
    <dl class="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
      <div><dt class="inline">Keys: </dt><dd class="inline">{result.keys === "accepted" ? "Accepted by Eden" : result.keys === "missing" ? "Required" : "Not verified"}</dd></div>
      <div><dt class="inline">Firmware: </dt><dd class="inline">{result.firmware === "accepted" ? "Accepted by Eden" : result.firmware === "missing" ? "Required" : "Not verified"}</dd></div>
      <div><dt class="inline">Game folder: </dt><dd class="inline">{result.library === "accepted" ? "Connected" : "Not verified"}</dd></div>
    </dl>
  {/if}
  {#if errorMessage}
    <p id="library-support-error" role="alert" class="mt-2 rounded-ui bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-950 dark:text-red-200">{errorMessage}</p>
  {/if}
</div>
