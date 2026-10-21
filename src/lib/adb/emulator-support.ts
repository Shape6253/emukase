import { primaryStorageForUser, userScopedDevice } from "./android-user";
import { validateArmsx2Inputs } from "./armsx2-inputs";
import type { BiosSystemRun } from "./bios-systems";
import { validateEdenInputs } from "./eden-inputs";
import type { EmulatorConfigurationOptions } from "./emulator-configuration-types";
import { validateMelonDsInputs } from "./melonds-inputs";
import { uploadMediaStoreFile } from "./media-store-upload";
import type { DeviceTransport } from "./transport";
import { validateVita3kInputs } from "./vita3k-inputs";
import { workspacePaths } from "./workspace";

async function uploadSupport(device: DeviceTransport, user: number, platformId: string, files: readonly File[], options: EmulatorConfigurationOptions) {
  const workspace = workspacePaths(primaryStorageForUser(user), options.folders);
  const upload = async (directory: string, inputs: readonly File[], replaceExisting = true): Promise<void> => {
    const total = inputs.reduce((bytes, file) => bytes + file.size, 0);
    let transferred = 0;
    for (const file of inputs) {
      options.onStatus?.(`Uploading ${file.name}…`);
      await uploadMediaStoreFile(device, user, directory, file, {
        replaceExisting, signal: options.signal,
        providerSession: platformId === "switch" || platformId === "psvita",
        onProgress: (bytes) => options.onProgress?.(transferred + bytes, total),
      });
      transferred += file.size;
    }
  };
  switch (platformId) {
    case "nds": {
      const input = await validateMelonDsInputs(files, options.signal);
      const root = `${workspace.bios}/nds/${input.console}`;
      // Never overwrite an existing, writable DSi NAND, including on a retry.
      const directory = input.console === "DSi" ? `${root}/import_${crypto.randomUUID().replaceAll("-", "")}` : root;
      await upload(directory, input.files, input.console === "DS");
      return { platformId, ...input, directory } as const;
    }
    case "ps2": {
      const input = await validateArmsx2Inputs(files, options.signal);
      const directory = `${workspace.bios}/ps2`;
      options.onStatus?.(`Uploading PS2 BIOS ${input.info.version} (${input.info.zone})…`);
      await upload(directory, [input.file]);
      return { platformId, ...input, directory } as const;
    }
    case "switch": {
      const inputs = await validateEdenInputs(files, options.signal);
      const directory = `${workspace.bios}/switch`;
      await upload(directory, inputs.map((input) => input.file));
      return { platformId, inputs, directory } as const;
    }
    case "psvita": {
      const input = await validateVita3kInputs(files, options.signal);
      const directory = `${workspace.bios}/psvita`;
      await upload(directory, [input.file]);
      return { platformId, ...input, directory } as const;
    }
    default: throw new Error("Support-file preparation is not available for this emulator.");
  }
}

type PreparedSupport = Awaited<ReturnType<typeof uploadSupport>>;

/** Run-local cache: retains validated/normalized files and their completed upload,
 * never just a filename/size match or evidence from a previous setup session. */
export class EmulatorSupportPreparation {
  private entries: { device: DeviceTransport; user: number; key: string; files: readonly File[]; result: Promise<PreparedSupport> }[] = [];

  prepare(device: DeviceTransport, user: number, platformId: string, files: readonly File[], options: EmulatorConfigurationOptions): Promise<PreparedSupport> {
    const connection = device.restorationDevice ?? device;
    const key = JSON.stringify([platformId, workspacePaths(primaryStorageForUser(user), options.folders)]);
    const previous = this.entries.find((entry) => entry.device === connection && entry.user === user && entry.key === key
      && entry.files.length === files.length && entry.files.every((file, index) => file === files[index]));
    if (previous) return previous.result;
    const result = uploadSupport(userScopedDevice(device, user, options.signal), user, platformId, files, options);
    this.entries.push({ device: connection, user, key, files: [...files], result });
    // Foreground configuration consumes errors; background preparation must not
    // produce an unhandled rejection before that system reaches its setup step.
    void result.catch(() => {});
    return result;
  }
}

export async function prepareEmulatorSupport<P extends PreparedSupport["platformId"]>(
  device: DeviceTransport, user: number, platformId: P, files: readonly File[], options: EmulatorConfigurationOptions,
): Promise<Extract<PreparedSupport, { platformId: P }>> {
  options.signal?.throwIfAborted();
  const result = await (options.supportPreparation ?? new EmulatorSupportPreparation()).prepare(device, user, platformId, files, options);
  options.signal?.throwIfAborted();
  if (result.platformId !== platformId) throw new Error("Prepared support files belong to another emulator.");
  return result as Extract<PreparedSupport, { platformId: P }>;
}

/** File transfers only: no activity launches, pickers, or accessibility reads.
 * Two workers overlap uploads with base setup without flooding the USB link. */
export function prefetchEmulatorSupport(
  device: DeviceTransport, user: number, runs: readonly BiosSystemRun[], options: EmulatorConfigurationOptions,
): { preparation: EmulatorSupportPreparation; dispose(): Promise<void> } {
  const preparation = new EmulatorSupportPreparation();
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const queue = runs.flatMap((run) => {
    const groups = run.groups.filter((group) => group.files.length);
    // Match Eden's combined import so setup can install firmware before title.keys.
    return run.platformId === "switch" && groups.length
      ? [{ platformId: run.platformId, files: groups.flatMap((group) => group.files) }]
      : groups.map((group) => ({ platformId: run.platformId, files: group.files }));
  });
  let next = 0;
  const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
    while (!signal.aborted) {
      const task = queue[next++];
      if (!task) return;
      try { await preparation.prepare(device, user, task.platformId, task.files, { ...options, signal }); }
      catch { /* The cached result surfaces this system's error at configuration. */ }
    }
  });
  return {
    preparation,
    async dispose() {
      controller.abort(new Error("Support-file preparation finished."));
      await Promise.allSettled(workers);
    },
  };
}
