<script lang="ts">
  import EmulatorCheckButton from "./EmulatorCheckButton.svelte";
  import EmulatorConfigurationBadge from "./EmulatorConfigurationBadge.svelte";
  import type { EmulatorConfigurationState } from "./emulator-configuration-state";

  let { name, installedPackages, configuration, supportsConfiguration, disabled, checking, installing, onInstall, onCheck }: {
    name: string;
    installedPackages: readonly string[];
    configuration: EmulatorConfigurationState | undefined;
    supportsConfiguration: boolean;
    disabled: boolean;
    checking: boolean;
    installing: boolean;
    onInstall: () => void;
    onCheck: () => void;
  } = $props();
  const foundBadge = "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-200";
  const missingBadge = "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-200";
</script>

<div class="mt-5">
  <h3 class="text-sm font-medium text-zinc-900 dark:text-zinc-50">Emulator</h3>
  <ul id="library-emulator" class="mt-2 space-y-2">
    <li data-emulator-app={installedPackages.length ? "installed" : "missing"} class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-ui border border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <div class="contents">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm font-medium text-zinc-900 dark:text-zinc-50">{name} app</span>
            {#if !installedPackages.length}
              <span class="inline-flex items-center rounded-ui px-3 py-1 text-xs font-medium ring-1 ring-inset {missingBadge}">Missing</span>
            {/if}
          </div>
          {#if installedPackages.length}
            <p class="mt-1 break-all font-mono text-xs text-zinc-700 dark:text-zinc-300">{installedPackages.join(", ")}</p>
          {:else}
            <p class="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              Install {name} through Obtainium. Run Setup first if Obtainium or the emulator source is missing.
            </p>
          {/if}
        </div>
        {#if installedPackages.length}
          {#if supportsConfiguration}
            <div class="flex shrink-0 items-center gap-2">
              {#if configuration?.running}
                <button
                  id="library-support-skip"
                  type="button"
                  onclick={() => {
                    if (configuration?.automaticCheck) configuration.skip();
                    else configuration?.cancel();
                  }}
                  class="rounded-ui border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                >{configuration.nativeInstalling ? "Stop after import" : "Skip check"}</button>
              {:else}
                <EmulatorConfigurationBadge state={configuration} />
                <EmulatorCheckButton id="library-support-verify" label="Check emulator setup" disabled={!configuration || configuration.unavailable} running={configuration?.running} onCheck={() => configuration?.check()} />
              {/if}
            </div>
          {:else}
            <div class="flex shrink-0 items-center gap-2">
              <span class="inline-flex shrink-0 items-center rounded-ui px-3 py-1 text-xs font-medium ring-1 ring-inset {foundBadge}">Installed</span>
              <EmulatorCheckButton id="library-support-verify" label={`Check ${name} installation`} {disabled} running={checking} {onCheck} />
            </div>
          {/if}
        {:else}
          <button type="button" id="library-install-emulator" disabled={disabled} onclick={onInstall} class="shrink-0 rounded-ui border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900">
            {installing ? "Installing…" : "Install"}
          </button>
        {/if}
      </div>
    </li>
  </ul>
  {#if name === "RetroArch"}
    <p class="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">The core may live in RetroArch's app storage, which is not visible over USB. Check RetroArch on the device.</p>
  {/if}
</div>
