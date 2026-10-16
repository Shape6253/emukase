<script lang="ts">
  import { onDestroy } from "svelte";
  import EmulatorSupportControls from "./EmulatorSupportControls.svelte";
  import EmulatorSupportPending from "./EmulatorSupportPending.svelte";
  import EmulatorSetupStatus from "./EmulatorSetupStatus.svelte";
  import { supportRequirementStatus, type EmulatorConfigurationState, type SupportRequirementStatus } from "./emulator-configuration-state";
  import { uploadPlatformSupportFiles, type LibraryUploadProgress } from "./adb/library-upload";
  import { supportsEmulatorConfiguration } from "./adb/emulator-configuration";
  import type { LibraryPlatform, LibrarySupportRequirement } from "./adb/library-catalog";
  import type { PlatformLibraryScan } from "./adb/library-scan";
  import type { DeviceState } from "./device-state.svelte";
  import type { LibrarySettings } from "./library-settings.svelte";

  let { device, settings, platform, scan, configuration, biosFolder, disabled, onComplete, onOpenSettings }: {
    device: DeviceState;
    settings: LibrarySettings;
    platform: LibraryPlatform;
    scan: PlatformLibraryScan | undefined;
    configuration: EmulatorConfigurationState | undefined;
    biosFolder: string;
    disabled: boolean;
    onComplete: () => void;
    onOpenSettings: () => void;
  } = $props();

  let uploading = $state(false);
  let progress = $state<LibraryUploadProgress>();
  let message = $state("");
  let errorMessage = $state("");
  let controller: AbortController | undefined;
  let destroyed = false;
  const nativeImport = $derived(supportsEmulatorConfiguration(platform.id));
  const supportAvailable = $derived(scan?.requirements.some((entry) => entry.present) ?? false);
  const unavailable = $derived(disabled || uploading || settings.foldersInvalid || !device.connection);
  const controlsDisabled = $derived(nativeImport ? !configuration || configuration.unavailable : unavailable);
  const percent = $derived(progress ? Math.min(100, Math.floor(progress.transferredBytes / progress.totalBytes * 100)) : 0);
  const labels: Record<SupportRequirementStatus, string> = {
    found: "Found", checking: "Checking…", missing: "Missing", unchecked: "Missing · Not checked", configured: "Configured",
  };
  const foundBadge = "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-200";
  const missingBadge = "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-200";
  const unverifiedBadge = "bg-zinc-100 text-zinc-600 ring-zinc-500/20 dark:bg-zinc-900 dark:text-zinc-400";
  const button = "mt-2 inline-flex items-center rounded-ui border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";

  $effect(() => {
    device.connection;
    settings.libraryFolder;
    settings.romsFolder;
    settings.biosFolder;
    platform.id;
    message = "";
    errorMessage = "";
    return () => controller?.abort(new Error("The library source changed."));
  });

  function formatBytes(bytes: number): string {
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GiB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MiB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
    return `${bytes} B`;
  }

  function uploadSupport(requirement: LibrarySupportRequirement, files: File[]): void {
    if (nativeImport) configuration?.configure(files);
    else void upload(requirement, files);
  }

  async function upload(requirement: LibrarySupportRequirement, files: File[]): Promise<void> {
    if (unavailable || !files.length) return;
    const connection = device.connection;
    if (!connection) return;
    const abort = new AbortController();
    controller = abort;
    uploading = true;
    device.setupRunning = true;
    progress = undefined;
    message = "Preparing support file upload…";
    errorMessage = "";
    void connection.disconnected.then(() => abort.abort(new Error("The USB connection was disconnected.")));
    try {
      const result = await uploadPlatformSupportFiles(connection.transport, platform.id, requirement.id, files, {
        folders: settings.folderOptions,
        signal: abort.signal,
        onProgress(value) { progress = value; message = "Uploading support files…"; },
      });
      message = `${result.uploaded} ${result.uploaded === 1 ? "file" : "files"} uploaded.${result.skipped ? ` ${result.skipped} existing ${result.skipped === 1 ? "file" : "files"} kept.` : ""}`;
    } catch (error) {
      message = "";
      if (!destroyed && device.connection === connection) errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      controller = undefined;
      uploading = false;
      device.setupRunning = false;
      if (!destroyed && device.connection === connection) onComplete();
    }
  }

  onDestroy(() => {
    destroyed = true;
    controller?.abort(new Error("Support file upload stopped because the page closed."));
  });
