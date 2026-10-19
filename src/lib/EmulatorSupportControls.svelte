<script lang="ts">
  import type { LibrarySupportRequirement } from "./adb/library-catalog";

  let { requirement, disabled, highlight, onUpload }: {
    requirement: LibrarySupportRequirement;
    disabled: boolean;
    highlight: boolean;
    onUpload: (files: File[]) => void;
  } = $props();
  let input: HTMLInputElement | undefined = $state();
  const description = $derived(`library-support-expected-${requirement.id}${requirement.picker.hint ? ` library-support-hint-${requirement.id}` : ""}`);
  const button = "inline-flex size-8 shrink-0 items-center justify-center rounded-ui border transition disabled:cursor-not-allowed disabled:opacity-50";
  const uploadStyle = $derived(highlight
    ? "border-zinc-900 bg-zinc-900 text-white hover:border-zinc-700 hover:bg-zinc-700 dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:border-zinc-200 dark:hover:bg-zinc-200"
    : "border-zinc-300 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900");
</script>

<input
  bind:this={input}
  id="library-support-input-{requirement.id}"
  type="file"
  accept={requirement.picker.accept}
  multiple={requirement.picker.multiple}
  {disabled}
  aria-label={requirement.picker.label}
  aria-describedby={description}
  class="sr-only"
  tabindex="-1"
  onchange={(event) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    onUpload(files);
  }}
/>
<button
  id="library-support-upload-{requirement.id}"
  type="button"
  {disabled}
  onclick={() => input?.click()}
  aria-label={requirement.picker.label}
  aria-describedby={description}
  title={requirement.picker.label}
  class="{button} {uploadStyle}"
>
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="size-4" aria-hidden="true">
    <path d="M12 4v9.8"></path>
    <path d="M6.9 9.1 12 4l5.1 5.1"></path>
    <path d="M4.4 13.8v3.7a2.5 2.5 0 0 0 2.5 2.5h10.2a2.5 2.5 0 0 0 2.5-2.5v-3.7"></path>
  </svg>
</button>
