<script lang="ts">
  import { biosSystemInputs, biosSystemRun, biosSystemRunIncomplete, biosSystems } from "./adb/bios-systems";
  import type { DeviceState } from "./device-state.svelte";

  let { device, selection, files, disabled, onToggle, onFiles }: {
    device: DeviceState;
    selection: readonly string[];
    files: Record<string, Record<string, readonly File[]>>;
    disabled: boolean;
    onToggle: (platformId: string, selected: boolean) => void;
    onFiles: (platformId: string, slotId: string, files: readonly File[]) => void;
  } = $props();

  const systems = $derived(biosSystems(device.info?.abi));
  let openTab = $state("ps2");

  $effect(() => {
    if (!systems.some((system) => system.id === openTab)) openTab = systems[0]?.id ?? "";
  });
  const open = $derived(systems.find((system) => system.id === openTab) ?? systems[0]);

  function pick(platformId: string, slotId: string): void {
    const input = document.getElementById(`bios-system-input-${platformId}-${slotId}`);
    if (input instanceof HTMLInputElement) input.click();
  }

  function picked(systemId: string, slotId: string): readonly File[] {
    return files[systemId]?.[slotId] ?? [];
  }

  function useFreeBios(): void {
    onFiles("nds", "ds", []);
    onFiles("nds", "dsi", []);
  }

  function attachedNames(systemId: string): string {
    return Object.values(files[systemId] ?? {}).flat().map((file) => file.name).join(", ");
  }
</script>

{#if systems.length}
  <div id="bios-systems" class="mt-2">
    <div role="tablist" aria-label="Systems with BIOS files" class="flex flex-wrap gap-1 border-b border-zinc-200 dark:border-zinc-800">
      {#each systems as system (system.id)}
        {@const active = open?.id === system.id}
        {@const on = selection.includes(system.id)}
        {@const ready = !biosSystemRunIncomplete(biosSystemRun(system.id, files[system.id] ?? {}))}
        <button
          role="tab"
          type="button"
          aria-selected={active}
          data-system={system.id}
          id="bios-system-tab-{system.id}"
          {disabled}
          onclick={() => (openTab = system.id)}
          class="-mb-px flex items-baseline gap-2 rounded-t-lg border border-b-0 px-3 py-2 text-sm transition disabled:cursor-not-allowed disabled:opacity-50 {active
            ? 'border-zinc-200 bg-white font-semibold text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50'
            : 'border-transparent bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800'}"
        >
          {system.name}
          {#if on}
            <span
              class="inline-block size-2 rounded-full {ready ? 'bg-emerald-500 dark:bg-emerald-400' : 'bg-orange-500 dark:bg-orange-400'}"
              aria-label={ready ? "system files available" : "system files missing or incomplete"}
            ></span>
          {/if}
        </button>
      {/each}
    </div>

    <div class="rounded-b-lg rounded-tr-lg border border-t-0 border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      {#if open}
        {@const on = selection.includes(open.id)}
        <label class="flex cursor-pointer items-center gap-3">
          <input
            id="bios-system-toggle-{open.id}"
            type="checkbox"
            class="size-4 shrink-0 rounded border-zinc-300 accent-zinc-900 dark:border-zinc-700 dark:accent-zinc-100"
            checked={on}
            {disabled}
            onchange={() => onToggle(open.id, !on)}
          />
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium text-zinc-900 dark:text-zinc-50">{open.id === "nds" ? "Set up" : "I have files for"} {open.name}</span>
            <span class="mt-0.5 block text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              {on && attachedNames(open.id) ? attachedNames(open.id) : open.id === "nds"
                ? "FreeBIOS is built in for DS. DSi also requires your own DS files."
                : biosSystemInputs(open.id).map((input) => input.title).join(" and ")}
            </span>
          </span>
        </label>
        {#if on}
          {@const inputs = biosSystemInputs(open.id)}
          <div data-system-files={open.id} class="mt-3 grid gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800 {inputs.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}">
            {#each inputs as input (input.id)}
              {@const chosen = picked(open.id, input.id)}
              {@const ds = open.id === "nds" && input.id === "ds"}
              {@const builtIn = ds && !chosen.length && !picked("nds", "dsi").length}
              {@const ready = chosen.length > 0 || builtIn}
              <div data-slot={input.id} class="rounded-ui border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
                <p class="text-xs font-semibold text-zinc-900 dark:text-zinc-50">{input.title}</p>
                <p class="mt-0.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{input.hint}</p>
                <div class="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    id="bios-system-input-{open.id}-{input.id}"
                    type="file"
                    accept={input.accept || undefined}
                    multiple={input.multiple}
                    {disabled}
                    aria-label={`${input.label} for ${open.name}`}
                    class="sr-only"
                    tabindex="-1"
                    onchange={(event) => {
                      const selected = Array.from(event.currentTarget.files ?? []);
                      event.currentTarget.value = "";
                      onFiles(open.id, input.id, selected);
                    }}
                  />
                  <button
                    type="button"
                    id="bios-system-files-{open.id}-{input.id}"
                    {disabled}
                    onclick={() => pick(open.id, input.id)}
                    class="rounded-ui border px-2.5 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 {ready
                      ? 'border-zinc-500 text-zinc-900 hover:bg-zinc-100 dark:border-zinc-400 dark:text-zinc-50 dark:hover:bg-zinc-900'
                      : 'border-transparent bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200'}"
                  >
                    {ready ? "Replace" : input.label}
                  </button>
                  {#if ds}
                    <button
                      type="button"
                      id="bios-system-freebios-nds"
                      {disabled}
                      aria-pressed={builtIn}
                      title="Use FreeBIOS for DS only and clear selected DS and DSi files"
                      onclick={useFreeBios}
                      class="rounded-ui px-2 py-1 text-xs font-medium transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-800 {builtIn
                        ? 'bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'
                        : 'text-zinc-500 underline underline-offset-2 dark:text-zinc-400'}"
                    >FreeBIOS</button>
                  {/if}
                  {#if chosen.length}
                    <span class="min-w-0 break-all font-mono text-xs text-zinc-600 dark:text-zinc-300">
                      {chosen.map((file) => file.name).join(", ")}
                    </span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/if}
