<script lang="ts">
  import DeviceConnect from "./lib/DeviceConnect.svelte";
  import EmulatorSetup from "./lib/EmulatorSetup.svelte";
  import LibrarySetup from "./lib/LibrarySetup.svelte";
  import { DeviceState } from "./lib/device-state.svelte";

  const device = new DeviceState();
</script>

<main class="mx-auto flex min-h-svh w-full max-w-3xl flex-col gap-6 px-4 py-10">
  <header>
    <h1 class="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Emukase</h1>
    <p class="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Connect by USB, then set up your emulators and library folders.</p>
  </header>
  <DeviceConnect {device} />
  <EmulatorSetup {device} />
  <LibrarySetup {device} />
</main>
