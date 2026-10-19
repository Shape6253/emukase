import { installedAndroidPackages, readAndroidPackage } from "./android-package";
import { withAndroidUiDump } from "./android-ui-dump";
import { primaryStorageForUser, readAndroidUser, userScopedDevice } from "./android-user";
import { selectAbi, selectCores } from "./catalog";
import { importDaijishoProfile, inspectDaijishoFolder, inspectDaijishoProfile } from "./daijisho-library";
import { DAIJISHO_PACKAGE, launchDaijisho, readDaijishoLabels, restartDaijisho, type DaijishoUiContext } from "./daijisho-navigation";
import { loadDaijishoProfile, validateDaijishoPlatformIds, type DaijishoProfile } from "./daijisho-profiles";
import { keepDeviceAwake } from "./device-keep-awake";
import { withAwakeDevice } from "./device-awake";
import { retroArchPackageName } from "./emulators";
import type { ConfigurationItemState, EmulatorConfigurationOptions } from "./emulator-configuration-types";
import { LIBRARY_PLATFORMS } from "./library-catalog";
import { createMediaStoreFolders, queryMediaStoreFiles } from "./media-store";
import { uploadMediaStoreFile } from "./media-store-upload";
import { getObtainiumTrackedApps } from "./obtainium-catalog";
import { installApplicationViaObtainium } from "./obtainium-install";
import { readRetroArchConfig } from "./retroarch";
import { shellCommand, type DeviceTransport } from "./transport";
import { workspacePaths } from "./workspace";

export interface DaijishoSetupOptions extends Pick<EmulatorConfigurationOptions, "folders" | "signal" | "onStatus" | "onUnlockRequired"> {
  log?: (message: string) => void;
  /** Omitted means all Library platforms with an installed emulator. */
  platformIds?: readonly string[];
}

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

export interface DaijishoConfigurationResult {
  /** Saved routing profiles and folder grants, not a completed ROM scan. */
  library: ConfigurationItemState;
  romDirectory: string;
  platforms: readonly DaijishoPlatformConfiguration[];
  /** Native routing/settings readback does not certify emulator prerequisites or gameplay. */
  gameplayVerified: false;
}

async function stageProfile(context: DaijishoUiContext, profile: DaijishoProfile, directory: string): Promise<string> {
  const bytes = new TextEncoder().encode(profile.json);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const path = `${directory}/${profile.platformId}-${hash}.json`;
  const records = await queryMediaStoreFiles(context.device, context.user, directory, context.signal);
  if (!records.some((record) => record.path === path)) {
    await uploadMediaStoreFile(context.device, context.user, directory,
      new File([profile.json], path.slice(path.lastIndexOf("/") + 1), { type: "application/json" }), { signal: context.signal, mimeType: "application/json" });
  }
  const uploaded = (await queryMediaStoreFiles(context.device, context.user, directory, context.signal)).filter((record) => record.path === path);
  const record = uploaded[0];
  if (uploaded.length !== 1 || !record || record.bytes !== bytes.length) throw new Error("Daijishō's import file was not confirmed.");
  const read = shellCommand("content", "read", "--user", String(context.user), "--uri", `content://media/external/file/${record.id}`);
  const digest = await context.device.shell(`${read} | ${shellCommand("sha256sum")}`);
  if (digest.trim().split(/\s+/)[0] !== hash) throw new Error("Daijishō's import file differs from the generated profile; it was not overwritten.");
  return path;
}

