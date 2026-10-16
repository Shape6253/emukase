<script lang="ts">
  import { onDestroy } from "svelte";
  import UnlockSnackbar from "./UnlockSnackbar.svelte";
  import { configureEmulator, verifyEmulatorConfiguration, type EmulatorConfigurationOptions, type EmulatorConfigurationResult } from "./adb/emulator-configuration";
  import type { DeviceState } from "./device-state.svelte";
  import type { LibrarySettings } from "./library-settings.svelte";

  let { device, settings, platformId, disabled, onComplete }: {
    device: DeviceState;
    settings: LibrarySettings;
    platformId: string;
    disabled: boolean;
    onComplete: () => void;
  } = $props();

  let input: HTMLInputElement | undefined = $state();
  let running = $state(false);
  let unlockRequired = $state(false);
  let nativeInstalling = $state(false);
  let status = $state("");
  let errorMessage = $state("");
  let result = $state<EmulatorConfigurationResult>();
  let progress = $state<{ bytes: number; total: number }>();
  let controller: AbortController | undefined;
  let destroyed = false;
  const unavailable = $derived(disabled || running || settings.foldersInvalid || !device.connection);
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

  async function run(files?: File[]): Promise<void> {
    const connection = device.connection;
    if (unavailable || !connection || files?.length === 0) return;
    const abort = new AbortController();
    controller = abort;
    running = true;
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
        : await verifyEmulatorConfiguration(connection.transport, platformId, options);
      abort.signal.throwIfAborted();
      if (device.connection !== connection) return;
      result = checked;
      status = checked.contentVerified
        ? checked.library === "accepted"
          ? "Eden's content check passed after restart. The selected Switch game folder is connected."
          : "Eden's content check passed, but the selected Switch game folder is not verified."
        : "Eden's native setup status checked after restart.";
    } catch (error) {
      status = "";
      if (!destroyed && device.connection === connection) errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      controller = undefined;
      running = false;
      unlockRequired = false;
      nativeInstalling = false;
      device.setupRunning = false;
      if (!destroyed && device.connection === connection) onComplete();
    }
  }

  onDestroy(() => {
    destroyed = true;
    controller?.abort(new Error("Emulator configuration stopped because the page closed."));
  });
</script>

<UnlockSnackbar visible={running && unlockRequired} message="Unlock your Android device to configure Eden." />

<div class="mt-3 rounded-ui border border-zinc-200 p-3 dark:border-zinc-800">
  <p class="text-sm font-medium text-zinc-900 dark:text-zinc-50">Set up Eden</p>
  <p class="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
    Choose prod.keys and a firmware ZIP to import them automatically in Eden. These replace the corresponding installed keys or firmware. Your Switch ROM folder is connected during setup.
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
    <button id="library-support-upload" type="button" disabled={unavailable} onclick={() => input?.click()} class={button}>Choose keys and firmware</button>
    <button id="library-support-verify" type="button" disabled={unavailable} onclick={() => void run()} class={button}>Check in Eden</button>
    {#if running}
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
