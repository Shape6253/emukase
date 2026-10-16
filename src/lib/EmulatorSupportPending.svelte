<script lang="ts">
  import type { EmulatorConfigurationState } from "./emulator-configuration-state";

  let { state }: { state: EmulatorConfigurationState | undefined } = $props();
</script>

{#if state?.running}
  <div class="flex h-12 items-center justify-center rounded-ui border border-zinc-200 bg-white text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400" role="status" aria-label="Eden operation in progress" aria-busy="true">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true">
      <path d="M12 3.6A8.4 8.4 0 1 1 3.6 12"></path>
    </svg>
  </div>
{/if}