async function inspectPlatform(context: DaijishoUiContext, profile: DaijishoProfile, directory: string, staging: string, configure: boolean): Promise<DaijishoPlatformConfiguration> {
  let inspected = await inspectDaijishoProfile(context, profile);
  if (!inspected.exists && configure) {
    await importDaijishoProfile(context, await stageProfile(context, profile, staging));
    inspected = await inspectDaijishoProfile(context, profile);
    if (!inspected.accepted) throw new Error(`Daijishō did not retain the imported profile for ${profile.name}. ${inspected.reason ?? ""}`);
  }
  const folder = inspected.accepted && await inspectDaijishoFolder(context, profile, directory, configure);
  return { platformId: profile.platformId, emulatorPackage: profile.emulatorPackage, coreId: profile.coreId, romDirectory: directory,
    profile: inspected.accepted ? "accepted" : "missing", folder: !inspected.accepted ? "unverified" : folder ? "accepted" : "missing", state: inspected.accepted && folder ? "accepted" : "missing",
    ...(!inspected.accepted ? { reason: inspected.reason } : !folder ? { reason: "The ROM path or its persisted read/write permission is missing. Existing paths were preserved." } : {}) };
}

async function runDaijisho(device: DeviceTransport, options: DaijishoSetupOptions, configure: boolean): Promise<DaijishoConfigurationResult> {
  validateDaijishoPlatformIds(options.platformIds);
  const user = await readAndroidUser(device, options.signal);
  const scoped = userScopedDevice(device, user, options.signal);
  const sdk = (await scoped.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
  if (!/^[1-9]\d*$/.test(sdk) || !Number.isSafeInteger(Number(sdk)) || Number(sdk) < 26) throw new Error("Daijishō configuration requires Android 8 or newer.");
  if (configure && Number(sdk) < 30) throw new Error("Uploading Daijishō's JSON profiles through MediaStore requires Android 11 or newer.");
  if (!await readAndroidPackage(scoped, DAIJISHO_PACKAGE, user, options.signal)) throw new Error("Install Daijishō before configuring it.");
  const abi = selectAbi((await scoped.shell(shellCommand("getprop", "ro.product.cpu.abilist"))).trim().split(","));
  const packages = await installedAndroidPackages(scoped, user, options.signal);
  const retroarchAbi = !packages.has(retroArchPackageName(abi)) && packages.has("com.retroarch.ra32")
    ? (abi === "x86_64" ? "x86" : "armeabi-v7a") : abi;
  const paths = workspacePaths(primaryStorageForUser(user), options.folders);
  const systems = LIBRARY_PLATFORMS.filter((platform) => options.platformIds ? options.platformIds.includes(platform.id)
    : platform.emulatorPackages.some((name) => packages.has(name)));
  if (!systems.length) throw new Error("Install a supported Library emulator before configuring Daijishō.");
  const cores = selectCores(retroarchAbi);
  const plans = await Promise.all(systems.map(async (platform) => {
    const emulatorPackage = platform.cores.length ? retroArchPackageName(retroarchAbi) : platform.emulatorPackages[0];
    const coreId = cores.find((core) => platform.cores.includes(core.id))?.id;
    const result: DaijishoPlatformConfiguration = { platformId: platform.id, emulatorPackage, coreId, romDirectory: `${paths.roms}/${platform.id}`,
      profile: "unverified", folder: "unverified", state: "missing" };
    if (!emulatorPackage || !packages.has(emulatorPackage)) return { result: { ...result, reason: "Emulator is not installed in this Android profile." } };
    options.onStatus?.(`Preparing Daijishō: ${platform.name}…`);
    try {
      const profile = await loadDaijishoProfile(platform.id, emulatorPackage, user, coreId, options.signal);
      const resolved = await scoped.shell(shellCommand("cmd", "package", "resolve-activity", "--brief", "--user", String(user), "-n", profile.component));
      const short = profile.component.replace(`${emulatorPackage}/${emulatorPackage}.`, `${emulatorPackage}/.`);
      if (!resolved.trim().split(/\r?\n/).some((line) => [profile.component, short].includes(line))) throw new Error("The upstream player activity is unavailable on this device.");
      if (coreId && !await readRetroArchConfig(scoped, `${primaryStorageForUser(user)}/Android/data/${emulatorPackage}/files/retroarch.cfg`, options.signal)) {
        throw new Error("RetroArch's config is unavailable; finish its setup first.");
      }
      return { profile, result };
    } catch (error) {
      options.signal?.throwIfAborted();
      return { result: { ...result, reason: error instanceof Error ? error.message : "The upstream platform definition is unavailable." } };
    }
  }));
  if (!plans.some((plan) => plan.profile)) return { library: "missing", romDirectory: paths.roms,
    platforms: plans.map((plan) => plan.result), gameplayVerified: false };
  const lease = await keepDeviceAwake(scoped, user, { signal: options.signal, log: options.log });
  try {
    return await withAwakeDevice(scoped, user, options, (ensureUnlocked) => withAndroidUiDump(scoped, options.signal, async () => {
      const base = { device: scoped, user, signal: options.signal, ensureUnlocked };
      let changed = false;
      const context: DaijishoUiContext = { ...base, labels: await readDaijishoLabels(base), onMutation: () => { changed = true; } };
      await launchDaijisho(context);
      await restartDaijisho(context);
      const staging = `${paths.setup}/Daijisho`;
      if (configure) await createMediaStoreFolders(scoped, user, [staging, ...plans.filter((plan) => plan.profile).map((plan) => plan.result.romDirectory)], options.signal);
      const inspect = async (apply: boolean): Promise<DaijishoPlatformConfiguration[]> => {
        const results: DaijishoPlatformConfiguration[] = [];
        for (const plan of plans) {
          options.signal?.throwIfAborted();
          options.onStatus?.(`${apply ? "Configuring" : "Checking"} Daijishō: ${plan.result.platformId}…`);
          results.push(plan.profile ? await inspectPlatform(context, plan.profile, plan.result.romDirectory, staging, apply) : plan.result);
        }
        return results;
      };
      let platforms = await inspect(configure);
      if (configure && changed) {
        options.onStatus?.("Restarting Daijishō and checking its saved profiles and ROM folders…");
        await restartDaijisho(context);
        platforms = await inspect(false);
      }
      return { library: platforms.every((platform) => platform.state === "accepted") ? "accepted" : "missing", romDirectory: paths.roms, platforms, gameplayVerified: false };
    }));
  } finally { await lease.release(); }
}

/** Import missing profiles and paths only; never reset user data or assign the system launcher. */
export async function configureDaijisho(device: DeviceTransport, options: DaijishoSetupOptions = {}): Promise<DaijishoConfigurationResult> {
  return runDaijisho(device, options, true);
}

export async function verifyDaijisho(device: DeviceTransport, options: DaijishoSetupOptions = {}): Promise<DaijishoConfigurationResult> {
  return runDaijisho(device, options, false);
}

export async function setupDaijisho(device: DeviceTransport, options: DaijishoSetupOptions = {}): Promise<DaijishoConfigurationResult> {
  validateDaijishoPlatformIds(options.platformIds);
  const user = await readAndroidUser(device, options.signal);
  const scoped = userScopedDevice(device, user, options.signal);
  const sdk = Number((await scoped.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim());
  const abi = selectAbi((await scoped.shell(shellCommand("getprop", "ro.product.cpu.abilist"))).trim().split(","));
  workspacePaths(primaryStorageForUser(user), options.folders);
  if (!Number.isSafeInteger(sdk) || sdk < 30) throw new Error("Automatic Daijishō setup requires Android 11 or newer for JSON file uploads.");
  const app = getObtainiumTrackedApps(abi, { sdk }).find((entry) => entry.id === DAIJISHO_PACKAGE);
  if (!app) throw new Error("Daijishō's official update source does not support this device.");
  await installApplicationViaObtainium(scoped, app, { signal: options.signal, importSource: true, log: options.log,
    reportStatus(message, status) { options.onStatus?.(message); if (status?.unlockRequired !== undefined) options.onUnlockRequired?.(status.unlockRequired); } });
  return configureDaijisho(scoped, options);
}
