import type { DeviceInfo } from "./device-info";

/** Android version, API and userspace architecture for device summaries. */
export function formatAndroidLabel(info: Pick<DeviceInfo, "android" | "sdk" | "abi" | "supportedAbis">): string {
  const width = (info.supportedAbis ?? [info.abi]).some((abi) => abi === "arm64-v8a" || abi === "x86_64")
    ? "64-bit"
    : "32-bit";
  if (info.android.startsWith("API ")) return `${info.android} · ${width} · ${info.abi}`;
  return `${info.android} (API ${info.sdk}) · ${width} · ${info.abi}`;
}
