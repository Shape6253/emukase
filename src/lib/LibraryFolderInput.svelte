<script lang="ts">
  import { normalizeStorageFolder } from "./adb/workspace";

  interface Props {
    id: string;
    label: string;
    help: string;
    value: string;
    defaultValue: string;
    customized: boolean;
    disabled: boolean;
    invalid?: boolean;
    oninput: (folder: string) => void;
  }

  let { id, label, help, value, defaultValue, customized, disabled, invalid = $bindable(false), oninput }: Props = $props();

  let draft = $state("");
  let errorMessage = $state("");
  let helpDismissed = $state(false);
  let lastValue: string | undefined;

  $effect(() => {
    if (value === lastValue) return;
    lastValue = value;
    draft = value;
    errorMessage = "";
    invalid = false;
  });

  function update(value: string): void {
    draft = value.replaceAll(".", "_");
    try {
      const folder = normalizeStorageFolder(draft);
      oninput(folder);
      lastValue = folder;
      errorMessage = "";
      invalid = false;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      invalid = true;
    }
  }
</script>

<svelte:window onkeydown={(event) => {
  if (event.key === "Escape") helpDismissed = true;
}} />

<div class="mt-3">
  <div class="flex flex-wrap items-end gap-3">
    <div class="min-w-64 flex-1">
      <div
        role="group"
        aria-labelledby="{id}-label"
        onpointerenter={() => (helpDismissed = false)}
        class="group/field flex items-stretch rounded-ui border border-zinc-300 bg-white focus-within:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
      >
        <div
          class="group/help relative inline-flex w-16 shrink-0 items-center border-r border-zinc-200 px-3 font-mono text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
        >
          <label id="{id}-label" for={id} class="cursor-help">{label}</label>
          <span
            id="{id}-description"
            role="tooltip"
            hidden={helpDismissed}
            class="invisible absolute left-0 top-full z-20 w-64 max-w-[calc(100vw-4rem)] pt-2 font-sans text-xs leading-5 group-focus-within/field:visible group-hover/help:visible"
          >
            <span class="block rounded-ui bg-zinc-900 px-3 py-2 text-zinc-50 shadow-lg dark:bg-zinc-100 dark:text-zinc-900">{help}</span>
          </span>
        </div>
        <input
          {id}
          bind:value={() => draft, update}
          onfocus={() => (helpDismissed = false)}
          aria-describedby="{id}-description"
          aria-invalid={invalid}
          {disabled}
          spellcheck="false"
          autocapitalize="off"
          class="min-w-0 flex-1 bg-transparent px-3 py-2 font-mono text-sm text-zinc-900 focus:outline-none disabled:opacity-50 dark:text-zinc-50"
        />
      </div>
    </div>
    {#if customized}
      <button
        type="button"
        {disabled}
        onclick={() => update(defaultValue)}
        class="inline-flex items-center rounded-ui border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        Use default
      </button>
    {/if}
  </div>
  {#if errorMessage}
    <p role="alert" class="mt-2 rounded-ui bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-600/20 dark:bg-red-950 dark:text-red-200">{errorMessage}</p>
  {/if}
</div>
