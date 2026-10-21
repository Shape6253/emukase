import { assertAndroidUser } from "./android-user";
import { checkAbort } from "./setup-events";
import { shellCommand, type DeviceTransport } from "./transport";

const SCREEN_TIMEOUT_MS = 3_600_000;

export interface KeepDeviceAwakeOptions {
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface DeviceAwakeLease {
  release(): Promise<void>;
}

export class DeviceAwakeRestoreError extends Error {}

interface Setting {
  namespace: "system" | "global";
  key: string;
  original: string | null;
  applied: string;
  attempted: boolean;
}

interface SharedAwakeLease {
  lease: Promise<DeviceAwakeLease>;
  holders: number;
  releasing?: Promise<void>;
}
const activeLeases = new WeakMap<DeviceTransport, Map<number, SharedAwakeLease>>();

function parseSetting(output: string, key: string): string | null {
  const value = output.trim();
  if (output.length > 64 || (value !== "null"
    && (!/^(?:0|[1-9]\d*)$/.test(value) || Number(value) > 2_147_483_647))) {
    throw new Error(`Android's ${key} setting was not a single supported value.`);
  }
  return value === "null" ? null : value;
}

export async function keepDeviceAwake(
  device: DeviceTransport, user: number, options: KeepDeviceAwakeOptions = {},
): Promise<DeviceAwakeLease> {
  checkAbort(options.signal);
  const connection = device.restorationDevice ?? device;
  const users = activeLeases.get(connection) ?? new Map<number, SharedAwakeLease>();
  activeLeases.set(connection, users);
  let shared = users.get(user);
  if (shared?.releasing) {
    await shared.releasing;
    return keepDeviceAwake(device, user, options);
  }
  if (!shared) {
    shared = { lease: Promise.resolve().then(() => acquireDeviceAwake(device, user, options)), holders: 0 };
    users.set(user, shared);
  }
  const current = shared;
  current.holders++;
  try { await current.lease; }
  catch (error) {
    current.holders--;
    if (users.get(user) === current) users.delete(user);
    throw error;
  }
  let released = false;
  const lease = { release(): Promise<void> {
    if (released) return current.releasing ?? Promise.resolve();
    released = true;
    if (--current.holders > 0) return Promise.resolve();
    current.releasing = (async () => {
      try { await (await current.lease).release(); }
      finally { if (users.get(user) === current) users.delete(user); }
    })();
    return current.releasing;
  } };
  if (options.signal?.aborted) {
    await lease.release();
    options.signal.throwIfAborted();
  }
  return lease;
}

async function acquireDeviceAwake(
  device: DeviceTransport, user: number, options: KeepDeviceAwakeOptions,
): Promise<DeviceAwakeLease> {
  const restoration = device.restorationDevice ?? device;
  const log = (message: string): void => {
    try { options.log?.(message); } catch { /* Logging must not interrupt restoration. */ }
  };
  const command = (action: "get" | "put" | "delete", setting: Pick<Setting, "namespace" | "key">, value?: string): string =>
    shellCommand("settings", ...(setting.namespace === "system" ? ["--user", String(user)] : []),
      action, setting.namespace, setting.key, ...(value === undefined ? [] : [value]));
  const normalShell = async (script: string, beforeWrite?: () => void): Promise<string> => {
    await assertAndroidUser(device, user, options.signal);
    beforeWrite?.();
    const output = await device.shell(script);
    checkAbort(options.signal);
    return output;
  };
  const timeoutSetting = { namespace: "system", key: "screen_off_timeout" } as const;
  const stayOnSetting = { namespace: "global", key: "stay_on_while_plugged_in" } as const;
  const timeout = parseSetting(await normalShell(command("get", timeoutSetting)), timeoutSetting.key);
  const stayOn = parseSetting(await normalShell(command("get", stayOnSetting)), stayOnSetting.key);
  const settings: Setting[] = [
    { ...timeoutSetting, original: timeout,
      applied: String(timeout === null ? SCREEN_TIMEOUT_MS : Math.max(Number(timeout), SCREEN_TIMEOUT_MS)), attempted: false },
    { ...stayOnSetting, original: stayOn, applied: "15", attempted: false },
  ];
  let releasePromise: Promise<void> | undefined;
  const lease: DeviceAwakeLease = {
    release(): Promise<void> {
      releasePromise ??= (async () => {
        const failures: Error[] = [];
        for (const setting of [...settings].reverse()) {
          if (!setting.attempted) continue;
          try {
            const current = parseSetting(await restoration.shell(command("get", setting)), setting.key);
            if (current !== setting.original && current !== setting.applied) {
              log(`Android's ${setting.key} changed during setup; its newer value was preserved.`);
              continue;
            }
            if (current !== setting.original) {
              await restoration.shell(command(setting.original === null ? "delete" : "put", setting, setting.original ?? undefined));
              const restored = parseSetting(await restoration.shell(command("get", setting)), setting.key);
              if (restored !== setting.original) throw new Error("The original value was not confirmed by readback.");
            }
            log(`Restored ${setting.key}=${setting.original ?? "null"} and confirmed it by readback.`);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const failure = new Error(`Could not restore Android's ${setting.key}=${setting.original ?? "null"}: ${detail}`, { cause: error });
            failures.push(failure);
            log(failure.message);
          }
        }
        if (failures.length) {
          throw new DeviceAwakeRestoreError(failures.map((error) => error.message).join("\n"), {
            cause: new AggregateError(failures, "Android screen settings restoration failed."),
          });
        }
      })();
      return releasePromise;
    },
  };
  try {
    for (const setting of settings) {
      if (setting.original !== setting.applied) {
        const write = command("put", setting, setting.applied);
        await normalShell(write, () => { setting.attempted = true; });
      }
      const effective = parseSetting(await normalShell(command("get", setting)), setting.key);
      if (effective !== setting.applied) throw new Error(`Android did not apply the temporary ${setting.key} setting.`);
    }
    checkAbort(options.signal);
    log("Keeping Android awake during installation; its original screen settings will be restored afterwards.");
    return lease;
  } catch (error) {
    try {
      await lease.release();
    } catch (restoreError) {
      const failures = [error, restoreError];
      throw new AggregateError(failures, failures.map((failure) => failure instanceof Error ? failure.message : String(failure)).join("\n"));
    }
    throw error;
  }
}
