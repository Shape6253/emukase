import { androidUserProcessPid, primaryStorageForUser } from "./android-user";
import { checkAbort } from "./setup-events";
import { shellCommand } from "./transport";
import { ESDE_PACKAGE } from "./esde-types";
import type { EsdeContext, EsdeFileChange, EsdeRecoveryRecord } from "./esde-types";
import { ESDE_MAX_TEXT_BYTES, validateEsdeText } from "./esde-xml";
import { createMediaStoreFolders } from "./media-store";
import { runEsdeHelper } from "./esde-helper";
import { readSharedStorageText, sharedStorageReadable, writeSharedStorageText } from "./shared-storage-text";

const storageAccess = new WeakMap<EsdeContext, Promise<boolean>>();

/** Access is stable for this pinned-profile run; every transport call still
 * checks the foreground user. File bytes are never cached between stages. */
export function esdeStorageReadable(context: EsdeContext): Promise<boolean> {
  checkAbort(context.signal);
  let readable = storageAccess.get(context);
  if (!readable) {
    readable = sharedStorageReadable(context.device, context.user, context.signal);
    storageAccess.set(context, readable);
  }
  return readable;
}

/** Require explicit shell completion: WebADB does not expose an exit status. */
export async function esdeShell(context: EsdeContext, script: string): Promise<string> {
  checkAbort(context.signal);
  const marker = `__emukase_esde_${crypto.randomUUID()}__`;
  const output = await context.device.shell(shellCommand("sh", "-c", [
    "set -eu", script, shellCommand("printf", `\n${marker}`),
  ].join("\n")));
  checkAbort(context.signal);
  const suffix = `\n${marker}`;
  if (!output.endsWith(suffix)) throw new Error("Android did not confirm the ES-DE file operation. Shared storage must be accessible in this profile.");
  return output.slice(0, -suffix.length);
}

function pathParts(context: EsdeContext, path: string): string[] {
  const storage = primaryStorageForUser(context.user);
  if (!path.startsWith(`${storage}/`) || path.length > 2048 || /[\x00-\x1f\x7f]/.test(path)
    || path.slice(1).split("/").some((part) => !part || part === "." || part === "..")
    || path.slice(storage.length + 1).split("/")[0] === "Android") throw new Error("Unsafe ES-DE shared-storage path.");
  const parts = path.slice(storage.length + 1).split("/");
  return [storage, ...parts.map((_, index) => `${storage}/${parts.slice(0, index + 1).join("/")}`)];
}

export function esdePathChecks(context: EsdeContext, path: string): string {
  return pathParts(context, path).map((part) => [
    shellCommand("test", "!", "-L", part),
    `if ${shellCommand("test", "-e", part)}; then`,
    shellCommand("test", "-r", part),
    `else ${shellCommand("test", "-r", part.slice(0, part.lastIndexOf("/")))}; fi`,
  ].join("\n")).join("\n");
}

export async function ensureEsdeDirectory(context: EsdeContext, path: string): Promise<void> {
  pathParts(context, path);
  if (!await esdeStorageReadable(context)) {
    await createMediaStoreFolders(context.device, context.user, [path], context.signal);
    return;
  }
  // Check existing ancestors before mkdir; absent descendants are safe only
  // after their nearest existing parent has been proven traversable.
  const checks = pathParts(context, path).map((part) => `if ${shellCommand("test", "-e", part)} || ${shellCommand("test", "-L", part)}; then\n`
    + [shellCommand("test", "!", "-L", part), shellCommand("test", "-d", part), shellCommand("test", "-r", part), shellCommand("test", "-x", part)].join("\n") + "\nfi");
  const storage = primaryStorageForUser(context.user);
  await esdeShell(context, [shellCommand("test", "-d", storage), shellCommand("test", "-r", storage), shellCommand("test", "-x", storage),
    ...checks, shellCommand("mkdir", "-p", path), shellCommand("test", "-w", path)].join("\n"));
}

