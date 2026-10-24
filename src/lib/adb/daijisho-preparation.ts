import { installedAndroidPackages } from "./android-package";
import { primaryStorageForUser } from "./android-user";
import { selectCores, type Abi } from "./catalog";
import { loadDaijishoProfile, validateDaijishoPlatformIds, type DaijishoProfile } from "./daijisho-profiles";
import { retroArchPackageName } from "./emulators";
import type { ConfigurationItemState } from "./emulator-configuration-types";
import { LIBRARY_PLATFORMS } from "./library-catalog";
import { readRetroArchConfig } from "./retroarch";
import { shellCommand, type DeviceTransport } from "./transport";

export interface DaijishoPlatformConfiguration {
  platformId: string;
  emulatorPackage?: string;
  coreId?: string;
  romDirectory: string;
  profile: ConfigurationItemState;
  folder: ConfigurationItemState;
  state: ConfigurationItemState;
  reason?: string;
}

export interface DaijishoPlatformPlan {
  profile?: DaijishoProfile;
  result: DaijishoPlatformConfiguration;
}

export interface DaijishoPreparationOptions {
  platformIds?: readonly string[];
  signal?: AbortSignal;
  log?: (message: string) => void;
}

/** Prepare routing without opening or requiring an installed Daijishō app. */
export async function prepareDaijishoPlatforms(
  device: DeviceTransport, user: number, abi: Abi, romDirectory: string, options: DaijishoPreparationOptions = {},
): Promise<DaijishoPlatformPlan[]> {
  validateDaijishoPlatformIds(options.platformIds);
  const packages = await installedAndroidPackages(device, user, options.signal);
  const retroarchAbi = !packages.has(retroArchPackageName(abi)) && packages.has("com.retroarch.ra32")
    ? (abi === "x86_64" ? "x86" : "armeabi-v7a") : abi;
  const systems = LIBRARY_PLATFORMS.filter((platform) => options.platformIds ? options.platformIds.includes(platform.id)
    : platform.emulatorPackages.some((name) => packages.has(name)));
  if (!systems.length) throw new Error("Install a supported Library emulator before configuring Daijishō.");
  const cores = selectCores(retroarchAbi);
  const activities = new Map<string, Promise<string>>();
  const configs = new Map<string, ReturnType<typeof readRetroArchConfig>>();
  return Promise.all(systems.map(async (platform): Promise<DaijishoPlatformPlan> => {
    options.signal?.throwIfAborted();
    const emulatorPackage = platform.cores.length ? retroArchPackageName(retroarchAbi) : platform.emulatorPackages[0];
    const coreId = cores.find((core) => platform.cores.includes(core.id))?.id;
    const result: DaijishoPlatformConfiguration = { platformId: platform.id, emulatorPackage, coreId,
      romDirectory: `${romDirectory}/${platform.id}`, profile: "unverified", folder: "unverified", state: "missing" };
    if (!emulatorPackage || !packages.has(emulatorPackage)) return { result: { ...result, reason: "Emulator is not installed in this Android profile." } };
    options.log?.(`Preparing Daijishō: ${platform.name}…`);
    try {
      const profile = await loadDaijishoProfile(platform.id, emulatorPackage, user, coreId, options.signal);
      let activity = activities.get(profile.component);
      if (!activity) {
        activity = device.shell(shellCommand("cmd", "package", "resolve-activity", "--brief", "--user", String(user), "-n", profile.component));
        activities.set(profile.component, activity);
      }
      const resolved = await activity;
      const short = profile.component.replace(`${emulatorPackage}/${emulatorPackage}.`, `${emulatorPackage}/.`);
      if (!resolved.trim().split(/\r?\n/).some((line) => [profile.component, short].includes(line))) throw new Error("The upstream player activity is unavailable on this device.");
      if (coreId) {
        let config = configs.get(emulatorPackage);
        if (!config) {
          config = readRetroArchConfig(device, `${primaryStorageForUser(user)}/Android/data/${emulatorPackage}/files/retroarch.cfg`, options.signal);
          configs.set(emulatorPackage, config);
        }
        if (!await config) throw new Error("RetroArch's config is unavailable; finish its setup first.");
      }
      return { profile, result };
    } catch (error) {
      options.signal?.throwIfAborted();
      return { result: { ...result, reason: error instanceof Error ? error.message : "The upstream platform definition is unavailable." } };
    }
  }));
}
