<script lang="ts">
  import type { EmulatorConfigurationState } from "./emulator-configuration-state";

  let { state }: { state: EmulatorConfigurationState | undefined } = $props();
  const button = "rounded-ui border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900";
</script>

{#if state?.running || state?.status || state?.errorMessage}
  <div class="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
    {#if state?.running}
      <div class="mt-2 flex flex-wrap gap-2">
        {#if state.automaticCheck}
          <button id="library-support-skip" type="button" onclick={() => state?.skip()} class={button}>Skip setup check</button>
        {:else}
          <button type="button" onclick={() => state?.cancel()} class={button}>{state.nativeInstalling ? "Stop after import" : "Cancel"}</button>
        {/if}
      </div>
    {/if}
    {#if state?.status}
      <p id="library-support-status" role="status" aria-live="polite" class="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{state.status}</p>
    {/if}
    {#if state?.running && state.progress}
      <progress aria-label="Support file upload progress" value={state.progress.bytes} max={state.progress.total} class="mt-3 h-1.5 w-full accent-zinc-700 dark:accent-zinc-300"></progress>
    {/if}
    {#if state?.errorMessage}
      <p id="library-support-error" role="alert" class="mt-2 rounded-ui bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-950 dark:text-red-200">{state.errorMessage}</p>
    {/if}
  </div>
{/if}
