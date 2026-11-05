<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { Snippet } from "svelte";
  import { LIBRARY_SYSTEM_OPTIONS, librarySystemFromInput, type LibrarySystem } from "./adb/library-systems";
  import { searchLibrarySystems } from "./library-system-search";

  let { selectedId, addedIds, romsFolder, disabled, onSelect, actions }: {
    selectedId: string;
    addedIds: readonly string[];
    romsFolder: string;
    disabled: boolean;
    onSelect: (id: string) => void;
    actions: Snippet;
  } = $props();

  let query = $state("");
  let activeIndex = $state(-1);
  let searchFocused = $state(false);
  let suggestionsOpen = $state(false);
  let searchInput = $state<HTMLInputElement>();
  const matches = $derived(searchLibrarySystems(query, addedIds, selectedId));
  const customFolder = $derived.by((): { system?: LibrarySystem; error?: string } => {
    if (!query.trim()) return {};
    try {
      const system = librarySystemFromInput(query);
      return LIBRARY_SYSTEM_OPTIONS.some((option) => option.id === system.id) ? {} : { system };
    } catch (error) {
      return matches.length ? {} : { error: error instanceof Error ? error.message : String(error) };
    }
  });
  const matchingSystems = $derived(matches.filter((system) => system.id !== customFolder.system?.id));
  const results = $derived(customFolder.system ? [...matchingSystems, customFolder.system] : matchingSystems);
  const popupVisible = $derived(suggestionsOpen && !disabled && results.length > 0);

  onMount(() => {
    searchInput?.focus({ preventScroll: true });
    if (document.activeElement === searchInput) {
      searchFocused = true;
      suggestionsOpen = true;
    }
  });

  function closeSuggestions(): void {
    suggestionsOpen = false;
    activeIndex = -1;
  }

  function choose(system: LibrarySystem): void {
    if (disabled) return;
    query = system.name;
    searchInput?.focus({ preventScroll: true });
    closeSuggestions();
    if (selectedId !== system.id) onSelect(system.id);
  }

  async function moveSelection(index: number): Promise<void> {
    suggestionsOpen = true;
    activeIndex = index;
    await tick();
    document.getElementById(`library-system-option-${index}`)?.scrollIntoView({ block: "nearest" });
  }

  function searchKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!results.length) return;
      const next = event.key === "ArrowDown"
        ? activeIndex < 0 ? 0 : (activeIndex + 1) % results.length
        : activeIndex < 0 ? results.length - 1 : (activeIndex - 1 + results.length) % results.length;
      void moveSelection(next);
    } else if (event.key === "Enter" && popupVisible) {
      event.preventDefault();
      const system = results[activeIndex < 0 ? 0 : activeIndex];
      if (system) choose(system);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSuggestions();
    } else if (event.key === "Tab") {
      closeSuggestions();
    }
  }
</script>

<div class="mt-4">
  <div class="flex flex-wrap items-center gap-3">
    <div
      class="relative min-w-0 flex-1 basis-64"
      onfocusout={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          searchFocused = false;
          closeSuggestions();
        }
      }}
    >
      <label for="library-system-search" class="sr-only">Search systems or ROM folders</label>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true" class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500 dark:text-zinc-400">
        <circle cx="10.5" cy="10.5" r="6.5"></circle>
        <path d="m16 16 4.5 4.5"></path>
      </svg>
      <input
        bind:this={searchInput}
        id="library-system-search"
        role="combobox"
        bind:value={query}
        oninput={() => { activeIndex = -1; suggestionsOpen = true; }}
        onfocus={() => { searchFocused = true; suggestionsOpen = true; }}
        onclick={() => { suggestionsOpen = true; }}
        onkeydown={searchKeydown}
        {disabled}
        autocomplete="off"
        spellcheck="false"
        placeholder="Search systems or enter a ROM folder"
        aria-autocomplete="list"
        aria-expanded={popupVisible}
        aria-controls="library-system-results"
        aria-activedescendant={popupVisible && activeIndex >= 0 && activeIndex < results.length ? `library-system-option-${activeIndex}` : undefined}
        aria-describedby={selectedId ? undefined : "library-system-hint"}
        class="w-full rounded-ui border border-zinc-300 bg-white py-2 pl-9 pr-3 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
      />

      <div id="library-system-results" role="listbox" aria-label="Systems" aria-disabled={disabled} class:hidden={!popupVisible} class="absolute inset-x-0 top-full z-10 mt-1 max-h-56 overflow-y-auto overscroll-contain rounded-ui border border-zinc-300 bg-white p-1 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
        {#each results as system, index (system.id)}
          {@const isCustomFolder = customFolder.system?.id === system.id}
          <button
            id={`library-system-option-${index}`}
            type="button"
            role="option"
            aria-selected={selectedId === system.id}
            {disabled}
            tabindex="-1"
            onmousedown={(event) => event.preventDefault()}
            onclick={() => choose(system)}
            class="flex w-full items-baseline justify-between gap-3 rounded-ui px-2 py-2 text-left hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-800 {selectedId === system.id ? 'bg-zinc-100 dark:bg-zinc-800' : ''} {searchFocused && activeIndex === index ? 'ring-1 ring-inset ring-zinc-400 dark:ring-zinc-600' : ''}"
          >
            <span class="min-w-0 break-words text-sm text-zinc-900 dark:text-zinc-50">
              {#if isCustomFolder}
                {selectedId === system.id ? `Folder “${system.id}”` : `Open folder “${system.id}”`}
              {:else}
                {system.name}
              {/if}
            </span>
            <span class="flex shrink-0 items-baseline gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              {#if !isCustomFolder && system.name !== system.id}{system.id}{/if}
              {#if selectedId === system.id}
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="size-3.5 self-center text-zinc-700 dark:text-zinc-300"><path d="m3 8 3 3 7-7"></path></svg>
              {/if}
            </span>
          </button>
        {/each}
      </div>
    </div>
    {@render actions()}
  </div>

  {#if !selectedId}
    <p id="library-system-hint" class="mt-2 break-words text-xs text-zinc-500 dark:text-zinc-400">
      {#if customFolder.system && matchingSystems.length}
        {matchingSystems.length} {matchingSystems.length === 1 ? "system" : "systems"} found. You can also open {romsFolder}/{customFolder.system.id}.
      {:else if customFolder.system}
        ROM folder: {romsFolder}/{customFolder.system.id}. The folder will be created when you upload files.
      {:else if customFolder.error}
        {customFolder.error}
      {:else if query.trim()}
        {results.length} {results.length === 1 ? "system" : "systems"} found.
      {:else}
        Choose a system, or search all systems by name, abbreviation or ROM folder.
      {/if}
    </p>
  {/if}
</div>