export async function readEsdeText(context: EsdeContext, path: string): Promise<string | undefined> {
  const ancestors = pathParts(context, path).slice(0, -1);
  if (!await esdeStorageReadable(context)) {
    if (context.sdk >= 31) return (await readEsdeTexts(context, [path])).get(path);
    const text = await readSharedStorageText(context.device, context.user, path, ESDE_MAX_TEXT_BYTES, context.signal);
    if (text !== undefined) validateEsdeText(text);
    return text;
  }
  const checks = ancestors.map((part) => [
    shellCommand("test", "!", "-L", part),
    `if ${shellCommand("test", "-e", part)}; then`,
    shellCommand("test", "-d", part), shellCommand("test", "-r", part), shellCommand("test", "-x", part),
    "else printf 'missing\\n'; exit 0; fi",
  ].join("\n"));
  // Do not use `test ! -e` below an inaccessible parent: it can falsely report
  // a missing file and lead to overwriting an unobserved configuration.
  const marker = `__emukase_esde_read_${crypto.randomUUID()}__`;
  const output = await context.device.shell(shellCommand("sh", "-c", [
    "set -eu", shellCommand("test", "-d", primaryStorageForUser(context.user)),
    shellCommand("test", "-r", primaryStorageForUser(context.user)), shellCommand("test", "-x", primaryStorageForUser(context.user)), ...checks,
    shellCommand("test", "!", "-L", path),
    `if ${shellCommand("test", "!", "-e", path)}; then printf 'missing\\n'; exit 0; fi`,
    shellCommand("test", "-f", path), shellCommand("test", "-r", path),
    `test "$( ${shellCommand("wc", "-c")} < ${shellCommand(path)} )" -le ${ESDE_MAX_TEXT_BYTES}`,
    shellCommand("printf", "present\n"), shellCommand("head", "-c", String(ESDE_MAX_TEXT_BYTES + 1), path),
    shellCommand("printf", `\n${marker}`),
  ].join("\n")));
  checkAbort(context.signal);
  if (output === "missing\n") return undefined;
  if (!output.startsWith("present\n") || !output.endsWith(`\n${marker}`)) {
    throw new Error("ES-DE configuration could not be read safely in this Android profile.");
  }
  const text = output.slice("present\n".length, -(`\n${marker}`).length);
  validateEsdeText(text);
  return text;
}

/** Fresh reads through one provider session per batch. Never share their bytes
 * across ES-DE stop/restart boundaries; only the DEX transport is reused. */
export async function readEsdeTexts(context: EsdeContext, paths: readonly string[]): Promise<ReadonlyMap<string, string | undefined>> {
  const result = new Map<string, string | undefined>();
  for (const path of paths) pathParts(context, path);
  if (new Set(paths).size !== paths.length) throw new Error("Duplicate ES-DE configuration read paths.");
  if (!paths.length) return result;
  if (context.sdk < 31 || await esdeStorageReadable(context)) {
    for (const path of paths) result.set(path, await readEsdeText(context, path));
    return result;
  }
  for (let offset = 0; offset < paths.length; offset += 16) {
    const batch = paths.slice(offset, offset + 16);
    const output = await runEsdeHelper(context, {
      operation: "read", recovery: `${context.workspace.setup}/esde`, paths: batch, maxBytes: ESDE_MAX_TEXT_BYTES,
    });
    if (!output.startsWith("esde-read:")) throw new Error(`Android did not read the ES-DE configuration safely. ${output}`);
    const value: unknown = JSON.parse(output.slice("esde-read:".length));
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== batch.length) {
      throw new Error("Android returned incomplete ES-DE configuration readback.");
    }
    for (const path of batch) {
      const text: unknown = Object.getOwnPropertyDescriptor(value, path)?.value;
      if (text !== null && typeof text !== "string") throw new Error("Android did not confirm an ES-DE configuration file.");
      if (typeof text === "string") validateEsdeText(text);
      result.set(path, text === null ? undefined : text);
    }
  }
  return result;
}

