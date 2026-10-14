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

async function uiDumpCommand(device: DeviceTransport, path: string, signal?: AbortSignal): Promise<string> {
  if (!/^\/data\/local\/tmp\/emukase-ui-[a-f0-9-]{1,64}\.xml$/.test(path)) {
    throw new Error("Android UI snapshot path is invalid.");
  }
  checkAbort(signal);
  const helper = activeHelpers.get(device);
  if (!helper) throw new Error("Android UI snapshot helper is not active.");
  await helper.ready;
  checkAbort(signal);
  return shellCommand("env",
    `CLASSPATH=${helper.path}:/system/framework/uiautomator.jar`, "app_process", "/", "AndroidUiDump", path);
}

export interface AndroidUiCapture {
  path: string;
  userBefore: string;
  foregroundBefore: string;
  dump: string;
  xml: string;
  userAfter: string;
  foregroundAfter: string;
}

export function parseAndroidUiCapture(output: string, marker: string): AndroidUiCapture {
  if (output.length > 12_582_912 || !/^emukase-ui-[a-f0-9-]{36}$/.test(marker)) {
    throw new Error("Android UI snapshot framing is invalid.");
  }
  const keys = ["userBefore", "foregroundBefore", "dump", "xml", "userAfter", "foregroundAfter", "end"] as const;
  const values: string[] = [];
  let offset = 0;
  for (const key of keys) {
    const delimiter = `\n${marker}:${key}\n`;
    const index = output.indexOf(delimiter, offset);
    if (index < 0 || output.indexOf(delimiter) !== index || output.lastIndexOf(delimiter) !== index) {
      throw new Error("Android UI snapshot framing is incomplete or ambiguous.");
    }
    values.push(output.slice(offset, index));
    offset = index + delimiter.length;
  }
  const [prefix, userBefore, foregroundBefore, dump, xml, userAfter, foregroundAfter] = values;
  if (prefix?.trim() || output.slice(offset).trim()) throw new Error("Android UI snapshot contains unframed output.");
  if (userBefore === undefined || foregroundBefore === undefined || dump === undefined || xml === undefined
    || userAfter === undefined || foregroundAfter === undefined) throw new Error("Android UI snapshot is incomplete.");
  return {
    path: `/data/local/tmp/${marker}.xml`, userBefore, foregroundBefore, dump, xml, userAfter, foregroundAfter,
  };
}

export async function captureAndroidUi(device: DeviceTransport, user: number, signal?: AbortSignal): Promise<AndroidUiCapture> {
  if (!Number.isSafeInteger(user) || user < 0) throw new Error("Invalid Android user ID.");
  checkAbort(signal);
  if (!activeHelpers.has(device)) return withAndroidUiDump(device, signal, () => captureAndroidUi(device, user, signal));
  const marker = `emukase-ui-${crypto.randomUUID()}`;
  const path = `/data/local/tmp/${marker}.xml`;
  const delimiter = (key: string): string => shellCommand("printf", `\n${marker}:${key}\n`);
  const cleanup = shellCommand("rm", "-f", path);
  const script = [
    "set -eu",
    shellCommand("trap", cleanup, "EXIT"),
    delimiter("userBefore"),
    `emukase_ui_user_before=$(${shellCommand("am", "get-current-user")})`,
    "printf '%s\\n' \"$emukase_ui_user_before\"",
    `test "$emukase_ui_user_before" = ${shellCommand(String(user))}`,
    delimiter("foregroundBefore"), shellCommand("dumpsys", "window"),
    delimiter("dump"), await uiDumpCommand(device, path, signal),
    delimiter("xml"), `if ${shellCommand("test", "-f", path)}; then ${shellCommand("cat", path)}; fi`,
    delimiter("userAfter"), shellCommand("am", "get-current-user"),
    delimiter("foregroundAfter"), shellCommand("dumpsys", "window"),
    delimiter("end"),
  ].join("\n");
  try {
    // All observations stay serial on Android, without separate USB round trips.
    const output = await device.shell(shellCommand("sh", "-c", script));
    checkAbort(signal);
    return parseAndroidUiCapture(output, marker);
  } catch (error) {
    await (device.restorationDevice ?? device).shell(cleanup).catch(() => {});
    throw error;
  }
}
