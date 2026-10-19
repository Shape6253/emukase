import { readAndroidPackage } from "./android-package";
import { assertAndroidUser } from "./android-user";
import type { EmulatorUiContext } from "./emulator-ui";
import { shellCommand } from "./transport";

export async function hasAndroidAllFilesAccess(context: EmulatorUiContext, packageName: string): Promise<boolean> {
  if (!/^[A-Za-z][\w]*(?:\.[\w]+)+$/.test(packageName)) throw new Error("Invalid Android package.");
  const output = await context.device.shell(shellCommand("cmd", "appops", "get", "--user", String(context.user), packageName, "MANAGE_EXTERNAL_STORAGE"));
  if (/Error:|Exception|Permission Denial|Unknown operation/i.test(output)) throw new Error("Android could not inspect all-files access.");
  if (/^No operations\.?\s*(?:\nDefault mode: default)?\s*$/i.test(output.trim())) return false;
  const uidModes = [...output.matchAll(/Uid mode:\s*MANAGE_EXTERNAL_STORAGE:\s*(\w+)/g)];
  const modes = [...output.replace(/Uid mode:[^\r\n]*/g, "").matchAll(/^\s*MANAGE_EXTERNAL_STORAGE:\s*(\w+)(?=;|\s|$)/gm)];
  if (uidModes.length > 1 || modes.length > 1 || !uidModes.length && !modes.length) throw new Error("Android reported ambiguous all-files access.");
  const uid = uidModes[0]?.[1];
  return (uid !== undefined && uid !== "default" ? uid : modes[0]?.[1]) === "allow";
}

/** Grant only a manifest-declared, profile-scoped app-op, then verify it. */
export async function prepareAndroidAllFilesAccess(context: EmulatorUiContext, packageName: string, name: string): Promise<void> {
  const sdk = (await context.device.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
  if (!/^[1-9]\d*$/.test(sdk) || !Number.isSafeInteger(Number(sdk))) throw new Error("Android's version could not be confirmed.");
  if (Number(sdk) < 30) throw new Error(`${name}'s all-files setup requires Android 11 or later.`);
  const info = await readAndroidPackage(context.device, packageName, context.user, context.signal);
  if (!info?.requestedPermissions.includes("android.permission.MANAGE_EXTERNAL_STORAGE")) {
    throw new Error(`This ${name} build does not request all-files access.`);
  }
  if (await hasAndroidAllFilesAccess(context, packageName)) return;
  await assertAndroidUser(context.device, context.user, context.signal);
  const output = await context.device.shell(shellCommand("cmd", "appops", "set", "--user", String(context.user), packageName, "MANAGE_EXTERNAL_STORAGE", "allow"));
  if (/Error:|Exception|Permission Denial|Unknown operation/i.test(output) || !await hasAndroidAllFilesAccess(context, packageName)) {
    throw new Error(`Android did not grant ${name} filesystem access. Allow all-files access on the device, then retry.`);
  }
  await assertAndroidUser(context.device, context.user, context.signal);
}
