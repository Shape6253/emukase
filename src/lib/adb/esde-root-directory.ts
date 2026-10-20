import { primaryStorageForUser } from "./android-user";
import { esdePathChecks, esdeShell } from "./esde-files";
import type { EsdeContext } from "./esde-types";
import { shellCommand } from "./transport";
import { sharedStorageReadable } from "./shared-storage-text";

/** Remove only an empty default folder after a verified startup in the workspace. */
export async function removeEmptyEsdeRootDirectory(context: EsdeContext): Promise<void> {
  // Keep an unobservable default folder; provider listings cannot prove that
  // it contains no unindexed user files and must not authorize its deletion.
  if (!await sharedStorageReadable(context.device, context.user, context.signal)) return;
  const source = `${primaryStorageForUser(context.user)}/ES-DE`;
  const root = source.toLowerCase();
  if (Object.values(context.workspace).some((path) => path.toLowerCase() === root || path.toLowerCase().startsWith(`${root}/`))) return;
  context.options.onStatus?.("Checking ES-DE's default folder in internal storage…");
  const output = await esdeShell(context, [esdePathChecks(context, source), shellCommand("set", "--", source), `
if test -e "$1"; then
  test -d "$1"
  test -x "$1"
  entry=$(find "$1" -mindepth 1 -maxdepth 1 -print -quit)
  if test -z "$entry"; then rmdir "$1"; else printf preserved; fi
fi`].join("\n"));
  if (output === "preserved") context.options.onStatus?.("Keeping ES-DE's non-empty default folder in place.");
  else if (output !== "") throw new Error("ES-DE's default folder could not be inspected.");
}