export async function esdeTextHash(text: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function recordEsdeRecovery(
  context: EsdeContext, stage: string, phase: EsdeRecoveryRecord["phase"],
  details: EsdeRecoveryRecord["details"] = {}, token: string = crypto.randomUUID(),
): Promise<string> {
  if (!/^[a-z][a-z-]{0,63}$/.test(stage) || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(token)) throw new Error("Invalid ES-DE recovery identity.");
  const record: EsdeRecoveryRecord = { schema: 1, token, user: context.user, stage, phase, details };
  const directory = `${context.workspace.setup}/esde`;
  if (context.sdk >= 31 && !await esdeStorageReadable(context)) {
    const output = await runEsdeHelper(context, { operation: "recovery", recovery: directory, record });
    if (output !== "esde-recovery:verified") throw new Error(`ES-DE recovery evidence was not saved. ${output}`);
    await context.options.onRecovery?.(record);
    return token;
  }
  const path = `${directory}/${token}.json`;
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  if (!await esdeStorageReadable(context)) {
    await writeSharedStorageText(context.device, context.user, path, JSON.stringify(record), { replaceExisting: true, signal: context.signal });
  } else {
    await ensureEsdeDirectory(context, directory);
    await esdeShell(context, [
      esdePathChecks(context, path), shellCommand("test", "!", "-e", temporary), shellCommand("test", "!", "-L", temporary), "set -C",
      `${shellCommand("printf", "%s", JSON.stringify(record))} > ${shellCommand(temporary)}`,
      shellCommand("mv", "-f", temporary, path), "sync",
    ].join("\n"));
  }
  if (await readEsdeText(context, path) !== JSON.stringify(record)) throw new Error("ES-DE recovery evidence was not saved.");
  await context.options.onRecovery?.(record);
  return token;
}

/** The original survives cancellation, disconnection and later verification
 * failures. Replacements are compare-before-write and atomic on shared storage. */
export async function applyEsdeFile(context: EsdeContext, change: EsdeFileChange, requireStopped = true): Promise<void> {
  validateEsdeText(change.applied);
  if (change.original === change.applied) return;
  const stopped = async (): Promise<void> => {
    if (requireStopped && await androidUserProcessPid(context.device, ESDE_PACKAGE, context.user, context.signal)) {
      throw new Error("ES-DE must remain stopped while importing its configuration.");
    }
  };
  await stopped();
  if (await readEsdeText(context, change.path) !== change.original) throw new Error("ES-DE file changed before import; no replacement was made.");
  const direct = await esdeStorageReadable(context);
  // A pending MediaStore insert creates its parents without temporary markers.
  if (direct) await ensureEsdeDirectory(context, change.path.slice(0, change.path.lastIndexOf("/")));
  const token = crypto.randomUUID();
  const staging = `${change.path}.emukase-${token}.tmp`;
  const backup = change.original === undefined ? undefined : `${change.path}.emukase-${token}.bak`;
  if (!direct) {
    if (backup && change.original !== undefined) {
      await writeSharedStorageText(context.device, context.user, backup, change.original, { signal: context.signal });
      change.backupPath = backup;
    }
    const details = { path: change.path, backupPath: backup ?? "", originalHash: change.original === undefined ? "" : await esdeTextHash(change.original),
      appliedHash: await esdeTextHash(change.applied) };
    await recordEsdeRecovery(context, "config-import", "intent", details, token);
    try {
      await writeSharedStorageText(context.device, context.user, change.path, change.applied,
        { replaceExisting: change.original !== undefined, signal: context.signal, beforePublish: async () => {
          await stopped();
          if (await readEsdeText(context, change.path) !== change.original) throw new Error("ES-DE file changed before import; no replacement was made.");
        } });
      await recordEsdeRecovery(context, "config-import", "verified", details, token);
    } catch (error) {
      await recordEsdeRecovery(context, "config-import", "uncertain", details, token).catch(() => {});
      throw error;
    }
    return;
  }
  if (backup) {
    await esdeShell(context, [esdePathChecks(context, change.path), shellCommand("test", "!", "-e", backup),
      shellCommand("test", "!", "-L", backup), "set -C", `${shellCommand("cat", change.path)} > ${shellCommand(backup)}`, "sync"].join("\n"));
    if (await readEsdeText(context, backup) !== change.original) throw new Error("ES-DE backup verification failed; no replacement was made.");
    change.backupPath = backup;
  }
  const details = { path: change.path, backupPath: backup ?? "", originalHash: change.original === undefined ? "" : await esdeTextHash(change.original),
    appliedHash: await esdeTextHash(change.applied) };
  await recordEsdeRecovery(context, "config-import", "intent", details, token);
  try {
    await esdeShell(context, [shellCommand("test", "!", "-e", staging), shellCommand("test", "!", "-L", staging)].join("\n"));
    await context.device.push(new TextEncoder().encode(change.applied), staging, { signal: context.signal });
    if (await readEsdeText(context, staging) !== change.applied) throw new Error("ES-DE staged configuration readback failed.");
    await stopped();
    await esdeShell(context, [esdePathChecks(context, change.path), esdePathChecks(context, staging),
      backup ? shellCommand("cmp", "-s", change.path, backup) : shellCommand("test", "!", "-e", change.path),
      shellCommand("mv", "-f", staging, change.path), "sync"].join("\n"));
    if (await readEsdeText(context, change.path) !== change.applied) throw new Error("ES-DE imported configuration readback failed.");
    await recordEsdeRecovery(context, "config-import", "verified", details, token);
  } catch (error) {
    // Keep the backup and intent even if the original connection is gone.
    await recordEsdeRecovery(context, "config-import", "uncertain", details, token).catch(() => {});
    throw error;
  } finally {
    const cleanup = context.device.restorationDevice ?? context.device;
    await cleanup.shell(shellCommand("sh", "-c", `test "$(am get-current-user)" = ${shellCommand(String(context.user))} && ${shellCommand("rm", "-f", staging)}`)).catch(() => {});
  }
}
