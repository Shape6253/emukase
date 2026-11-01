import { readAndroidPackage } from "./android-package";
import { matchesApplicationVersion } from "./application";
import { latestRelease, selectCores, type Abi } from "./catalog";
import { prefetchApk, type Download, type DownloadProgress } from "./download";
import { createLibretroDownloader, readLibretroText } from "./libretro-download";
import { prefetchRetroArchCores } from "./retroarch-cores";
import { installRetroArch, type RetroArchInstallOptions } from "./retroarch-install";
import type { DeviceTransport } from "./transport";

interface RetroArchSetupOptions extends Pick<RetroArchInstallOptions, "signal" | "log" | "onEvent" | "folders"> {
  onProgress?: (event: DownloadProgress) => void;
}

export interface RetroArchSetup {
  version: string;
  coreCount: number;
  prefetch: () => void;
  install: (installerPackageName: string) => Promise<void>;
  dispose: () => Promise<void>;
}

export async function prepareRetroArchSetup(
  device: DeviceTransport, abi: Abi, user: number, options: RetroArchSetupOptions,
): Promise<RetroArchSetup> {
  const { signal } = options;
  const release = await latestRelease(abi, (url) => readLibretroText(url, { signal }));
  const installed = await readAndroidPackage(device, release.packageName, user, signal);
  const reuse = installed !== undefined && matchesApplicationVersion(release, installed.version);
  const cores = selectCores(release.abi);
  const download = createLibretroDownloader({ onProgress: options.onProgress, signal });
  const prefetched: { dispose(): Promise<void> }[] = [];
  let downloads: { apk: Download; cores: ReturnType<typeof prefetchRetroArchCores> } | undefined;

  function startDownload(): NonNullable<typeof downloads> {
    signal?.throwIfAborted();
    if (!downloads) {
      let apk: Download = download;
      if (!reuse) {
        const prefetchedApk = prefetchApk(download, release.apkUrl, signal);
        prefetched.push(prefetchedApk);
        apk = prefetchedApk;
      }
      const coreArchives = prefetchRetroArchCores(download, release.abi, cores, signal);
      prefetched.push(coreArchives);
      downloads = { apk, cores: coreArchives };
      options.log?.(`Downloading ${reuse ? "" : "RetroArch and "}${cores.length} cores in parallel…`);
    }
    return downloads;
  }

  return {
    version: release.version,
    coreCount: cores.length,
    prefetch() { startDownload(); },
    async install(installerPackageName) {
      const files = startDownload();
      await installRetroArch(device, release, files.apk, {
        signal, log: options.log, onEvent: options.onEvent, folders: options.folders,
        cores, coreDownload: files.cores, installerPackageName,
      });
    },
    async dispose() {
      const results = await Promise.allSettled(prefetched.map((item) => item.dispose()));
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Could not remove RetroArch downloads.");
    },
  };
}
