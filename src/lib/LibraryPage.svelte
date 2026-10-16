<script lang="ts">
  import { onDestroy } from "svelte";
  import UnlockSnackbar from "./UnlockSnackbar.svelte";
  import RomUpload from "./RomUpload.svelte";
  import EmulatorConfiguration from "./EmulatorConfiguration.svelte";
  import EmulatorCard from "./EmulatorCard.svelte";
  import EmulatorSupportFiles from "./EmulatorSupportFiles.svelte";
  import type { EmulatorConfigurationState } from "./emulator-configuration-state";
  import { supportsEmulatorConfiguration, type EmulatorConfigurationCheckRequest } from "./adb/emulator-configuration";
  import { libraryPlatform, libraryPlatformGroups } from "./adb/library-catalog";
  import { scanPlatformLibrary, type PlatformLibraryScan } from "./adb/library-scan";
  import { readAndroidPackage } from "./adb/android-package";
  import { readAndroidUser, userScopedDevice } from "./adb/android-user";
  import { installEmulatorViaObtainium, ObtainiumNotInstalledError } from "./adb/obtainium-install";
  import type { LibrarySettings } from "./library-settings.svelte";
  import type { DeviceState } from "./device-state.svelte";

  let { device, settings, onInstallSetup }: {
    device: DeviceState;
    settings: LibrarySettings;
    onInstallSetup: () => void;
  } = $props();

  const groups = libraryPlatformGroups();
  const buttonOutline = "inline-flex items-center rounded-ui border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";
  const buttonSmall = "mt-2 inline-flex items-center rounded-ui border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";

  let selectedId = $state("");
  let configurationState = $state<EmulatorConfigurationState>();
  let configurationCheckRequest = $state<EmulatorConfigurationCheckRequest>({ id: 0, inspect: false });
  let scans = $state<Record<string, PlatformLibraryScan>>({});
  let configurationApps = $state<Record<string, boolean>>({});
  let scanning = $state(false);
  let installing = $state(false);
  let unlockRequired = $state(false);
  let installMessage = $state("");
  let installAbort: AbortController | undefined;
  let errorMessage = $state("");
  let obtainiumMissing = $state(false);
  let jobAbort: AbortController | undefined;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let lastConnection: DeviceState["connection"];
  let lastRomsFolder: string | undefined;
  let lastLibraryFolder: string | undefined;
  let lastBiosFolder: string | undefined;

  const selected = $derived(selectedId ? libraryPlatform(selectedId) : undefined);
  const scan = $derived(selectedId ? scans[selectedId] : undefined);
  const installedPackages = $derived(scan?.emulator.installed ?? (configurationApps[selectedId] === true ? selected?.emulatorPackages.slice(0, 1) ?? [] : []));
  const romsFolderLabel = $derived(settings.romsFolder || settings.defaultRomsFolder);
  const romDirectoryLabel = $derived(selected ? `${romsFolderLabel}/${selected.id}` : "");
  const missingLibrary = $derived(scan !== undefined && !scan.workspaceFound && !settings.romsFolder && !settings.biosFolder);
  const listedRomBytes = $derived((scan?.roms ?? []).reduce((sum, file) => sum + file.bytes, 0));
  const actionDisabled = $derived(!device.connected || !device.connection || scanning || device.setupRunning || device.pending !== undefined);
  const configurationCheckDisabled = $derived(!device.connected || !device.connection || device.setupRunning || device.pending !== undefined);

  const statusText = $derived.by(() => {
    if (!device.connected) {
      return selected
        ? `Connect your device to scan ${selected.name}.`
        : "Connect your device first, then choose a platform.";
    }
    if (!selected) return "Choose a platform to inspect its ROMs and support files.";
    if (installing) return installMessage;
    if (scanning) return `Scanning ${selected.name}…`;
    const result = scan;
    if (!result) return `Waiting to scan ${selected.name}.`;
    if (missingLibrary) return `The ${settings.libraryFolder} library folder was not found on this device.`;
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
    const folder = settings.romsFolder;
    const libraryFolder = settings.libraryFolder;
    const biosFolder = settings.biosFolder;
    if (connection === lastConnection && folder === lastRomsFolder &&
      libraryFolder === lastLibraryFolder && biosFolder === lastBiosFolder) return;
    const connectionChanged = connection !== lastConnection;
    settings.setCheckEmulatorSetup(true);
    lastConnection = connection;
    lastRomsFolder = folder;
    lastLibraryFolder = libraryFolder;
    lastBiosFolder = biosFolder;
    cancelScan("The library source changed.");
    scans = {};
    configurationState = undefined;
    configurationApps = {};
    errorMessage = "";
    const platformId = selectedId;
    if (connection && platformId) {
      if (connectionChanged) void runScan(platformId, true, true);
      else scanTimer = setTimeout(() => {
        scanTimer = undefined;
        void runScan(platformId, true, true);
      }, 300);
    }
  });

  function updateConfigurationState(state: EmulatorConfigurationState | undefined): void {
    configurationState = state;
  }

  function formatBytes(bytes: number): string {
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GiB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MiB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
    return `${bytes} B`;
  }

  function showError(error: unknown): void {
    obtainiumMissing = error instanceof ObtainiumNotInstalledError;
    const raw = error instanceof Error ? error.message : String(error);
    errorMessage = /disconnect|USB connection/i.test(raw)
      ? "The USB connection was interrupted. Reconnect the same device, then scan again."
      : raw;
  }

  function cancelScan(reason: string): void {
    clearTimeout(scanTimer);
    scanTimer = undefined;
    jobAbort?.abort(new Error(reason));
    jobAbort = undefined;
    scanning = false;
  }

  function requestConfigurationCheck(platformId: string, inspect: boolean): void {
    if (supportsEmulatorConfiguration(platformId) && (configurationApps[platformId] ?? !!scans[platformId]?.emulator.installed.length)) {
      configurationCheckRequest = { id: configurationCheckRequest.id + 1, inspect: inspect && settings.checkEmulatorSetup };
    }
  }

  async function runScan(platformId: string, force = false, checkConfiguration = false): Promise<void> {
    cancelScan("Another library scan started.");
    if (!force && scans[platformId]) {
      errorMessage = "";
      requestConfigurationCheck(platformId, checkConfiguration);
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
      let configurationStarted = false;
      const checkInstalled = async (): Promise<void> => {
        if (!checkConfiguration || !settings.checkEmulatorSetup || !supportsEmulatorConfiguration(platformId)) return;
        const user = await readAndroidUser(connection.transport, controller.signal);
        const scoped = userScopedDevice(connection.transport, user, controller.signal);
        const packageName = libraryPlatform(platformId).emulatorPackages[0];
        if (!packageName) throw new Error("The emulator package is unavailable.");
        const installed = await readAndroidPackage(scoped, packageName, user, controller.signal);
        if (device.connection !== connection || controller.signal.aborted) return;
        configurationApps = { ...configurationApps, [platformId]: installed !== undefined };
        if (installed) {
          requestConfigurationCheck(platformId, true);
          configurationStarted = true;
        }
      };
      // Native setup inspection can start as soon as the package is confirmed;
      // the read-only ROM/BIOS scan does not depend on the foreground app.
      const [files] = await Promise.allSettled([
        scanPlatformLibrary(connection.transport, platformId, settings.folderOptions, controller.signal),
        checkInstalled(),
      ]);
      if (device.connection !== connection || controller.signal.aborted) return;
      if (files.status === "rejected") throw files.reason;
      scans = { ...scans, [platformId]: files.value };
      configurationApps = { ...configurationApps, [platformId]: files.value.emulator.installed.length > 0 };
      if (!configurationStarted) requestConfigurationCheck(platformId, checkConfiguration);
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
    settings.setCheckEmulatorSetup(true);
    configurationState = undefined;
    selectedId = platformId;
    if (platformId) void runScan(platformId, false, true);
    else cancelScan("No platform is selected.");
  }

  function refreshFiles(): void {
    if (selectedId) void runScan(selectedId, true);
  }

  function refresh(): void {
    if (selectedId) void runScan(selectedId, true);
  }

  async function installEmulator(): Promise<void> {
    const connection = device.connection;
    const info = device.info;
    const platformId = selectedId;
    if (!connection || !info || !platformId || !scan || scan.emulator.installed.length || actionDisabled) return;
    const controller = new AbortController();
    installAbort = controller;
    controller.signal.addEventListener("abort", () => { unlockRequired = false; }, { once: true });
    installing = true;
    device.setupRunning = true;
    installMessage = "Checking Obtainium…";
    errorMessage = "";
    void connection.disconnected.then(() => controller.abort(new Error("The USB connection was disconnected.")));
    try {
      await installEmulatorViaObtainium(connection.transport, platformId, info.abi, {
        signal: controller.signal,
        reportStatus(message, options) {
          installMessage = message;
          if (options?.unlockRequired !== undefined) unlockRequired = options.unlockRequired;
        },
      });
      if (device.connection !== connection || controller.signal.aborted) return;
      scans = {};
      configurationState = undefined;
      await runScan(platformId, true, true);
    } catch (error) {
      if (device.connection === connection) showError(error);
    } finally {
      controller.abort(new Error("Emulator installation finished."));
      installAbort = undefined;
      installing = false;
      installMessage = "";
      device.setupRunning = false;
    }
  }

  function openLibrarySettings(): void {
    settings.open = true;
    requestAnimationFrame(() => {
      document.querySelector("#library-settings-body")?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }

  onDestroy(() => {
    cancelScan("Page closed.");
    installAbort?.abort(new Error("Page closed."));
  });
</script>

<UnlockSnackbar visible={installing && unlockRequired} message="Unlock your Android device to continue installation." />

<section aria-labelledby="library-platform-title" class="w-full rounded-ui border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h2 id="library-platform-title" class="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
      2. Library
    </h2>
    {#if scan}
      <span class="inline-flex items-center rounded-ui bg-zinc-100 px-3 py-1 font-mono text-xs text-zinc-600 ring-1 ring-inset ring-zinc-500/20 dark:bg-zinc-900 dark:text-zinc-400">
        {scan.romFileCount} ROM files
      </span>
    {/if}
  </div>

  {#snippet romUpload()}
    <RomUpload {device} {settings} platformId={selectedId} directory={romDirectoryLabel} disabled={actionDisabled} onComplete={refreshFiles} />
  {/snippet}

  <p class="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
    Review your game library.
  </p>

  <div class="mt-4 flex flex-wrap items-end gap-3">
    <label class="min-w-64 flex-1" for="library-platform">
      <span class="relative block">
        <select
          id="library-platform"
          aria-label="Platform"
          value={selectedId}
          disabled={device.setupRunning || device.pending !== undefined}
          onchange={(event) => selectPlatform(event.currentTarget.value)}
          class="w-full appearance-none rounded-ui border border-zinc-300 bg-white py-2 pl-3 pr-9 text-sm text-zinc-900 transition focus:border-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
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
    {:else if installing}
      <button type="button" onclick={() => installAbort?.abort(new Error("Emulator installation canceled."))} class={buttonOutline}>
        Cancel
      </button>
    {/if}
  </div>

  {#if selected && (!scan || missingLibrary)}
    <div class="mt-5">
      <h3 class="text-sm font-medium text-zinc-900 dark:text-zinc-50">ROM files</h3>
      {@render romUpload()}
    </div>
  {/if}

  {#if missingLibrary}
    <div class="mt-4 rounded-ui bg-amber-50 px-3 py-2 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-950 dark:ring-amber-600/20">
      <p class="text-sm text-amber-800 dark:text-amber-200">
        The {settings.libraryFolder} library folder was not found on this device. Create the shared library folders or choose an existing library in settings.
      </p>
      <button type="button" onclick={openLibrarySettings} class={buttonSmall}>Open library settings</button>
    </div>
  {:else if scan}
    <div class="mt-5">
      <h3 class="text-sm font-medium text-zinc-900 dark:text-zinc-50">ROM files</h3>
      {@render romUpload()}
      {#if !scan.romDirectoryFound}
        <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Folder not found on this device.
        </p>
        <button type="button" id="library-open-settings" onclick={openLibrarySettings} class={buttonSmall}>Open library settings</button>
      {:else if !scan.roms.length}
        <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          No games yet.
        </p>
      {:else}
        <p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          {formatBytes(listedRomBytes)}{scan.romFileCount > scan.roms.length ? ` · showing the first ${scan.roms.length} files` : ""}
        </p>
        <ul id="library-roms" class="mt-2 max-h-80 overflow-auto rounded-ui border border-zinc-200 dark:border-zinc-800">
          {#each scan.roms as file (file.relativePath)}
            <li class="flex items-center justify-between gap-3 px-3 py-2 odd:bg-zinc-50 dark:odd:bg-zinc-900/60">
              <span class="font-mono text-xs break-all text-zinc-800 dark:text-zinc-200">{file.relativePath}</span>
              <span class="shrink-0 font-mono text-xs text-zinc-500 dark:text-zinc-400">{formatBytes(file.bytes)}</span>
            </li>
          {/each}
        </ul>
      {/if}
      {#if scan.romsFromIndex}
        <p class="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Recently added files may take a moment to appear.
        </p>
      {/if}
    </div>
  {/if}

  {#if selected && ((scan && !missingLibrary) || supportsEmulatorConfiguration(selectedId))}
    {#key selectedId}
      <EmulatorSupportFiles {device} {settings} platform={selected} scan={missingLibrary ? undefined : scan} configuration={configurationState} biosFolder={settings.biosFolder || settings.defaultBiosFolder} disabled={actionDisabled} onComplete={refreshFiles} onOpenSettings={openLibrarySettings} />
    {/key}
  {/if}

  {#if selected && (scan || configurationApps[selectedId] !== undefined)}
    <EmulatorCard name={selected.emulator} {installedPackages} configuration={configurationState} supportsConfiguration={supportsEmulatorConfiguration(selectedId)} disabled={actionDisabled} checking={scanning} {installing} onInstall={installEmulator} onCheck={refresh} />
  {/if}

  {#if supportsEmulatorConfiguration(selectedId)}
    <EmulatorConfiguration {device} {settings} platformId={selectedId} disabled={actionDisabled} inspectDisabled={configurationCheckDisabled} appInstalled={configurationApps[selectedId] ?? (scan ? scan.emulator.installed.length > 0 : undefined)} checkRequest={configurationCheckRequest} onStateChange={updateConfigurationState} onComplete={refreshFiles} />
  {/if}

  <div id="library-scan-status" role="status" aria-live="polite" class={scan && !missingLibrary && !scanning && !installing ? "sr-only" : "mt-4 text-sm text-zinc-600 dark:text-zinc-400"}>
    {statusText}
  </div>
  {#if errorMessage}
    <div id="library-scan-error" role="alert" class="mt-2 flex flex-wrap items-center gap-3 rounded-ui bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-950 dark:text-red-200">
      <p class="min-w-0 grow basis-56">
        {errorMessage}
        {#if obtainiumMissing}
          Run <a
            href={device.setupRunning ? undefined : "#/"}
            aria-disabled={device.setupRunning || undefined}
            tabindex={device.setupRunning ? -1 : undefined}
            class="font-medium underline underline-offset-2"
          >Setup</a> first.
        {/if}
      </p>
      {#if obtainiumMissing}
        <button
          type="button"
          id="library-install-setup"
          disabled={actionDisabled}
          onclick={onInstallSetup}
          class="{buttonOutline} ml-auto shrink-0"
        >
          Install now
        </button>
      {/if}
    </div>
  {/if}
</section>
