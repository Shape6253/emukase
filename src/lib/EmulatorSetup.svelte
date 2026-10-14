<script lang="ts">
  import { onDestroy } from "svelte";
  import { createObtainiumSteps, OBTAINIUM_SETUP_STAGES } from "./adb/obtainium";
  import { latestObtainiumRelease, type ObtainiumRelease } from "./adb/obtainium-release";
  import { APPLICATION_INSTALL_STAGES, installApplication } from "./adb/application-install";
  import { createObtainiumDownloader, readObtainiumText } from "./adb/obtainium-download";
  import { latestRelease } from "./adb/catalog";
  import { createLibretroDownloader, readLibretroText } from "./adb/libretro-download";
  import { installRetroArch, RETROARCH_SETUP_STAGES } from "./adb/retroarch-install";
  import { AdbInstallVerifierRestoreError } from "./adb/adb-install-verifier";
  import type { DownloadProgress } from "./adb/download";
  import type { SetupEvent, SetupStage } from "./adb/setup-events";
  import type { DeviceState } from "./device-state.svelte";

  let { device }: { device: DeviceState } = $props();

  const STAGES: { id: SetupStage; label: string }[] = [
    ...APPLICATION_INSTALL_STAGES,
    ...OBTAINIUM_SETUP_STAGES.map((step): { id: SetupStage; label: string } => ({ id: `extra:${step.id}`, label: step.label })),
    ...RETROARCH_SETUP_STAGES.map((step): { id: SetupStage; label: string } => ({ id: `extra:${step.id}`, label: step.label })),
  ];

  let running = $state(false);
  let release = $state<ObtainiumRelease | undefined>(undefined);
  let stages = $state<Partial<Record<SetupStage, SetupEvent>>>({});
  let logs = $state<string[]>([]);
  let transferVisible = $state(false);
  let transferLabel = $state("");
  let transferTotal = $state<number | undefined>(undefined);
  let transferReceived = $state<number | undefined>(undefined);
  let statusText = $state("Connect your device first, then set up the emulators.");
  let errorMessage = $state("");
  let jobAbort: AbortController | undefined;

  const installDisabled = $derived(!device.connected || !device.info || running || device.pending !== undefined);

  function formatBytes(bytes: number): string {
    return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`;
  }

  function log(message: string): void {
    logs = [...logs, message].slice(-35);
  }

  function showError(error: unknown): void {
    const raw = error instanceof Error ? error.message : String(error);
    let message = raw;
    if (error instanceof AdbInstallVerifierRestoreError) {
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
    stages = { ...stages, [event.stage]: event };
    if (event.message) statusText = event.message;
    if (["download", "extra:retroarch-download"].includes(event.stage) && event.status === "complete") transferVisible = false;
  }

  function stageDetail(stage: SetupStage): string {
    const event = stages[stage];
    if (!event) return "Waiting";
    if (event.status === "running") {
      if (event.message) return event.message;
      return event.total && event.total > 1 ? `${event.completed ?? 0} / ${event.total}` : "Working";
    }
    return event.status === "failed" ? "Failed" : "Done";
  }

  function onDownload(event: DownloadProgress): void {
    transferVisible = true;
    const filename = new URL(event.url).pathname.split("/").at(-1) ?? "Obtainium";
    transferLabel = `${filename}: ${formatBytes(event.receivedBytes)}${event.totalBytes ? ` / ${formatBytes(event.totalBytes)}` : ""}`;
    transferTotal = event.totalBytes;
    transferReceived = event.totalBytes ? event.receivedBytes : undefined;
  }

  async function install(): Promise<void> {
    const connection = device.connection;
    const info = device.info;
    if (!connection || !info || running) return;
    running = true;
    const controller = new AbortController();
    jobAbort = controller;
    const signal = controller.signal;
    void connection.disconnected.then(() => controller.abort(new Error("The USB connection was disconnected.")));
    errorMessage = "";
    stages = {};
    transferVisible = false;
    release = undefined;
    statusText = "Finding official Obtainium and RetroArch releases…";
    log("Starting emulator setup.");
    const download = createObtainiumDownloader({ onProgress: onDownload, signal });
    const retroArchDownload = createLibretroDownloader({ onProgress: onDownload, signal });
    try {
      onEvent({ stage: "prepare", status: "running" });
      const [resolved, retroArch] = await Promise.all([
        latestObtainiumRelease(info.abi, (url) => readObtainiumText(url, { signal })),
        latestRelease(info.abi, (url) => readLibretroText(url, { signal })),
      ]);
      release = resolved;
      statusText = `Installing Obtainium ${resolved.version}…`;
      await installApplication(connection.transport, resolved, download, {
        signal, log, onEvent, extraSteps: createObtainiumSteps(),
      });
      await installRetroArch(connection.transport, retroArch, retroArchDownload, { signal, log, onEvent });
      statusText = `Ready: Obtainium ${resolved.version} and RetroArch ${retroArch.version}. Emulator updates are configured and RetroArch's first launch and asset extraction are verified. Cores, BIOS and games are not included.`;
    } catch (error) {
      showError(error);
      if (!stages.prepare || stages.prepare.status === "running") onEvent({ stage: "prepare", status: "failed" });
      controller.abort(error);
      statusText = "Installation stopped.";
    } finally {
      transferVisible = false;
      running = false;
      jobAbort = undefined;
    }
  }

  onDestroy(() => {
    jobAbort?.abort(new Error("Page closed."));
  });
