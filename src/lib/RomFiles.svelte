<script lang="ts">
  import { onDestroy } from "svelte";
  import { deletePlatformRom, renamePlatformRom, validateRomFilename } from "./adb/library-roms";
  import type { LibraryFileEntry } from "./adb/library-scan";
  import type { DeviceState } from "./device-state.svelte";
  import type { LibrarySettings } from "./library-settings.svelte";

  let { device, settings, platformId, files, disabled, onComplete }: {
    device: DeviceState;
    settings: LibrarySettings;
    platformId: string;
    files: readonly LibraryFileEntry[];
    disabled: boolean;
    onComplete: (previousPath: string, renamedPath?: string) => void;
  } = $props();

  let editor = $state<{ path: string; action: "rename" | "delete"; extension: string }>();
  let draft = $state("");
  let pending = $state(false);
  let message = $state("");
  let errorMessage = $state("");
  let controller: AbortController | undefined;
  let destroyed = false;

  const unavailable = $derived(disabled || pending || settings.foldersInvalid);
  const actionClass = "rounded-ui border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";
  const deleteClass = "rounded-ui border border-red-300 px-2.5 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950";
  const iconClass = "inline-flex size-7 shrink-0 items-center justify-center rounded-ui transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

  $effect(() => {
    const source = [device.connection, platformId, settings.libraryFolder, settings.romsFolder];
    void source;
    editor = undefined;
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

  function edit(path: string, action: "rename" | "delete"): void {
    if (unavailable) return;
    const name = path.slice(path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 ? name.slice(dot) : "";
    editor = { path, action, extension };
    draft = extension ? name.slice(0, -extension.length) : name;
    message = "";
    errorMessage = "";
  }

  function cancel(): void {
    if (pending) return;
    editor = undefined;
    errorMessage = "";
  }

  function focusName(input: HTMLInputElement): void {
    input.focus();
    input.select();
  }

  async function apply(): Promise<void> {
    const connection = device.connection;
    const current = editor;
    if (unavailable || !connection || !current) return;
    const name = `${draft.trim()}${current.extension}`;
    if (current.action === "rename") {
      try {
        if (!draft.trim()) throw new Error("Enter a file name.");
        validateRomFilename(name);
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
        return;
      }
    }
    const abort = new AbortController();
    controller = abort;
    pending = true;
    device.setupRunning = true;
    errorMessage = "";
    message = "";
    let completed = false;
    let renamedPath: string | undefined;
    void connection.disconnected.then(() => abort.abort(new Error("The USB connection was disconnected.")));
    try {
      const options = { folders: settings.folderOptions, signal: abort.signal };
      if (current.action === "rename") {
        renamedPath = await renamePlatformRom(connection.transport, platformId, current.path, name, options);
        message = `Renamed to ${name}.`;
      } else {
        await deletePlatformRom(connection.transport, platformId, current.path, options);
        message = `Deleted ${current.path}.`;
      }
      completed = true;
      editor = undefined;
    } catch (error) {
      if (!destroyed && !abort.signal.aborted) errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      controller = undefined;
      pending = false;
      device.setupRunning = false;
      if (completed && !destroyed && !abort.signal.aborted && device.connection === connection) onComplete(current.path, renamedPath);
    }
  }

  onDestroy(() => {
    destroyed = true;
    controller?.abort(new Error("ROM file operation canceled because the page closed."));
  });
</script>

<ul id="library-roms" class="mt-2 max-h-80 overflow-auto rounded-ui border border-zinc-200 dark:border-zinc-800">
  {#each files as file (file.relativePath)}
    <li class="px-3 py-2 odd:bg-zinc-50 dark:odd:bg-zinc-900/60">
      {#if editor?.path === file.relativePath && editor.action === "rename"}
        <form class="flex items-center gap-2" onsubmit={(event) => { event.preventDefault(); void apply(); }}>
          <label for="library-rom-name" class="sr-only">Rename {file.relativePath}</label>
          <input
            use:focusName
            id="library-rom-name"
            type="text"
            bind:value={draft}
            disabled={unavailable}
            required
            onkeydown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } }}
            aria-describedby={editor.extension ? "library-rom-extension" : undefined}
            class="min-w-0 flex-1 rounded-ui border border-zinc-300 bg-white px-2 py-1.5 font-mono text-xs text-zinc-900 focus:border-zinc-500 focus:outline-none disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
          />
          {#if editor.extension}
            <span id="library-rom-extension" class="shrink-0 font-mono text-xs text-zinc-500 dark:text-zinc-400">{editor.extension}</span>
          {/if}
          <div class="flex shrink-0 gap-2">
            <button type="submit" disabled={unavailable || !draft.trim()} class={actionClass}>{pending ? "Saving…" : "Save"}</button>
            <button type="button" disabled={pending} onclick={cancel} class={actionClass}>Cancel</button>
          </div>
        </form>
      {:else}
        <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div class="flex min-w-0 flex-1 items-center gap-1">
            <span class="min-w-0 break-all font-mono text-xs text-zinc-800 dark:text-zinc-200">{file.relativePath}</span>
            <button type="button" aria-label={`Rename ${file.relativePath}`} title="Rename" disabled={unavailable} onclick={() => edit(file.relativePath, "rename")} class="{iconClass} text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="size-4">
                <path d="m16 4 4 4M4 20l4-1L20 7a2.12 2.12 0 0 0-3-3L5 16l-1 4Z"></path>
              </svg>
            </button>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <span class="mr-1 font-mono text-xs text-zinc-500 dark:text-zinc-400">{formatBytes(file.bytes)}</span>
            <button type="button" aria-label={`Delete ${file.relativePath}`} title="Delete" disabled={unavailable} onclick={() => edit(file.relativePath, "delete")} class="{iconClass} text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="size-4">
                <path d="M3 6h18M19 6l-1 14H6L5 6M9 6V3h6v3M10 10v7m4-7v7"></path>
              </svg>
            </button>
          </div>
        </div>
      {/if}
      {#if editor?.path === file.relativePath && editor.action === "delete"}
        <div class="mt-3 rounded-ui border border-red-200 p-3 dark:border-red-900">
          <p class="break-all text-xs text-zinc-700 dark:text-zinc-300">Delete {file.relativePath} from your device? This cannot be undone.</p>
          <div class="mt-2 flex gap-2">
            <button type="button" disabled={unavailable} onclick={() => void apply()} class={deleteClass}>{pending ? "Deleting…" : "Delete file"}</button>
            <button type="button" disabled={pending} onclick={cancel} class={actionClass}>Cancel</button>
          </div>
        </div>
      {/if}
    </li>
  {/each}
</ul>
<p role="status" aria-live="polite" class="mt-2 break-all text-sm text-zinc-600 dark:text-zinc-400">{message}</p>
{#if errorMessage}
  <p role="alert" class="mt-2 break-all rounded-ui bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-950 dark:text-red-200">{errorMessage}</p>
{/if}