</script>

<div class="mt-5">
  <h3 class="text-sm font-medium text-zinc-900 dark:text-zinc-50">BIOS, keys and firmware</h3>
  {#if !platform.requirements.length}
    <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">This platform only needs ROM files; no BIOS, keys or firmware apply.</p>
  {:else}
    {#if scan && !scan.supportDirectoryFound && !configuration?.running}
      <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">No {biosFolder} folder on this device yet.</p>
      <button type="button" id="library-open-bios-settings" onclick={onOpenSettings} class={button}>Open library settings</button>
    {/if}
    <div class="relative mt-2">
      <ul id="library-requirements" class="space-y-2" class:hidden={configuration?.running}>
        {#each platform.requirements as requirement (requirement.id)}
          {@const entry = scan?.requirements.find((item) => item.requirement.id === requirement.id)}
          {@const supportStatus = supportRequirementStatus(requirement.id, entry?.present ?? false, configuration)}
          <li class="rounded-ui border border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <span class="text-sm font-medium text-zinc-900 dark:text-zinc-50">{requirement.label}</span>
              <div class="flex shrink-0 items-center gap-2">
                <span data-requirement={requirement.id} data-present={entry?.present} data-support-state={supportStatus} class="inline-flex items-center rounded-ui px-3 py-1 text-xs font-medium ring-1 ring-inset {supportStatus === "found" || supportStatus === "configured" ? foundBadge : supportStatus === "missing" ? missingBadge : unverifiedBadge}">{labels[supportStatus]}</span>
                <EmulatorSupportControls state={configuration} {requirement} disabled={controlsDisabled} highlight={supportStatus === "missing" || supportStatus === "unchecked"} onUpload={(files) => uploadSupport(requirement, files)} />
              </div>
            </div>
            <p class="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{requirement.expected}.</p>
            {#if entry?.present}
              <ul class="mt-1 space-y-1">
                {#each entry.files as file (file.relativePath)}
                  <li class="flex items-center justify-between gap-3">
                    <span class="break-all font-mono text-xs text-zinc-700 dark:text-zinc-300">{file.relativePath}</span>
                    <span class="shrink-0 font-mono text-xs text-zinc-500 dark:text-zinc-400">{formatBytes(file.bytes)}</span>
                  </li>
                {/each}
              </ul>
            {:else if scan && supportStatus === "checking"}
              <p class="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">Waiting for {platform.emulator}'s setup check…</p>
            {/if}
          </li>
        {/each}
      </ul>
      <EmulatorSupportPending state={configuration} />
    </div>
    {#if nativeImport && supportAvailable && !configuration?.running}
      <button id="library-support-repair" type="button" disabled={!configuration || configuration.unavailable || configuration.ready} onclick={() => configuration?.repair()} class={button}>Complete setup from device files</button>
    {/if}
    {#if !configuration?.running}
      <EmulatorSetupStatus state={configuration} />
    {/if}
    {#if uploading && progress}
      <div class="mt-3">
        <p class="break-all text-xs text-zinc-600 dark:text-zinc-400">{progress.fileIndex}/{progress.fileCount} · {progress.filename} · {percent}%</p>
        <progress aria-label="Support file upload progress" value={progress.transferredBytes} max={progress.totalBytes} class="mt-1 h-1.5 w-full accent-zinc-700 dark:accent-zinc-300"></progress>
      </div>
    {/if}
    {#if uploading}
      <button type="button" id="library-support-upload-cancel" onclick={() => controller?.abort(new Error("Support file upload canceled. Completed files have been kept."))} class={button}>Cancel upload</button>
    {/if}
    {#if message}
      <p role="status" aria-live="polite" class="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{message}</p>
    {/if}
    {#if errorMessage}
      <p role="alert" class="mt-2 rounded-ui bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-950 dark:text-red-200">{errorMessage}</p>
    {/if}
  {/if}
</div>
