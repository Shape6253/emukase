<script lang="ts">
  import { onDestroy } from "svelte";
  import UnlockSnackbar from "./UnlockSnackbar.svelte";
  import SetupWizard from "./SetupWizard.svelte";
  import SetupResult from "./SetupResult.svelte";
  import SetupDownloads from "./SetupDownloads.svelte";
  import { FRONTENDS, frontendSetupStages, type FrontendSelection } from "./adb/frontend-catalog";
  import { createObtainiumSteps, OBTAINIUM_SETUP_STAGES } from "./adb/obtainium";
  import { latestObtainiumRelease } from "./adb/obtainium-release";
  import { APPLICATION_INSTALL_STAGES, installApplication } from "./adb/application-install";
  import { matchesApplicationVersion } from "./adb/application";
  import { readAndroidPackage } from "./adb/android-package";
  import { readAndroidUser } from "./adb/android-user";
  import { createObtainiumDownloader, readObtainiumText } from "./adb/obtainium-download";
  import { latestRelease, selectCores } from "./adb/catalog";
  import { createLibretroDownloader, readLibretroText } from "./adb/libretro-download";
  import { installRetroArch, RETROARCH_SETUP_STAGES } from "./adb/retroarch-install";
  import { emulatorUiReadinessMessage } from "./adb/emulator-ui";
  import { setupErrorMessage } from "./adb/setup-errors";
  import { prefetchApk, type Download, type DownloadProgress } from "./adb/download";
  import { prefetchRetroArchCores } from "./adb/retroarch-cores";
  import { withLibrarySetup, LIBRARY_SETUP_STAGE } from "./adb/setup-library";
  import { biosSystemRun, biosSystemRunIncomplete, biosSystems } from "./adb/bios-systems";
  import { biosSystemStage, setupBiosSystem } from "./adb/setup-bios-systems";
  import { setupBaseEmulator } from "./adb/setup-base-emulators";
  import { finishDeviceSetup, SETUP_FINISH_STAGE } from "./adb/setup-finish";
  import { prefetchEmulatorSupport } from "./adb/emulator-support";
  import { prefetchEsdeTheme, type EsdeThemeTransfer } from "./adb/esde-theme-transfer";
  import { libraryPlatform } from "./adb/library-catalog";
  import type { SetupEvent, SetupStage } from "./adb/setup-events";
  import type { DeviceState } from "./device-state.svelte";
  import type { LibrarySettings } from "./library-settings.svelte";

  let { device, settings }: { device: DeviceState; settings: LibrarySettings } = $props();

  const SETUP_SUCCESS_TITLE = "Your device is set up and ready.";
  const SETUP_SUCCESS_MESSAGE = "Open Library to manage your games and add any skipped BIOS files.";

  const BASE_STAGES: readonly { id: SetupStage; label: string }[] = [
    ...APPLICATION_INSTALL_STAGES.filter((step) => step.id === "prepare"),
    { id: LIBRARY_SETUP_STAGE, label: "Create shared library folders" },
    ...APPLICATION_INSTALL_STAGES.filter((step) => step.id !== "prepare"),
    ...OBTAINIUM_SETUP_STAGES.map((step): { id: SetupStage; label: string } => ({ id: `extra:${step.id}`, label: step.label })),
    ...RETROARCH_SETUP_STAGES.map((step): { id: SetupStage; label: string } => ({ id: `extra:${step.id}`, label: step.label })),
  ];

  const BASE_STEPS = [
    { id: "device", label: "Prepare device", description: "Device checks and shared game folders" },
    { id: "updates", label: "Set up updates", description: "Obtainium and official app sources" },
    { id: "emulators", label: "Emulators and cores", description: "Install and configure selected emulators and cores" },
  ] as const;
  const BIOS_STEP = { id: "bios", label: "BIOS systems", description: "Install selected emulators and import their BIOS" } as const;
  const FRONTEND_STEP = { id: "frontend", label: "Frontend", description: "Install and configure the selected frontend" } as const;
  type StepId = (typeof BASE_STEPS)[number]["id"] | (typeof BIOS_STEP)["id"] | (typeof FRONTEND_STEP)["id"];
  type StepStatus = "running" | "complete" | "failed" | "stopped";

  let biosSelection = $state<readonly string[]>(["nds"]);
  let biosFiles = $state<Record<string, Record<string, readonly File[]>>>({});
  let frontendSelection = $state<FrontendSelection>("android");
  let esdeApk = $state<File>();

  const BASE_OPTIONAL = [
    { id: "dolphin", name: "Wii and GameCube", systems: "Dolphin", platformIds: ["gc", "wii"], requires64Bit: true },
    { id: "ppsspp", name: "PlayStation Portable", systems: "PPSSPP", platformIds: ["psp"] },
    { id: "azahar", name: "Nintendo 3DS", systems: "Azahar", platformIds: ["n3ds"], minSdk: 29, requires64Bit: true },
  ] as const;
  const baseOptions = $derived(BASE_OPTIONAL.map((option) => {
    const info = device.info;
    const unsupportedReason = info && "minSdk" in option && info.sdk < option.minSdk
      ? "Not compatible with this Android version"
      : info && "requires64Bit" in option && !["arm64-v8a", "x86_64"].includes(info.abi)
        ? "Requires 64-bit Android" : undefined;
    return { ...option, supported: unsupportedReason === undefined, unsupportedReason };
  }));
  let baseSelection = $state<readonly string[]>(["dolphin", "ppsspp", "azahar"]);
  const baseRuns = $derived(baseOptions.filter((option) => option.supported && baseSelection.includes(option.id)));

  $effect(() => {
    const unsupported = new Set<string>(baseOptions.filter((option) => !option.supported).map((option) => option.id));
    if (baseSelection.some((id) => unsupported.has(id))) {
      baseSelection = baseSelection.filter((id) => !unsupported.has(id));
    }
  });

  $effect(() => {
    const frontend = FRONTENDS.find((option) => option.id === frontendSelection);
    if (device.info && frontend && device.info.sdk < frontend.minSdk) frontendSelection = "android";
  });

  let running = $state(false);
  let setupConnection = $state<DeviceState["connection"]>(undefined);
  let setupComplete = $state(false);
  let completedStages = $state<SetupStage[]>([]);
  let stepStatuses = $state<Partial<Record<StepId, StepStatus>>>({});
  let logs = $state<string[]>([]);
  let logElement = $state<HTMLPreElement>();
  let followingLog = true;
  let detailsOpen = $state(false);

  let transfers = $state<Record<string, DownloadProgress>>({});
  let statusText = $state("Connect your device first, then set up the emulators.");
  let errorMessage = $state("");
  let infoMessage = $state("");
  let unlockRequired = $state(false);
  let activeStep: StepId = "device";
  let deviceChecksComplete = false;
  let stages = $state<Partial<Record<SetupStage, SetupEvent>>>({});
  let jobAbort: AbortController | undefined;

  const biosRuns = $derived(biosSystems(device.info?.abi)
    .filter((platform) => biosSelection.includes(platform.id))
    .map((platform) => biosSystemRun(platform.id, biosFiles[platform.id] ?? {})));
  const biosIncomplete = $derived(biosRuns.some(biosSystemRunIncomplete));
  const frontendIncomplete = $derived(frontendSelection === "esde" && !esdeApk);
  const installDisabled = $derived(!device.connected || !device.info || running || device.setupRunning || device.pending !== undefined || settings.foldersInvalid || biosIncomplete || frontendIncomplete);
  const frontendStages = $derived(frontendSetupStages(frontendSelection));
  const cocoonCompletion = $derived(stages["extra:frontend-cocoon-configure"]);
  const completionNote = $derived(cocoonCompletion?.status === "complete" ? cocoonCompletion.message : undefined);
  const resultTitle = $derived(completionNote ? "Setup finished with a frontend limitation." : SETUP_SUCCESS_TITLE);
  const successMessage = $derived([SETUP_SUCCESS_MESSAGE, completionNote].filter(Boolean).join(" "));
  const STEPS = $derived([
    ...BASE_STEPS,
    ...(biosRuns.length ? [BIOS_STEP] : []),
    ...(frontendStages.length ? [FRONTEND_STEP] : []),
  ]);
  const STAGES = $derived.by(() => {
    const stages: { id: SetupStage; label: string }[] = [
      ...BASE_STAGES,
      ...baseRuns.map((option): { id: SetupStage; label: string } => ({
        id: `extra:base-${option.id}`,
        label: `Set up ${option.name} (${option.systems})`,
      })),
    ];
    for (const run of biosRuns) {
      const platform = libraryPlatform(run.platformId);
      stages.push({ id: biosSystemStage(run.platformId), label: `Set up ${platform.name} (${platform.emulator})` });
    }
    stages.push(...frontendStages, SETUP_FINISH_STAGE);
    return stages;
  });
  const currentSetup = $derived(setupConnection !== undefined && setupConnection === device.connection);
  const setupFinished = $derived(currentSetup && setupComplete && !running);
  const completedStepCount = $derived(currentSetup ? STAGES.filter((stage) => completedStages.includes(stage.id)).length : 0);
  const setupLabel = $derived(running ? "Setting up" : currentSetup && setupComplete ? "Done" : currentSetup && (errorMessage || infoMessage) ? "Stopped" : "Ready");

  function scrollLogToEnd(): void {
    if (followingLog && logElement) logElement.scrollTop = logElement.scrollHeight;
  }

  function trackLogScroll(): void {
    if (!logElement || logElement.clientHeight === 0) return;
    followingLog = logElement.scrollHeight - logElement.clientHeight - logElement.scrollTop <= 4;
  }

  $effect(() => {
    logs.length;
    scrollLogToEnd();
  });

  $effect(() => {
    if (!logElement) return;
    const observer = new ResizeObserver(scrollLogToEnd);
    observer.observe(logElement);
    return () => observer.disconnect();
  });

  function startOver(): void {
    if (running || device.setupRunning) return;
    setupConnection = undefined;
    setupComplete = false;
    completedStages = [];
    stepStatuses = {};
    stages = {};
    logs = [];
    errorMessage = "";
    infoMessage = "";
    detailsOpen = false;
    statusText = "Choose your setup options to begin.";
  }

  function log(message: string): void {
    logs = [...logs, message];
  }

  function showError(error: unknown): void {
    const readinessMessage = emulatorUiReadinessMessage(error);
    if (readinessMessage) {
      infoMessage = readinessMessage;
      log(readinessMessage);
      return;
    }
    errorMessage = setupErrorMessage(error);
    log(error instanceof Error ? error.message : String(error));
  }

  function onEvent(event: SetupEvent): void {
    if (event.unlockRequired !== undefined) unlockRequired = event.unlockRequired;
    const previous = stages[event.stage];
    stages[event.stage] = event;
    if ((event.status === "complete" || event.status === "skipped") &&
      STAGES.some((step) => step.id === event.stage) && !completedStages.includes(event.stage)) {
      completedStages = [...completedStages, event.stage];
    }
    if (event.stage === LIBRARY_SETUP_STAGE) {
      if (event.status === "failed") stepStatuses.device = "failed";
      else completeDevicePreparation();
    } else if (event.status === "failed") {
      stepStatuses[activeStep] = "failed";
    }
    const stage = STAGES.find((step) => step.id === event.stage);
    if (event.status === "running" && previous?.status !== "running" && stage) log(`${stage.label}…`);
    if (event.message && event.message !== previous?.message) log(event.message);
    if (event.message) statusText = event.message;
    else if (event.status === "running") {
      if (stage) statusText = `${stage.label}${event.total && event.total > 1 ? ` (${event.completed ?? 0}/${event.total})` : "…"}`;
    }
  }

  function completeDevicePreparation(): void {
    if (deviceChecksComplete && stages[LIBRARY_SETUP_STAGE]?.status === "complete") {
      stepStatuses.device = "complete";
    }
  }

  function stepStatus(step: StepId): StepStatus | undefined {
    return currentSetup || running ? stepStatuses[step] : undefined;
  }

  function onDownload(event: DownloadProgress): void {
    const next = { ...transfers };
    if (event.totalBytes !== undefined && event.receivedBytes === event.totalBytes) delete next[event.url];
    else next[event.url] = event;
    transfers = next;
  }

  function toggleBaseEmulator(id: string, selected: boolean): void {
    if (selected && !baseOptions.some((option) => option.id === id && option.supported)) return;
    if (selected) {
      if (!baseSelection.includes(id)) baseSelection = [...baseSelection, id];
    } else {
      baseSelection = baseSelection.filter((entry) => entry !== id);
    }
  }

  function toggleBiosSystem(platformId: string, selected: boolean): void {
    if (selected) {
      if (!biosSelection.includes(platformId)) biosSelection = [...biosSelection, platformId];
    } else {
      biosSelection = biosSelection.filter((entry) => entry !== platformId);
      delete biosFiles[platformId];
    }
  }

  function setBiosFiles(platformId: string, slotId: string, files: readonly File[]): void {
    const slots = { ...(biosFiles[platformId] ?? {}) };
    if (files.length) slots[slotId] = files;
    else delete slots[slotId];
    biosFiles = { ...biosFiles, [platformId]: slots };
  }

  export async function install(): Promise<void> {
    const connection = device.connection;
    const info = device.info;
    if (!connection || !info || installDisabled || setupFinished) return;
    const folderOptions = settings.folderOptions;
    setupConnection = connection;
    setupComplete = false;
    completedStages = [];
    stepStatuses = { device: "running" };
    activeStep = "device";
    deviceChecksComplete = false;
    device.setupRunning = true;
    running = true;
    detailsOpen = true;
    const controller = new AbortController();
    jobAbort = controller;
    const signal = controller.signal;
    signal.addEventListener("abort", () => { unlockRequired = false; }, { once: true });
    void connection.disconnected.then(() => controller.abort(new Error("The USB connection was disconnected.")));
    logs = [];
    errorMessage = "";
    infoMessage = "";
    stages = {};
    transfers = {};
    statusText = "Checking the connected Android profile…";
    log("Starting emulator setup.");
    const retroArchDownload = createLibretroDownloader({ onProgress: onDownload, signal });
    const prefetched: { dispose(): Promise<void> }[] = [];
    try {
      onEvent({ stage: "prepare", status: "running" });
      const user = await readAndroidUser(connection.transport, signal);
      let support: ReturnType<typeof prefetchEmulatorSupport> | undefined;
      let themeTransfer: EsdeThemeTransfer | undefined;
      const { result, library } = await withLibrarySetup(connection.transport, controller, async () => {
        statusText = "Finding official Obtainium and RetroArch releases…";
        const [resolved, retroArch] = await Promise.all([
          latestObtainiumRelease(info.abi, (url) => readObtainiumText(url, { signal })),
          latestRelease(info.abi, (url) => readLibretroText(url, { signal })),
        ]);
        onEvent({ stage: "prepare", status: "running", message: "Checking installed applications in this profile…" });
        const [obtainiumInstalled, retroArchInstalled] = await Promise.all([
          readAndroidPackage(connection.transport, resolved.packageName, user, signal),
          readAndroidPackage(connection.transport, retroArch.packageName, user, signal),
        ]);
        deviceChecksComplete = true;
        completeDevicePreparation();
        const reuseObtainium = obtainiumInstalled !== undefined && matchesApplicationVersion(resolved, obtainiumInstalled.version);
        const reuseRetroArch = retroArchInstalled !== undefined && matchesApplicationVersion(retroArch, retroArchInstalled.version);
        const cores = selectCores(retroArch.abi);
        type RetroArchDownloads = { apk: Download; cores: ReturnType<typeof prefetchRetroArchCores> };
        let retroArchDownloads: RetroArchDownloads | undefined;
        function startRetroArchDownload(): RetroArchDownloads {
          signal.throwIfAborted();
          if (!retroArchDownloads) {
            let apk: Download = retroArchDownload;
            if (!reuseRetroArch) {
              const prefetchedApk = prefetchApk(retroArchDownload, retroArch.apkUrl, signal);
              prefetched.push(prefetchedApk);
              apk = prefetchedApk;
            }
            const coreArchives = prefetchRetroArchCores(retroArchDownload, retroArch.abi, cores, signal);
            prefetched.push(coreArchives);
            retroArchDownloads = { apk, cores: coreArchives };
            log(`Downloading ${reuseRetroArch ? "" : "RetroArch and "}${cores.length} cores in parallel…`);
          }
          return retroArchDownloads;
        }
        const download = createObtainiumDownloader({
          signal,
          onProgress(event) {
            onDownload(event);
            if (event.totalBytes !== undefined && event.totalBytes > 0 &&
              event.receivedBytes >= event.totalBytes * 0.75) startRetroArchDownload();
          },
        });
        let obtainiumApk: Download = download;
        if (reuseObtainium) startRetroArchDownload();
        else {
          const prefetchedApk = prefetchApk(download, resolved.apkUrl, signal);
          prefetched.push(prefetchedApk);
          obtainiumApk = prefetchedApk;
        }
        statusText = `Setting up Obtainium ${resolved.version}…`;
        activeStep = "updates";
        stepStatuses.updates = "running";
        await installApplication(connection.transport, resolved, obtainiumApk, {
          signal, log, onEvent, extraSteps: createObtainiumSteps(info),
        });
        stepStatuses.updates = "complete";
        activeStep = "emulators";
        stepStatuses.emulators = "running";
        const retroDownloads = startRetroArchDownload();
        await installRetroArch(connection.transport, retroArch, retroDownloads.apk, {
          signal, log, onEvent, cores, coreDownload: retroDownloads.cores,
          installerPackageName: resolved.packageName, folders: folderOptions,
        });
        return { resolved, retroArch, cores };
      }, {
        ...folderOptions, log, onEvent,
        onFoldersReady(library) {
          if (frontendSelection === "esde") {
            themeTransfer = prefetchEsdeTheme(connection.transport, library.user, { folders: folderOptions, signal, log });
            prefetched.push(themeTransfer);
          }
          support = prefetchEmulatorSupport(connection.transport, library.user, biosRuns, {
            folders: folderOptions, signal,
            onStatus: (message) => log(`Background BIOS transfer: ${message}`),
          });
          prefetched.push(support);
        },
      });
      signal.throwIfAborted();
      if (device.connection !== connection) return;
      if (!support) throw new Error("Support-file preparation did not start after library setup.");
      const { resolved, retroArch, cores } = result;
      for (const option of baseRuns) {
        await setupBaseEmulator(connection.transport, info.abi, option.platformIds, `extra:base-${option.id}`, {
          folders: folderOptions, signal, log, onEvent,
          onUnlockRequired: (required) => { unlockRequired = required; },
        });
      }
      stepStatuses.emulators = "complete";
      if (biosRuns.length) {
        activeStep = "bios";
        stepStatuses.bios = "running";
        for (const run of biosRuns) {
          const platform = libraryPlatform(run.platformId);
          const stage = biosSystemStage(run.platformId);
          try {
            await setupBiosSystem(connection.transport, info.abi, run, {
              folders: folderOptions,
              supportPreparation: support.preparation,
              signal, log, onEvent,
              onUnlockRequired: (required) => { unlockRequired = required; },
            });
            onEvent({ stage, status: "complete" });
          } catch (error) {
            unlockRequired = false;
            if (signal.aborted) throw error;
            const raw = error instanceof Error ? error.message : String(error);
            onEvent({ stage, status: "failed", message: `${platform.name}: ${raw}` });
            throw error;
          }
        }
        stepStatuses.bios = "complete";
      }
      if (frontendStages.length) {
        activeStep = "frontend";
        stepStatuses.frontend = "running";
        const { setupFrontend } = await import("./adb/setup-frontend");
        await setupFrontend(connection.transport, info, frontendSelection, esdeApk, {
          folders: folderOptions, signal, log, onEvent, importSource: false, themeTransfer,
          onUnlockRequired: (required) => { unlockRequired = required; },
        });
        stepStatuses.frontend = "complete";
      }
      await finishDeviceSetup(connection.transport, user, { signal, log, onEvent });
      log(`Configured Obtainium ${resolved.version}, RetroArch ${retroArch.version}, ${cores.length} cores and ${library.systemCount} shared ROM folders.`);
      statusText = `${SETUP_SUCCESS_TITLE} ${SETUP_SUCCESS_MESSAGE}`;
      setupComplete = true;
    } catch (error) {
      showError(error);
      if (infoMessage) stepStatuses[activeStep] = "stopped";
      else if (!STEPS.some((step) => stepStatuses[step.id] === "failed")) stepStatuses[activeStep] = "failed";
      for (const step of STEPS) {
        if (stepStatuses[step.id] === "running") stepStatuses[step.id] = "stopped";
      }
      controller.abort(error);
      statusText = "Installation stopped.";
    } finally {
      unlockRequired = false;
      controller.abort(new Error("Setup finished."));
      const cleanup = await Promise.allSettled(prefetched.map((download) => download.dispose()));
      for (const result of cleanup) {
        if (result.status === "rejected") log(`Could not remove a temporary download: ${String(result.reason)}`);
      }
      transfers = {};
      if (setupComplete) detailsOpen = false;
      running = false;
      device.setupRunning = false;
      jobAbort = undefined;
    }
  }

  onDestroy(() => {
    jobAbort?.abort(new Error("Page closed."));
  });
