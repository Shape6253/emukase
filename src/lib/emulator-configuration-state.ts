import type { EmulatorConfigurationResult } from "./adb/emulator-configuration";

export interface EmulatorConfigurationState {
  result: EmulatorConfigurationResult | undefined;
  running: boolean;
  automaticCheck: boolean;
  nativeInstalling: boolean;
  unavailable: boolean;
  ready: boolean;
  status: string;
  errorMessage: string;
  progress: { bytes: number; total: number } | undefined;
  check: () => void;
  configure: (files: File[]) => void;
  repair: () => void;
  skip: () => void;
  cancel: () => void;
}

export type SupportRequirementStatus = "found" | "checking" | "missing" | "unchecked" | "configured";

/** Installed Eden support can satisfy an item missing from the shared library. */
export function supportRequirementStatus(
  requirementId: string, present: boolean, state: EmulatorConfigurationState | undefined,
): SupportRequirementStatus {
  if (present) return "found";
  const item = requirementId === "switch-keys" ? "keys" : requirementId === "switch-firmware" ? "firmware" : undefined;
  if (!item) return "missing";
  if (state?.running) return "checking";
  if (!state?.result) return "unchecked";
  const installed = state.result[item];
  return installed === "accepted" ? "configured" : installed === "missing" ? "missing" : "unchecked";
}
