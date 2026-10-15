<script lang="ts">
  import { onDestroy } from "svelte";
  import { libraryPlatform, libraryPlatformGroups } from "./adb/library-catalog";
  import {
    scanPlatformLibrary,
    ROMS_FOLDER,
    SUPPORT_FOLDER,
    WORKSPACE_FOLDER,
    type PlatformLibraryScan,
  } from "./adb/library-scan";
  import type { LibrarySettings } from "./library-settings.svelte";
  import type { DeviceState } from "./device-state.svelte";

  let { device, settings }: { device: DeviceState; settings: LibrarySettings } = $props();

  const groups = libraryPlatformGroups();
  const foundBadge = "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-200";
  const missingBadge = "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-200";
  const unverifiedBadge = "bg-zinc-100 text-zinc-600 ring-zinc-500/20 dark:bg-zinc-900 dark:text-zinc-400";
  const buttonOutline = "inline-flex items-center rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";
  const buttonSmall = "mt-2 inline-flex items-center rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";

  let selectedId = $state("");
  let scans = $state<Record<string, PlatformLibraryScan>>({});
  let scanning = $state(false);
  let errorMessage = $state("");
  let jobAbort: AbortController | undefined;
  let lastConnection: DeviceState["connection"];
  let lastRomsFolder: string | undefined;

  const selected = $derived(selectedId ? libraryPlatform(selectedId) : undefined);
  const scan = $derived(selectedId ? scans[selectedId] : undefined);
  const romsFolderLabel = $derived(settings.romsFolder || `${WORKSPACE_FOLDER}/${ROMS_FOLDER}`);
  const romDirectoryLabel = $derived(selected ? `${romsFolderLabel}/${selected.id}` : "");
  const listedRomBytes = $derived((scan?.roms ?? []).reduce((sum, file) => sum + file.bytes, 0));
  const actionDisabled = $derived(!device.connected || !device.connection || scanning || device.pending !== undefined);

  const statusText = $derived.by(() => {
    if (!device.connected) {
      return selected
        ? `Connect your device to scan ${selected.name}.`
        : "Connect your device first, then choose a platform.";
    }
    if (!selected) return "Choose a platform to inspect its ROMs and support files.";
    if (scanning) return `Scanning ${selected.name}…`;
    const result = scan;
    if (!result) return `Waiting to scan ${selected.name}.`;
    if (!result.workspaceFound && !settings.romsFolder) return "The Emukase library folder was not found on this device.";
    const roms = `${result.romFileCount} ROM ${result.romFileCount === 1 ? "file" : "files"} in ${romDirectoryLabel}.`;
    const app = result.emulator.installed.length
      ? `${result.platform.emulator} installed.`
      : `${result.platform.emulator} not installed.`;
    const core = result.emulator.coreState === "installed" ? " Core installed."
      : result.emulator.coreState === "unavailable" ? " Core not verified." : "";
    if (!result.requirements.length) return `${roms} ${app}${core}`;
    const found = result.requirements.filter((entry) => entry.present).length;
    return `${roms} ${app}${core} ${found} of ${result.requirements.length} support items found.`;
  });

  $effect(() => {
    const connection = device.connection;
    if (connection === lastConnection) return;
    lastConnection = connection;
    cancelScan("The device connection changed.");
    scans = {};
    errorMessage = "";
    const platformId = selectedId;
    if (connection && platformId) void runScan(platformId);
  });

  // The settings form can change the ROMs folder while this page is open; drop stale scans.
  $effect(() => {
    const folder = settings.romsFolder;
    if (folder === lastRomsFolder) return;
    const baseline = lastRomsFolder === undefined;
    lastRomsFolder = folder;
    if (baseline) return;
    scans = {};
    errorMessage = "";
    if (selectedId && device.connection) void runScan(selectedId, true);
  });

  function formatBytes(bytes: number): string {
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GiB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MiB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
    return `${bytes} B`;
  }

  function showError(error: unknown): void {
    const raw = error instanceof Error ? error.message : String(error);
    errorMessage = /disconnect|USB connection/i.test(raw)
      ? "The USB connection was interrupted. Reconnect the same device, then scan again."
      : raw;
  }

  function cancelScan(reason: string): void {
    jobAbort?.abort(new Error(reason));
    jobAbort = undefined;
    scanning = false;
  }

  async function runScan(platformId: string, force = false): Promise<void> {
    cancelScan("Another library scan started.");
    if (!force && scans[platformId]) {
      errorMessage = "";
      return;
    }
    const connection = device.connection;
    if (!connection) return;
    const controller = new AbortController();
    jobAbort = controller;
    scanning = true;
    errorMessage = "";
    void connection.disconnected.then(() => controller.abort(new Error("The USB connection was disconnected.")));
    try {
      const options = { romsFolder: settings.romsFolder || undefined };
      const result = await scanPlatformLibrary(connection.transport, platformId, options, controller.signal);
      if (device.connection !== connection || controller.signal.aborted) return;
      scans = { ...scans, [platformId]: result };
    } catch (error) {
      if (device.connection !== connection || controller.signal.aborted) return;
      showError(error);
    } finally {
      if (jobAbort === controller) {
        jobAbort = undefined;
        scanning = false;
      }
    }
  }

  function selectPlatform(platformId: string): void {
    selectedId = platformId;
    if (platformId) void runScan(platformId);
  }

  function refresh(): void {
    if (selectedId) void runScan(selectedId, true);
  }

  /** The connect card owns the library settings; open the form in place and bring it into view. */
  function openLibrarySettings(): void {
    settings.open = true;
    requestAnimationFrame(() => {
      document.querySelector("#library-settings-body")?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }

  onDestroy(() => {
    jobAbort?.abort(new Error("Page closed."));
  });
</script>

<section aria-labelledby="library-platform-title" class="w-full rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h2 id="library-platform-title" class="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
      2. Choose a platform
    </h2>
    {#if scan}
      <span class="inline-flex items-center rounded-full bg-zinc-100 px-3 py-1 font-mono text-xs text-zinc-600 ring-1 ring-inset ring-zinc-500/20 dark:bg-zinc-900 dark:text-zinc-400">
        {scan.romFileCount} ROM files
      </span>
    {/if}
  </div>

  <p class="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
    Review your game library.
  </p>

  <div class="mt-4 flex flex-wrap items-end gap-3">
    <label class="min-w-64 flex-1" for="library-platform">
      <span class="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Platform</span>
      <span class="relative block">
        <select
          id="library-platform"
          value={selectedId}
          disabled={device.pending !== undefined}
          onchange={(event) => selectPlatform(event.currentTarget.value)}
          class="w-full appearance-none rounded-lg border border-zinc-300 bg-white py-2 pl-3 pr-9 text-sm text-zinc-900 transition focus:border-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
        >
          <option value="">Select a platform…</option>
          {#each groups as group (group.emulator)}
            <optgroup label={group.emulator}>
              {#each group.platforms as platform (platform.id)}
                <option value={platform.id}>{platform.name}</option>
              {/each}
            </optgroup>
          {/each}
        </select>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500 dark:text-zinc-400">
          <path d="m6 9 6 6 6-6"></path>
        </svg>
      </span>
    </label>
    <button type="button" id="library-refresh-button" disabled={!selectedId || actionDisabled} onclick={refresh} class={buttonOutline}>
      {scanning ? "Scanning…" : "Refresh"}
    </button>
    {#if scanning}
      <button type="button" onclick={() => cancelScan("Library scan canceled.")} class={buttonOutline}>
        Cancel
      </button>
    {/if}
  </div>

  {#if scan && !scan.workspaceFound && !settings.romsFolder}
    <div class="mt-4 rounded-lg bg-amber-50 px-3 py-2 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-950 dark:ring-amber-600/20">
      <p class="text-sm text-amber-800 dark:text-amber-200">
        The Emukase library folder was not found on this device. Create the shared library folders on the Setup page first, or point the ROMs folder at your own collection.
      </p>
      <button type="button" onclick={openLibrarySettings} class={buttonSmall}>Open library settings</button>
    </div>
  {:else if scan}
    <div class="mt-5">
      <h3 class="text-sm font-medium text-zinc-900 dark:text-zinc-50">Emulator</h3>
      <ul id="library-emulator" class="mt-2 space-y-2">
        <li data-emulator-app={scan.emulator.installed.length ? "installed" : "missing"} class="rounded-xl border border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <span class="text-sm font-medium text-zinc-900 dark:text-zinc-50">{scan.platform.emulator} app</span>
            <span class="inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset {scan.emulator.installed.length ? foundBadge : missingBadge}">
              {scan.emulator.installed.length ? "Installed" : "Missing"}
            </span>
          </div>
          {#if scan.emulator.installed.length}
            <p class="mt-1 font-mono text-xs break-all text-zinc-700 dark:text-zinc-300">{scan.emulator.installed.join(", ")}</p>
          {:else}
            <p class="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              Install {scan.platform.emulator} on the device; the Setup page tracks it in Obtainium updates.
            </p>
          {/if}
        </li>
        {#if scan.emulator.coreState}
          <li data-emulator-core={scan.emulator.coreState} class="rounded-xl border border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <span class="text-sm font-medium text-zinc-900 dark:text-zinc-50">RetroArch core</span>
              <span class="inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset {scan.emulator.coreState === "installed" ? foundBadge : unverifiedBadge}">
                {scan.emulator.coreState === "installed" ? "Installed" : "Not verified"}
              </span>
            </div>
            {#if scan.emulator.coreState === "installed" && scan.emulator.corePath}
              <p class="mt-1 font-mono text-xs break-all text-zinc-700 dark:text-zinc-300">{scan.emulator.corePath}</p>
            {:else}
              <p class="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                The core may live in RetroArch's app storage, which is not visible over USB. Check RetroArch on the device.
              </p>
            {/if}
          </li>
        {/if}
      </ul>
    </div>

    <div class="mt-5">
      <h3 class="text-sm font-medium text-zinc-900 dark:text-zinc-50">BIOS, keys and firmware</h3>
      {#if !scan.requirements.length}
        <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          This platform only needs ROM files; no BIOS, keys or firmware apply.
        </p>
      {:else}
        {#if !scan.supportDirectoryFound}
          <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            The shared {SUPPORT_FOLDER} folder does not exist yet; support files can be added after creating the library folders.
          </p>
        {/if}
        <ul id="library-requirements" class="mt-2 space-y-2">
          {#each scan.requirements as entry (entry.requirement.id)}
            <li class="rounded-xl border border-zinc-200 px-3 py-2 dark:border-zinc-800">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <span class="text-sm font-medium text-zinc-900 dark:text-zinc-50">{entry.requirement.label}</span>
                <span
                  data-requirement={entry.requirement.id}
                  data-present={entry.present}
                  class="inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset {entry.present ? foundBadge : missingBadge}"
                >
                  {entry.present ? "Found" : "Missing"}
                </span>
              </div>
              {#if entry.present}
                <ul class="mt-1 space-y-1">
                  {#each entry.files as file (file.relativePath)}
                    <li class="flex items-center justify-between gap-3">
                      <span class="font-mono text-xs break-all text-zinc-700 dark:text-zinc-300">{file.relativePath}</span>
                      <span class="shrink-0 font-mono text-xs text-zinc-500 dark:text-zinc-400">{formatBytes(file.bytes)}</span>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                  Add {entry.requirement.expected} to {WORKSPACE_FOLDER}/{SUPPORT_FOLDER}/{scan.platform.id}/.
                </p>
              {/if}
            </li>
          {/each}
        </ul>
        <p class="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Files are detected anywhere under {WORKSPACE_FOLDER}/{SUPPORT_FOLDER}; per-platform folders keep them organized.
        </p>
      {/if}
    </div>

    <div class="mt-5">
      <h3 class="text-sm font-medium text-zinc-900 dark:text-zinc-50">ROM files</h3>
      {#if !scan.romDirectoryFound}
        <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          No {romDirectoryLabel} folder on this device yet.
        </p>
        <button type="button" id="library-open-settings" onclick={openLibrarySettings} class={buttonSmall}>Open library settings</button>
      {:else if !scan.roms.length}
        <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          No ROM files found in {romDirectoryLabel}.
        </p>
      {:else}
        <p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          {scan.romFileCount} {scan.romFileCount === 1 ? "file" : "files"} · {formatBytes(listedRomBytes)}{scan.romFileCount > scan.roms.length ? ` · showing the first ${scan.roms.length}` : ""}
        </p>
        <ul id="library-roms" class="mt-2 max-h-80 overflow-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          {#each scan.roms as file (file.relativePath)}
            <li class="flex items-center justify-between gap-3 px-3 py-2 odd:bg-zinc-50 dark:odd:bg-zinc-900/60">
              <span class="font-mono text-xs break-all text-zinc-800 dark:text-zinc-200">{file.relativePath}</span>
              <span class="shrink-0 font-mono text-xs text-zinc-500 dark:text-zinc-400">{formatBytes(file.bytes)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  <div id="library-scan-status" role="status" aria-live="polite" class="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
    {statusText}
  </div>
  {#if errorMessage}
    <div id="library-scan-error" role="alert" class="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-950 dark:text-red-200">
      {errorMessage}
    </div>
  {/if}
</section>
