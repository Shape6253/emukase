import { checkAbort } from "./setup-events";
import { shellCommand, type DeviceTransport } from "./transport";

const HELPER_URL = new URL("./ui-dump/compiled.dex", import.meta.url).href;
const HELPER_SHA256 = "61ae134b2c661961dc383042295b5d0724b4e5e6c742d4d0088560953cf2fb4d";
// Renew before the helper's five-minute idle expiry, allowing time for capture probes.
const HELPER_MAX_IDLE_MS = 240_000;
const SINGLE_SHOT_MARKER = "EMUKASE_UI_SINGLE_SHOT";
let cachedBytes: Uint8Array | undefined;
interface UiDumpSession {
  path: string;
  directory: string;
  ready: Promise<void>;
  lastRequestAt: number;
  singleShot: boolean;
}
interface UiDumpHelper {
  session: UiDumpSession;
  user?: number;
  capturing: boolean;
  leases: Set<DeviceTransport>;
}
const activeHelpers = new WeakMap<DeviceTransport, UiDumpHelper>();
const singleShotConnections = new WeakSet<DeviceTransport>();

function helperConnection(device: DeviceTransport): DeviceTransport {
  return device.restorationDevice ?? device;
}

function helperRequest(directory: string, request: string, timeoutSeconds = "10"): string {
  const script = `printf '%s\\n' ${shellCommand(request)} > ${shellCommand(`${directory}/request`)}\n${shellCommand("cat", `${directory}/response`)}`;
  return shellCommand("timeout", timeoutSeconds, "sh", "-c", script);
}

function killHelperProcess(directory: string): string {
  return [
    `if ${shellCommand("test", "-r", `${directory}/pid`)}; then`,
    `  emukase_ui_pid=$(${shellCommand("cat", `${directory}/pid`)})`,
    "  case \"$emukase_ui_pid\" in ''|*[!0-9]*) exit 1;; esac",
    `  if test -r "/proc/$emukase_ui_pid/cmdline" && ${shellCommand("tr", "\\000", "\\n")} < "/proc/$emukase_ui_pid/cmdline" | ${shellCommand("grep", "-Fxq", directory)}; then`,
    "    kill \"$emukase_ui_pid\"", "  fi", "fi",
  ].join("\n");
}

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

function startHelper(device: DeviceTransport, signal?: AbortSignal): UiDumpSession {
  const id = crypto.randomUUID();
  const helperPath = `/data/local/tmp/emukase-ui-dump-${id}.dex`;
  const directory = `/data/local/tmp/emukase-ui-session-${id}`;
  const session: UiDumpSession = { path: helperPath, directory, ready: Promise.resolve(), lastRequestAt: performance.now(),
    singleShot: singleShotConnections.has(helperConnection(device)) };
  session.ready = (async (): Promise<void> => {
    const helper = await loadAndroidUiDump(signal);
    await device.push(helper, helperPath);
    checkAbort(signal);
    const launch = ["set -eu",
      shellCommand("mkfifo", `${directory}/request`, `${directory}/response`),
      `${shellCommand("env", `CLASSPATH=${helperPath}:/system/framework/uiautomator.jar`, "app_process", "/", "AndroidUiDump", "--serve", directory)} < /dev/null > /dev/null 2>&1 &`,
      `printf '%s\\n' "$!" > ${shellCommand(`${directory}/pid`)}`,
      helperRequest(directory, "ready"),
    ].join("\n");
    const start = session.singleShot ? [shellCommand("printf", `${SINGLE_SHOT_MARKER}\n`)] : [
      "umask 077", shellCommand("mkdir", directory),
      `if ${shellCommand("sh", "-c", launch)} 2>/dev/null; then :; else`,
      killHelperProcess(directory), shellCommand("printf", `${SINGLE_SHOT_MARKER}\n`), "fi",
    ];
    const output = await device.shell(shellCommand("sh", "-c", [
      "set -eu", shellCommand("chmod", "400", helperPath), ...start,
    ].join("\n")));
    session.singleShot = output.trim() === SINGLE_SHOT_MARKER;
    if (session.singleShot) singleShotConnections.add(helperConnection(device));
    if (!session.singleShot && output.trim() !== "ready") throw new Error("Android UI snapshot helper did not start.");
    checkAbort(signal);
  })();
  return session;
}

