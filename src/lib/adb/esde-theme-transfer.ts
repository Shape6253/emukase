import { primaryStorageForUser, userScopedDevice } from "./android-user";
import { createBrowserDownloader } from "./download";
import type { EmulatorConfigurationOptions } from "./emulator-configuration-types";
import { cleanQueryOutput, contentCommand } from "./media-store";
import { uploadMediaStoreFile } from "./media-store-upload";
import { readSharedStorageText } from "./shared-storage-text";
import { esdeThemeDiscovered } from "./esde-theme";
import { ESDE_THEME } from "./esde-theme-source";
import type { DeviceTransport } from "./transport";
import { workspacePaths } from "./workspace";

export interface EsdeThemeTransfer {
  readonly user: number;
  readonly dataDirectory: string;
  /** Undefined means the last startup already discovered this theme. */
  readonly ready: Promise<string | undefined>;
  dispose(): Promise<void>;
}

/** Network and file transfer only: safe alongside APK installs and onboarding.
 * Failures are retained until the theme stage awaits ready; disposal joins and
 * cancels the worker before deleting only its uniquely named archive. */
export function prefetchEsdeTheme(
  device: DeviceTransport, user: number, options: Pick<EmulatorConfigurationOptions, "folders" | "signal" | "log"> = {},
): EsdeThemeTransfer {
  const workspace = workspacePaths(primaryStorageForUser(user), options.folders);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const scoped = userScopedDevice(device, user, signal);
  const name = `emukase-theme-${crypto.randomUUID()}.zip`;
  const directory = `${workspace.setup}/esde`;
  const path = `${directory}/${name}`;
  let uploadStarted = false;
  const ready = (async (): Promise<string | undefined> => {
    const log = await readSharedStorageText(scoped, user, `${workspace.esde}/logs/es_log.txt`, 16_777_216, signal);
    if (log !== undefined && esdeThemeDiscovered(log)) return undefined;
    options.log?.(`Downloading ${ESDE_THEME.name} through the site in the background…`);
    const download = createBrowserDownloader({ requestUrl(url, route) {
      if (route !== "artifact" || url !== ESDE_THEME.url) throw new Error("Invalid ES-DE theme download source.");
      return `/api/esde-theme/artifact?url=${encodeURIComponent(url)}`;
    } }, { signal, maxBytes: ESDE_THEME.bytes });
    const artifact = await download.file?.(ESDE_THEME.url);
    if (!artifact) throw new Error("The theme downloader could not create its temporary file.");
    try {
      if (artifact.file.size !== ESDE_THEME.bytes) throw new Error("The theme archive has an unexpected size.");
      options.log?.(`Sending ${ESDE_THEME.name} to Android in the background…`);
      uploadStarted = true;
      await uploadMediaStoreFile(scoped, user, directory, new File([artifact.file], name), { signal });
    } finally { await artifact.dispose(); }
    options.log?.(`${ESDE_THEME.name} archive is ready on Android.`);
    return path;
  })();
  void ready.catch(() => {});
  let disposed: Promise<void> | undefined;
  return {
    user, dataDirectory: workspace.esde, ready,
    dispose() {
      disposed ??= (async () => {
        controller.abort(new Error("ES-DE theme transfer finished."));
        await ready.catch(() => {});
        if (!uploadStarted) return;
        const recovery = userScopedDevice(device.restorationDevice ?? device, user);
        const removed = cleanQueryOutput(await contentCommand(recovery, user,
          ["delete", "--where", `_data='${path.replaceAll("'", "''")}'`]));
        if (removed) throw new Error("Android did not confirm cleanup of the temporary theme archive.");
      })();
      return disposed;
    },
  };
}