</script>

<section aria-labelledby="emulator-setup-title" class="w-full rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h2 id="emulator-setup-title" class="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
      2. Set up emulators
    </h2>
    {#if release}
      <span class="inline-flex items-center rounded-full bg-zinc-100 px-3 py-1 font-mono text-xs text-zinc-600 ring-1 ring-inset ring-zinc-500/20 dark:bg-zinc-900 dark:text-zinc-400">
        Obtainium {release.version} · {release.abi}
      </span>
    {/if}
  </div>
  <p class="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
    Installs Obtainium and imports official emulator update sources, then installs RetroArch from Libretro in the current Android profile.
    Verifies RetroArch permissions, its first launch, and asset extraction. Cores, BIOS and games are not included.
  </p>

  <div class="mt-4 flex flex-wrap gap-3">
    <button
      type="button"
      id="install-button"
      disabled={installDisabled}
      onclick={() => void install()}
      class="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
    >
      {running ? "Setting up…" : "Set up emulators"}
    </button>
    {#if running}
      <button
        type="button"
        onclick={() => jobAbort?.abort(new Error("Setup canceled."))}
        class="inline-flex items-center rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        Cancel setup
      </button>
    {/if}
  </div>

  <ol id="stages" class="mt-5 space-y-2">
    {#each STAGES as stage (stage.id)}
      <li
        data-stage={stage.id}
        class="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
      >
        <span class="font-medium text-zinc-900 dark:text-zinc-50">{stage.label}</span>
        <span class="text-xs text-zinc-500 dark:text-zinc-400">{stageDetail(stage.id)}</span>
      </li>
    {/each}
  </ol>

  {#if transferVisible}
    <div id="transfer" class="mt-3">
      <span id="transfer-label" class="text-xs text-zinc-600 dark:text-zinc-400">{transferLabel}</span>
      <progress
        id="transfer-progress"
        max={transferTotal}
        value={transferReceived}
        aria-label="Current file download"
        class="mt-1 w-full"
      ></progress>
    </div>
  {/if}

  <div id="install-status" role="status" aria-live="polite" class="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
    {statusText}
  </div>
  {#if errorMessage}
    <div id="install-error" role="alert" class="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-950 dark:text-red-200">
      {errorMessage}
    </div>
  {/if}

  <details class="mt-4">
    <summary class="cursor-pointer text-sm font-medium text-zinc-700 dark:text-zinc-300">Installation details</summary>
    <pre id="log" class="mt-2 max-h-48 overflow-auto rounded-xl bg-zinc-100 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">{logs.length ? logs.join("\n") : "No steps have run yet."}</pre>
  </details>
</section>
