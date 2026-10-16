<script lang="ts">
  import { onDestroy } from "svelte";
  import UnlockSnackbar from "./UnlockSnackbar.svelte";
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
  import { AdbInstallVerifierRestoreError } from "./adb/adb-install-verifier";
  import { DeviceAwakeRestoreError } from "./adb/device-keep-awake";
  import { prefetchApk, type Download, type DownloadProgress } from "./adb/download";
  import { prefetchRetroArchCores } from "./adb/retroarch-cores";
  import { withLibrarySetup, LIBRARY_SETUP_STAGE } from "./adb/setup-library";
  import type { SetupEvent, SetupStage } from "./adb/setup-events";
  import type { DeviceState } from "./device-state.svelte";
  import type { LibrarySettings } from "./library-settings.svelte";

  let { device, settings }: { device: DeviceState; settings: LibrarySettings } = $props();

  const STAGES: { id: SetupStage; label: string }[] = [
    ...APPLICATION_INSTALL_STAGES.filter((step) => step.id === "prepare"),
    { id: LIBRARY_SETUP_STAGE, label: "Create shared library folders" },
    ...APPLICATION_INSTALL_STAGES.filter((step) => step.id !== "prepare"),
    ...OBTAINIUM_SETUP_STAGES.map((step): { id: SetupStage; label: string } => ({ id: `extra:${step.id}`, label: step.label })),
    ...RETROARCH_SETUP_STAGES.map((step): { id: SetupStage; label: string } => ({ id: `extra:${step.id}`, label: step.label })),
  ];

  const STEPS = [
    { id: "device", label: "Prepare device", description: "Device checks and shared game folders" },
    { id: "updates", label: "Set up updates", description: "Obtainium and official app sources" },
    { id: "emulators", label: "Emulators and cores", description: "RetroArch and classic-system cores" },
  ] as const;
  type StepId = typeof STEPS[number]["id"];
  type StepStatus = "running" | "complete" | "failed" | "stopped";

  let running = $state(false);
  let setupConnection = $state<DeviceState["connection"]>(undefined);
  let setupComplete = $state(false);
  let completedStages = $state<SetupStage[]>([]);
  let stepStatuses = $state<Partial<Record<StepId, StepStatus>>>({});
  let logs = $state<string[]>([]);
  let transfers = $state<Record<string, DownloadProgress>>({});
  let statusText = $state("Connect your device first, then set up the emulators.");
  let errorMessage = $state("");
  let unlockRequired = $state(false);
  let activeStep: StepId = "device";
  let deviceChecksComplete = false;
  let stages: Partial<Record<SetupStage, SetupEvent>> = {};
  let jobAbort: AbortController | undefined;

  const installDisabled = $derived(!device.connected || !device.info || running || device.setupRunning || device.pending !== undefined || settings.foldersInvalid);
  const currentSetup = $derived(setupConnection !== undefined && setupConnection === device.connection);
  const completedStepCount = $derived(currentSetup ? completedStages.length : 0);
  const setupLabel = $derived(running ? "Setting up" : currentSetup && setupComplete ? "Done" : currentSetup && errorMessage ? "Stopped" : "Ready");
  const visibleStatus = $derived(currentSetup || running ? statusText : device.connected
    ? "Ready to set up your device."
    : "Connect your device first, then set up the emulators.");

  function formatBytes(bytes: number): string {
    return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`;
  }

  function log(message: string): void {
    logs = [...logs, message];
  }

  function showError(error: unknown): void {
    const raw = error instanceof Error ? error.message : String(error);
    let message = raw;
    if (error instanceof AdbInstallVerifierRestoreError || error instanceof DeviceAwakeRestoreError || error instanceof AggregateError) {
      message = raw;
    } else if (raw.includes("INSTALL_FAILED_VERIFICATION_FAILURE")) {
      message = "Android's app verification blocked this APK.";
    } else if (raw.includes("INSTALL_GRANT_RUNTIME_PERMISSIONS") || raw.includes("INSTALL_FAILED_USER_RESTRICTED")) {
      message =
        "Android blocked APK installation. Check USB installation permissions on the device, then try again.";
    } else if (/disconnect|USB connection/i.test(raw)) {
      message = "The USB connection was interrupted. Reconnect the same device, then install again.";
    }
    errorMessage = message;
    log(raw);
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

  export async function install(): Promise<void> {
    const connection = device.connection;
    const info = device.info;
    if (!connection || !info || installDisabled) return;
    const folderOptions = settings.folderOptions;
    setupConnection = connection;
    setupComplete = false;
    completedStages = [];
    stepStatuses = { device: "running" };
    activeStep = "device";
    deviceChecksComplete = false;
    device.setupRunning = true;
    running = true;
    const controller = new AbortController();
    jobAbort = controller;
    const signal = controller.signal;
    signal.addEventListener("abort", () => { unlockRequired = false; }, { once: true });
    void connection.disconnected.then(() => controller.abort(new Error("The USB connection was disconnected.")));
    logs = [];
    errorMessage = "";
    stages = {};
    transfers = {};
    statusText = "Checking the connected Android profile…";
    log("Starting emulator setup.");
    const retroArchDownload = createLibretroDownloader({ onProgress: onDownload, signal });
    const prefetched: { dispose(): Promise<void> }[] = [];
    try {
      onEvent({ stage: "prepare", status: "running" });
      const user = await readAndroidUser(connection.transport, signal);
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
        const installed = await installRetroArch(connection.transport, retroArch, retroDownloads.apk, {
          signal, log, onEvent, cores, coreDownload: retroDownloads.cores,
          installerPackageName: resolved.packageName,
        });
        stepStatuses.emulators = "complete";
        return { resolved, retroArch, cores, installed };
      }, { ...folderOptions, log, onEvent });
      signal.throwIfAborted();
      if (device.connection !== connection) return;
      const { resolved, retroArch, cores, installed } = result;
      const assets = installed.assetExtraction === "verified"
        ? ""
        : "RetroArch resources could not be verified automatically; check the app on the device. ";
      log(`Configured Obtainium ${resolved.version}, RetroArch ${retroArch.version}, ${cores.length} cores and ${library.systemCount} shared ROM folders.`);
      statusText = `Your device is set up and ready. ${assets}BIOS and games are not included.`;
      setupComplete = true;
    } catch (error) {
      showError(error);
      if (!STEPS.some((step) => stepStatuses[step.id] === "failed")) stepStatuses[activeStep] = "failed";
      for (const step of STEPS) {
        if (stepStatuses[step.id] === "running") stepStatuses[step.id] = "stopped";
      }
      controller.abort(error);
      statusText = "Installation stopped.";
    } finally {
      controller.abort(new Error("Setup finished."));
      const cleanup = await Promise.allSettled(prefetched.map((download) => download.dispose()));
      for (const result of cleanup) {
        if (result.status === "rejected") log(`Could not remove a temporary download: ${String(result.reason)}`);
      }
      transfers = {};
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
      2. Device setup
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
  <p class="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
    Sets up RetroArch, emulator cores, app updates and shared game folders. BIOS and games are not included.
  </p>

  <div class="mt-4 flex flex-wrap gap-3">
    <button
      type="button"
      id="install-button"
      disabled={installDisabled}
      onclick={() => void install()}
      class="inline-flex items-center rounded-ui bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
    >
      {running ? "Setting up…" : "Start setup"}
    </button>
    {#if running}
      <button
        type="button"
        onclick={() => jobAbort?.abort(new Error("Setup canceled."))}
        class="inline-flex items-center rounded-ui border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        Cancel setup
      </button>
    {/if}
  </div>

  {#if settings.foldersInvalid}
    <p role="alert" class="mt-2 text-sm text-red-700 dark:text-red-200">
      Fix the invalid folder paths in library settings before starting setup.
    </p>
  {/if}

  {#if device.connected || running}
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

  {#if Object.keys(transfers).length}
    <div id="transfer" class="mt-3 space-y-2">
      {#each Object.values(transfers) as transfer (transfer.url)}
        {@const filename = new URL(transfer.url).pathname.split("/").at(-1)}
        <div data-download-url={transfer.url}>
          <span class="text-xs text-zinc-600 dark:text-zinc-400">
            {filename}: {formatBytes(transfer.receivedBytes)}{transfer.totalBytes ? ` / ${formatBytes(transfer.totalBytes)}` : ""}
          </span>
          <progress
            max={transfer.totalBytes}
            value={transfer.totalBytes ? transfer.receivedBytes : undefined}
            aria-label={`Download ${filename}`}
            class="mt-1 w-full"
          ></progress>
        </div>
      {/each}
    </div>
  {/if}

  <div id="install-status" role="status" aria-live="polite" class="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
    {visibleStatus}
    {#if currentSetup && setupComplete && !running}
      Open <a
        href={device.setupRunning ? undefined : "#/library"}
        aria-disabled={device.setupRunning || undefined}
        tabindex={device.setupRunning ? -1 : undefined}
        class="font-medium text-zinc-900 underline underline-offset-2 dark:text-zinc-50"
      >Library</a> to check your games and BIOS.
    {/if}
  </div>
  {#if errorMessage}
    <div id="install-error" role="alert" class="mt-2 rounded-ui bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-950 dark:text-red-200">
      {errorMessage}
    </div>
  {/if}

  <details class="mt-5 border-t border-zinc-200 pt-3 dark:border-zinc-800">
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
          <div class="min-w-0 flex-1 sm:flex sm:items-baseline sm:justify-between sm:gap-4">
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
        </li>
      {/each}
    </ol>
    <h3 class="mt-4 text-xs font-medium text-zinc-500 dark:text-zinc-400">Installation log</h3>
    <pre id="log" class="mt-2 max-h-48 overflow-auto rounded-ui bg-zinc-100 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">{logs.length ? logs.join("\n") : "No steps have run yet."}</pre>
  </details>
</section>
