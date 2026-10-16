import { readAndroidPackage } from "./android-package";
import { assertAndroidUser } from "./android-user";
import type { EmulatorUiContext } from "./emulator-ui";
import { shellCommand } from "./transport";
import { VITA3K_PACKAGE } from "./vita3k-navigation";

function permissionAllowed(output: string): boolean {
  if (/Error:|Exception|Permission Denial|Unknown operation/i.test(output)) return false;
  const uidModes = [...output.matchAll(/Uid mode:\s*MANAGE_EXTERNAL_STORAGE:\s*(\w+)/g)];
  if (uidModes.length > 1) return false;
  const uid = uidModes[0]?.[1];
  if (uid !== undefined && uid !== "default") return uid === "allow";
  const modes = [...output.replace(/Uid mode:[^\r\n]*/g, "").matchAll(/^\s*MANAGE_EXTERNAL_STORAGE:\s*(\w+)(?=;|\s|$)/gm)];
  return modes.length === 1 && modes[0]?.[1] === "allow";
}

/** Vita3K's native installer requires filesystem access in addition to its picker URI. */
export async function prepareVita3kStorage(context: EmulatorUiContext): Promise<void> {
  const { device, user, signal } = context;
  const sdk = (await device.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
  if (!/^[1-9]\d*$/.test(sdk) || !Number.isSafeInteger(Number(sdk))) throw new Error("Android's version could not be confirmed.");
  if (Number(sdk) < 30) throw new Error("Vita3K firmware setup requires Android 11 or later.");
  const info = await readAndroidPackage(device, VITA3K_PACKAGE, user, signal);
  if (!info?.requestedPermissions.includes("android.permission.MANAGE_EXTERNAL_STORAGE")) {
    throw new Error("This Vita3K build does not request the filesystem permission required by its firmware installer.");
  }
  const query = (): Promise<string> => device.shell(shellCommand("cmd", "appops", "get", "--user", String(user), VITA3K_PACKAGE, "MANAGE_EXTERNAL_STORAGE"));
  if (permissionAllowed(await query())) return;
  await assertAndroidUser(device, user, signal);
  // Match Obtainium's scoped app-op setup rather than guessing OEM Settings
  // controls. Some devices redirect the permission screen into anonymous Compose UI.
  const output = await device.shell(shellCommand("cmd", "appops", "set", "--user", String(user), VITA3K_PACKAGE, "MANAGE_EXTERNAL_STORAGE", "allow"));
  signal?.throwIfAborted();
  if (/Error:|Exception|Permission Denial|Unknown operation/i.test(output) || !permissionAllowed(await query())) {
    throw new Error("Android did not grant Vita3K filesystem access. Allow all-files access for Vita3K on the device, then retry.");
  }
  await assertAndroidUser(device, user, signal);
}
