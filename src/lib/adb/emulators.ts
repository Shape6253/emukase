import type { Abi } from "./catalog.ts";

interface EmulatorSpec {
  readonly name: string;
  readonly packages: readonly string[];
}

export const EMULATORS = {
  retroarch: { name: "RetroArch", packages: ["com.retroarch.aarch64", "com.retroarch.ra32"] },
  ppsspp: { name: "PPSSPP", packages: ["org.ppsspp.ppsspp"] },
  dolphin: { name: "Dolphin", packages: ["org.dolphinemu.dolphinemu"] },
  azahar: { name: "Azahar", packages: ["org.azahar_emu.azahar"] },
  melonds: { name: "melonDS", packages: ["me.magnum.melonds"] },
  armsx2: { name: "ARMSX2", packages: ["com.armsx2"] },
  eden: { name: "Eden", packages: ["dev.eden.eden_emulator"] },
  vita3k: { name: "Vita3K", packages: ["org.vita3k.emulator"] },
} as const satisfies Record<string, EmulatorSpec>;

export type EmulatorId = keyof typeof EMULATORS;

export function retroArchPackageName(abi: Abi): string {
  return EMULATORS.retroarch.packages[abi === "arm64-v8a" || abi === "x86_64" ? 0 : 1];
}
