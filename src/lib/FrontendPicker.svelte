<script lang="ts">
  import androidIcon from "../assets/frontend-icons/android.svg";
  import cocoonIcon from "../assets/frontend-icons/cocoon.svg";
  import daijishoIcon from "../assets/frontend-icons/daijisho.png";
  import esdeIcon from "../assets/frontend-icons/esde.png";
  import retrohraiIcon from "../assets/frontend-icons/retrohrai.jpg";
  import cocoonScreen from "../assets/frontend-screens/cocoon.jpg";
  import daijishoScreen from "../assets/frontend-screens/daijisho.jpg";
  import esdeScreen from "../assets/frontend-screens/esde.jpg";
  import retrohraiScreen from "../assets/frontend-screens/retrohrai.jpg";
  import { FRONTENDS, type FrontendId, type FrontendOption, type FrontendSelection } from "./adb/frontend-catalog";
  import type { DeviceState } from "./device-state.svelte";

  let { device, selection = $bindable("android"), esdeApk = $bindable(), disabled = false }: {
    device: DeviceState;
    selection?: FrontendSelection;
    esdeApk?: File;
    disabled?: boolean;
  } = $props();

  let apkInput = $state<HTMLInputElement>();
  let apkError = $state("");

  function selectApk(event: Event): void {
    if (!(event.currentTarget instanceof HTMLInputElement)) return;
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (!/\.apk$/i.test(file.name) || !Number.isSafeInteger(file.size) || file.size <= 0) {
      apkError = "Choose a non-empty APK file for ES-DE.";
      return;
    }
    esdeApk = file;
    apkError = "";
  }

  const ICONS: Record<FrontendId, string> = {
    esde: esdeIcon,
    daijisho: daijishoIcon,
    cocoon: cocoonIcon,
    retrohrai: retrohraiIcon,
  };

  const SCREENS: Record<FrontendId, string> = {
    esde: esdeScreen,
    daijisho: daijishoScreen,
    cocoon: cocoonScreen,
    retrohrai: retrohraiScreen,
  };

  const focusRing = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-zinc-500";
  const unsupportedBadge =
    "inline-flex items-center rounded-ui px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset bg-zinc-100 text-zinc-600 ring-zinc-500/20 dark:bg-zinc-900 dark:text-zinc-400";

  const deviceSdk = $derived(device.info?.sdk);

  function isSupported(option: FrontendOption): boolean {
    return deviceSdk === undefined || deviceSdk >= option.minSdk;
  }
</script>

{#snippet icon(id: FrontendId, size: string)}
  <img src={ICONS[id]} alt="" class="{size} shrink-0 rounded-ui" />
{/snippet}

{#snippet screen(id: FrontendId)}
  <div class="aspect-[2/1] overflow-hidden rounded-ui ring-1 ring-inset ring-zinc-200 dark:ring-zinc-800">
    <img src={SCREENS[id]} alt="" class="size-full object-cover" />
  </div>
{/snippet}

<section aria-label="Frontend selection">
  <div role="radiogroup" aria-label="Frontend" class="grid grid-cols-1 gap-3 sm:grid-cols-2">
    <button
      type="button"
      role="radio"
      aria-checked={selection === "android"}
      {disabled}
      onclick={() => (selection = "android")}
      class="flex items-center justify-between gap-3 rounded-ui border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50 sm:col-span-2 {focusRing} {selection === "android" ? "border-zinc-900 dark:border-zinc-100" : "border-zinc-200 dark:border-zinc-800"}"
    >
      <span class="min-w-0">
        <span class="flex items-center gap-2">
          <img src={androidIcon} alt="" class="size-5 shrink-0" />
          <span class="text-sm font-medium text-zinc-900 dark:text-zinc-50">Keep Android</span>
        </span>
        <span class="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">Skip frontend installation and keep your current launcher.</span>
      </span>
      {#if selection === "android"}
        <span class="inline-flex shrink-0 items-center rounded-ui bg-zinc-900 px-1.5 py-0.5 text-[10px] font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">Selected</span>
      {/if}
    </button>
    {#each FRONTENDS as f (f.id)}
      <div class="rounded-ui border p-3 transition {selection === f.id && isSupported(f) ? "border-zinc-900 dark:border-zinc-100" : "border-zinc-200 dark:border-zinc-800"} {!isSupported(f) ? "opacity-60" : ""}">
        <button
          type="button"
          role="radio"
          aria-checked={selection === f.id}
          disabled={disabled || !isSupported(f)}
          onclick={() => (selection = f.id)}
          class="block w-full text-left transition disabled:cursor-not-allowed disabled:opacity-50 {focusRing}"
        >
          {@render screen(f.id)}
          <span class="mt-3 flex items-center justify-between gap-2">
            <span class="flex items-center gap-2">
              {@render icon(f.id, "size-5")}
              <span class="text-sm font-medium text-zinc-900 dark:text-zinc-50">{f.name}</span>
            </span>
            {#if !isSupported(f)}
              <span class={unsupportedBadge}>{f.requires}</span>
            {:else if selection === f.id}
              <span class="inline-flex items-center rounded-ui bg-zinc-900 px-1.5 py-0.5 text-[10px] font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">Selected</span>
            {/if}
          </span>
        </button>
      </div>
    {/each}
  </div>
  {#if selection === "esde"}
    <div class="mt-4 flex flex-wrap items-center gap-3 rounded-ui bg-zinc-100 px-3 py-2 text-sm text-zinc-600 ring-1 ring-inset ring-zinc-500/20 dark:bg-zinc-900 dark:text-zinc-400">
      <p class="min-w-0 grow basis-56">
        ES-DE is a paid app, available through the
        <a href="https://www.patreon.com/es_de" target="_blank" rel="noreferrer noopener" class="font-medium underline underline-offset-2">ES-DE Patreon</a>.
        Installation requires your own APK file.
        {#if esdeApk}
          <span role="status" class="break-all font-mono text-xs text-zinc-900 dark:text-zinc-100">{esdeApk.name}</span>
        {/if}
      </p>
      <input
        bind:this={apkInput}
        type="file"
        accept=".apk,application/vnd.android.package-archive"
        aria-label="Choose ES-DE APK"
        {disabled}
        class="sr-only"
        tabindex="-1"
        onchange={selectApk}
      />
      <button
        type="button"
        {disabled}
        onclick={() => apkInput?.click()}
        class="ml-auto inline-flex shrink-0 items-center rounded-ui border px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 {esdeApk
          ? 'border-zinc-500 text-zinc-900 hover:bg-zinc-200 dark:border-zinc-400 dark:text-zinc-50 dark:hover:bg-zinc-800'
          : 'border-transparent bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200'}"
      >
        {esdeApk ? "Replace APK" : "Select APK"}
      </button>
    </div>
    {#if apkError}
      <p role="alert" class="mt-2 text-sm text-red-700 dark:text-red-200">{apkError}</p>
    {/if}
  {/if}
</section>