export async function withAndroidUiDump<T>(
  device: DeviceTransport, signal: AbortSignal | undefined, action: () => Promise<T>,
): Promise<T> {
  checkAbort(signal);
  const connection = helperConnection(device);
  const helper = activeHelpers.get(connection) ?? {
    session: startHelper(device, signal), user: device.androidUser, capturing: false, leases: new Set<DeviceTransport>(),
  };
  if (helper.leases.has(device)) throw new Error("Android UI snapshot helper is already in use.");
  if (helper.user !== undefined && device.androidUser !== undefined && helper.user !== device.androidUser) {
    throw new Error("Android UI snapshot helper belongs to another profile.");
  }
  // Native import handoffs use a transport without the cancelled signal, while
  // retaining the same USB connection and accessibility session.
  helper.leases.add(device);
  activeHelpers.set(connection, helper);
  try {
    await helper.session.ready;
    checkAbort(signal);
    return await action();
  } finally {
    helper.leases.delete(device);
    if (helper.leases.size === 0) {
      activeHelpers.delete(connection);
      await stopHelper(connection, helper.session);
    }
  }
}

async function stopHelper(connection: DeviceTransport, session: UiDumpSession): Promise<void> {
  const { directory, path } = session;
  await connection.shell(shellCommand("sh", "-c", [
    "set -eu",
    `if ${shellCommand("test", "-f", `${directory}/pid`)}; then`,
    `  emukase_ui_pid=$(${shellCommand("cat", `${directory}/pid`)})`,
    "  case \"$emukase_ui_pid\" in ''|*[!0-9]*) exit 1;; esac",
    `  if test -r "/proc/$emukase_ui_pid/cmdline" && ${shellCommand("tr", "\\000", "\\n")} < "/proc/$emukase_ui_pid/cmdline" | ${shellCommand("grep", "-Fxq", directory)}; then`,
    `    ${helperRequest(directory, "stop", "3")} > /dev/null || kill "$emukase_ui_pid"`,
    "  fi", "fi",
    shellCommand("rm", "-f", path, `${directory}/request`, `${directory}/response`, `${directory}/pid`),
    `if ${shellCommand("test", "-d", directory)}; then ${shellCommand("rmdir", directory)}; fi`,
  ].join("\n"))).catch(() => {});
}

async function uiDumpCommand(device: DeviceTransport, path: string, signal?: AbortSignal): Promise<string> {
  if (!/^\/data\/local\/tmp\/emukase-ui-[a-f0-9-]{1,64}\.xml$/.test(path)) {
    throw new Error("Android UI snapshot path is invalid.");
  }
  checkAbort(signal);
  const helper = activeHelpers.get(helperConnection(device));
  if (!helper) throw new Error("Android UI snapshot helper is not active.");
  await helper.session.ready;
  checkAbort(signal);
  // Uploads and native installs can outlast the helper's lease without any UI reads.
  if (!helper.session.singleShot && performance.now() - helper.session.lastRequestAt >= HELPER_MAX_IDLE_MS) {
    await stopHelper(helperConnection(device), helper.session);
    checkAbort(signal);
    helper.session = startHelper(device, signal);
    await helper.session.ready;
    checkAbort(signal);
  }
  const singleShot = shellCommand("env", `CLASSPATH=${helper.session.path}:/system/framework/uiautomator.jar`, "app_process", "/", "AndroidUiDump", path);
  if (helper.session.singleShot) return singleShot;
  // Some OEM policies permit regular shell files but deny FIFO access, or
  // change that policy when a game starts. Keep the same shipped dumper and
  // foreground/profile checks; never weaken SELinux or require privileged ADB.
  return [
    `if ${helperRequest(helper.session.directory, path)} 2>/dev/null; then :; else`,
    killHelperProcess(helper.session.directory), shellCommand("rm", "-f", path),
    shellCommand("printf", `${SINGLE_SHOT_MARKER}\n`), singleShot, "fi",
  ].join("\n");
}

