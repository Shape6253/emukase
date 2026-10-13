import { shellCommand, type DeviceTransport } from "./transport";
import { assertAndroidUser, primaryStorageForUser } from "./android-user";

export const storageBridgePackage = "app.emukase.storagebridge";
export const storageBridgeComponent = `${storageBridgePackage}/${storageBridgePackage}.StorageInstrumentation`;
export const storageBridgeSha256 = "ff7f33ca4926eeaaa60c4b54a178e60c947f70eb00f26201789196febf4293d5";
const maxOutputBytes = 8 * 1024 * 1024;

function encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Result framing is separate from stdout: shell errors cannot impersonate successful instrumentation. */
export function storageBridgeResult(output: string, user: number): string {
  if (output.length > 12 * 1024 * 1024) throw new Error("Storage bridge response exceeds the output limit.");
  const values = new Map<string, string>();
  const chunks: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const chunk = /^INSTRUMENTATION_STATUS: chunk=(\d+):(.*)$/.exec(line);
    if (chunk) {
      if (chunk[1] !== String(chunks.length) || chunks.length >= 256) throw new Error("Ambiguous storage bridge chunks.");
      chunks.push(chunk[2]!);
      continue;
    }
    const match = /^INSTRUMENTATION_RESULT: (exit|output|chunks|user|root|error)=(.*)$/.exec(line);
    if (!match) continue;
    if (values.has(match[1]!)) throw new Error("Ambiguous storage bridge result.");
    values.set(match[1]!, match[2]!);
  }
  const codes = [...output.matchAll(/^INSTRUMENTATION_CODE: (-?\d+)\s*$/gm)].map((match) => match[1]);
  if (codes.length !== 1 || codes[0] !== "0" || values.has("error")) {
    throw new Error(`Storage bridge failed: ${values.get("error") ?? "instrumentation did not complete"}`);
  }
  if (values.get("user") !== String(user) || values.get("root") !== primaryStorageForUser(user)) {
    throw new Error("Storage bridge targets another Android user.");
  }
  if (values.has("chunks") && (values.has("output") || values.get("chunks") !== String(chunks.length))) {
    throw new Error("Invalid storage bridge chunk count.");
  }
  const encodedChunks = values.has("chunks") ? chunks : [values.get("output")];
  if (!values.has("chunks") && chunks.length) throw new Error("Invalid storage bridge chunk framing.");
  let binary = "";
  for (const encoded of encodedChunks) {
    if (encoded === undefined || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error("Invalid storage bridge output.");
    }
    binary += atob(encoded);
    if (binary.length > maxOutputBytes) throw new Error("Storage bridge output exceeds 8 MiB.");
  }
  const result = new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  if (values.get("exit") !== "0")
    throw new Error(`Storage bridge command failed (${values.get("exit") ?? "unknown"}): ${result.trim()}`);
  return result;
}

