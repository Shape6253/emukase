import { shellCommand, type DeviceTransport } from "./transport";
import { checkAbort } from "./setup-events";

const scopedDevices = new WeakMap<DeviceTransport, { device: DeviceTransport; user: number; signal?: AbortSignal }>();

export function primaryStorageForUser(user: number): string {
  if (!Number.isSafeInteger(user) || user < 0) throw new Error("Invalid Android user ID.");
  return `/storage/emulated/${user}`;
}

/** ADB paths must name the pinned profile explicitly. App-process aliases
 * such as /sdcard and /data/data are not safe in the shell's namespace. */
export function assertAndroidUserPaths(value: string, user: number): void {
  primaryStorageForUser(user);
  for (const match of value.matchAll(/\/(?:storage\/emulated|data\/user(?:_de)?)\/(\d+)(?=\/|[^\w]|$)/g)) {
    if (Number(match[1]) !== user) throw new Error("Path targets another Android user's storage.");
  }
  if (user !== 0 && /\/(?:sdcard|storage\/self\/primary|data\/data)(?=\/|[^\w]|$)/.test(value)) {
    throw new Error("Path uses an ambiguous Android profile alias.");
  }
}

export async function readAndroidUser(device: DeviceTransport, signal?: AbortSignal): Promise<number> {
  const binding = scopedDevices.get(device);
  checkAbort(signal);
  checkAbort(binding?.signal);
  // A current-user query is already the check; do not route it through the
  // scoped shell guard and issue a second query. Only unwrap our own wrapper.
  const transport = binding?.device ?? device;
  const output = (await transport.shell(shellCommand("am", "get-current-user"))).trim();
  checkAbort(signal);
  checkAbort(binding?.signal);
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

/** Our scoped shell already guards this exact user immediately before dispatch.
 * An androidUser property alone is not evidence that a transport is guarded. */
export async function androidUserShell(device: DeviceTransport, user: number, command: string, signal?: AbortSignal): Promise<string> {
  checkAbort(signal);
  const binding = scopedDevices.get(device);
  if (!binding || binding.user !== user) await assertAndroidUser(device, user, signal);
  const output = await device.shell(command);
  checkAbort(signal);
  return output;
}

/** Match process ownership too: the same package can run in several profiles. */
export async function androidUserProcessPid(
  device: DeviceTransport,
  packageName: string,
  user: number,
  signal?: AbortSignal,
): Promise<string> {
  await assertAndroidUser(device, user, signal);
  // Android 6/7 toolbox does not support -A or -o.
  const output = await device.shell(shellCommand("ps"));
  await assertAndroidUser(device, user, signal);
  return androidUserProcessPidFromOutput(output, packageName, user);
}

export function androidUserProcessPidFromOutput(output: string, packageName: string, user: number): string {
  primaryStorageForUser(user);
  const lines = output.trim().split(/\r?\n/);
  const header = lines.shift()?.trim().split(/\s+/) ?? [];
  if (output.length > 2_097_152 || !["USER", "UID"].includes(header[0] ?? "") || header[1] !== "PID" || header.at(-1) !== "NAME") {
    throw new Error("Android process ownership was not confirmed.");
  }
  const pids: string[] = [];
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.at(-1) !== packageName) continue;
    const owner = fields[0] ?? "";
    const symbolic = /^u(0|[1-9]\d*)_([ai])(0|[1-9]\d*)$/.exec(owner);
    const uid = /^(?:0|[1-9]\d*)$/.test(owner) ? Number(owner)
      : symbolic ? Number(symbolic[1]) * 100000 + (symbolic[2] === "a" ? 10000 : 99000) + Number(symbolic[3])
      : NaN;
    const pid = fields[1] ?? "";
    if (!Number.isSafeInteger(uid) || uid < 0 || uid > 4_294_967_295
      || (symbolic && Number(symbolic[3]) >= (symbolic[2] === "a" ? 90000 : 1000))
      || !/^[1-9]\d*$/.test(pid) || !Number.isSafeInteger(Number(pid))) {
      throw new Error("Android process ownership was not confirmed.");
    }
    if (Math.floor(uid / 100000) === user) pids.push(pid);
  }
  if (pids.length > 1) throw new Error("Android app process identity is ambiguous.");
  return pids[0] ?? "";
}

/** Bind one run to the foreground user and recheck immediately before every
 * transport operation. Storage paths and explicit user arguments stay pinned. */
export function userScopedDevice(device: DeviceTransport, user: number, signal?: AbortSignal): DeviceTransport {
  primaryStorageForUser(user);
  const existing = scopedDevices.get(device);
  if (existing) {
    if (existing.user !== user) throw new Error("Device is already bound to another Android user.");
    if (!signal) return device;
  }
  if (device.androidUser !== undefined && device.androidUser !== user) {
    throw new Error("Device is already bound to another Android user.");
  }
  const transport = existing?.device ?? device;
  const scopedSignal = existing?.signal && signal ? AbortSignal.any([existing.signal, signal]) : signal;
  const scoped: DeviceTransport = {
    androidUser: user,
    restorationDevice: device.restorationDevice ?? device,
    async shell(command) {
      // Unwrap shellCommand's nested single-quote escaping before inspecting arguments.
      const argumentsText = command.replaceAll("'\"'\"'", "'");
      assertAndroidUserPaths(argumentsText, user);
      for (const match of argumentsText.matchAll(/--user['"]*(?:\s+|=)['"]*([^\s'";]+)/g)) {
        if (match[1] !== String(user)) throw new Error("Shell operation targets another Android user.");
      }
      await assertAndroidUser(transport, user, scopedSignal);
      const output = await transport.shell(command);
      checkAbort(scopedSignal);
      return output;
    },
    async push(data, path, options) {
      if (path.split("/").some((part) => part === "." || part === "..") || path.includes("\0"))
        throw new Error("Unsafe Android file transfer path.");
      assertAndroidUserPaths(path, user);
      const signal = scopedSignal && options?.signal ? AbortSignal.any([scopedSignal, options.signal]) : scopedSignal ?? options?.signal;
      await assertAndroidUser(transport, user, signal);
      await transport.push(data, path, { ...options, signal });
      await assertAndroidUser(transport, user, signal);
    },
    async install(apk, expectedUser = user, installerPackageName) {
      if (expectedUser !== user) throw new Error("APK installation targets another Android user.");
      await assertAndroidUser(transport, user, scopedSignal);
      await transport.install(apk, user, installerPackageName);
      await assertAndroidUser(transport, user, scopedSignal);
    },
    async writeContent(data, uri, expectedUser, options) {
      if (expectedUser !== user) throw new Error("Content transfer targets another Android user.");
      const signal = scopedSignal && options?.signal ? AbortSignal.any([scopedSignal, options.signal]) : scopedSignal ?? options?.signal;
      await assertAndroidUser(transport, user, signal);
      await transport.writeContent(data, uri, user, { ...options, signal });
      await assertAndroidUser(transport, user, signal);
    },
  };
  scopedDevices.set(scoped, { device: transport, user, signal: scopedSignal });
  return scoped;
}
