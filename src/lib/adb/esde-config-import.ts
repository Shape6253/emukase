import { applyEsdeFile, esdeStorageReadable } from "./esde-files";
import { runEsdeHelper, withEsdeHelper } from "./esde-helper";
import type { EsdeContext, EsdeFileChange } from "./esde-types";
import { validateEsdeText } from "./esde-xml";

const BATCH_SIZE = 4;

/** Never replay an uncertain provider batch. Device-side backups and recovery
 * records survive host cancellation and loss of the shell response. */
export async function applyEsdeConfigFiles(context: EsdeContext, changes: readonly EsdeFileChange[]): Promise<void> {
  if (!changes.length) return;
  const progress = (completed: number): void => context.options.onStatus?.(`Saving ES-DE configuration files (${completed}/${changes.length})…`);
  // Host recovery hooks can veto publication, so retain their original ordering.
  if (context.sdk < 31 || context.options.onRecovery || await esdeStorageReadable(context)) {
    for (const [index, change] of changes.entries()) {
      progress(index);
      await applyEsdeFile(context, change);
      progress(index + 1);
    }
    return;
  }
  for (const change of changes) {
    validateEsdeText(change.applied);
    if (change.original !== undefined) validateEsdeText(change.original);
  }
  await withEsdeHelper(context, async () => {
    for (let offset = 0; offset < changes.length; offset += BATCH_SIZE) {
      context.signal?.throwIfAborted();
      progress(offset);
      const batch = changes.slice(offset, offset + BATCH_SIZE).map((change) => ({
        path: change.path, original: change.original ?? null, applied: change.applied, token: crypto.randomUUID(),
      }));
      const output = await runEsdeHelper(context, {
        operation: "apply", recovery: `${context.workspace.setup}/esde`, changes: batch,
      });
      if (output !== "esde-config:verified") {
        throw new Error(`Android did not confirm the ES-DE configuration batch. Existing backups and recovery records were retained. ${output}`);
      }
      for (const [index, entry] of batch.entries()) {
        const change = changes[offset + index];
        if (change && entry.original !== null) change.backupPath = `${entry.path}.emukase-${entry.token}.bak`;
      }
      context.signal?.throwIfAborted();
      progress(offset + batch.length);
    }
  });
}
