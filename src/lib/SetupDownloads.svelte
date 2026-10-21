<script lang="ts">
  import type { DownloadProgress } from "./adb/download";

  let { transfers }: { transfers: readonly DownloadProgress[] } = $props();

  function formatBytes(bytes: number): string {
    return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`;
  }
</script>

{#if transfers.length}
  <div id="transfer" class="mt-3 space-y-2">
    {#each transfers as transfer (transfer.url)}
      {@const filename = new URL(transfer.url).pathname.split("/").at(-1)}
      <div data-download-url={transfer.url}>
        <span class="text-xs text-zinc-600 dark:text-zinc-400">
          {filename}: {formatBytes(transfer.receivedBytes)}{transfer.totalBytes ? ` / ${formatBytes(transfer.totalBytes)}` : ""}
        </span>
        <progress
          max={transfer.totalBytes}
          value={transfer.totalBytes ? transfer.receivedBytes : undefined}
          aria-label={`Download ${filename}`}
          class="mt-1 w-full"
        ></progress>
      </div>
    {/each}
  </div>
{/if}
