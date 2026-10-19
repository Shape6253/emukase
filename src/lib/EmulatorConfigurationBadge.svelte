<script lang="ts">
  import { melonDsConsoleReady, type EmulatorConfigurationState } from "./emulator-configuration-state";
  import type { MelonDsConsole } from "./adb/melonds-inputs";

  let { state, system }: { state: EmulatorConfigurationState | undefined; system?: MelonDsConsole } = $props();
  const ready = $derived(system ? !!state?.result && melonDsConsoleReady(state.result, system) : state?.ready);
</script>

<span id={system ? `library-support-setup-state-${system.toLowerCase()}` : "library-support-setup-state"} data-setup-state={state?.running ? "checking" : ready ? "configured" : state?.result ? "incomplete" : "unchecked"} class="inline-flex shrink-0 items-center rounded-ui px-3 py-1 text-xs font-medium ring-1 ring-inset {ready ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-200" : "bg-zinc-100 text-zinc-600 ring-zinc-500/20 dark:bg-zinc-900 dark:text-zinc-400"}">
  {system ? `${system}: ` : ""}{state?.running ? "Checking setup…" : ready ? "Configured" : state?.result ? "Needs attention" : "Installed"}
</span>
