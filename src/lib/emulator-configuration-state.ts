import type { EmulatorConfigurationResult } from "./adb/emulator-configuration";
import type { MelonDsConsole } from "./adb/melonds-inputs";

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

export type SupportRequirementStatus = "found" | "checking" | "missing" | "unchecked" | "unverified" | "configured";

export function melonDsConsoleReady(result: EmulatorConfigurationResult, console: MelonDsConsole): boolean {
  return "dsi" in result && result.library === "accepted" && result[console === "DS" ? "ds" : "dsi"] === "accepted";
}

export function emulatorConfigurationReady(result: EmulatorConfigurationResult): boolean {
  if ("vitaFirmware" in result) return result.vitaFirmware === "accepted" && result.vitaFonts === "accepted" && result.setupComplete;
  if ("dsi" in result) return melonDsConsoleReady(result, result.consoleType);
  if ("bios" in result) return result.library === "accepted" && result.bios === "accepted" && result.setupComplete;
  if ("keys" in result) return result.keys === "accepted" && result.firmware === "accepted" && result.library === "accepted";
  // Standalone game-folder adapters do not require BIOS imports.
  return result.library === "accepted" && result.setupComplete;
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
  if (requirementId === "nds-ds" || requirementId === "nds-dsi") {
    if (state?.running) return "checking";
    if (!state?.result || !("dsi" in state.result)) return present ? "found" : "unchecked";
    const installed = state.result[requirementId === "nds-ds" ? "dsBios" : "dsi"];
    if (installed !== "accepted") return installed === "missing" ? "missing" : "unverified";
    return requirementId === "nds-ds" && !state.result.customBios ? "found" : "configured";
  }
  if (present) return "found";
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
