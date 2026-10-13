<script lang="ts">
  import { onDestroy } from "svelte";
  import { connectWebAdb, webAdbSupport } from "./adb/web-adb";
  import { inspectDevice, type DeviceInfo } from "./adb/device-info";
  import { formatAndroidLabel } from "./adb/android-label";
  import { formatDisplays } from "./adb/display";

  type Connection = Awaited<ReturnType<typeof connectWebAdb>>;

  const initialStatusText = "Connect your device to get started.";
  const initialHelpText =
    "Enable USB debugging on your Android device and connect it by USB. Authorize this computer when Android asks.";

  let connection = $state<Connection | undefined>(undefined);
  let info = $state<DeviceInfo | undefined>(undefined);
  let pending = $state<"connecting" | "disconnecting" | undefined>(undefined);
  let statusText = $state(initialStatusText);
  let errorMessage = $state("");
  let helpText = $state(initialHelpText);
  let destroyed = false;
  let inspecting: Connection | undefined;

  const support = webAdbSupport();
  const connected = $derived(connection !== undefined && info !== undefined);
  const badgeClasses = $derived(
    connected
      ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
      : "bg-zinc-100 text-zinc-600 ring-zinc-500/20",
  );

  const chipsetLabel = $derived.by(() => {
    if (!info) return "—";
    const soc = info.hardware?.soc && info.hardware.soc !== "unknown" ? info.hardware.soc : "CPU/SoC not reported";
    const gpu = info.hardware?.gpu && info.hardware.gpu !== "unknown" ? info.hardware.gpu : "GPU not reported";
    return `${soc} / ${gpu}`;
  });

  function showError(error: unknown): void {
    const raw = error instanceof Error ? error.message : String(error);
    errorMessage =
      error instanceof DOMException && error.name === "NotFoundError"
        ? "No device was selected. Connect your Android device and try again."
        : raw;
  }

  async function disconnect(): Promise<void> {
    if (!connection) return;
    pending = "disconnecting";
    const previous = connection;
    connection = undefined;
    info = undefined;
    errorMessage = "";
    statusText = "Disconnecting from your device…";
    helpText = initialHelpText;
    try {
      await previous.close();
    } catch (error) {
      showError(error);
    } finally {
      statusText = initialStatusText;
      pending = undefined;
    }
  }

  async function connect(): Promise<void> {
    if (destroyed || pending) return;
    if (connection) {
      await disconnect();
      return;
    }
    pending = "connecting";
    errorMessage = "";
    statusText = "Choose your device and approve this computer if Android asks.";
    let opened: Connection | undefined;
    try {
      opened = await connectWebAdb();
      if (destroyed) {
        await opened.close();
        return;
      }
      inspecting = opened;
      const nextInfo = await inspectDevice(opened.transport, opened.serial);
      if (destroyed) return;
      connection = opened;
      inspecting = undefined;
      info = nextInfo;
      statusText = "Connected. Device info is shown below.";
      helpText = "Connected and inspected.";
      const current = connection;
      void current.disconnected.then(() => {
        if (connection !== current) return;
        void disconnect();
      });
    } catch (error) {
      await opened?.close().catch(() => {});
      if (destroyed) return;
      if (connection === opened) {
        connection = undefined;
        info = undefined;
      }
      showError(error);
      statusText = "Connection could not be established.";
    } finally {
      inspecting = undefined;
      pending = undefined;
    }
  }

  function release(): void {
    destroyed = true;
    const current = connection ?? inspecting;
    connection = undefined;
    inspecting = undefined;
    info = undefined;
    void current?.close().catch(() => {});
  }
  onDestroy(release);
</script>

<svelte:window onbeforeunload={release} />

<section aria-labelledby="device-connect-title" class="w-full rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h2 id="device-connect-title" class="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
      1. Connect your device
    </h2>
    <span
      id="connection-badge"
      class="inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset {badgeClasses}"
    >
      {connected ? "Connected" : "Not connected"}
    </span>
  </div>

  <p id="connection-help" class="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{helpText}</p>

  <div class="mt-4 flex flex-wrap gap-2">
    <button
      type="button"
      id="connect-button"
      disabled={pending !== undefined || !support.supported}
      onclick={connect}
      class="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
    >
      {pending === "disconnecting" ? "Disconnecting…" : connection ? "Disconnect" : pending === "connecting" ? "Connecting…" : "Connect device"}
    </button>
  </div>

  {#if !support.supported}
    <p class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-950 dark:text-amber-200">
      {support.reason ?? "WebUSB is unavailable in this browser."} Use Chrome or Edge over HTTPS or localhost.
    </p>
  {/if}

  {#if info}
    <dl id="device-summary" class="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div class="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
        <dt class="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Device</dt>
        <dd id="device-model" class="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-50">{info.model}</dd>
        <dd class="mt-0.5 font-mono text-xs text-zinc-500 dark:text-zinc-400">{info.serial}</dd>
      </div>
      <div class="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
        <dt class="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Android</dt>
        <dd id="device-android" class="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          {formatAndroidLabel(info)}
        </dd>
      </div>
      <div class="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
        <dt class="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Chipset / GPU</dt>
        <dd id="device-chipset" class="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-50">{chipsetLabel}</dd>
      </div>
      <div class="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
        <dt class="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Display</dt>
        <dd id="device-display" class="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          {formatDisplays(info.displays ?? [])}
        </dd>
      </div>
    </dl>
  {/if}

  <div id="status" role="status" aria-live="polite" class="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
    {statusText}
  </div>
  {#if errorMessage}
    <div id="error" role="alert" class="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-950 dark:text-red-200">
      {errorMessage}
    </div>
  {/if}
</section>
