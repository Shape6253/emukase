import { sha256 } from "@noble/hashes/sha2.js";
import { matchesApplicationVersion, type ApplicationRelease } from "./application";
import type { Download, DownloadedFile } from "./download";
import { MAX_ARTIFACT_BYTES } from "./download-policy";
import { assertAndroidUser, readAndroidUser, userScopedDevice } from "./android-user";
import { readAndroidPackage } from "./android-package";
import { withAwakeDevice } from "./device-awake";
import { keepDeviceAwake, type DeviceAwakeLease } from "./device-keep-awake";
import { checkAbort, type SetupEvent, type SetupStage } from "./setup-events";
import { shellCommand, type Apk, type DeviceTransport } from "./transport";

export interface ApplicationInstallContext<T extends ApplicationRelease = ApplicationRelease> {
  device: DeviceTransport;
  release: T;
  user: number;
  download: Download;
  signal?: AbortSignal;
  log: (message: string) => void;
  reportProgress: (completed: number, total: number) => void | Promise<void>;
  reportStatus: (message: string) => void | Promise<void>;
}

export interface ApplicationExtraStep<T extends ApplicationRelease = ApplicationRelease> {
  id: string;
  label: string;
  preflight?(context: ApplicationInstallContext<T>): Promise<void>;
  run(context: ApplicationInstallContext<T>): Promise<void | { status: "skipped"; message: string }>;
}

export interface ApplicationInstallOptions<T extends ApplicationRelease = ApplicationRelease> {
  signal?: AbortSignal;
  log?: (message: string) => void;
  onEvent?: (event: SetupEvent) => void | Promise<void>;
  extraSteps?: readonly ApplicationExtraStep<T>[];
  /** Installer attribution for APKs installed by this run. */
  installerPackageName?: string;
  install?: (context: ApplicationInstallContext<T>, apk: Apk) => Promise<void>;
}

export const APPLICATION_INSTALL_STAGES: readonly { id: SetupStage; label: string }[] = [
  { id: "prepare", label: "Check device" },
  { id: "download", label: "Download APK" },
  { id: "verify", label: "Check APK download" },
  { id: "install", label: "Install APK" },
];

function validateRelease(release: ApplicationRelease): void {
  if (!release.name.trim() || !release.version.trim() || /[\x00-\x1f]/.test(release.name + release.version)) {
    throw new Error("Application name and version are required.");
  }
  if (release.versionNameAliases !== undefined && (!Array.isArray(release.versionNameAliases) ||
    release.versionNameAliases.length > 10 || release.versionNameAliases.some((version: unknown) =>
      typeof version !== "string" || !version.trim() || /[\x00-\x1f]/.test(version)))) {
    throw new Error("Invalid Android version name aliases.");
  }
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(release.packageName)) {
    throw new Error("Invalid Android package name.");
  }
  const url = new URL(release.apkUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.href !== release.apkUrl) {
    throw new Error("The APK must have a canonical HTTPS source URL.");
  }
  if (release.sha256 !== undefined && !/^[a-f\d]{64}$/i.test(release.sha256)) {
    throw new Error("Invalid published APK SHA-256.");
  }
  if (release.apkSize !== undefined && (!Number.isSafeInteger(release.apkSize) ||
    release.apkSize < 4 || release.apkSize > MAX_ARTIFACT_BYTES)) {
    throw new Error("Invalid published APK size.");
  }
}

async function verifyApk(apk: Apk, release: ApplicationRelease, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  if (!(apk instanceof Uint8Array) && !(apk instanceof Blob)) throw new Error("Invalid APK download.");
  const size = apk instanceof Uint8Array ? apk.byteLength : apk.size;
  const header = apk instanceof Uint8Array ? apk : new Uint8Array(await apk.slice(0, 4).arrayBuffer());
  if (size < 4 || size > MAX_ARTIFACT_BYTES ||
    header[0] !== 0x50 || header[1] !== 0x4b || header[2] !== 0x03 || header[3] !== 0x04) {
    throw new Error("The download does not have an APK ZIP header.");
  }
  if (release.apkSize !== undefined && size !== release.apkSize) {
    throw new Error("The APK does not match its expected size.");
  }
  if (release.sha256 !== undefined) {
    const hash = sha256.create();
    try {
      for (let offset = 0; offset < size; offset += 64 * 1024) {
        checkAbort(signal);
        const end = Math.min(offset + 64 * 1024, size);
        const bytes = apk instanceof Uint8Array
          ? apk.subarray(offset, end)
          : new Uint8Array(await apk.slice(offset, end).arrayBuffer());
        hash.update(bytes);
      }
      const actual = Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (actual !== release.sha256.toLowerCase()) throw new Error("The APK does not match its expected SHA-256.");
    } finally {
      hash.destroy();
    }
  }
  checkAbort(signal);
}

async function installApk<T extends ApplicationRelease>(
  context: ApplicationInstallContext<T>, apk: Apk, install?: ApplicationInstallOptions<T>["install"],
  installerPackageName?: string,
): Promise<void> {
  const { device, user, signal, reportStatus } = context;
  const message = "Installing the APK…";
  await withAwakeDevice(device, user, {
    signal,
    onUnlockRequired(required) {
      if (signal?.aborted) return;
      return reportStatus(required ? "Unlock your Android device to install the APK." : message);
    },
  }, async () => {
    await reportStatus(message);
    if (install) await install(context, apk);
    else await device.install(apk, user, installerPackageName);
  });
}

