import { installApplication, type ApplicationInstallOptions } from "./application-install";
import type { ApplicationExtraStep } from "./application-install";
import { withAdbInstallVerifier } from "./adb-install-verifier";
import { grantPackagePermissions, readAndroidPackage } from "./android-package";
import { assignAndroidPackageInstaller } from "./android-package-installer";
import { matchesApplicationVersion } from "./application";
import { BUILDBOT, coreFilename, type Core, type Release } from "./catalog";
import type { Download } from "./download";
import { createRetroArchSteps } from "./retroarch";
import { checkRetroArchAssets, type RetroArchAssetExtraction } from "./retroarch-assets";
import { installRetroArchCores } from "./retroarch-cores";
import type { SetupStage } from "./setup-events";
import type { DeviceTransport } from "./transport";

export const RETROARCH_SETUP_STAGES = [
  { id: "retroarch-download", label: "Download RetroArch APK" },
  { id: "retroarch-verify", label: "Check RetroArch APK" },
  { id: "retroarch-install", label: "Install RetroArch" },
  { id: "retroarch-permissions", label: "Verify RetroArch permissions" },
  { id: "retroarch-installer", label: "Link RetroArch to Obtainium" },
  { id: "retroarch-launch", label: "Verify RetroArch first launch" },
  { id: "retroarch-cores", label: "Install RetroArch cores" },
] as const;

export interface RetroArchInstallOptions extends Pick<ApplicationInstallOptions<Release>, "signal" | "log" | "onEvent"> {
  cores?: readonly Core[];
  coreDownload?: Download;
  installerPackageName?: string;
}

export interface RetroArchInstallResult {
  assetExtraction: RetroArchAssetExtraction;
}

export async function installRetroArch(
  device: DeviceTransport,
  release: Release,
  download: Download,
  options: RetroArchInstallOptions = {},
): Promise<RetroArchInstallResult> {
  if (!["arm64-v8a", "armeabi-v7a", "x86_64", "x86"].includes(release.abi)) {
    throw new Error("RetroArch architecture is not supported.");
  }
  const expectedPackage = release.abi === "arm64-v8a" || release.abi === "x86_64"
    ? "com.retroarch.aarch64" : "com.retroarch.ra32";
  const filename = expectedPackage === "com.retroarch.aarch64" ? "RetroArch_aarch64.apk" : "RetroArch_ra32.apk";
  if (release.name !== "RetroArch" || release.packageName !== expectedPackage
    || !/^\d+\.\d+\.\d+$/.test(release.version)
    || release.apkUrl !== `${BUILDBOT}/stable/${release.version}/android/${filename}`) {
    throw new Error("RetroArch installation requires the official stable APK for this architecture.");
  }
  const cores = options.cores?.slice() ?? [];
  const installerPackageName = options.installerPackageName;
  for (const core of cores) coreFilename(core);
  const startup = createRetroArchSteps()[0];
  if (!startup) throw new Error("RetroArch startup verification is unavailable.");
  let assetExtraction: RetroArchAssetExtraction = "unavailable";
  const application = { ...release, versionNameAliases: [`${release.version}_GIT`] };
  await installApplication(device, application, download, {
    signal: options.signal,
    log: options.log,
    installerPackageName,
    onEvent(event) {
      if (event.stage === "prepare") return options.onEvent?.(event);
      const id = event.stage.startsWith("extra:") ? event.stage.slice(6) : event.stage;
      const stage: SetupStage = `extra:retroarch-${id}`;
      return options.onEvent?.({ ...event, stage });
    },
    async install(context, apk) {
      await withAdbInstallVerifier(context.device, context.user, async () => {
        await context.device.install(apk, context.user, installerPackageName);
        const installed = await readAndroidPackage(context.device, release.packageName, context.user, context.signal);
        if (!installed || !matchesApplicationVersion(application, installed.version)) {
          throw new Error("Android did not confirm the expected RetroArch version in this profile.");
        }
      }, { signal: context.signal, log: context.log });
    },
    extraSteps: [
      {
        id: "permissions", label: "Verify RetroArch permissions",
        async run(context) {
          await grantPackagePermissions(context.device, release.packageName, context.user,
            ["android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE"], context.signal);
        },
      },
      ...(installerPackageName === undefined ? [] : [{
        id: "installer", label: "Assign RetroArch update installer",
        run(context) {
          return assignAndroidPackageInstaller(context.device, release.packageName, installerPackageName, context.user, {
            signal: context.signal, log: context.log,
          });
        },
      } satisfies ApplicationExtraStep<Release>]),
      {
        ...startup,
        async run(context) {
          await startup.run(context);
          assetExtraction = await checkRetroArchAssets(context);
          if (assetExtraction === "unavailable") {
            const message = "RetroArch is installed and its first launch is verified. Asset extraction could not be verified because its config is unavailable to ADB in this profile. Check it on the device.";
            context.log(message);
            return;
          }
          context.log("RetroArch asset extraction is confirmed by its current process's config.");
        },
      },
      ...(cores.length ? [{
        id: "cores", label: "Install RetroArch cores",
        async run(context) {
          // APK prefetch limits file access to the APK; its callable path can still fetch cores.
          const coreDownload = options.coreDownload ?? ((url: string) => download(url));
          await installRetroArchCores({ ...context, download: coreDownload }, cores);
          await startup.run(context);
        },
      } satisfies ApplicationExtraStep<Release>] : []),
    ],
  });
  return { assetExtraction };
}