</script>

<UnlockSnackbar visible={running && currentSetup && unlockRequired} />

<section aria-labelledby="emulator-setup-title" class="w-full rounded-ui border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h2 id="emulator-setup-title" class="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
      Device setup
    </h2>
    {#if device.connected}
      <span
        id="setup-progress"
        role="status"
        aria-atomic="true"
        aria-label={`${setupLabel}: ${completedStepCount} of ${STAGES.length} steps completed`}
        class="inline-flex items-center rounded-ui bg-zinc-100 px-3 py-1 font-mono text-xs text-zinc-600 ring-1 ring-inset ring-zinc-500/20 dark:bg-zinc-900 dark:text-zinc-400"
      >
        {setupLabel} · {completedStepCount}/{STAGES.length}
      </span>
    {/if}
  </div>
  {#if currentSetup && !running}
  <SetupResult complete={setupComplete} title={resultTitle} message={setupComplete ? successMessage : statusText}
    libraryDisabled={device.setupRunning} onStartOver={startOver}
  />
  {/if}
  {#if !setupFinished}
  <SetupWizard
    {device} {baseOptions} {baseSelection} {biosSelection} {biosFiles}
    {running} {biosIncomplete} {installDisabled} {statusText}
    bind:frontendSelection bind:esdeApk
    onBaseToggle={toggleBaseEmulator}
    onBiosToggle={toggleBiosSystem}
    onBiosFiles={setBiosFiles}
    onInstall={() => void install()}
    onCancel={() => jobAbort?.abort(new Error("Setup canceled."))}
  />
  {/if}

  {#if settings.foldersInvalid}
    <p role="alert" class="mt-2 text-sm text-red-700 dark:text-red-200">
      Fix the invalid folder paths in library settings before starting setup.
    </p>
  {/if}

  {#if currentSetup || running}
    <div
      role="progressbar"
      aria-label="Device setup"
      aria-valuemin="0"
      aria-valuemax={STAGES.length}
      aria-valuenow={completedStepCount}
      aria-valuetext={`${completedStepCount} of ${STAGES.length} steps completed`}
      class="mt-5 h-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
    >
      <div
        class="h-full rounded-full bg-zinc-900 dark:bg-zinc-100"
        style:width={`${completedStepCount / STAGES.length * 100}%`}
      ></div>
    </div>
  {/if}

  <SetupDownloads transfers={Object.values(transfers)} />

  {#if infoMessage}
    <p role="status" class="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{infoMessage}</p>
  {/if}
  {#if errorMessage}
    <div id="install-error" role="alert" class="mt-2 rounded-ui bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-950 dark:text-red-200">
      {errorMessage}
    </div>
  {/if}

  <details bind:open={detailsOpen} class="mt-5 border-t border-zinc-200 pt-3 dark:border-zinc-800">
    <summary class="cursor-pointer rounded-ui text-sm font-medium text-zinc-600 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-zinc-500 dark:text-zinc-400">Installation details</summary>
    <ol id="stages" class="mt-4 divide-y divide-zinc-100 dark:divide-zinc-900">
      {#each STEPS as step (step.id)}
        {@const status = stepStatus(step.id)}
        <li
          data-step={step.id}
          aria-current={status === "running" ? "step" : undefined}
          class="flex items-start gap-2.5 py-2.5 text-sm"
        >
          <span
            aria-hidden="true"
            class="mt-0.5 flex size-4 shrink-0 items-center justify-center {status === 'failed'
              ? 'text-red-600 dark:text-red-400'
              : status === 'complete' || status === 'running'
                ? 'text-zinc-900 dark:text-zinc-100'
                : 'text-zinc-400 dark:text-zinc-600'}"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="size-4">
              {#if status === "complete"}
                <path d="m3 8 3 3 7-7"></path>
              {:else if status === "failed"}
                <path d="m4 4 8 8M12 4l-8 8"></path>
              {:else if status === "stopped"}
                <path d="M4 8h8"></path>
              {:else if status === "running"}
                <circle cx="8" cy="8" r="5.5" opacity=".2"></circle>
                <path d="M8 2.5A5.5 5.5 0 0 1 13.5 8" class="origin-center motion-safe:animate-spin"></path>
              {:else}
                <circle cx="8" cy="8" r="2"></circle>
              {/if}
            </svg>
          </span>
          <div class="min-w-0 flex-1">
            <div class="sm:flex sm:items-baseline sm:justify-between sm:gap-4">
              <div class="flex min-w-0 items-baseline justify-between gap-3">
                <span class="shrink-0 {status === 'running' || status === 'failed' ? 'font-medium text-zinc-900 dark:text-zinc-50' : 'font-medium text-zinc-700 dark:text-zinc-300'}">{step.label}</span>
                {#if status}
                  <span class="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{status === "running" ? "In progress" : status === "complete" ? "Done" : status === "failed" ? "Failed" : "Stopped"}</span>
                {:else}
                  <span class="sr-only">Not started</span>
                {/if}
              </div>
              <p class="mt-0.5 text-xs text-zinc-500 sm:ml-auto sm:mt-0 sm:text-right dark:text-zinc-400">{step.description}</p>
            </div>
            {#if step.id === "emulators" && baseRuns.length}
              <ul class="mt-1.5 space-y-0.5 border-l border-zinc-200 pl-2.5 dark:border-zinc-800">
                {#each baseRuns as option (option.id)}
                  {@const event = stages[`extra:base-${option.id}`]}
                  <li class="text-xs text-zinc-500 dark:text-zinc-400">
                    {option.name} ({option.systems})
                    <span class={event?.status === "failed" ? "text-red-700 dark:text-red-300" : "text-zinc-400 dark:text-zinc-500"}>
                      — {event?.status === "running" ? "in progress" : event?.status === "complete" ? "done" : event?.status === "failed" ? "failed" : "queued"}
                    </span>
                  </li>
                {/each}
              </ul>
            {:else if step.id === "bios" && biosRuns.length}
              <ul class="mt-1.5 space-y-0.5 border-l border-zinc-200 pl-2.5 dark:border-zinc-800">
                {#each biosRuns as run (run.platformId)}
                  {@const platformId = run.platformId}
                  {@const event = stages[biosSystemStage(platformId)]}
                  <li class="text-xs text-zinc-500 dark:text-zinc-400">
                    {libraryPlatform(platformId).name}
                    <span class={event?.status === "failed" ? "text-red-700 dark:text-red-300" : "text-zinc-400 dark:text-zinc-500"}>
                      — {event?.status === "running" ? "in progress" : event?.status === "complete" ? "done" : event?.status === "failed" ? "failed" : "queued"}
                    </span>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        </li>
      {/each}
    </ol>
    <h3 class="mt-4 text-xs font-medium text-zinc-500 dark:text-zinc-400">Installation log</h3>
    <pre bind:this={logElement} onscroll={trackLogScroll} id="log" class="[overflow-anchor:none] mt-2 max-h-48 overflow-auto rounded-ui bg-zinc-100 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">{logs.length ? logs.join("\n") : "No steps have run yet."}</pre>
  </details>
</section>
