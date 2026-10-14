import type { ApplicationRelease } from "./application";
import type { Download } from "./download";
import { MAX_ARTIFACT_BYTES } from "./download-policy";
import { assertAndroidUser, readAndroidUser, userScopedDevice } from "./android-user";
import { withAwakeDevice } from "./device-awake";
import { keepDeviceAwake, type DeviceAwakeLease } from "./device-keep-awake";
import { checkAbort, type SetupEvent, type SetupStage } from "./setup-events";
import { shellCommand, type DeviceTransport } from "./transport";

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
  run(context: ApplicationInstallContext<T>): Promise<void>;
}

export interface ApplicationInstallOptions<T extends ApplicationRelease = ApplicationRelease> {
  signal?: AbortSignal;
  log?: (message: string) => void;
  onEvent?: (event: SetupEvent) => void | Promise<void>;
  extraSteps?: readonly ApplicationExtraStep<T>[];
  install?: (context: ApplicationInstallContext<T>, apk: Uint8Array) => Promise<void>;
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

async function verifyApk(apk: Uint8Array, release: ApplicationRelease, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  if (!(apk instanceof Uint8Array) || apk.byteLength < 4 || apk.byteLength > MAX_ARTIFACT_BYTES ||
    apk[0] !== 0x50 || apk[1] !== 0x4b || apk[2] !== 0x03 || apk[3] !== 0x04) {
    throw new Error("The download does not have an APK ZIP header.");
  }
  if (release.apkSize !== undefined && apk.byteLength !== release.apkSize) {
    throw new Error("The APK does not match its expected size.");
  }
  if (release.sha256 !== undefined) {
    if (!(apk.buffer instanceof ArrayBuffer)) throw new Error("APK verification requires an ArrayBuffer.");
    const bytes = new Uint8Array(apk.buffer, apk.byteOffset, apk.byteLength);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const actual = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== release.sha256.toLowerCase()) throw new Error("The APK does not match its expected SHA-256.");
  }
  checkAbort(signal);
}

async function installApk<T extends ApplicationRelease>(
  context: ApplicationInstallContext<T>, apk: Uint8Array, install?: ApplicationInstallOptions<T>["install"],
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
    else await device.install(apk, user);
  });
}

export async function installApplication<T extends ApplicationRelease>(
  device: DeviceTransport,
  release: T,
  download: Download,
  options: ApplicationInstallOptions<T> = {},
): Promise<void> {
  validateRelease(release);
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
  let apk: Uint8Array | undefined;
  let awake: DeviceAwakeLease | undefined;
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
    awake = await keepDeviceAwake(scoped, user, { signal: options.signal, log });
    await emit({ stage, status: "complete" });

    stage = "download";
    await emit({ stage, status: "running" });
    check();
    log(`Downloading ${release.name} ${release.version}…`);
    apk = await download(release.apkUrl);
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
    await installApk(context(stage), apk, options.install);
    apk = undefined;
    check();
    const installed = await scoped.shell(shellCommand("pm", "path", "--user", String(user), release.packageName));
    if (!installed.trim().split(/\r?\n/).every((path) => /^package:\/[^\x00-\x1f]+\.apk$/.test(path))) {
      throw new Error(`Android did not confirm the ${release.name} installation.`);
    }
    check();
    await emit({ stage, status: "complete" });

    for (const step of extraSteps) {
      check();
      stage = `extra:${step.id}`;
      await emit({ stage, status: "running" });
      check();
      await step.run(context(stage));
      check();
      await emit({ stage, status: "complete" });
    }
    check();
    log(`Installed: ${release.name} ${release.version}.`);
  } catch (error) {
    await emit({ stage, status: "failed" });
    throw error;
  } finally {
    apk = undefined;
    await awake?.release();
  }
}
