import { loadAndroidUiDump } from "./android-ui-dump";
import { assertAndroidUser } from "./android-user";
import { cleanQueryOutput, queryMediaStoreFolders } from "./media-store";
import type { EmulatorUiContext } from "./emulator-ui";
import { shellCommand } from "./transport";

async function providerPrefix(context: EmulatorUiContext, directory: string, name: string): Promise<string | undefined> {
  const { device, user, signal } = context;
  const records = await queryMediaStoreFolders(device, user, [directory], signal);
  const record = records[0];
  if (records.length !== 1 || !record || record.format !== 12289) return undefined;
  const temporary = `/data/local/tmp/emukase-document-prefix-${crypto.randomUUID()}.dex`;
  const cleanup = shellCommand("rm", "-f", temporary);
  try {
    await device.push(await loadAndroidUiDump(signal), temporary, { signal });
    await assertAndroidUser(device, user, signal);
    const output = cleanQueryOutput(await device.shell(shellCommand("sh", "-c", [
      "set -eu", shellCommand("trap", cleanup, "EXIT"), shellCommand("chmod", "400", temporary),
      shellCommand("timeout", "10", "env", `CLASSPATH=${temporary}`, "app_process", "/", "MediaStoreStat", String(user), record.id, name),
    ].join("\n"))));
    await assertAndroidUser(device, user, signal);
    const after = await queryMediaStoreFolders(device, user, [directory], signal);
    if (after.length !== 1 || after[0]?.id !== record.id || after[0].format !== 12289) return undefined;
    const marker = `media-prefix:${user}:${record.id}:${name}:`;
    if (!output.startsWith(marker)) return undefined;
    const prefix = output.slice(marker.length);
    return /^[A-Za-z0-9_.-]{1,64}$/.test(prefix) && name.startsWith(prefix) ? prefix : undefined;
  } finally {
    await (device.restorationDevice ?? device).shell(cleanup).catch(() => {});
  }
}

/** Bound the title highlighter using all actual siblings, including unindexed files. */
export async function documentSearchPrefix(context: EmulatorUiContext, directory: string, name: string): Promise<string> {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error("Invalid Android document search name.");
  context.signal?.throwIfAborted();
  const first = name.slice(0, 1);
  if (name.length <= 1) return first;
  const marker = `emukase-document-names-${crypto.randomUUID()}`;
  try {
    const output = await context.device.shell(shellCommand("sh", "-c", ["set -e",
      shellCommand("find", directory, "-mindepth", "1", "-maxdepth", "1", "-print0"), shellCommand("printf", marker),
    ].join("\n")));
    context.signal?.throwIfAborted();
    if (output.length <= 2_097_152 && output.endsWith(`\0${marker}`)) {
      const parent = `${directory.replace(/\/$/, "")}/`;
      const paths = output.slice(0, -marker.length - 1).split("\0");
      if (paths.every((path) => path.startsWith(parent) && !path.slice(parent.length).includes("/"))) {
        const names = paths.map((path) => path.slice(parent.length));
        if (names.includes(name) && names.every(Boolean)) {
          const limit = names.reduce((length, entry) => Math.min(length, entry.length), name.length);
          const others = names.filter((entry) => entry !== name).map((entry) => entry.toLowerCase());
          for (let length = 1; length < limit; length++) {
            const prefix = name.slice(0, length);
            if (!others.some((entry) => entry.startsWith(prefix.toLowerCase()))) return prefix;
          }
          return name.slice(0, limit);
        }
      }
    }
  } catch {
    context.signal?.throwIfAborted();
  }
  // A MediaStore row identifies the parent; its read-only descriptor supplies
  // the complete filesystem listing rather than trusting indexed children.
  try { return await providerPrefix(context, directory, name) ?? first; }
  catch { context.signal?.throwIfAborted(); return first; }
}
