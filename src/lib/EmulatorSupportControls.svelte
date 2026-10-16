<script lang="ts">
  import EmulatorCheckButton from "./EmulatorCheckButton.svelte";
  import type { EmulatorConfigurationState } from "./emulator-configuration-state";
  import type { LibrarySupportRequirement } from "./adb/library-catalog";

  let { state: configuration, requirement, disabled, highlight, onUpload }: {
    state: EmulatorConfigurationState | undefined;
    requirement: LibrarySupportRequirement;
    disabled: boolean;
    highlight: boolean;
    onUpload: (files: File[]) => void;
  } = $props();
  let input: HTMLInputElement | undefined = $state();
  const kind = $derived(requirement.id === "switch-keys" ? "keys" : requirement.id === "switch-firmware" ? "firmware" : requirement.id);
  const nativeLabels: Readonly<Record<string, { upload: string; input: string; check: string }>> = {
    keys: { upload: "Choose keys and install", input: "Choose Eden keys", check: "Check keys" },
    firmware: { upload: "Choose firmware and install", input: "Choose Eden firmware", check: "Check firmware" },
    "nds-dsi": { upload: "Choose DSi files and configure", input: "Choose DSi files", check: "Check DSi files" },
  };
  const labels = $derived(nativeLabels[kind]);
  const nativeImport = $derived(labels !== undefined);
  const uploadLabel = $derived(labels?.upload ?? `Upload ${requirement.label}`);
  const button = "inline-flex size-8 shrink-0 items-center justify-center rounded-ui border transition disabled:cursor-not-allowed disabled:opacity-50";
  const uploadStyle = $derived(highlight
    ? "border-zinc-900 bg-zinc-900 text-white hover:border-zinc-700 hover:bg-zinc-700 dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:border-zinc-200 dark:hover:bg-zinc-200"
    : "border-zinc-300 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900");
</script>

<input
  bind:this={input}
  id="library-support-input-{kind}"
  type="file"
  accept={requirement.accept}
  multiple={kind !== "firmware"}
  {disabled}
  aria-label={labels?.input ?? `Choose ${requirement.label}`}
  class="sr-only"
  tabindex="-1"
  onchange={(event) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    onUpload(files);
  }}
/>
<div class="flex shrink-0 items-center gap-2">
  {#if nativeImport}
    <EmulatorCheckButton id="library-support-verify-{kind}" label={labels?.check ?? `Check ${requirement.label}`} {disabled} running={configuration?.running} onCheck={() => configuration?.check()} />
  {/if}
  <button id="library-support-upload-{kind}" type="button" {disabled} onclick={() => input?.click()} aria-label={uploadLabel} title={uploadLabel} class="{button} {uploadStyle}">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="size-4" aria-hidden="true">
      <path d="M12 4v9.8"></path>
      <path d="M6.9 9.1 12 4l5.1 5.1"></path>
      <path d="M4.4 13.8v3.7a2.5 2.5 0 0 0 2.5 2.5h10.2a2.5 2.5 0 0 0 2.5-2.5v-3.7"></path>
    </svg>
  </button>
</div>
