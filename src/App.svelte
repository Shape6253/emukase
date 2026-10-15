<script lang="ts">
  import { onDestroy } from "svelte";
  import DeviceConnect from "./lib/DeviceConnect.svelte";
  import EmulatorSetup from "./lib/EmulatorSetup.svelte";
  import LibraryPage from "./lib/LibraryPage.svelte";
  import Wordmark from "./lib/Wordmark.svelte";
  import { DeviceState } from "./lib/device-state.svelte";
  import { LibrarySettings } from "./lib/library-settings.svelte";
  import { PageRouter } from "./lib/route.svelte";

  const device = new DeviceState();
  const settings = new LibrarySettings();
  const router = new PageRouter(() => device.setupRunning);

  const tabClasses = "rounded-ui px-3 py-1.5 text-sm font-medium transition";
  const activeTabClasses = `${tabClasses} border border-transparent bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-50`;
  const inactiveTabClasses = `${tabClasses} border border-zinc-200 text-zinc-600 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200`;

  onDestroy(() => router.destroy());
</script>

<main class="mx-auto flex min-h-svh w-full max-w-3xl flex-col gap-6 px-4 py-10">
  <header class="flex flex-wrap items-center justify-between gap-3 px-2.5">
    <h1
      aria-label="emukase, named after omakase"
      class="w-fit text-zinc-900 dark:text-zinc-50"
    >
      <Wordmark />
    </h1>
    <div class="flex items-center gap-1 rounded-ui bg-zinc-100 p-1 dark:bg-zinc-900">
      <nav aria-label="Pages" class="flex items-center gap-1" class:opacity-50={device.setupRunning}>
        <a
          href={device.setupRunning ? undefined : "#/"}
          aria-disabled={device.setupRunning || undefined}
          tabindex={device.setupRunning ? -1 : undefined}
          aria-current={router.route === "setup" ? "page" : undefined}
          class={router.route === "setup" ? activeTabClasses : inactiveTabClasses}
        >
          Setup
        </a>
        <a
          href={device.setupRunning ? undefined : "#/library"}
          aria-disabled={device.setupRunning || undefined}
          tabindex={device.setupRunning ? -1 : undefined}
          aria-current={router.route === "library" ? "page" : undefined}
          class={router.route === "library" ? activeTabClasses : inactiveTabClasses}
        >
          Library
        </a>
      </nav>
      <a
        id="repo-link"
        href="https://github.com/Shape6253/emukase"
        target="_blank"
        rel="noreferrer noopener"
        aria-label="Source code on GitHub"
        title="github.com/Shape6253/emukase"
        class="inline-flex size-9 items-center justify-center rounded-ui text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="size-4" aria-hidden="true">
          <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.75 2.69 1.25 3.35.95.1-.75.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.24 2.76.12 3.05.74.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.78 1.05.78 2.12 0 1.53-.01 2.76-.01 3.14 0 .31.21.68.8.56A10.52 10.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"></path>
        </svg>
      </a>
    </div>
  </header>
  <DeviceConnect {device} {settings} />
  <div hidden={router.route !== "setup"}>
    <EmulatorSetup {device} {settings} />
  </div>
  {#if router.route === "library"}
    <LibraryPage {device} {settings} />
  {/if}
</main>
