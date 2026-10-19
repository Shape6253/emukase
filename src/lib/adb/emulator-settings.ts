import { primaryStorageForUser } from "./android-user";
import type { EmulatorUiContext } from "./emulator-ui";
import { shellCommand } from "./transport";

const MAX_SETTINGS_BYTES = 131_072;

export class EmulatorSettingsAccessError extends Error {}

/** Distinguish missing settings from inaccessible storage before configuring an emulator. */
export async function readEmulatorSettings(
  context: EmulatorUiContext, path: string,
): Promise<string | undefined> {
  const storage = primaryStorageForUser(context.user);
  if (!path.startsWith(`${storage}/`) || /[\x00-\x1f\x7f]/.test(path)
    || path.split("/").slice(1).some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid emulator settings path.");
  }
  const marker = `emukase-settings-${crypto.randomUUID()}`;
  const parts = path.slice(storage.length + 1).split("/");
  const ancestors = [storage, ...parts.slice(0, -1).map((_, index) => `${storage}/${parts.slice(0, index + 1).join("/")}`)];
  const output = await context.device.shell(shellCommand("sh", "-c", [
    "set -eu",
    shellCommand("test", "-d", storage), shellCommand("test", "-r", storage), shellCommand("test", "-x", storage),
    ...ancestors.map((directory) => [
      shellCommand("test", "!", "-L", directory),
      `if ${shellCommand("test", "!", "-e", directory)}; then printf 'missing'; exit 0; fi`,
      shellCommand("test", "-d", directory), shellCommand("test", "-r", directory), shellCommand("test", "-x", directory),
    ].join("\n")),
    shellCommand("test", "!", "-L", path),
    `if ${shellCommand("test", "!", "-e", path)}; then printf 'missing'; exit 0; fi`,
    shellCommand("test", "-f", path), shellCommand("test", "-r", path),
    shellCommand("printf", "present\n"), shellCommand("head", "-c", String(MAX_SETTINGS_BYTES + 1), path),
    shellCommand("printf", `\n${marker}`),
  ].join("\n")));
  context.signal?.throwIfAborted();
  if (output === "missing") return undefined;
  if (output.startsWith("present\n") && output.endsWith(`\n${marker}`)) {
    const text = output.slice("present\n".length, -(`\n${marker}`).length);
    validateSettings(text);
    return text;
  }
  throw new EmulatorSettingsAccessError("Android blocked access to the emulator's settings in this profile. Setup could not be verified.");
}

function validateSettings(text: string): void {
  if (new TextEncoder().encode(text).length > MAX_SETTINGS_BYTES || text.includes("\0") || !/^\uFEFF?\[[^\]\r\n]+\]/m.test(text)) {
    throw new Error("Android returned invalid or unreadable emulator settings.");
  }
}
