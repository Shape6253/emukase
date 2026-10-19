<script lang="ts">
  import BiosSystems from "./BiosSystems.svelte";
  import FrontendPicker from "./FrontendPicker.svelte";
  import type { FrontendSelection } from "./adb/frontend-catalog";
  import type { DeviceState } from "./device-state.svelte";

  let {
    device, baseOptions, baseSelection, biosSelection, biosFiles, running, biosIncomplete,
    installDisabled, frontendSelection = $bindable("android"), esdeApk = $bindable(),
    onBaseToggle, onBiosToggle, onBiosFiles, onInstall, onCancel,
  }: {
    device: DeviceState;
    baseOptions: readonly { id: string; name: string; systems: string; supported: boolean }[];
    baseSelection: readonly string[];
    biosSelection: readonly string[];
    biosFiles: Record<string, Record<string, readonly File[]>>;
    running: boolean;
    biosIncomplete: boolean;
    installDisabled: boolean;
    frontendSelection?: FrontendSelection;
    esdeApk?: File;
    onBaseToggle: (id: string, selected: boolean) => void;
    onBiosToggle: (platformId: string, selected: boolean) => void;
    onBiosFiles: (platformId: string, slotId: string, files: readonly File[]) => void;
    onInstall: () => void;
    onCancel: () => void;
  } = $props();

  let wizardPosition = $state(0);

  const WIZARD_STEPS = [
    { id: "base", label: "Base setup", hint: "Runs first, in any case" },
    { id: "bios", label: "System files", hint: "Optional" },
    { id: "frontend", label: "Frontend", hint: "Optional" },
  ] as const;

  function wizardMove(step: number): void {
    wizardGo(wizardPosition + step);
  }

  function wizardGo(index: number): void {
    const target = Math.max(0, Math.min(WIZARD_STEPS.length - 1, index));
    if (canNavigate(target)) wizardPosition = target;
  }

  function canNavigate(index: number): boolean {
    return !running && !device.setupRunning &&
      (index <= wizardPosition || index < 2 || !biosIncomplete);
  }
</script>

<div class="mt-4" data-setup-wizard>
  <div class="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
    <span class="font-medium text-zinc-700 dark:text-zinc-200">Step {wizardPosition + 1} of {WIZARD_STEPS.length} · {WIZARD_STEPS[wizardPosition]?.label}</span>
    <span>{WIZARD_STEPS[wizardPosition]?.hint}</span>
  </div>
  <ol class="mt-2 flex gap-1" aria-label="Setup steps">
    {#each WIZARD_STEPS as entry, index (entry.id)}
      <li class="flex-1">
        <button
          type="button"
          onclick={() => wizardGo(index)}
          disabled={!canNavigate(index)}
          aria-label={`${entry.label}${index === wizardPosition ? " (current step)" : ""}`}
          aria-current={index === wizardPosition ? "step" : undefined}
          class="h-1 w-full rounded-full transition {index === wizardPosition
            ? 'bg-zinc-900 dark:bg-zinc-100'
            : index < wizardPosition
              ? 'bg-zinc-400 dark:bg-zinc-600'
              : 'bg-zinc-200 dark:bg-zinc-800'}"
        ></button>
      </li>
    {/each}
  </ol>

  {#if WIZARD_STEPS[wizardPosition]?.id === "base"}
    <div class="mx-auto mt-4 max-w-md text-left">
      <ul class="divide-y divide-zinc-100 dark:divide-zinc-900">
        <li class="flex cursor-default items-center gap-3 py-2.5">
          <input type="checkbox" checked disabled aria-label="Retro systems and cores, always installed" class="size-4 rounded border-zinc-300 accent-zinc-900 dark:border-zinc-700 dark:accent-zinc-100" />
          <span class="min-w-0">
            <span class="block text-sm font-medium text-zinc-900 dark:text-zinc-50">Retro systems and cores</span>
            <span class="block text-xs text-zinc-500 dark:text-zinc-400">RetroArch and its libretro cores</span>
          </span>
        </li>
        <li class="flex cursor-default items-center gap-3 py-2.5">
          <input type="checkbox" checked disabled aria-label="App update system, always installed" class="size-4 rounded border-zinc-300 accent-zinc-900 dark:border-zinc-700 dark:accent-zinc-100" />
          <span class="min-w-0">
            <span class="block text-sm font-medium text-zinc-900 dark:text-zinc-50">App update system</span>
            <span class="block text-xs text-zinc-500 dark:text-zinc-400">Obtainium tracks every supported emulator</span>
          </span>
        </li>
        {#each baseOptions as option (option.id)}
          {@const on = option.supported && baseSelection.includes(option.id)}
          <li>
            <label class="flex items-center gap-3 py-2.5 {option.supported ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}">
              <input
                type="checkbox"
                checked={on}
                disabled={!option.supported || running || device.setupRunning}
                aria-describedby="base-emulator-description-{option.id}"
                onchange={() => onBaseToggle(option.id, !on)}
                class="size-4 rounded border-zinc-300 accent-zinc-900 disabled:cursor-not-allowed dark:border-zinc-700 dark:accent-zinc-100"
              />
              <span class="min-w-0">
                <span class="block text-sm font-medium text-zinc-900 dark:text-zinc-50">{option.name}</span>
                <span id="base-emulator-description-{option.id}" class="block text-xs text-zinc-500 dark:text-zinc-400">{option.systems}{!option.supported ? " · Not compatible with this Android version" : ""}</span>
              </span>
            </label>
          </li>
        {/each}
      </ul>
      <p class="mt-1.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
        Unchecked emulators can be installed later from the Library.
      </p>
    </div>
  {:else if WIZARD_STEPS[wizardPosition]?.id === "bios"}
    <div class="mt-4 text-left">
      <p class="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
        These systems use BIOS, keys or firmware files that aren’t included with the emulators.
        Attach your own files now, or skip and add them later on the Library page.
      </p>
      <BiosSystems
        {device}
        selection={biosSelection}
        files={biosFiles}
        disabled={running || device.setupRunning}
        onToggle={onBiosToggle}
        onFiles={onBiosFiles}
      />
    </div>
  {:else}
    <div class="mt-4">
      <FrontendPicker {device} bind:selection={frontendSelection} bind:esdeApk disabled={running || device.setupRunning} />
    </div>
  {/if}
</div>

<div class="mt-6 flex items-center justify-between gap-3">
  <button
    type="button"
    onclick={() => wizardMove(-1)}
    disabled={wizardPosition === 0 || running || device.setupRunning}
    class="inline-flex items-center rounded-ui border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
  >
    Back
  </button>
  <div class="flex flex-wrap justify-end gap-3">
    {#if wizardPosition < WIZARD_STEPS.length - 1}
      <button
        type="button"
        onclick={() => wizardMove(1)}
        disabled={!canNavigate(wizardPosition + 1)}
        class="inline-flex items-center rounded-ui bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        Next
      </button>
    {:else}
      <button
        type="button"
        id="install-button"
        disabled={installDisabled}
        onclick={onInstall}
        class="inline-flex items-center rounded-ui bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {running ? "Setting up…" : "Start setup"}
      </button>
    {/if}
    {#if running}
      <button
        type="button"
        onclick={onCancel}
        class="inline-flex items-center rounded-ui border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        Cancel setup
      </button>
    {/if}
  </div>
</div>
