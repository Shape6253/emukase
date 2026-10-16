import { queryMediaStoreFiles, readMediaStoreFiles } from "./media-store";
import type { EmulatorUiContext } from "./emulator-ui";
import { shellCommand } from "./transport";
import type { EdenInputKind } from "./eden-inputs";

export interface EdenImport {
  name: string;
  kind: EdenInputKind;
}

export interface EdenDeviceInput extends EdenImport {
  path: string;
}

interface SupportFile {
  path: string;
  bytes: number;
  order: bigint;
}

async function supportFiles(context: EmulatorUiContext, directory: string): Promise<SupportFile[]> {
  const marker = `emukase-eden-files-${crypto.randomUUID()}`;
  const listing = shellCommand("find", directory, "-type", "f", "(", "-name", "prod.keys", "-o", "-iname", "*.zip", ")",
    "-exec", "stat", "-c", "%s %Y %n", "{}", "+");
  const script = [
    `if entries=$( ${listing} 2>/dev/null ); then`,
    `printf '%s\\n' ${shellCommand(marker)}`,
    `if [ -n "$entries" ]; then printf '%s\\n' "$entries"; fi`,
    "else",
    `printf '%s\\n' ${shellCommand(`${marker}:indexed`)}`,
    "fi",
  ].join("\n");
  const output = (await context.device.shell(shellCommand("sh", "-c", script))).trimEnd();
  const lines = output.split(/\r?\n/);
  const mode = lines.shift();
  if (mode === marker) {
    const paths = new Set<string>();
    return lines.map((line) => {
      const match = /^(\d+) (\d+) (.+)$/.exec(line);
      const bytes = Number(match?.[1]);
      const path = match?.[3];
      if (!match?.[2] || !Number.isSafeInteger(bytes) || bytes < 0 || !path?.startsWith(`${directory}/`)
        || /[\x00-\x1f\x7f]/.test(path) || path.split("/").some((part) => part === "." || part === "..") || paths.has(path)) {
        throw new Error("Android returned an invalid support-file listing.");
      }
      paths.add(path);
      return { path, bytes, order: BigInt(match[2]) };
    });
  }
  if (mode !== `${marker}:indexed` || lines.length) throw new Error("Android did not complete the support-file listing.");
  const indexed = await queryMediaStoreFiles(context.device, context.user, directory, context.signal);
  const candidates = indexed.filter((file) => file.bytes > 0 && (file.path.endsWith("/prod.keys") || /\.zip$/i.test(file.path)));
  const readable = await readMediaStoreFiles(context.device, context.user, candidates, context.signal);
  return readable.map((file) => ({ path: file.path, bytes: file.bytes, order: BigInt(file.id) }));
}

/** Reuse supplied support files in place; Eden validates them in its native installer. */
export async function findEdenDeviceInputs(
  context: EmulatorUiContext, directory: string, needed: readonly EdenInputKind[],
): Promise<EdenDeviceInput[]> {
  if (!needed.length) return [];
  const files = await supportFiles(context, directory);
  const result: EdenDeviceInput[] = [];
  for (const kind of needed) {
    const matches = files.filter((file) => file.bytes > 0 && (kind === "keys" ? file.path.endsWith("/prod.keys")
      : /^switch\/(?:import_[a-f\d]+\/)?[^/]+\.zip$/i.test(file.path.slice(directory.length + 1))));
    const supplied = matches.filter((file) => !/^switch\/import_[a-f\d]+\//.test(file.path.slice(directory.length + 1)));
    if (supplied.length > 1) throw new Error(`Multiple ${kind} files are available. Choose the keys or firmware to import.`);
    // Staging folders contain previous user-selected uploads. Prefer the newest
    // upload when no file was placed directly in the support folder.
    const selected = supplied[0] ?? matches.sort((left, right) => left.order < right.order ? 1 : left.order > right.order ? -1 : 0)[0];
    if (!selected) throw new Error(`No readable ${kind === "keys" ? "prod.keys" : "firmware ZIP"} is available in the support folder. Choose keys and firmware first.`);
    const name = selected.path.split("/").at(-1);
    if (!name) throw new Error("The selected support file has no name.");
    result.push({ kind, name, path: selected.path });
  }
  return result;
}
