import { loadAndroidUiDump } from "./android-ui-dump";
import type { EsdeContext } from "./esde-types";
import { cleanQueryOutput } from "./media-store";
import { shellCommand } from "./transport";

interface HelperSession {
  directory: string;
  ready?: Promise<void>;
  busy: boolean;
}

const sessions = new WeakMap<EsdeContext, HelperSession>();

/** Share the private DEX across recovery, menu reads and configuration writes. */
export async function withEsdeHelper<T>(context: EsdeContext, action: () => Promise<T>): Promise<T> {
  if (sessions.has(context)) return action();
  const session: HelperSession = { directory: `/data/local/tmp/emukase-esde-${crypto.randomUUID()}`, busy: false };
  sessions.set(context, session);
  try {
    return await action();
  } finally {
    sessions.delete(context);
    if (session.ready) {
      await session.ready.catch(() => {});
      const cleanup = [shellCommand("rm", "-f", `${session.directory}/helper.dex`, `${session.directory}/request.json`),
        shellCommand("rmdir", session.directory)].join("\n");
      await (context.device.restorationDevice ?? context.device).shell(shellCommand("sh", "-c", cleanup)).catch(() => {});
    }
  }
}

/** A missing/uncertain response is an error; mutation requests are never replayed. */
export async function runEsdeHelper(context: EsdeContext, request: Readonly<Record<string, unknown>>): Promise<string> {
  const session = sessions.get(context);
  if (!session) return withEsdeHelper(context, () => runEsdeHelper(context, request));
  context.signal?.throwIfAborted();
  if (session.busy) throw new Error("An ES-DE helper request is already in progress.");
  session.busy = true;
  const dex = `${session.directory}/helper.dex`;
  const path = `${session.directory}/request.json`;
  try {
    session.ready ??= (async (): Promise<void> => {
      await context.device.shell(shellCommand("sh", "-c", `umask 077\n${shellCommand("mkdir", session.directory)}`));
      await context.device.push(await loadAndroidUiDump(context.signal), dex, { signal: context.signal });
      await context.device.shell(shellCommand("chmod", "400", dex));
    })();
    await session.ready;
    const serialized = JSON.stringify({ ...request, user: context.user });
    const bytes = new TextEncoder().encode(serialized);
    const script = ["set -eu", "umask 077"];
    // Small metadata requests fit in the guarded shell call. Config payloads
    // retain the file transfer so arbitrary original XML is never shell input.
    if (request.operation !== "apply" && bytes.length <= 8192) {
      script.push(`${shellCommand("printf", "%s", serialized)} > ${shellCommand(path)}`);
    } else {
      await context.device.push(bytes, path, { signal: context.signal });
    }
    const output = await context.device.shell(shellCommand("sh", "-c", [
      ...script, shellCommand("chmod", "600", path),
      shellCommand("env", `CLASSPATH=${dex}`, "app_process", "/", "EsdeConfig", path),
    ].join("\n")));
    context.signal?.throwIfAborted();
    return cleanQueryOutput(output);
  } finally {
    session.busy = false;
  }
}
