import { readAndroidPackage } from "./android-package";
import { assertAndroidUser, primaryStorageForUser, readAndroidUser, userScopedDevice } from "./android-user";
import { EMULATORS } from "./emulators";
import { readRetroArchConfig } from "./retroarch";
import { shellCommand, type DeviceTransport } from "./transport";
import { workspacePaths, type LibraryFolderOptions } from "./workspace";

export interface RetroArchSupportOptions {
  folders?: LibraryFolderOptions;
  signal?: AbortSignal;
  log?: (message: string) => void;
  onStatus?: (message: string) => void;
}

async function installedRetroArchPackage(device: DeviceTransport, user: number, signal?: AbortSignal): Promise<string> {
  for (const pkg of EMULATORS.retroarch.packages) {
    if (await readAndroidPackage(device, pkg, user, signal)) return pkg;
  }
  throw new Error("Install RetroArch before pointing it at the shared BIOS folder.");
}

/** Rewrites only the System/BIOS line; Android's default (inside the app's own
 * data folder) is replaced, a user-chosen custom folder is kept. */
export function replaceRetroArchSystemDirectory(config: string, path: string): string {
  const line = `system_directory = "${path}"`;
  const lines = config.split(/\r?\n/);
  const index = lines.findIndex((entry) => /^\s*system_directory\s*=/.test(entry));
  if (index < 0) return `${config.trimEnd()}\n${line}\n`;
  const value = /^.*?=\s*"([^"]*)"/.exec(lines[index])?.[1];
  const defaultFolder = /\/Android\/data\/[^/]+(?:\/.*)?$/.test(value ?? "");
  if (value === path || value === "default" || !value || defaultFolder) lines[index] = line;
  return lines.join("\n");
}

/** Points RetroArch's System/BIOS directory at the shared BIOS folder so its
 * cores resolve the uploaded files. RetroArch is stopped first: it saves this
 * config on exit and reads it again on the next launch. */
export async function pointRetroArchAtBiosFolder(device: DeviceTransport, options: RetroArchSupportOptions = {}): Promise<void> {
  const { signal } = options;
  const user = await readAndroidUser(device, signal);
  const scoped = userScopedDevice(device, user, signal);
  const root = primaryStorageForUser(user);
  const pkg = await installedRetroArchPackage(scoped, user, signal);
  const workspace = workspacePaths(root, options.folders);
  const target = workspace.bios;
  const config = `${root}/Android/data/${pkg}/files/retroarch.cfg`;
  const pointed = `system_directory = "${target}"`;
  const current = await readRetroArchConfig(scoped, config, signal);
  if (current === undefined) {
    throw new Error("RetroArch's config is not readable over USB. Point its System/BIOS directory at the shared BIOS folder on the device.");
  }
  const updated = replaceRetroArchSystemDirectory(current, target);
  if (updated === current) {
    options.log?.(current.includes(pointed)
      ? `RetroArch's System/BIOS folder already points at ${target}.`
      : "RetroArch keeps a custom System/BIOS folder; it was not changed.");
    return;
  }
  options.onStatus?.("Pointing RetroArch's System/BIOS folder at the shared BIOS folder…");
  await assertAndroidUser(scoped, user, signal);
  await scoped.shell(shellCommand("am", "force-stop", "--user", String(user), pkg));
  await scoped.push(new TextEncoder().encode(updated), config, { signal });
  const written = await readRetroArchConfig(scoped, config, signal);
  if (!written?.includes(pointed)) {
    throw new Error("RetroArch's config could not be updated over USB. Point its System/BIOS directory at the shared BIOS folder on the device.");
  }
  options.log?.(`RetroArch's System/BIOS folder is set to ${target}.`);
}
