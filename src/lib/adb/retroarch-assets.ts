import type { ApplicationInstallContext } from "./application-install";
import { androidUserProcessPid } from "./android-user";
import type { Release } from "./catalog";
import { readRetroArchConfig, startupAssetsReady, startupConfigPath } from "./retroarch";
import { checkAbort } from "./setup-events";
import { shellCommand } from "./transport";

export type RetroArchAssetExtraction = "verified" | "unavailable";

export async function checkRetroArchAssets(
  context: ApplicationInstallContext<Release>, timeoutMs = 120_000,
): Promise<RetroArchAssetExtraction> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid asset extraction timeout.");
  const { device, release, user, signal } = context;
  const pid = await androidUserProcessPid(device, release.packageName, user, signal);
  if (!pid) throw new Error("RetroArch stopped before its asset extraction could be checked.");
  const log = await device.shell(shellCommand("logcat", "-d", "-v", "threadtime", "-s", "RetroArch:I", "*:S"));
  checkAbort(signal);
  const path = startupConfigPath(log, pid, user, release.packageName);
  if (!path) return "unavailable";
  const deadline = Date.now() + timeoutMs;
  do {
    checkAbort(signal);
    const config = await readRetroArchConfig(device, path, signal);
    if (await androidUserProcessPid(device, release.packageName, user, signal) !== pid) {
      throw new Error("RetroArch stopped or restarted while its asset extraction was being checked.");
    }
    if (config === undefined) return "unavailable";
    if (startupAssetsReady(config)) return "verified";
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(500, remaining)));
  } while (Date.now() < deadline);
  throw new Error("RetroArch asset extraction did not finish. Check the app on the device.");
}
