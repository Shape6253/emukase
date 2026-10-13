import { selectAbi, type Abi } from "./catalog";
import { shellCommand, type DeviceTransport } from "./transport";
import type { HardwareInfo } from "./hardware";
import { probeDisplays, type DeviceDisplay } from "./display";
import { probeHardware } from "./probe-hardware";

export interface DeviceInfo {
  serial: string;
  model: string;
  android: string;
  sdk: number;
  abi: Abi;
  /** Android's supported app ABIs, not the processor's instruction set or SoC name. */
  supportedAbis?: readonly string[];
  hardware?: HardwareInfo;
  /** Logical displays observed once at connect time; empty/undefined means unknown. */
  displays?: DeviceDisplay[];
}

export async function inspectDevice(device: DeviceTransport, serial: string): Promise<DeviceInfo> {
  const properties = ["ro.product.model", "ro.build.version.release", "ro.build.version.sdk", "ro.product.cpu.abilist"];
  const [model, android, sdk, abiList] = await Promise.all(
    properties.map(async (property) => {
      return (await device.shell(shellCommand("getprop", property))).trim();
    }),
  );
  if (!/^\d+$/.test(sdk!) || Number(sdk) < 23) throw new Error("This setup needs Android 6 or later.");
  const supportedAbis = abiList!.split(",").map((entry) => entry.trim()).filter(Boolean);
  const [hardware, displays] = await Promise.all([probeHardware(device), probeDisplays(device)]);
  return {
    serial,
    model: model || "Android device",
    android: android || `API ${sdk}`,
    sdk: Number(sdk),
    abi: selectAbi(supportedAbis),
    supportedAbis,
    hardware,
    displays,
  };
}
