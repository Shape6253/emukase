import { primaryStorageForUser } from "./android-user";

/** Rebind paths in an app's launch template, not in an ADB shell command.
 * The receiving activity runs in the frontend's profile; --user is not an
 * Intent argument and must never be copied into these templates. */
export function scopeAndroidLaunchArguments(source: string, user: number): string {
  const storage = primaryStorageForUser(user);
  if (!source.trim() || source.length > 65_536 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(source)
    || /(?:^|\s)--user(?:\s|=|$)/.test(source) || /\/(?:\.\.?)(?:\/|[\s"']|$)/.test(source)) {
    throw new Error("Unsupported Android player launch arguments.");
  }
  return source.replace(/\/(?:storage\/emulated\/\d+|storage\/self\/primary|sdcard)(?=\/|[\s"']|$)/g, storage)
    .replace(/\/data\/(?:data|user\/\d+)(?=\/)/g, `/data/user/${user}`)
    .replace(/\/data\/user_de\/\d+(?=\/)/g, `/data/user_de/${user}`);
}

/** Require the standard config for the selected RetroArch package before
 * adapting an upstream player. Unknown or duplicate config extras fail closed. */
export function scopeRetroArchLaunchArguments(source: string, packageName: string, user: number): string {
  if (!/^com\.retroarch(?:\.(?:aarch64|ra32))?$/.test(packageName)) throw new Error("Invalid RetroArch player package.");
  const matches = [...source.matchAll(/(?:^|\s)(?:-e|--es)\s+CONFIGFILE\s+(\S+)(?=\s|$)/g)];
  const path = matches[0]?.[1];
  const suffix = `/Android/data/${packageName}/files/retroarch.cfg`;
  if (matches.length !== 1 || !path || !path.endsWith(suffix)
    || !/^\/(?:storage\/emulated\/\d+|storage\/self\/primary|sdcard)$/.test(path.slice(0, -suffix.length))) {
    throw new Error("Unsupported upstream RetroArch config argument.");
  }
  return scopeAndroidLaunchArguments(source, user);
}