async function installedBridgeDigest(device: DeviceTransport, user: number): Promise<string | undefined> {
  await assertAndroidUser(device, user);
  const packages = (
    await device.shell(shellCommand("pm", "list", "packages", "--user", String(user), storageBridgePackage))
  ).trim();
  if (!packages) return undefined;
  if (packages !== `package:${storageBridgePackage}`) throw new Error("Storage bridge package identity was not confirmed.");
  const pathOutput = (await device.shell(shellCommand("pm", "path", "--user", String(user), storageBridgePackage))).trim();
  const path = /^package:(\/data\/app\/[A-Za-z0-9_~+=./-]+\/base\.apk)$/.exec(pathOutput)?.[1];
  if (!path || /\/(?:\.|\.\.)\//.test(path)) throw new Error("Storage bridge APK location was not confirmed.");
  const hashOutput = (await device.shell(shellCommand("sha256sum", path))).trim();
  const digest = /^([a-f0-9]{64})  (\S+)$/.exec(hashOutput);
  if (!digest || digest[2] !== path) throw new Error("Storage bridge APK digest was not confirmed.");
  await assertAndroidUser(device, user);
  return digest[1]!;
}

async function bridgeHasAccess(device: DeviceTransport, user: number): Promise<boolean> {
  const output = await device.shell(
    shellCommand("cmd", "appops", "get", "--user", String(user), storageBridgePackage, "MANAGE_EXTERNAL_STORAGE"),
  );
  const modes = [...output.matchAll(/^(?:Uid mode: )?MANAGE_EXTERNAL_STORAGE: (allow|deny|ignore|default)(?:;.*)?$/gm)].map(
    (match) => match[1],
  );
  return modes.length > 0 && modes.every((mode) => mode === "allow");
}

/** Reuse only the exact shipped helper already installed and authorized in this profile. Never mutates. */
export async function inspectStorageBridge(device: DeviceTransport, user: number): Promise<DeviceTransport | undefined> {
  if ((await installedBridgeDigest(device, user)) !== storageBridgeSha256) return undefined;
  if (!(await bridgeHasAccess(device, user))) return undefined;
  await assertAndroidUser(device, user);
  return wrapFilesystem(device, user);
}

function storageCommand(command: string, user: number): boolean {
  for (const match of command.matchAll(/\/storage\/emulated\/(\d+)(?=\/|[\s'";)]|$)/g)) {
    if (Number(match[1]) !== user) throw new Error("Storage bridge command targets another Android user.");
  }
  if (/\/(?:\.\.|\.)\//.test(command)) throw new Error("Storage bridge rejects traversing storage paths.");
  return /\/(?:storage\/|sdcard(?:\/|[\s'";)]|$))/.test(command);
}

/** Install this tool in the selected profile only; all-files access does not cover other apps' Android/data. */
export async function prepareStorageBridge(
  device: DeviceTransport,
  user: number,
  apk: Uint8Array,
): Promise<DeviceTransport> {
  const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(apk));
  const digest = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== storageBridgeSha256) throw new Error("Storage bridge APK does not match the shipped artifact.");
  await assertAndroidUser(device, user);
  if ((await installedBridgeDigest(device, user)) !== storageBridgeSha256) {
    // PackageManager enforces the installed package's signing certificate; never uninstall to bypass it.
    await device.install(apk, user);
    if ((await installedBridgeDigest(device, user)) !== storageBridgeSha256)
      throw new Error("Installed storage bridge APK verification failed.");
  }
  await assertAndroidUser(device, user);
  if (!(await bridgeHasAccess(device, user))) {
    await device.shell(
      shellCommand("cmd", "appops", "set", "--user", String(user), storageBridgePackage, "MANAGE_EXTERNAL_STORAGE", "allow"),
    );
    if (!(await bridgeHasAccess(device, user))) throw new Error("Storage bridge all-files permission was not confirmed.");
  }
  const bridge = wrapFilesystem(device, user);
  await bridge.shell(shellCommand("test", "-r", primaryStorageForUser(user)));
  await bridge.shell(shellCommand("test", "-w", primaryStorageForUser(user)));
  return bridge;
}

/** The helper preserves the existing filesystem scripts, including exclusive backups and atomic rename. */
export function wrapFilesystem(device: DeviceTransport, user: number): DeviceTransport {
  primaryStorageForUser(user);
  let pending: Promise<unknown> = Promise.resolve();
  async function filesystemShell(command: string): Promise<string> {
    const previous = pending;
    const run = (async () => {
      await previous.catch(() => {});
      await assertAndroidUser(device, user);
      const output = await device.shell(
        shellCommand(
          "am",
          "instrument",
          "--user",
          String(user),
          "--no-isolated-storage",
          "-w",
          "-r",
          "-e",
          "user",
          String(user),
          "-e",
          "command",
          encode(command),
          storageBridgeComponent,
        ),
      );
      await assertAndroidUser(device, user);
      return storageBridgeResult(output, user);
    })();
    pending = run;
    return run;
  }
  return {
    ...device,
    androidUser: user,
    restorationDevice: device.restorationDevice ?? device,
    async shell(command) {
      if (storageCommand(command, user)) return filesystemShell(command);
      await assertAndroidUser(device, user);
      return device.shell(command);
    },
    async push(data, path) {
      if (!storageCommand(path, user)) {
        await assertAndroidUser(device, user);
        return device.push(data, path);
      }
      if (!/^\/storage\/(?:emulated\/\d+|[a-fA-F0-9]{4}-[a-fA-F0-9]{4})\//.test(path) || /[\x00-\x1f]/.test(path)) {
        throw new Error("Storage bridge transfer needs an explicit safe storage path.");
      }
      const staging = `/data/local/tmp/emukase-storage-${crypto.randomUUID()}.bin`;
      await assertAndroidUser(device, user);
      try {
        await device.push(data, staging);
        await device.shell(shellCommand("chmod", "0644", staging));
        await filesystemShell(`set -eu\n${shellCommand("test", "!", "-L", path)}\n${shellCommand("cp", staging, path)}`);
      } finally {
        await device.shell(shellCommand("rm", "-f", staging));
      }
    },
    async install(apk, expectedUser = user) {
      if (expectedUser !== user) throw new Error("APK installation targets another Android user.");
      await assertAndroidUser(device, user);
      await device.install(apk, user);
      await assertAndroidUser(device, user);
    },
  };
}
