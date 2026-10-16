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

  let running = $state(false);
  let setupConnection = $state<DeviceState["connection"]>(undefined);
  let setupComplete = $state(false);
  let completedStages = $state<SetupStage[]>([]);
  let stages = $state<Partial<Record<SetupStage, SetupEvent>>>({});
  let logs = $state<string[]>([]);
  let transfers = $state<Record<string, DownloadProgress>>({});
  let statusText = $state("Connect your device first, then set up the emulators.");
  let errorMessage = $state("");
  let unlockRequired = $state(false);
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
    stages = { ...stages, [event.stage]: event };
    if ((event.status === "complete" || event.status === "skipped") &&
      STAGES.some((step) => step.id === event.stage) && !completedStages.includes(event.stage)) {
      completedStages = [...completedStages, event.stage];
    }
    if (event.message) statusText = event.message;
  }

  function stageDetail(stage: SetupStage): string {
    if (!currentSetup && !running) return "Waiting";
    const event = stages[stage];
    if (!event) return "Waiting";
    if (event.status === "running") {
      if (event.message) return event.message;
      return event.total && event.total > 1 ? `${event.completed ?? 0} / ${event.total}` : "Working";
    }
    if (event.status === "skipped") return event.message ?? "Skipped";
    return event.status === "failed" ? "Failed" : "Done";
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
        await installApplication(connection.transport, resolved, obtainiumApk, {
          signal, log, onEvent, extraSteps: createObtainiumSteps(info),
        });
        const retroDownloads = startRetroArchDownload();
        const installed = await installRetroArch(connection.transport, retroArch, retroDownloads.apk, {
          signal, log, onEvent, cores, coreDownload: retroDownloads.cores,
          installerPackageName: resolved.packageName,
        });
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
      if (!stages.prepare || stages.prepare.status === "running") onEvent({ stage: "prepare", status: "failed" });
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
      2. Set up emulators
    </h2>
    {#if device.connected}
      <span
        id="setup-progress"
        role="status"
        aria-atomic="true"
        aria-label={setupLabel === "Done" ? "Setup complete" : `${setupLabel}: ${completedStepCount} of ${STAGES.length} steps completed`}
        class="inline-flex items-center rounded-ui bg-zinc-100 px-3 py-1 font-mono text-xs text-zinc-600 ring-1 ring-inset ring-zinc-500/20 dark:bg-zinc-900 dark:text-zinc-400"
      >
        {setupLabel}{setupLabel === "Done" ? "" : ` · ${completedStepCount}/${STAGES.length}`}
      </span>
    {/if}
  </div>
  <p class="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
    Installs the emulator app with classic-system cores and official update sources. BIOS and games are not included.
  </p>

  <div class="mt-4 flex flex-wrap gap-3">
    <button
      type="button"
      id="install-button"
      disabled={installDisabled}
      onclick={() => void install()}
      class="inline-flex items-center rounded-ui bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
    >
      {running ? "Setting up…" : "Set up emulators"}
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

  <ol id="stages" class="mt-5 space-y-2">
    {#each STAGES as stage (stage.id)}
      <li
        data-stage={stage.id}
        class="flex items-center justify-between gap-3 rounded-ui border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
      >
        <span class="font-medium text-zinc-900 dark:text-zinc-50">{stage.label}</span>
        <span class="text-xs text-zinc-500 dark:text-zinc-400">{stageDetail(stage.id)}</span>
      </li>
    {/each}
  </ol>

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

  <details class="mt-4">
    <summary class="cursor-pointer text-sm font-medium text-zinc-700 dark:text-zinc-300">Installation details</summary>
    <pre id="log" class="mt-2 max-h-48 overflow-auto rounded-ui bg-zinc-100 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">{logs.length ? logs.join("\n") : "No steps have run yet."}</pre>
  </details>
</section>
