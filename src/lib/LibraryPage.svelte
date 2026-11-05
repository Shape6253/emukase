<script lang="ts">
  import { onDestroy } from "svelte";
  import UnlockSnackbar from "./UnlockSnackbar.svelte";
  import RomUpload from "./RomUpload.svelte";
  import RomFiles from "./RomFiles.svelte";
  import EmulatorConfiguration from "./EmulatorConfiguration.svelte";
  import EmulatorCard from "./EmulatorCard.svelte";
  import EmulatorSupportFiles from "./EmulatorSupportFiles.svelte";
  import LibrarySystemPicker from "./LibrarySystemPicker.svelte";
  import type { EmulatorConfigurationState } from "./emulator-configuration-state";
  import { supportsEmulatorConfiguration, type EmulatorConfigurationCheckRequest } from "./adb/emulator-configuration";
  import { libraryPlatform } from "./adb/library-catalog";
  import { librarySystem, MAIN_LIBRARY_PLATFORMS } from "./adb/library-systems";
  import { readAddedSystems, persistAddedSystems } from "./library-added-systems";
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

  const buttonOutline = "inline-flex items-center rounded-ui border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";
  const buttonSmall = "mt-2 inline-flex items-center rounded-ui border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";

  let selectedId = $state("");
  let addedIds = $state<string[]>([]);
  let configurationState = $state<EmulatorConfigurationState>();
  let configurationCheckRequest = $state<EmulatorConfigurationCheckRequest>({ id: 0, inspect: false });
  let scans = $state<Record<string, PlatformLibraryScan>>({});
  let configurationApps = $state<Record<string, readonly string[]>>({});
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

  const selected = $derived(selectedId ? librarySystem(selectedId) : undefined);
  const scan = $derived(Object.hasOwn(scans, selectedId) ? scans[selectedId] : undefined);
  const configuredPackages = $derived(Object.hasOwn(configurationApps, selectedId) ? configurationApps[selectedId] : undefined);
  const installedPackages = $derived(configuredPackages ?? scan?.emulator.installed ?? []);
  const emulatorInstalled = $derived(configuredPackages !== undefined || scan ? installedPackages.length > 0 : undefined);
  const romsFolderLabel = $derived(settings.romsFolder || settings.defaultRomsFolder);
  const addedSystemsScope = $derived(JSON.stringify([device.connection?.serial ?? null, romsFolderLabel]));
  const romDirectoryLabel = $derived(selected ? `${romsFolderLabel}/${selected.id}` : "");
  const missingLibrary = $derived(scan !== undefined && !scan.workspaceFound && !settings.romsFolder && !settings.biosFolder);
  const listedRomBytes = $derived((scan?.roms ?? []).reduce((sum, file) => sum + file.bytes, 0));
  const actionDisabled = $derived(!device.connected || !device.connection || scanning || device.setupRunning || device.pending !== undefined);
  const installationDisabled = $derived(actionDisabled || !device.info || emulatorInstalled !== false);
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
    const app = !result.platform.emulator ? "Emulator setup isn’t managed for this system." : result.emulator.installed.length
      ? `${result.platform.emulator} installed.`
      : `${result.platform.emulator} not installed.`;
    const core = result.emulator.coreState === "installed" ? " Core installed."
      : result.emulator.coreState === "unavailable" ? " Core not verified." : "";
    if (!result.requirements.length) return `${roms} ${app}${core}`;
    const found = result.requirements.filter((entry) => entry.present).length;
    return `${roms} ${app}${core} ${found} of ${result.requirements.length} support items found.`;
  });

  $effect(() => {
    addedIds = readAddedSystems(addedSystemsScope);
  });

  $effect(() => {
    const connection = device.connection;
    const folder = settings.romsFolder;
    const libraryFolder = settings.libraryFolder;
    const biosFolder = settings.biosFolder;
    if (connection === lastConnection && folder === lastRomsFolder &&
      libraryFolder === lastLibraryFolder && biosFolder === lastBiosFolder) return;
    const connectionChanged = connection !== lastConnection;
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
    if (supportsEmulatorConfiguration(platformId) && (configurationApps[platformId] ?? scans[platformId]?.emulator.installed)?.length) {
      configurationCheckRequest = { id: configurationCheckRequest.id + 1, inspect: inspect && settings.checkEmulatorSetup };
    }
  }

  async function runScan(platformId: string, force = false, checkConfiguration = false): Promise<void> {
    cancelScan("Another library scan started.");
    if (!force && Object.hasOwn(scans, platformId)) {
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
        configurationApps = { ...configurationApps, [platformId]: installed ? [packageName] : [] };
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
      configurationApps = { ...configurationApps, [platformId]: files.value.emulator.installed };
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
    configurationState = undefined;
    errorMessage = "";
    obtainiumMissing = false;
    selectedId = platformId;
    if (platformId) void runScan(platformId, false, true);
    else cancelScan("No platform is selected.");
  }

  function refreshFiles(): void {
    if (selectedId) void runScan(selectedId, true);
  }

  function onUploadComplete(uploaded: number): void {
    if (uploaded > 0 && selectedId && !addedIds.includes(selectedId) && !MAIN_LIBRARY_PLATFORMS.some((platform) => platform.id === selectedId)) {
      addedIds = [...addedIds, selectedId];
      persistAddedSystems(addedSystemsScope, addedIds);
    }
    refreshFiles();
  }

  function onRomChanged(previousPath: string, renamedPath?: string): void {
    const current = scan;
    if (current) {
      scans = { ...scans, [selectedId]: {
        ...current,
        roms: current.roms.flatMap((file) => file.relativePath !== previousPath ? [file]
          : renamedPath ? [{ ...file, relativePath: renamedPath }] : []),
        romFileCount: current.romFileCount - (renamedPath ? 0 : 1),
      } };
    }
    refreshFiles();
  }

  function refresh(): void {
    if (selectedId) void runScan(selectedId, true);
  }

  async function installEmulator(): Promise<void> {
    const connection = device.connection;
    const info = device.info;
    const platformId = selectedId;
    if (!connection || !info || !platformId || installationDisabled) return;
    const controller = new AbortController();
    installAbort = controller;
    controller.signal.addEventListener("abort", () => { unlockRequired = false; }, { once: true });
    installing = true;
    device.setupRunning = true;
    installMessage = "Checking Obtainium…";
    errorMessage = "";
    void connection.disconnected.then(() => controller.abort(new Error("The USB connection was disconnected.")));
    try {
      const packageName = await installEmulatorViaObtainium(connection.transport, platformId, info.abi, {
        signal: controller.signal,
        importSource: true,
        reportStatus(message, options) {
          installMessage = message;
          if (options?.unlockRequired !== undefined) unlockRequired = options.unlockRequired;
        },
      });
      if (device.connection !== connection || controller.signal.aborted) return;
      configurationApps = { ...configurationApps, [platformId]: [packageName] };
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
      Review your game library
    </h2>
    {#if scan}
      <span class="inline-flex items-center rounded-ui bg-zinc-100 px-3 py-1 font-mono text-xs text-zinc-600 ring-1 ring-inset ring-zinc-500/20 dark:bg-zinc-900 dark:text-zinc-400">
        {scan.romFileCount} ROM files
      </span>
    {/if}
  </div>

  {#snippet romUpload()}
    <RomUpload {device} {settings} platformId={selectedId} directory={romDirectoryLabel} disabled={actionDisabled} onComplete={onUploadComplete} />
  {/snippet}

  <LibrarySystemPicker {selectedId} {addedIds} romsFolder={romsFolderLabel} disabled={device.setupRunning || device.pending !== undefined} onSelect={selectPlatform}>
    {#snippet actions()}
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
    {/snippet}
  </LibrarySystemPicker>

  {#if selected && (!scan || missingLibrary)}
    <div class="mt-5">
      <h3 class="text-sm font-medium text-zinc-900 dark:text-zinc-50">ROM files for {selected.name}</h3>
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
      <h3 class="text-sm font-medium text-zinc-900 dark:text-zinc-50">ROM files for {scan.platform.name}</h3>
      {@render romUpload()}
      {#if !scan.romDirectoryFound}
        <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          This folder will be created when you upload ROM files.
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
        <RomFiles {device} {settings} platformId={selectedId} files={scan.roms} disabled={actionDisabled} onComplete={onRomChanged} />
      {/if}
      {#if scan.romsFromIndex}
        <p class="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Recently added files may take a moment to appear.
        </p>
      {/if}
    </div>
  {/if}

  {#if selected && !selected.emulator}
    <p class="mt-4 text-sm text-zinc-600 dark:text-zinc-400">Emulator setup isn’t managed for this system.</p>
  {/if}

  {#if selected?.emulator && selected.requirements.length > 0 && ((scan && !missingLibrary) || supportsEmulatorConfiguration(selectedId))}
    {#key selectedId}
      <EmulatorSupportFiles {device} {settings} platform={selected} scan={missingLibrary ? undefined : scan} configuration={configurationState} biosFolder={settings.biosFolder || settings.defaultBiosFolder} disabled={actionDisabled} onComplete={refreshFiles} onOpenSettings={openLibrarySettings} />
    {/key}
  {/if}

  {#if selected?.emulator && (scan || configuredPackages !== undefined)}
    <EmulatorCard name={selected.emulator} {installedPackages} configuration={configurationState} supportsConfiguration={supportsEmulatorConfiguration(selectedId)} showSetupStatus={!selected.requirements.length} disabled={actionDisabled} installDisabled={installationDisabled} checking={scanning} {installing} onInstall={installEmulator} onCheck={refresh} />
  {/if}

  {#if supportsEmulatorConfiguration(selectedId)}
    <EmulatorConfiguration {device} {settings} platformId={selectedId} disabled={actionDisabled} inspectDisabled={configurationCheckDisabled} appInstalled={emulatorInstalled} checkRequest={configurationCheckRequest} onStateChange={updateConfigurationState} onComplete={refreshFiles} />
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
