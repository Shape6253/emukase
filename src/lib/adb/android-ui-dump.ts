import { checkAbort } from "./setup-events";
import { shellCommand, type DeviceTransport } from "./transport";

const HELPER_URL = new URL("./ui-dump/compiled.dex", import.meta.url).href;
const HELPER_SHA256 = "692039d53745e8ad7edd80764525ae21a9764bd292ce54cd9ff1500e0e597209";
let cachedBytes: Uint8Array | undefined;
const activeHelpers = new WeakMap<DeviceTransport, { path: string; ready: Promise<void> }>();

export async function loadAndroidUiDump(signal?: AbortSignal): Promise<Uint8Array> {
  checkAbort(signal);
  if (cachedBytes) return cachedBytes.slice();
  const response = await fetch(HELPER_URL, { signal });
  if (!response.ok) throw new Error("Android UI snapshot helper could not be loaded.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  checkAbort(signal);
  if (bytes.length < 112 || bytes.length > 65_536) throw new Error("Android UI snapshot helper has an invalid size.");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const digest = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== HELPER_SHA256) throw new Error("Android UI snapshot helper does not match the shipped artifact.");
  checkAbort(signal);
  cachedBytes = bytes;
  return bytes.slice();
}

export async function withAndroidUiDump<T>(
  device: DeviceTransport, signal: AbortSignal | undefined, action: () => Promise<T>,
): Promise<T> {
  if (activeHelpers.has(device)) throw new Error("Android UI snapshot helper is already in use.");
  const helperPath = `/data/local/tmp/emukase-ui-dump-${crypto.randomUUID()}.dex`;
  const ready = (async (): Promise<void> => {
    const helper = await loadAndroidUiDump(signal);
    await device.push(helper, helperPath);
    checkAbort(signal);
    await device.shell(shellCommand("chmod", "400", helperPath));
    checkAbort(signal);
  })();
  activeHelpers.set(device, { path: helperPath, ready });
  try {
    await ready;
    return await action();
  } finally {
    activeHelpers.delete(device);
    const cleanup = device.restorationDevice ?? device;
    await cleanup.shell(shellCommand("rm", "-f", helperPath)).catch(() => {});
  }
}

export async function dumpAndroidUi(device: DeviceTransport, path: string, signal?: AbortSignal): Promise<string> {
  if (!/^\/data\/local\/tmp\/emukase-ui-[a-f0-9-]{1,64}\.xml$/.test(path)) {
    throw new Error("Android UI snapshot path is invalid.");
  }
  checkAbort(signal);
  const helper = activeHelpers.get(device);
  if (!helper) return withAndroidUiDump(device, signal, () => dumpAndroidUi(device, path, signal));
  await helper.ready;
  checkAbort(signal);
  const output = await device.shell(shellCommand("env",
    `CLASSPATH=${helper.path}:/system/framework/uiautomator.jar`, "app_process", "/", "AndroidUiDump", path));
  checkAbort(signal);
  return output;
}
