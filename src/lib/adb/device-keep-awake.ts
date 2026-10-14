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

interface Setting {
  namespace: "system" | "global";
  key: string;
  original: string | null;
  applied: string;
  attempted: boolean;
}

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
        for (const setting of [...settings].reverse()) {
          if (!setting.attempted) continue;
          try {
            const current = parseSetting(await restoration.shell(command("get", setting)), setting.key);
            if (current === setting.original) continue;
            if (current !== setting.applied) {
              log(`Android's ${setting.key} changed during setup; its newer value was preserved.`);
              continue;
            }
            await restoration.shell(command(setting.original === null ? "delete" : "put", setting, setting.original ?? undefined));
            const restored = parseSetting(await restoration.shell(command("get", setting)), setting.key);
            if (restored !== setting.original) throw new Error("The original value was not confirmed by readback.");
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            log(`Could not restore Android's ${setting.key}: ${detail}`);
          }
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
    await lease.release();
    throw error;
  }
}
