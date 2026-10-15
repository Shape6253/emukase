<script lang="ts">
  import { onDestroy } from "svelte";
  import { inspectWorkspace, verifySharedLibraryFolders, ensureSharedLibraryFolders } from "./adb/library-structure";
  import { WORKSPACE_FOLDER } from "./adb/workspace";
  import LibraryFolderInput from "./LibraryFolderInput.svelte";
  import type { LibrarySettings } from "./library-settings.svelte";
  import type { DeviceState } from "./device-state.svelte";

  let { device, settings }: { device: DeviceState; settings: LibrarySettings } = $props();

  const buttonOutline = "inline-flex items-center rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";
  const buttonPrimary = "inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200";

  let running = $state(false);
  let action = $state<"inspect" | "create" | "verify" | undefined>(undefined);
  let logs = $state<string[]>([]);
  let statusText = $state("Create or verify the shared library folders on this device.");
  let errorMessage = $state("");
  let libraryRoot = $state("");
  let jobAbort: AbortController | undefined;

  const actionDisabled = $derived(!device.connected || !device.connection || running || device.setupRunning || device.pending !== undefined);
  const jobDisabled = $derived(actionDisabled || settings.foldersInvalid);

  $effect(() => {
    const connection = device.connection;
    const options = settings.folderOptions;
    jobAbort?.abort(new Error("The library source changed."));
    libraryRoot = "";
    errorMessage = "";
    logs = [];
    statusText = connection
      ? `Create or verify the shared library folders in ${options.libraryFolder}.`
      : "Connect your device first, then create the shared library folders.";
  });

  function log(message: string): void {
    logs = [...logs, message].slice(-40);
  }

  function showError(error: unknown): void {
    const raw = error instanceof Error ? error.message : String(error);
    errorMessage = /disconnect|USB connection/i.test(raw)
      ? "The USB connection was interrupted. Reconnect the same device, then try again."
      : raw;
    log(raw);
  }

  async function runJob(kind: "inspect" | "create" | "verify"): Promise<void> {
    const connection = device.connection;
    if (!connection || jobDisabled) return;
    device.setupRunning = true;
    const transport = connection.transport;
    const options = settings.folderOptions;
    running = true;
    action = kind;
    const controller = new AbortController();
    jobAbort = controller;
    const signal = controller.signal;
    void connection.disconnected.then(() => controller.abort(new Error("The USB connection was disconnected.")));
    errorMessage = "";
    try {
      if (kind === "inspect") {
        statusText = "Inspecting storage and workspace…";
        log("Inspecting storage and workspace.");
        const result = await inspectWorkspace(transport, signal, options);
        signal.throwIfAborted();
        if (device.connection !== connection) return;
        libraryRoot = result.workspace.root;
        statusText = `Internal storage is accessible for the shared folders. Library root: ${libraryRoot}.`;
        log(`Android user ${result.user}. ${statusText}`);
      } else if (kind === "verify") {
        statusText = "Verifying all shared library folders…";
        const result = await verifySharedLibraryFolders(transport, signal, options);
        signal.throwIfAborted();
        if (device.connection !== connection) return;
        libraryRoot = result.workspace.root;
        statusText = `Verified ${result.systemCount} ROM folders, BIOS, ES-DE media, saves, states and setup.`;
        log(statusText);
      } else {
        statusText = "Preparing storage access and shared library folders…";
        log(statusText);
        const result = await ensureSharedLibraryFolders(transport, signal, log, options);
        signal.throwIfAborted();
        if (device.connection !== connection) return;
        libraryRoot = result.workspace.root;
        statusText = `Ready: ${result.systemCount} ROM folders, BIOS, ES-DE media, saves, states and setup verified. Existing files are preserved.`;
        log(statusText);
      }
    } catch (error) {
      if (device.connection === connection) {
        showError(error);
        statusText = "Library folders step stopped. See the error below.";
      }
    } finally {
      controller.abort(new Error("Library step finished."));
      running = false;
      device.setupRunning = false;
      jobAbort = undefined;
    }
  }

  onDestroy(() => {
    jobAbort?.abort(new Error("Page closed."));
    settings.libraryFolderInvalid = false;
    settings.romsFolderInvalid = false;
    settings.biosFolderInvalid = false;
  });