export interface AndroidUiCapture {
  path: string;
  userBefore: string;
  power: string;
  policy: string;
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
  const keys = ["userBefore", "power", "policy", "foregroundBefore", "dump", "xml", "userAfter", "foregroundAfter", "end"] as const;
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
  const [prefix, userBefore, power, policy, foregroundBefore, dump, xml, userAfter, foregroundAfter] = values;
  if (prefix?.trim() || output.slice(offset).trim()) throw new Error("Android UI snapshot contains unframed output.");
  if (userBefore === undefined || power === undefined || policy === undefined || foregroundBefore === undefined || dump === undefined || xml === undefined
    || userAfter === undefined || foregroundAfter === undefined) throw new Error("Android UI snapshot is incomplete.");
  return {
    path: `/data/local/tmp/${marker}.xml`, userBefore, power, policy, foregroundBefore, dump, xml, userAfter, foregroundAfter,
  };
}

export async function captureAndroidUi(device: DeviceTransport, user: number, signal?: AbortSignal): Promise<AndroidUiCapture> {
  if (!Number.isSafeInteger(user) || user < 0) throw new Error("Invalid Android user ID.");
  checkAbort(signal);
  const helper = activeHelpers.get(helperConnection(device));
  if (!helper?.leases.has(device)) return withAndroidUiDump(device, signal, () => captureAndroidUi(device, user, signal));
  if (!helper || helper.capturing) throw new Error("Android UI snapshot is already in progress.");
  helper.capturing = true;
  const marker = `emukase-ui-${crypto.randomUUID()}`;
  const path = `/data/local/tmp/${marker}.xml`;
  const delimiter = (key: string): string => shellCommand("printf", `\n${marker}:${key}\n`);
  const cleanup = shellCommand("rm", "-f", path);
  try {
    const script = [
      "set -eu",
      shellCommand("trap", cleanup, "EXIT"),
      delimiter("userBefore"),
      `emukase_ui_user_before=$(${shellCommand("am", "get-current-user")})`,
      "printf '%s\\n' \"$emukase_ui_user_before\"",
      `test "$emukase_ui_user_before" = ${shellCommand(String(user))}`,
      delimiter("power"), shellCommand("dumpsys", "power"),
      delimiter("policy"), shellCommand("dumpsys", "window", "policy"),
      delimiter("foregroundBefore"), shellCommand("dumpsys", "window"),
      delimiter("dump"), await uiDumpCommand(device, path, signal),
      delimiter("xml"), `if ${shellCommand("test", "-f", path)}; then ${shellCommand("cat", path)}; fi`,
      delimiter("userAfter"), shellCommand("am", "get-current-user"),
      delimiter("foregroundAfter"), shellCommand("dumpsys", "window"),
      delimiter("end"),
    ].join("\n");
    // All observations stay serial on Android, without separate USB round trips.
    helper.session.lastRequestAt = performance.now();
    const output = await device.shell(shellCommand("sh", "-c", script));
    checkAbort(signal);
    const capture = parseAndroidUiCapture(output, marker);
    if (capture.dump.split(/\r?\n/).includes(SINGLE_SHOT_MARKER)) {
      helper.session.singleShot = true;
      singleShotConnections.add(helperConnection(device));
    }
    return capture;
  } catch (error) {
    await (device.restorationDevice ?? device).shell(cleanup).catch(() => {});
    throw error;
  } finally {
    helper.capturing = false;
  }
}
