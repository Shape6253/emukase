import { unzipSync } from "fflate";
import type { ApplicationInstallContext } from "./application-install";
import { coreFilename, coreUrl, type Abi, type Core, type Release } from "./catalog";
import { prefetchArtifact, type Download, type DownloadedFile } from "./download";
import { checkAbort } from "./setup-events";
import { checkActivityStart, shellCommand } from "./transport";

const SIDELOAD = "com.retroarch.browser.debug.CoreSideloadActivity";
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type PrefetchedCores = Download & { dispose(): Promise<void> };

export function prefetchRetroArchCores(
  download: Download, abi: Abi, cores: readonly Core[], signal?: AbortSignal,
): PrefetchedCores {
  checkAbort(signal);
  const urls = cores.map((core) => coreUrl(abi, core));
  if (new Set(urls).size !== urls.length) throw new Error("Duplicate RetroArch cores.");
  const archives = new Map(urls.map((url) => [url, prefetchArtifact(download, url, signal)]));
  async function file(url: string): Promise<DownloadedFile> {
    checkAbort(signal);
    const archive = archives.get(url);
    if (!archive?.file) throw new Error("The requested core was not prefetched.");
    return archive.file(url);
  }
  return Object.assign(async (url: string): Promise<Uint8Array> => {
    const archive = await file(url);
    const bytes = new Uint8Array(await archive.file.arrayBuffer());
    checkAbort(signal);
    return bytes;
  }, {
    file,
    async dispose() {
      const results = await Promise.allSettled([...archives.values()].map((archive) => archive.dispose()));
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Could not remove temporary core archives.");
    },
  });
}

export function extractCore(zip: Uint8Array, filename: string, abi: Abi): Uint8Array {
  let oversized = false;
  const data = unzipSync(zip, {
    filter: (entry) => {
      if (entry.name !== filename) return false;
      oversized ||= entry.originalSize > 256 * 1024 * 1024;
      return !oversized;
    },
  })[filename];
  if (oversized) throw new Error(`Core ${filename} exceeds the 256 MiB limit.`);
  if (!data || data.length < 20 || data[0] !== 0x7f || data[1] !== 0x45 || data[2] !== 0x4c || data[3] !== 0x46) {
    throw new Error(`The archive does not contain a valid core named ${filename}.`);
  }
  const expected = {
    "arm64-v8a": { bits: 2, machine: 183 },
    "armeabi-v7a": { bits: 1, machine: 40 },
    x86_64: { bits: 2, machine: 62 },
    x86: { bits: 1, machine: 3 },
  }[abi];
  const machine = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(18, true);
  if (data[4] !== expected.bits || data[5] !== 1 || machine !== expected.machine) {
    throw new Error(`Core ${filename} does not match the ${abi} architecture.`);
  }
  return data;
}

export function sideloadConfirmed(log: string, source: string, target: { user: number; packageName: string }): boolean {
  const marker = `Copying ${source} to `;
  const start = log.lastIndexOf(marker);
  if (start === -1) return false;
  const afterCopy = log.slice(start + marker.length);
  const destination = afterCopy.split(/\r?\n/, 1)[0]?.trim();
  const coreName = source.split("/").at(-1);
  if (!destination || !coreName) return false;
  const privatePath = `/data/user/${target.user}/${target.packageName}/cores/${coreName}`;
  const legacyPath = `/data/data/${target.packageName}/cores/${coreName}`;
  const sharedPath = new RegExp(`^/storage/(?:emulated/${target.user}|[a-fA-F0-9]{4}-[a-fA-F0-9]{4})/`);
  if (
    destination.split("/").some((part) => part === "." || part === "..") ||
    (destination !== privatePath && !(target.user === 0 && destination === legacyPath) &&
      !(sharedPath.test(destination) && destination.endsWith(`/${coreName}`)))
  ) return false;
  return afterCopy.includes(`Running RetroArch with core ${destination}\n`);
}

export async function installRetroArchCores(
  context: ApplicationInstallContext<Release>,
  cores: readonly Core[],
  importTimeoutMs = 30_000,
): Promise<void> {
  if (!Number.isSafeInteger(importTimeoutMs) || importTimeoutMs <= 0) throw new Error("Invalid core import timeout.");
  const { device, release, user, download, signal, log, reportProgress } = context;
  const check = () => checkAbort(signal);
  check();
  if (!cores.length) return;
  for (const core of cores) {
    coreFilename(core);
  }
  await reportProgress(0, cores.length);
  const staging = `/data/local/tmp/emukase-${crypto.randomUUID()}`;
  try {
    await device.shell(shellCommand("mkdir", "-p", staging));
    check();
    await device.shell(shellCommand("chmod", "755", staging));
    let completed = 0;
    for (const core of cores) {
      check();
      log(`Preparing ${core.name}…`);
      await context.reportStatus(`Preparing ${core.name}…`);
      let temporary: DownloadedFile | undefined;
      let data: Uint8Array;
      try {
        const url = coreUrl(release.abi, core);
        temporary = await download.file?.(url);
        const archive = temporary ? new Uint8Array(await temporary.file.arrayBuffer()) : await download(url);
        check();
        data = extractCore(archive, coreFilename(core), release.abi);
      } finally {
        await temporary?.dispose();
      }
      check();
      log(`Installing ${core.name} (${core.systems})…`);
      await context.reportStatus(`Installing ${core.name} (${core.systems})…`);
      const source = `${staging}/${coreFilename(core)}`;
      await device.push(data, source);
      check();
      await device.shell(shellCommand("chmod", "644", source));
      check();
      await device.shell(shellCommand("am", "force-stop", "--user", String(user), release.packageName));
      check();
      checkActivityStart(
        await device.shell(
          shellCommand("am", "start", "--user", String(user), "-W", "-n", `${release.packageName}/${SIDELOAD}`, "--es", "LIBRETRO", source),
        ),
      );
      const deadline = Date.now() + importTimeoutMs;
      let confirmed = false;
      while (Date.now() < deadline) {
        check();
        const output = await device.shell(shellCommand("logcat", "-d", "-v", "raw", "-s", "sideload:D", "*:S"));
        if (sideloadConfirmed(`${output.trimEnd()}\n`, source, { user, packageName: release.packageName })) {
          confirmed = true;
          break;
        }
        await pause(300);
      }
      if (!confirmed) {
        throw new Error(`RetroArch did not confirm the import of ${core.name}. Check the error on the device screen; you can run the script again.`);
      }
      check();
      await reportProgress(++completed, cores.length);
    }
  } finally {
    const cleanup = device.restorationDevice ?? device;
    await cleanup.shell(shellCommand("rm", "-rf", staging)).catch(() => {});
  }
  check();
}
