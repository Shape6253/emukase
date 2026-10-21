import type { DeviceTransport } from "./transport";
import { ensureSharedLibraryFolders } from "./library-structure";
import type { LibraryVerification } from "./library-structure";
import type { LibraryFolderOptions } from "./workspace";
import { checkAbort } from "./setup-events";
import type { SetupEvent, SetupStage } from "./setup-events";

export const LIBRARY_SETUP_STAGE: SetupStage = "extra:library-folders";

interface LibrarySetupOptions extends LibraryFolderOptions {
  log?: (message: string) => void;
  onEvent?: (event: SetupEvent) => void;
  onFoldersReady?: (library: LibraryVerification) => void;
}

/** Run folder preparation alongside application downloads and installation.
 * Both tasks must finish, including cancellation cleanup, before the job is released. */
export async function withLibrarySetup<T>(
  device: DeviceTransport,
  controller: AbortController,
  setup: (signal: AbortSignal) => Promise<T>,
  options: LibrarySetupOptions = {},
): Promise<{ result: T; library: LibraryVerification }> {
  const { signal } = controller;
  checkAbort(signal);
  let foldersFinished = false;
  const library = Promise.resolve().then(async () => {
    checkAbort(signal);
    options.onEvent?.({ stage: LIBRARY_SETUP_STAGE, status: "running", message: "Preparing shared library folders…" });
    try {
      const result = await ensureSharedLibraryFolders(device, signal, options.log, options);
      checkAbort(signal);
      foldersFinished = true;
      options.onEvent?.({ stage: LIBRARY_SETUP_STAGE, status: "complete" });
      options.onFoldersReady?.(result);
      return result;
    } catch (error) {
      // The sibling application's failure cancels this task with the same reason.
      // Keep independent folder errors visible, even if cancellation raced with them.
      if (!signal.aborted || error !== signal.reason) {
        options.onEvent?.({ stage: LIBRARY_SETUP_STAGE, status: "failed" });
      }
      throw error;
    }
  });
  const applications = Promise.resolve().then(async () => {
    checkAbort(signal);
    const result = await setup(signal);
    checkAbort(signal);
    if (!foldersFinished) options.onEvent?.({ stage: LIBRARY_SETUP_STAGE, status: "running", message: "Finishing shared library folders…" });
    return result;
  });
  try {
    const [folders, result] = await Promise.all([library, applications]);
    checkAbort(signal);
    return { result, library: folders };
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled([library, applications]);
    throw error;
  }
}
