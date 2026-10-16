<script lang="ts">
  import { onDestroy } from "svelte";
  import UnlockSnackbar from "./UnlockSnackbar.svelte";
  import { uploadPlatformRoms, type RomUploadProgress } from "./adb/library-upload";
  import type { DeviceState } from "./device-state.svelte";
  import type { LibrarySettings } from "./library-settings.svelte";

  let { device, settings, platformId, directory, disabled, onComplete }: {
    device: DeviceState;
    settings: LibrarySettings;
    platformId: string;
    directory: string;
    disabled: boolean;
    onComplete: () => void;
  } = $props();

  let input: HTMLInputElement | undefined = $state();
  let uploading = $state(false);
  let unlockRequired = $state(false);
  let dragging = $state(false);
  let progress = $state<RomUploadProgress>();
  let message = $state("");
  let errorMessage = $state("");
  let controller: AbortController | undefined;
  let destroyed = false;
  const unavailable = $derived(disabled || uploading || settings.foldersInvalid);
  const percent = $derived(progress ? Math.min(100, Math.floor(progress.transferredBytes / progress.totalBytes * 100)) : 0);

  $effect(() => {
    const connection = device.connection;
    const folders = [settings.libraryFolder, settings.romsFolder, settings.biosFolder, platformId].join("\n");
    void connection;
    void folders;
    message = "";
    errorMessage = "";
    return () => controller?.abort(new Error("The library source changed."));
  });

  async function upload(files: File[]): Promise<void> {
    if (unavailable || !files.length) return;
    const connection = device.connection;
    if (!connection) return;
    const abort = new AbortController();
    controller = abort;
    uploading = true;
    device.setupRunning = true;
    progress = undefined;
    message = "Preparing ROM upload…";
    errorMessage = "";
    void connection.disconnected.then(() => abort.abort(new Error("The USB connection was disconnected.")));
    try {
      const result = await uploadPlatformRoms(connection.transport, platformId, files, {
        folders: settings.folderOptions,
        signal: abort.signal,
        onProgress(value) { progress = value; },
        onStatus(value) { message = value; progress = undefined; },
        onUnlockRequired(value) { unlockRequired = value; },
      });
      message = `${result.uploaded} ${result.uploaded === 1 ? "file" : "files"} uploaded.${result.skipped ? ` ${result.skipped} existing ${result.skipped === 1 ? "file" : "files"} kept.` : ""}`;
    } catch (error) {
      message = "";
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      controller = undefined;
      uploading = false;
      unlockRequired = false;
      device.setupRunning = false;
      if (!destroyed && device.connection === connection) onComplete();
    }
  }

  function drop(event: DragEvent): void {
    event.preventDefault();
    dragging = false;
    if (unavailable || !event.dataTransfer) return;
    if (Array.from(event.dataTransfer.items).some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
      errorMessage = "Drop ROM files, rather than folders.";
      return;
    }
    void upload(Array.from(event.dataTransfer.files));
  }

  onDestroy(() => {
    destroyed = true;
    controller?.abort(new Error("ROM upload canceled because the page closed."));
  });
</script>

<UnlockSnackbar visible={uploading && unlockRequired} message="Unlock your Android device to connect Eden's game folder." />

<div class="mt-3">
  <input
    bind:this={input}
    id="library-rom-input"
    type="file"
    multiple
    disabled={unavailable}
    aria-label="Choose ROM files"
    class="sr-only"
    tabindex="-1"
    onchange={(event) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      void upload(files);
    }}
  />
  <button
    id="library-rom-upload"
    type="button"
    aria-disabled={unavailable}
    aria-describedby="library-rom-upload-help"
    onclick={() => { if (!unavailable) input?.click(); }}
    ondragover={(event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = unavailable ? "none" : "copy";
      dragging = !unavailable;
    }}
    ondragleave={() => { dragging = false; }}
    ondrop={drop}
    class="flex w-full flex-col items-center gap-1 rounded-ui border border-dashed px-4 py-5 text-center transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 {dragging ? 'border-zinc-500 bg-zinc-100 dark:border-zinc-400 dark:bg-zinc-900' : 'border-zinc-300 dark:border-zinc-700'} {unavailable ? 'cursor-not-allowed opacity-50' : 'hover:border-zinc-500 hover:bg-zinc-50 dark:hover:border-zinc-500 dark:hover:bg-zinc-900'}"
  >
    <span class="text-sm font-medium text-zinc-900 dark:text-zinc-50">{uploading ? "Uploading ROMs…" : "Drop ROM files here or click to choose"}</span>
    <span class="break-all text-xs text-zinc-500 dark:text-zinc-400">Upload to {directory}</span>
  </button>
  <p id="library-rom-upload-help" class="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
    Files go to the selected platform. Existing files are kept.
  </p>
  {#if uploading && progress}
    <div class="mt-3">
      <p class="break-all text-xs text-zinc-600 dark:text-zinc-400">{progress.fileIndex}/{progress.fileCount} · {progress.filename} · {percent}%</p>
      <progress aria-label="ROM upload progress" value={progress.transferredBytes} max={progress.totalBytes} class="mt-1 h-1.5 w-full accent-zinc-700 dark:accent-zinc-300"></progress>
    </div>
  {/if}
  {#if uploading}
    <button type="button" id="library-rom-upload-cancel" onclick={() => controller?.abort(new Error("ROM upload canceled. Completed files have been kept."))} class="mt-2 rounded-ui border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900">Cancel upload</button>
  {/if}
  <p role="status" aria-live="polite" class="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{message}</p>
  {#if errorMessage}
    <p role="alert" class="mt-2 rounded-ui bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-950 dark:text-red-200">{errorMessage}</p>
  {/if}
</div>
