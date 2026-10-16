<script lang="ts">
  import type { EmulatorConfigurationState } from "./emulator-configuration-state";

  let { state }: { state: EmulatorConfigurationState | undefined } = $props();
</script>

<span id="library-support-setup-state" data-setup-state={state?.running ? "checking" : state?.ready ? "configured" : state?.result ? "incomplete" : "unchecked"} class="inline-flex shrink-0 items-center rounded-ui px-3 py-1 text-xs font-medium ring-1 ring-inset {state?.ready ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-200" : "bg-zinc-100 text-zinc-600 ring-zinc-500/20 dark:bg-zinc-900 dark:text-zinc-400"}">
  {state?.running ? "Checking setup…" : state?.ready ? "Configured" : state?.result ? "Needs attention" : "Installed"}
</span>
