import { assertAndroidUser } from "./android-user";
import { checkAbort } from "./setup-events";
import { shellCommand, type DeviceTransport } from "./transport";

export interface AndroidPackage {
  version: string;
  installer: string | undefined;
  requestedPermissions: readonly string[];
  grantedPermissions: ReadonlySet<string>;
}

export function parseAndroidPackage(output: string, packageName: string, user: number): AndroidPackage {
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName) ||
    !Number.isSafeInteger(user) || user < 0) throw new Error("Invalid Android package or profile.");
  const lines = output.split(/\r?\n/);
  const headings = lines.flatMap((line, index) =>
    line.trim().startsWith(`Package [${packageName}] (`) ? [index] : []);
  const start = headings[0];
  if (output.length > 2_097_152 || headings.length !== 1 || start === undefined) {
    throw new Error("Android package metadata could not be confirmed.");
  }
  const indent = lines[start]?.match(/^\s*/)?.[0].length ?? 0;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && (line.match(/^\s*/)?.[0].length ?? 0) <= indent) break;
    body.push(line);
  }
  const packageBody = body.join("\n");
  const versions = [...packageBody.matchAll(/^\s*versionName=([^\r\n]+)$/gm)];
  const installers = [...packageBody.matchAll(/^\s*installerPackageName=([^\s]+)$/gm)];
  const profiles = body.flatMap((line, index) => line.trim().startsWith(`User ${user}:`) ? [index] : []);
  const profileStart = profiles[0];
  if (versions.length !== 1 || !versions[0]?.[1]?.trim() || installers.length > 1 ||
    profiles.length !== 1 || profileStart === undefined || !/\binstalled=true\b/.test(body[profileStart] ?? "")) {
    throw new Error("Android did not confirm the installed package in this profile.");
  }
  const profileIndent = body[profileStart]?.match(/^\s*/)?.[0].length ?? 0;
  const profile: string[] = [];
  for (const line of body.slice(profileStart + 1)) {
    if (line.trim() && (line.match(/^\s*/)?.[0].length ?? 0) <= profileIndent) break;
    profile.push(line);
  }
  const requestedHeading = body.findIndex((line) => line.trim() === "requested permissions:");
  const requestedPermissions: string[] = [];
  if (requestedHeading >= 0) {
    const permissionIndent = body[requestedHeading]?.match(/^\s*/)?.[0].length ?? 0;
    for (const line of body.slice(requestedHeading + 1)) {
      if (!line.trim()) continue;
      if ((line.match(/^\s*/)?.[0].length ?? 0) <= permissionIndent) break;
      const permission = line.trim();
      if (!/^[\w]+(?:\.[\w]+)+$/.test(permission)) throw new Error("Android requested permissions could not be confirmed.");
      requestedPermissions.push(permission);
    }
  }
  const grantedPermissions = new Set<string>();
  for (const match of profile.join("\n").matchAll(/\b(android\.permission\.[A-Z_]+):\s*granted=true\b/g)) {
    if (match[1]) grantedPermissions.add(match[1]);
  }
  const installer = installers[0]?.[1];
  return {
    version: versions[0]?.[1]?.trim() ?? "",
    installer: installer === "null" ? undefined : installer,
    requestedPermissions, grantedPermissions,
  };
}

export async function readAndroidPackage(
  device: DeviceTransport, packageName: string, user: number, signal?: AbortSignal,
): Promise<AndroidPackage | undefined> {
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) {
    throw new Error("Invalid Android package name.");
  }
  await assertAndroidUser(device, user, signal);
  const packages = await device.shell(shellCommand("pm", "list", "packages", "--user", String(user), packageName));
  checkAbort(signal);
  if (!packages.trim().split(/\r?\n/).includes(`package:${packageName}`)) {
    if (packages.trim() && !packages.trim().split(/\r?\n/).every((line) => /^package:[\w.]+$/.test(line))) {
      throw new Error("Android package listing failed.");
    }
    return undefined;
  }
  const info = parseAndroidPackage(await device.shell(shellCommand("dumpsys", "package", packageName)), packageName, user);
  await assertAndroidUser(device, user, signal);
  return info;
}

export async function grantPackagePermissions(
  device: DeviceTransport, packageName: string, user: number, permissions: readonly string[], signal?: AbortSignal,
): Promise<void> {
  const info = await readAndroidPackage(device, packageName, user, signal);
  if (!info) throw new Error("The app is not installed in this profile.");
  for (const permission of permissions) {
    if (!/^android\.permission\.[A-Z_]+$/.test(permission) || !info.requestedPermissions.includes(permission)) {
      throw new Error("The app does not request the required Android permission.");
    }
    if (info.grantedPermissions.has(permission)) continue;
    const output = await device.shell(shellCommand("pm", "grant", "--user", String(user), packageName, permission));
    checkAbort(signal);
    if (/Error:|Exception|Permission Denial|Failure/i.test(output)) throw new Error("Android permission grant failed.");
  }
  const verified = await readAndroidPackage(device, packageName, user, signal);
  if (!verified || permissions.some((permission) => !verified.grantedPermissions.has(permission))) {
    throw new Error("Android did not confirm the required app permissions.");
  }
}
