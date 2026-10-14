<script lang="ts">
  import { onDestroy } from "svelte";
  import { webAdbSupport } from "./adb/web-adb";
  import { formatAndroidLabel } from "./adb/android-label";
  import { formatDisplays } from "./adb/display";
  import type { DeviceState } from "./device-state.svelte";

  let { device }: { device: DeviceState } = $props();

  const initialHelpText =
    "Enable USB debugging on your Android device and connect it by USB. Authorize this computer when Android asks.";

  const support = webAdbSupport();
  const badgeClasses = $derived(
    device.connected
      ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
      : "bg-zinc-100 text-zinc-600 ring-zinc-500/20",
  );

  const chipsetLabel = $derived.by(() => {
    const info = device.info;
    if (!info) return "—";
    const soc = info.hardware?.soc && info.hardware.soc !== "unknown" ? info.hardware.soc : "CPU/SoC not reported";
    const gpu = info.hardware?.gpu && info.hardware.gpu !== "unknown" ? info.hardware.gpu : "GPU not reported";
    return `${soc} / ${gpu}`;
  });

  const buttonLabel = $derived(
    device.pending === "disconnecting"
      ? "Disconnecting…"
      : device.connection
        ? "Disconnect"
        : device.pending === "connecting"
          ? "Connecting…"
          : "Connect device",
  );

  function release(): void {
    device.release();
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
      {device.connected ? "Connected" : "Not connected"}
    </span>
  </div>

  {#if !device.connected}
    <p id="connection-help" class="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{initialHelpText}</p>
  {/if}

  <div class="mt-4 flex flex-wrap gap-2">
    <button
      type="button"
      id="connect-button"
      disabled={device.pending !== undefined || !support.supported}
      onclick={() => void device.connect()}
      class="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
    >
      {buttonLabel}
    </button>
  </div>

  {#if !support.supported}
    <p class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-600/20 dark:bg-amber-950 dark:text-amber-200">
      {support.reason ?? "WebUSB is unavailable in this browser."} Use Chrome or Edge over HTTPS or localhost.
    </p>
  {/if}

  {#if device.info}
    <dl id="device-summary" class="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div class="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
        <dt class="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Device</dt>
        <dd id="device-model" class="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-50">{device.info.manufacturer ? `${device.info.manufacturer} ${device.info.model}` : device.info.model}</dd>
      </div>
      <div class="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
        <dt class="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Android</dt>
        <dd id="device-android" class="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          {formatAndroidLabel(device.info)}
        </dd>
      </div>
      <div class="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
        <dt class="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Chipset / GPU</dt>
        <dd id="device-chipset" class="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-50">{chipsetLabel}</dd>
      </div>
      <div class="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
        <dt class="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Display</dt>
        <dd id="device-display" class="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          {formatDisplays(device.info.displays ?? [])}
        </dd>
      </div>
    </dl>
  {/if}

  {#if device.statusText}
    <div id="status" role="status" aria-live="polite" class="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
      {device.statusText}
    </div>
  {/if}
  {#if device.errorMessage}
    <div id="error" role="alert" class="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-950 dark:text-red-200">
      {device.errorMessage}
    </div>
  {/if}
</section>
