import { shellCommand, type DeviceTransport } from "./transport";

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Setup stopped.");
}

const scopedDevices = new WeakMap<DeviceTransport, { device: DeviceTransport; user: number }>();

export function primaryStorageForUser(user: number): string {
  if (!Number.isSafeInteger(user) || user < 0) throw new Error("Invalid Android user ID.");
  return `/storage/emulated/${user}`;
}

export async function readAndroidUser(device: DeviceTransport, signal?: AbortSignal): Promise<number> {
  checkAbort(signal);
  // A current-user query is already the check; do not route it through the
  // scoped shell guard and issue a second query. Only unwrap our own wrapper.
  const transport = scopedDevices.get(device)?.device ?? device;
  const output = (await transport.shell(shellCommand("am", "get-current-user"))).trim();
  checkAbort(signal);
  if (!/^(?:0|[1-9]\d*)$/.test(output) || !Number.isSafeInteger(Number(output))) {
    throw new Error("Android current user was not confirmed.");
  }
  const user = Number(output);
  if (device.androidUser !== undefined && device.androidUser !== user) {
    throw new Error("Android user changed during setup. Reconnect to the selected profile.");
  }
  return user;
}

export async function assertAndroidUser(device: DeviceTransport, user: number, signal?: AbortSignal): Promise<void> {
  primaryStorageForUser(user);
  if ((await readAndroidUser(device, signal)) !== user) {
    throw new Error("Android user changed during setup. Reconnect to the selected profile.");
  }
}

/** pidof alone mixes processes from multiple profiles. Match the app's Linux UID too. */
export async function androidUserProcessPid(
  device: DeviceTransport,
  packageName: string,
  user: number,
  signal?: AbortSignal,
): Promise<string> {
  await assertAndroidUser(device, user, signal);
  const output = await device.shell(shellCommand("ps", "-A", "-o", "UID,PID,NAME"));
  checkAbort(signal);
  return androidUserProcessPidFromOutput(output, packageName, user);
}

/** Parse numeric Linux ownership rather than globally matching process names. */
export function androidUserProcessPidFromOutput(output: string, packageName: string, user: number): string {
  primaryStorageForUser(user);
  if (output.length > 2_097_152 || !/^\s*UID\s+PID\s+NAME\s*$/m.test(output)) {
    throw new Error("Android process ownership was not confirmed.");
  }
  const pids = output.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    return match && match[3] === packageName && Math.floor(Number(match[1]) / 100000) === user ? [match[2]!] : [];
  });
  if (pids.length > 1) throw new Error("Android app process identity is ambiguous.");
  return pids[0] ?? "";
}

/** Bind one run to the foreground user and recheck immediately before every
 * transport operation. Storage paths and explicit user arguments stay pinned. */
export function userScopedDevice(device: DeviceTransport, user: number): DeviceTransport {
  primaryStorageForUser(user);
  const existing = scopedDevices.get(device);
  if (existing) {
    if (existing.user !== user) throw new Error("Device is already bound to another Android user.");
    return device;
  }
  if (device.androidUser !== undefined && device.androidUser !== user) {
    throw new Error("Device is already bound to another Android user.");
  }
  const scoped: DeviceTransport = {
    androidUser: user,
    restorationDevice: device.restorationDevice ?? device,
    async shell(command) {
      for (const match of command.matchAll(/\/storage\/emulated\/(\d+)(?=\/|[^\w]|$)/g)) {
        if (Number(match[1]) !== user) throw new Error("Shell operation targets another Android user's storage.");
      }
      // Unwrap shellCommand's nested single-quote escaping before inspecting arguments.
      const argumentsText = command.replaceAll("'\"'\"'", "'");
      if (user !== 0 && /\/(?:sdcard|storage\/self\/primary)(?=\/|[^\w]|$)/.test(argumentsText)) {
        throw new Error("Shell operation uses an ambiguous Android storage alias.");
      }
      for (const match of argumentsText.matchAll(/--user['"]*(?:\s+|=)['"]*([^\s'";]+)/g)) {
        if (match[1] !== String(user)) throw new Error("Shell operation targets another Android user.");
      }
      await assertAndroidUser(device, user);
      return device.shell(command);
    },
    async push(data, path) {
      if (path.split("/").some((part) => part === "." || part === "..") || path.includes("\0"))
        throw new Error("Unsafe Android file transfer path.");
      const owner = /^\/storage\/emulated\/(\d+)(?:\/|$)/.exec(path)?.[1];
      if ((owner !== undefined && Number(owner) !== user) || (user !== 0 && /^\/(?:sdcard|storage\/self\/primary)(?:\/|$)/.test(path))) {
        throw new Error("File transfer targets another Android user's storage.");
      }
      await assertAndroidUser(device, user);
      return device.push(data, path);
    },
    async install(apk, expectedUser = user) {
      if (expectedUser !== user) throw new Error("APK installation targets another Android user.");
      await assertAndroidUser(device, user);
      await device.install(apk, user);
      await assertAndroidUser(device, user);
    },
  };
  scopedDevices.set(scoped, { device, user });
  return scoped;
}
