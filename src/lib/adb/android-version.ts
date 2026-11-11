import { checkAbort } from "./setup-events";
import { shellCommand, type DeviceTransport } from "./transport";

const androidVersions = new WeakMap<DeviceTransport, number>();

/** Device-wide SDK, stable for the session, cached per underlying connection. */
export async function readAndroidSdk(device: DeviceTransport, signal?: AbortSignal): Promise<number> {
  checkAbort(signal);
  const transport = device.restorationDevice ?? device;
  const known = androidVersions.get(transport);
  if (known !== undefined) return known;
  const sdk = (await device.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
  checkAbort(signal);
  if (!/^[1-9]\d*$/.test(sdk) || !Number.isSafeInteger(Number(sdk))) throw new Error("Android version was not confirmed.");
  const value = Number(sdk);
  androidVersions.set(transport, value);
  return value;
}
