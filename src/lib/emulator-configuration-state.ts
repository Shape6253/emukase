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
  skip: () => void;
  cancel: () => void;
}

export type SupportRequirementStatus = "found" | "checking" | "missing" | "unchecked" | "configured";

export function emulatorConfigurationReady(result: EmulatorConfigurationResult): boolean {
  if ("vitaFirmware" in result) return result.vitaFirmware === "accepted" && result.vitaFonts === "accepted" && result.setupComplete;
  return result.library === "accepted" && ("dsi" in result ? result.dsi === "accepted"
    : "bios" in result ? result.bios === "accepted" && result.setupComplete
      : result.keys === "accepted" && result.firmware === "accepted");
}

/** Native setup can satisfy an item missing from the shared library. */
export function supportRequirementStatus(
  requirementId: string, present: boolean, state: EmulatorConfigurationState | undefined,
): SupportRequirementStatus {
  if (requirementId === "psvita-firmware" || requirementId === "psvita-fonts") {
    if (state?.running) return "checking";
    if (state?.result && "vitaFirmware" in state.result) {
      const installed = state.result[requirementId === "psvita-firmware" ? "vitaFirmware" : "vitaFonts"];
      return installed === "accepted" ? "configured" : installed === "missing" ? "missing" : "unchecked";
    }
    return present ? "found" : "unchecked";
  }
  if (present) return "found";
  if (requirementId === "nds-dsi") {
    if (state?.running) return "checking";
    if (!state?.result || !("dsi" in state.result)) return "unchecked";
    return state.result.dsi === "accepted" ? "configured" : state.result.dsi === "missing" ? "missing" : "unchecked";
  }
  if (requirementId === "ps2-bios") {
    if (state?.running) return "checking";
    if (!state?.result || !("bios" in state.result)) return "unchecked";
    return state.result.bios === "accepted" ? "configured" : state.result.bios === "missing" ? "missing" : "unchecked";
  }
  const item = requirementId === "switch-keys" ? "keys" : requirementId === "switch-firmware" ? "firmware" : undefined;
  if (!item) return "missing";
  if (state?.running) return "checking";
  if (!state?.result) return "unchecked";
  if (!("keys" in state.result)) return "unchecked";
  const installed = state.result[item];
  return installed === "accepted" ? "configured" : installed === "missing" ? "missing" : "unchecked";
}
