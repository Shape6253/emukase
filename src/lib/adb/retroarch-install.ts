import { installApplication, type ApplicationInstallOptions } from "./application-install";
import { withAdbInstallVerifier } from "./adb-install-verifier";
import { grantPackagePermissions, readAndroidPackage } from "./android-package";
import { BUILDBOT, type Release } from "./catalog";
import type { Download } from "./download";
import { createRetroArchSteps } from "./retroarch";
import { checkRetroArchAssets, type RetroArchAssetExtraction } from "./retroarch-assets";
import type { SetupStage } from "./setup-events";
import type { DeviceTransport } from "./transport";

export const RETROARCH_SETUP_STAGES = [
  { id: "retroarch-prepare", label: "Check RetroArch startup support" },
  { id: "retroarch-download", label: "Download RetroArch APK" },
  { id: "retroarch-verify", label: "Check RetroArch APK" },
  { id: "retroarch-install", label: "Install RetroArch" },
  { id: "retroarch-permissions", label: "Verify RetroArch permissions" },
  { id: "retroarch-launch", label: "Verify RetroArch first launch" },
  { id: "retroarch-assets", label: "Check RetroArch asset extraction" },
] as const;

export interface RetroArchInstallResult {
  assetExtraction: RetroArchAssetExtraction;
}

export async function installRetroArch(
  device: DeviceTransport,
  release: Release,
  download: Download,
  options: Pick<ApplicationInstallOptions<Release>, "signal" | "log" | "onEvent"> = {},
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
  let assetExtraction: RetroArchAssetExtraction = "unavailable";
  await installApplication(device, release, download, {
    signal: options.signal,
    log: options.log,
    onEvent(event) {
      const id = event.stage.startsWith("extra:") ? event.stage.slice(6) : event.stage;
      const stage: SetupStage = `extra:retroarch-${id}`;
      return options.onEvent?.({ ...event, stage });
    },
    async install(context, apk) {
      await withAdbInstallVerifier(context.device, context.user, async () => {
        await context.device.install(apk, context.user);
        const installed = await readAndroidPackage(context.device, release.packageName, context.user, context.signal);
        if (!installed || ![release.version, `${release.version}_GIT`].includes(installed.version)) {
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
      ...createRetroArchSteps(),
      {
        id: "assets", label: "Check RetroArch asset extraction",
        async run(context) {
          assetExtraction = await checkRetroArchAssets(context);
          if (assetExtraction === "unavailable") {
            const message = "RetroArch is installed and its first launch is verified. Asset extraction could not be verified because its config is unavailable to ADB in this profile. Check it on the device.";
            context.log(message);
            return { status: "skipped", message };
          }
          context.log("RetroArch asset extraction is confirmed by its current process's config.");
        },
      },
    ],
  });
  return { assetExtraction };
}
