<script lang="ts">
  let { id, label, disabled, running = false, onCheck }: {
    id: string;
    label: string;
    disabled: boolean;
    running?: boolean;
    onCheck: () => void;
  } = $props();
</script>

<button
  {id}
  type="button"
  aria-label={label}
  title={label}
  {disabled}
  onclick={onCheck}
  class="inline-flex size-8 shrink-0 items-center justify-center rounded-ui border border-zinc-300 text-zinc-500 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900"
>
  {#if running}
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true">
      <path d="M12 3.6A8.4 8.4 0 1 1 3.6 12"></path>
    </svg>
  {:else}
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="size-4" aria-hidden="true">
      <path d="M3.43 11.25A8.6 8.6 0 0 1 18.08 5.92L20.48 8.32"></path>
      <path d="M20.48 3.72V8.32H15.88"></path>
      <path d="M20.57 12.75A8.6 8.6 0 0 1 5.92 18.08L3.52 15.68"></path>
      <path d="M8.12 15.68H3.52V20.28"></path>
    </svg>
  {/if}
</button>