</script>

<div id="library-settings-body" class="mt-5" hidden={!settings.open}>
  <h3 class="text-sm font-medium text-zinc-900 dark:text-zinc-50">Project folders</h3>

  <LibraryFolderInput
    id="library-folder-input"
    label="Main"
    help="Main folder for all project files."
    value={settings.libraryFolder}
    defaultValue={WORKSPACE_FOLDER}
    customized={settings.libraryFolder !== WORKSPACE_FOLDER}
    disabled={actionDisabled}
    bind:invalid={settings.libraryFolderInvalid}
    oninput={(folder) => settings.setLibraryFolder(folder)}
  />
  <LibraryFolderInput
    id="library-bios-folder-input"
    label="BIOS"
    help="BIOS, keys and firmware are detected anywhere inside this folder."
    value={settings.biosFolder || settings.defaultBiosFolder}
    defaultValue={settings.defaultBiosFolder}
    customized={Boolean(settings.biosFolder)}
    disabled={actionDisabled}
    bind:invalid={settings.biosFolderInvalid}
    oninput={(folder) => settings.setBiosFolder(folder)}
  />
  <LibraryFolderInput
    id="library-roms-folder-input"
    label="ROMs"
    help="Platform subfolders such as psx are expected inside."
    value={settings.romsFolder || settings.defaultRomsFolder}
    defaultValue={settings.defaultRomsFolder}
    customized={Boolean(settings.romsFolder)}
    disabled={actionDisabled}
    bind:invalid={settings.romsFolderInvalid}
    oninput={(folder) => settings.setRomsFolder(folder)}
  />

  <div class="mt-4 flex flex-wrap gap-3">
    <button
      type="button"
      id="library-inspect-button"
      disabled={jobDisabled}
      onclick={() => void runJob("inspect")}
      class={buttonOutline}
    >
      {running && action === "inspect" ? "Inspecting…" : "Inspect storage"}
    </button>
    <button
      type="button"
      id="library-create-button"
      disabled={jobDisabled}
      onclick={() => void runJob("create")}
      class={buttonPrimary}
    >
      {running && action === "create" ? "Creating…" : "Create folders"}
    </button>
    <button
      type="button"
      id="library-verify-button"
      disabled={jobDisabled}
      onclick={() => void runJob("verify")}
      class={buttonOutline}
    >
      {running && action === "verify" ? "Verifying…" : "Verify folders"}
    </button>
    {#if running}
      <button
        type="button"
        onclick={() => jobAbort?.abort(new Error("Library setup canceled."))}
        class={buttonOutline}
      >
        Cancel
      </button>
    {/if}
  </div>

  {#if libraryRoot}
    <dl class="mt-4 grid grid-cols-1 gap-3 text-sm">
      <div class="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
        <dt class="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Library root</dt>
        <dd id="library-root" class="mt-1 font-mono text-xs break-all text-zinc-900 dark:text-zinc-50">{libraryRoot}</dd>
      </div>
    </dl>
  {/if}

  <div id="library-status" role="status" aria-live="polite" class="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
    {statusText}
  </div>
  {#if errorMessage}
    <div id="library-error" role="alert" class="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-950 dark:text-red-200">
      {errorMessage}
    </div>
  {/if}

  <details class="mt-4">
    <summary class="cursor-pointer text-sm font-medium text-zinc-700 dark:text-zinc-300">Library details</summary>
    <pre id="library-log" class="mt-2 max-h-48 overflow-auto rounded-xl bg-zinc-100 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">{logs.length ? logs.join("\n") : "No library steps have run yet."}</pre>
  </details>
</div>
