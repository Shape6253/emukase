<script lang="ts">
  let { visible, message = "Unlock your Android device to continue setup." }: {
    visible: boolean;
    message?: string;
  } = $props();
</script>

<div role="status" aria-live="polite" aria-atomic="true">
  {#if visible}
    <div
      id="unlock-snackbar"
      class="fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 mx-auto flex max-w-md items-center gap-3 rounded-ui border border-amber-600/20 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-lg dark:border-amber-400/20 dark:bg-amber-950 dark:text-amber-100"
    >
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="size-5 shrink-0" aria-hidden="true">
        <rect x="5" y="10" width="14" height="11" rx="2"></rect>
        <path d="M8 10V6a4 4 0 0 1 8 0v4"></path>
      </svg>
      <p>{message}</p>
    </div>
  {/if}
</div>
