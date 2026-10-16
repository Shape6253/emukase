import { queryMediaStoreFiles, readMediaStoreFiles } from "./media-store";
import { melonDsDirectories, melonDsFileValid, type MelonDsConsole } from "./melonds-inputs";
import type { EmulatorUiContext } from "./emulator-ui";
import { shellCommand } from "./transport";

interface SupportFile { relativePath: string; bytes: number; order: bigint }

async function supportFiles(context: EmulatorUiContext, directory: string, console: MelonDsConsole): Promise<SupportFile[]> {
  const marker = `emukase-melonds-files-${crypto.randomUUID()}`;
  const listing = shellCommand("find", directory, "-type", "f", "-name", "*.bin", "-exec", "stat", "-c", "%s %Y %n", "{}", "+");
  const script = [
    `if entries=$( ${listing} 2>/dev/null ); then`,
    `printf '%s\\n' ${shellCommand(marker)}`,
    `if [ -n "$entries" ]; then printf '%s\\n' "$entries"; fi`,
    "else", `printf '%s\\n' ${shellCommand(`${marker}:indexed`)}`, "fi",
  ].join("\n");
  const lines = (await context.device.shell(shellCommand("sh", "-c", script))).trimEnd().split(/\r?\n/);
  const mode = lines.shift();
  context.signal?.throwIfAborted();
  if (mode === marker) {
    const paths = new Set<string>();
    return lines.map((line) => {
      const match = /^(\d+) (\d+) (.+)$/.exec(line);
      const bytes = Number(match?.[1]);
      const path = match?.[3];
      if (!match?.[2] || !Number.isSafeInteger(bytes) || bytes < 0 || !path?.startsWith(`${directory}/`)
        || /[\x00-\x1f\x7f]/.test(path) || path.split("/").some((part) => part === "." || part === "..") || paths.has(path)) {
        throw new Error("Android returned an invalid melonDS support-file listing.");
      }
      paths.add(path);
      return { relativePath: path, bytes, order: BigInt(match[2]) };
    });
  }
  if (mode !== `${marker}:indexed` || lines.length) throw new Error("Android did not complete the melonDS support-file listing.");
  const indexed = await queryMediaStoreFiles(context.device, context.user, directory, context.signal);
  const candidates = indexed.filter((file) => melonDsFileValid(console, file.path.slice(file.path.lastIndexOf("/") + 1), file.bytes));
  const readable = await readMediaStoreFiles(context.device, context.user, candidates, context.signal);
  return readable.map((file) => ({ relativePath: file.path, bytes: file.bytes, order: BigInt(file.id) }));
}

/** Keep console dumps together: files from different directories cannot form a bundle. */
export async function findMelonDsDirectory(context: EmulatorUiContext, root: string, console: MelonDsConsole, excluded: readonly string[] = []): Promise<string | undefined> {
  const files = await supportFiles(context, root, console);
  const directories = melonDsDirectories(console, files).filter((path) => !excluded.includes(path));
  const supplied = directories.filter((path) => !/\/import_[a-f\d]+$/.test(path));
  if (supplied.length > 1) throw new Error(`Multiple complete ${console} folders are available. Keep one ${console} BIOS folder in the support library before completing setup.`);
  if (supplied[0]) return supplied[0];
  const order = (path: string): bigint => files.filter((file) => file.relativePath.startsWith(`${path}/`))
    .reduce((latest, file) => file.order > latest ? file.order : latest, 0n);
  return directories.sort((left, right) => order(left) < order(right) ? 1 : order(left) > order(right) ? -1 : left.localeCompare(right))[0];
}