export async function installApplication<T extends ApplicationRelease>(
  device: DeviceTransport,
  release: T,
  download: Download,
  options: ApplicationInstallOptions<T> = {},
): Promise<void> {
  validateRelease(release);
  const installerPackageName = options.installerPackageName;
  if (installerPackageName !== undefined && (typeof installerPackageName !== "string" || installerPackageName.length >= 255 ||
    !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(installerPackageName))) {
    throw new Error("Invalid Android installer package name.");
  }
  const extraSteps = options.extraSteps?.slice() ?? [];
  const ids = new Set<string>();
  for (const step of extraSteps) {
    if (!/^[a-z][a-z\d-]*$/.test(step.id) || !step.label.trim() || ids.has(step.id)) {
      throw new Error("Extra installation steps require unique IDs and labels.");
    }
    ids.add(step.id);
  }
  const log = options.log ?? (() => {});
  const emit = options.onEvent ?? (() => {});
  const check = () => checkAbort(options.signal);
  check();
  let stage: SetupStage = "prepare";
  let apk: Apk | undefined;
  let temporary: DownloadedFile | undefined;
  let awake: DeviceAwakeLease | undefined;
  const failures: unknown[] = [];
  try {
    await emit({ stage, status: "running" });
    check();
    const user = await readAndroidUser(device, options.signal);
    const scoped = userScopedDevice(device, user, options.signal);
    const context = (progressStage: SetupStage): ApplicationInstallContext<T> => ({
      device: scoped, release, user, download, signal: options.signal, log,
      reportProgress(completed, total) {
        check();
        if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || completed < 0 || total < completed) {
          throw new Error("Invalid setup progress.");
        }
        return emit({ stage: progressStage, status: "running", completed, total });
      },
      reportStatus(message) {
        check();
        if (!message.trim() || message.length > 2048 || /[\x00-\x1f]/.test(message)) {
          throw new Error("Invalid setup status message.");
        }
        return emit({ stage: progressStage, status: "running", message });
      },
    });
    for (const step of extraSteps) {
      check();
      await step.preflight?.(context(stage));
      check();
    }
    await assertAndroidUser(scoped, user, options.signal);
    if (installerPackageName !== undefined) {
      const installer = await readAndroidPackage(scoped, installerPackageName, user, options.signal);
      if (!installer) throw new Error("The requested update installer is not installed in this Android profile.");
    }
    const installed = await readAndroidPackage(scoped, release.packageName, user, options.signal);
    const alreadyInstalled = installed !== undefined && matchesApplicationVersion(release, installed.version);
    if (installed) log(`Found ${release.name} ${installed.version} in Android profile ${user}.`);
    awake = await keepDeviceAwake(scoped, user, { signal: options.signal, log });
    await emit({ stage, status: "complete" });

    if (alreadyInstalled) {
      const message = `${release.name} ${installed.version} is already installed in this profile.`;
      log(`${message} Skipping APK download and installation.`);
      for (const skipped of ["download", "verify", "install"] as const) {
        check();
        stage = skipped;
        await emit({ stage, status: "skipped", message });
      }
    } else {
      stage = "download";
      await emit({ stage, status: "running" });
      check();
      log(`Downloading ${release.name} ${release.version}…`);
      if (download.file) {
        temporary = await download.file(release.apkUrl);
        apk = temporary.file;
      } else {
        apk = await download(release.apkUrl);
      }
      check();
      await emit({ stage, status: "complete" });

      stage = "verify";
      await emit({ stage, status: "running" });
      await verifyApk(apk, release, options.signal);
      if (!release.sha256) log("No published SHA-256; Android verifies APK signatures.");
      await emit({ stage, status: "complete" });

      stage = "install";
      await emit({ stage, status: "running" });
      check();
      log(`Installing ${release.name}…`);
      await installApk(context(stage), apk, options.install, installerPackageName);
      apk = undefined;
      await temporary?.dispose();
      temporary = undefined;
      check();
      const paths = await scoped.shell(shellCommand("pm", "path", "--user", String(user), release.packageName));
      if (!paths.trim().split(/\r?\n/).every((path) => /^package:\/[^\x00-\x1f]+\.apk$/.test(path))) {
        throw new Error(`Android did not confirm the ${release.name} installation.`);
      }
      if (installerPackageName !== undefined) {
        const confirmed = await readAndroidPackage(scoped, release.packageName, user, options.signal);
        if (!confirmed) throw new Error(`Android did not confirm the ${release.name} installation.`);
        if (confirmed.installer === undefined) {
          log(`Android reported no update installer for ${release.name}; continuing setup.`);
        } else if (confirmed.installer !== installerPackageName) {
          throw new Error(`Android did not confirm the requested update installer for ${release.name}.`);
        } else {
          log(`Confirmed ${installerPackageName} as the update installer for ${release.name}.`);
        }
      }
      check();
      await emit({ stage, status: "complete" });
    }

    for (const step of extraSteps) {
      check();
      stage = `extra:${step.id}`;
      await emit({ stage, status: "running" });
      check();
      const result = await step.run(context(stage));
      check();
      await emit(result ? { stage, ...result } : { stage, status: "complete" });
    }
    check();
    log(`Installed: ${release.name} ${release.version}.`);
  } catch (error) {
    failures.push(error);
    try {
      await emit({ stage, status: "failed" });
    } catch (eventError) {
      failures.push(eventError);
    }
  } finally {
    apk = undefined;
    try {
      await temporary?.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      await awake?.release();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, failures.map((error) => error instanceof Error ? error.message : String(error)).join("\n"));
  }
}
