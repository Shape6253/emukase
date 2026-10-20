import { primaryStorageForUser } from "./android-user";
import type { EmulatorUiContext } from "./emulator-ui";
import { shellCommand } from "./transport";
import { readSharedStorageText } from "./shared-storage-text";

const MAX_SETTINGS_BYTES = 131_072;

export class EmulatorSettingsAccessError extends Error {}

/** Distinguish missing settings from inaccessible storage before configuring an emulator. */
export async function readEmulatorSettings(
  context: EmulatorUiContext, path: string,
): Promise<string | undefined> {
  context.signal?.throwIfAborted();
  const storage = primaryStorageForUser(context.user);
  if (!path.startsWith(`${storage}/`) || /[\x00-\x1f\x7f]/.test(path)
    || path.split("/").slice(1).some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid emulator settings path.");
  }
  const marker = `emukase-settings-${crypto.randomUUID()}`;
  const parts = path.slice(storage.length + 1).split("/");
  const ancestors = [storage, ...parts.slice(0, -1).map((_, index) => `${storage}/${parts.slice(0, index + 1).join("/")}`)];
  const requireAccess = (...args: string[]): string => `${shellCommand("test", ...args)} || inaccessible`;
  const output = await context.device.shell(shellCommand("sh", "-c", [
    "set -eu",
    // Expected filesystem failures must exit successfully for WebADB to return
    // the access marker. Transport and cancellation errors still propagate.
    "inaccessible() { printf 'inaccessible'; exit 0; }",
    requireAccess("-d", storage), requireAccess("-r", storage), requireAccess("-x", storage),
    ...ancestors.map((directory) => [
      requireAccess("!", "-L", directory),
      `if ${shellCommand("test", "!", "-e", directory)}; then printf 'missing'; exit 0; fi`,
      requireAccess("-d", directory), requireAccess("-r", directory), requireAccess("-x", directory),
    ].join("\n")),
    requireAccess("!", "-L", path),
    `if ${shellCommand("test", "!", "-e", path)}; then printf 'missing'; exit 0; fi`,
    requireAccess("-f", path), requireAccess("-r", path),
    shellCommand("printf", "present\n"), `${shellCommand("head", "-c", String(MAX_SETTINGS_BYTES + 1), path)} || inaccessible`,
    shellCommand("printf", `\n${marker}`),
  ].join("\n")));
  context.signal?.throwIfAborted();
  if (output === "missing") return undefined;
  if (output.startsWith("present\n") && output.endsWith(`\n${marker}`)) {
    const text = output.slice("present\n".length, -(`\n${marker}`).length);
    validateSettings(text);
    return text;
  }
  if (path.slice(storage.length + 1).split("/")[0] !== "Android") {
    const text = await readSharedStorageText(context.device, context.user, path, MAX_SETTINGS_BYTES, context.signal);
    if (text !== undefined) validateSettings(text);
    return text;
  }
  throw new EmulatorSettingsAccessError("Android blocked access to the emulator's settings in this profile. Setup could not be verified.");
}

function validateSettings(text: string): void {
  if (new TextEncoder().encode(text).length > MAX_SETTINGS_BYTES || text.includes("\0") || !/^\uFEFF?\[[^\]\r\n]+\]/m.test(text)) {
    throw new Error("Android returned invalid or unreadable emulator settings.");
  }
}
