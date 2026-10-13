import { userScopedDevice } from "./android-user";
import { checkAbort } from "./setup-events";
import { shellCommand, type DeviceTransport } from "./transport";

const MAX_TIMEOUT_MS = 2_147_483_647;
const USER_NULL = "-10000";

export interface AwakeDeviceOptions {
  signal?: AbortSignal;
  unlockTimeoutMs?: number;
  onUnlockRequired?: (required: boolean) => void | Promise<void>;
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("Setup stopped."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function policySection(output: string): string {
  const lines = output.split(/\r?\n/);
  const headings = lines.flatMap((line, index) => /^\s*KeyguardServiceDelegate\s*$/.test(line) ? [index] : []);
  const start = headings[0];
  if (headings.length !== 1 || start === undefined) {
    throw new Error("Android lock state could not be confirmed. Unlock the device and try again.");
  }
  const indent = lines[start]?.match(/^\s*/)?.[0].length ?? 0;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && (line.match(/^\s*/)?.[0].length ?? 0) <= indent) break;
    body.push(line);
  }
  return body.join("\n");
}

function field(output: string, name: string): string | undefined {
  const matches = Array.from(output.matchAll(new RegExp(`(?:^|\\s)${name}=([^\\s]+)(?=\\s|$)`, "g")));
  if (matches.length > 1) throw new Error("Android screen or lock state is ambiguous. Unlock the device and try again.");
  return matches[0]?.[1];
}

function booleanField(output: string, name: string): boolean {
  const value = field(output, name);
  if (value !== "true" && value !== "false") {
    throw new Error("Android screen or lock state could not be confirmed. Unlock the device and try again.");
  }
  return value === "true";
}

function screenState(power: string, policy: string, user: number): { awake: boolean; locked: boolean } {
  if (power.length > 2_097_152 || policy.length > 2_097_152) {
    throw new Error("Android screen or lock state could not be confirmed.");
  }
  const wakefulness = field(power, "mWakefulness");
  if (!wakefulness || !["Awake", "Asleep", "Dreaming", "Dozing"].includes(wakefulness)) {
    throw new Error("Android power state could not be confirmed. Wake and unlock the device, then try again.");
  }
  const keyguard = policySection(policy);
  const showing = booleanField(keyguard, "showing");
  const restricted = booleanField(keyguard, "inputRestricted");
  for (const name of ["currentUser", "mCurrentUserId"]) {
    const reportedUser = field(keyguard, name);
    if (name === "currentUser" && reportedUser === USER_NULL) continue;
    if (reportedUser !== undefined && reportedUser !== String(user)) {
      throw new Error("Android lock state belongs to another profile. Unlock the selected profile and try again.");
    }
  }
  const monitorShowing = field(keyguard, "mIsShowing");
  const monitorRestricted = field(keyguard, "mInputRestricted");
  for (const value of [monitorShowing, monitorRestricted]) {
    if (value !== undefined && value !== "true" && value !== "false") {
      throw new Error("Android lock state could not be confirmed. Unlock the device and try again.");
    }
  }
  const state = field(keyguard, "screenState");
  let screenOn: boolean;
  if (state !== undefined) {
    if (!/^(?:[0-3]|SCREEN_STATE_(?:OFF|TURNING_ON|ON|TURNING_OFF))$/.test(state)) {
      throw new Error("Android display state could not be confirmed. Wake and unlock the device, then try again.");
    }
    screenOn = state === "2" || state === "SCREEN_STATE_ON";
  } else {
    // Some window policy variants report display state outside the delegate.
    screenOn = booleanField(policy, "mScreenOnFully");
  }
  // The monitor receives lock changes directly; delegate fields cache older queries.
  const locked = (monitorShowing === undefined ? showing : monitorShowing === "true") ||
    (monitorRestricted === undefined ? restricted : monitorRestricted === "true");
  return { awake: wakefulness === "Awake" && screenOn, locked };
}

export async function withAwakeDevice<T>(
  device: DeviceTransport,
  user: number,
  options: AwakeDeviceOptions,
  action: (ensureUnlocked: () => Promise<boolean>) => Promise<T>,
): Promise<T> {
  const unlockTimeoutMs = options.unlockTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(unlockTimeoutMs) || unlockTimeoutMs <= 0 || unlockTimeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("Invalid Android unlock timeout.");
  }
  const { signal, onUnlockRequired } = options;
  checkAbort(signal);
  const scoped = userScopedDevice(device, user, signal);
  let promptVisible = false;

  const prompt = async (required: boolean): Promise<void> => {
    if (promptVisible === required) return;
    promptVisible = required;
    await onUnlockRequired?.(required);
  };

  const ensureUnlocked = async (): Promise<boolean> => {
    checkAbort(signal);
    let state = screenState(
      await scoped.shell(shellCommand("dumpsys", "power")),
      await scoped.shell(shellCommand("dumpsys", "window", "policy")),
      user,
    );
    if (state.awake && !state.locked) return false;
    const deadline = Date.now() + unlockTimeoutMs;
    let dismissed = false;
    try {
      while (Date.now() < deadline) {
        checkAbort(signal);
        if (!state.awake) await scoped.shell(shellCommand("input", "keyevent", "KEYCODE_WAKEUP"));
        if (state.locked) {
          await prompt(true);
          checkAbort(signal);
          if (!dismissed) {
            dismissed = true;
            try {
              await scoped.shell(shellCommand("wm", "dismiss-keyguard"));
            } catch {
              checkAbort(signal);
            }
          }
        }
        await pause(Math.min(500, Math.max(0, deadline - Date.now())), signal);
        state = screenState(
          await scoped.shell(shellCommand("dumpsys", "power")),
          await scoped.shell(shellCommand("dumpsys", "window", "policy")),
          user,
        );
        if (state.awake && !state.locked) return true;
      }
      throw new Error("Launch verification needs an awake, unlocked device. Unlock it and try again.");
    } finally {
      await prompt(false);
    }
  };

  await ensureUnlocked();
  const result = await action(ensureUnlocked);
  checkAbort(signal);
  return result;
}
