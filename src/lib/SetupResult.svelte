<script lang="ts">
  let { complete, title, message, libraryDisabled, onStartOver }: {
    complete: boolean;
    title: string;
    message: string;
    libraryDisabled: boolean;
    onStartOver: () => void;
  } = $props();

  let element = $state<HTMLDivElement>();
  $effect(() => { element?.focus(); });
</script>

{#if complete}
<div
  bind:this={element}
  id="install-status"
  role="status"
  aria-live="polite"
  aria-atomic="true"
  tabindex="-1"
  class="mt-4 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-3 rounded-ui bg-emerald-50 p-4 ring-1 ring-emerald-600/10 ring-inset focus:outline-none sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:gap-x-4 dark:bg-emerald-950/35 dark:ring-emerald-400/15"
>
  <span aria-hidden="true" class="flex size-9 items-center justify-center rounded-full bg-emerald-700 text-white dark:bg-emerald-400 dark:text-emerald-950">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-5">
      <path d="m5 12 4 4L19 6"></path>
    </svg>
  </span>
  <div class="min-w-0 max-w-prose text-sm">
    <p class="leading-5 font-semibold text-emerald-900 dark:text-emerald-200">{title}</p>
    <p class="mt-1 leading-6 text-emerald-800 dark:text-emerald-100/80">{message}</p>
  </div>
  <a
    href={libraryDisabled ? undefined : "#/library"}
    aria-disabled={libraryDisabled || undefined}
    tabindex={libraryDisabled ? -1 : undefined}
    class="col-start-2 inline-flex items-center justify-center justify-self-start rounded-ui bg-emerald-700 px-3 py-2 text-sm font-semibold whitespace-nowrap text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-700 aria-disabled:pointer-events-none aria-disabled:opacity-50 sm:col-start-3 sm:row-start-1 dark:bg-emerald-400 dark:text-emerald-950 dark:hover:bg-emerald-300 dark:focus-visible:outline-emerald-300"
  >Open Library</a>
</div>
<div class="mt-3 flex justify-center">
  <button
    type="button"
    disabled={libraryDisabled}
    onclick={onStartOver}
    class="rounded-ui text-sm font-medium text-zinc-600 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-zinc-500 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-100"
  >Start over</button>
</div>
{:else}
  <p id="install-status" role="status" aria-live="polite" class="mt-4 text-sm text-zinc-600 dark:text-zinc-400">{message}</p>
{/if}
