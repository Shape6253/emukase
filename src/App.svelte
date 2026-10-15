<script lang="ts">
  import { onDestroy } from "svelte";
  import DeviceConnect from "./lib/DeviceConnect.svelte";
  import EmulatorSetup from "./lib/EmulatorSetup.svelte";
  import LibraryPage from "./lib/LibraryPage.svelte";
  import { DeviceState } from "./lib/device-state.svelte";
  import { LibrarySettings } from "./lib/library-settings.svelte";
  import { PageRouter } from "./lib/route.svelte";

  const device = new DeviceState();
  const settings = new LibrarySettings();
  const router = new PageRouter();

  const tabClasses = "rounded-md px-3 py-1.5 text-sm font-medium transition";
  const activeTabClasses = `${tabClasses} bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-50`;
  const inactiveTabClasses = `${tabClasses} text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200`;

  onDestroy(() => router.destroy());
</script>

<main class="mx-auto flex min-h-svh w-full max-w-3xl flex-col gap-6 px-4 py-10">
  <header class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Emukase</h1>
      <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        {router.route === "library"
          ? "Connect by USB, then review your game library."
          : "Connect by USB, then set up your emulators and library folders."}
      </p>
    </div>
    <nav aria-label="Pages" class="flex items-center gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
      <a
        href="#/"
        aria-current={router.route === "setup" ? "page" : undefined}
        class={router.route === "setup" ? activeTabClasses : inactiveTabClasses}
      >
        Setup
      </a>
      <a
        href="#/library"
        aria-current={router.route === "library" ? "page" : undefined}
        class={router.route === "library" ? activeTabClasses : inactiveTabClasses}
      >
        Library
      </a>
    </nav>
  </header>
  <DeviceConnect {device} {settings} />
  {#if router.route === "library"}
    <LibraryPage {device} {settings} />
  {:else}
    <EmulatorSetup {device} />
  {/if}
</main>
