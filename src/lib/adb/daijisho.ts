import { readAndroidPackage } from "./android-package";
import { withAndroidUiDump } from "./android-ui-dump";
import { primaryStorageForUser, readAndroidUser, userScopedDevice } from "./android-user";
import { selectAbi } from "./catalog";
import { importDaijishoPegasus, configureDaijishoFolder } from "./daijisho-library";
import { DAIJISHO_PACKAGE, readDaijishoLabels, type DaijishoUiContext } from "./daijisho-navigation";
import { validateDaijishoPlatformIds } from "./daijisho-profiles";
import { daijishoPegasusDocument } from "./daijisho-pegasus";
import { visitDaijishoPlatforms } from "./daijisho-platforms";
import { prepareDaijishoPlatforms, type DaijishoPlatformConfiguration, type DaijishoPlatformPlan } from "./daijisho-preparation";
import { keepDeviceAwake } from "./device-keep-awake";
import { withAwakeDevice } from "./device-awake";
import type { ConfigurationItemState, EmulatorConfigurationOptions } from "./emulator-configuration-types";
import { createMediaStoreFolders, queryMediaStoreFiles } from "./media-store";
import { uploadMediaStoreFile } from "./media-store-upload";
import { shellCommand, type DeviceTransport } from "./transport";
import { workspacePaths } from "./workspace";

export interface DaijishoSetupOptions extends Pick<EmulatorConfigurationOptions, "folders" | "signal" | "onStatus" | "onUnlockRequired"> {
  log?: (message: string) => void;
  /** Installer confirmed the app was absent before this run. */
  freshInstall?: boolean;
  /** Omitted means all Library platforms with an installed emulator. */
  platformIds?: readonly string[];
}

export interface DaijishoConfigurationResult {
  /** Imported or preserved routing profiles and folder grants, not a completed ROM scan. */
  library: ConfigurationItemState;
  romDirectory: string;
  platforms: readonly DaijishoPlatformConfiguration[];
  /** Configuration does not certify emulator prerequisites or gameplay. */
  gameplayVerified: false;
}

function platformName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
}

async function stagePegasus(context: DaijishoUiContext, document: string, directory: string): Promise<string> {
  const bytes = new TextEncoder().encode(document);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const path = `${directory}/pegasus-${hash}.txt`;
  const records = await queryMediaStoreFiles(context.device, context.user, directory, context.signal);
  if (!records.some((record) => record.path === path)) {
    await uploadMediaStoreFile(context.device, context.user, directory,
      new File([document], path.slice(path.lastIndexOf("/") + 1), { type: "text/plain" }), { signal: context.signal, mimeType: "text/plain" });
  }
  const uploaded = (await queryMediaStoreFiles(context.device, context.user, directory, context.signal)).filter((record) => record.path === path);
  const record = uploaded[0];
  if (uploaded.length !== 1 || !record || record.bytes !== bytes.length) throw new Error("Daijishō's import file was not confirmed.");
  const read = shellCommand("content", "read", "--user", String(context.user), "--uri", `content://media/external/file/${record.id}`);
  const digest = await context.device.shell(`${read} | ${shellCommand("sha256sum")}`);
  if (digest.trim().split(/\s+/)[0] !== hash) throw new Error("Daijishō's import file differs from the generated profile; it was not overwritten.");
  return path;
}

/** Import missing profiles and paths only; preserve existing platform settings. */
export async function configureDaijisho(
  device: DeviceTransport, options: DaijishoSetupOptions = {}, preparedPlans?: readonly DaijishoPlatformPlan[],
): Promise<DaijishoConfigurationResult> {
  validateDaijishoPlatformIds(options.platformIds);
  const user = await readAndroidUser(device, options.signal);
  const scoped = userScopedDevice(device, user, options.signal);
  const sdk = (await scoped.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
  if (!/^[1-9]\d*$/.test(sdk) || !Number.isSafeInteger(Number(sdk)) || Number(sdk) < 30) {
    throw new Error("Uploading Daijishō's Pegasus configuration through MediaStore requires Android 11 or newer.");
  }
  if (!await readAndroidPackage(scoped, DAIJISHO_PACKAGE, user, options.signal)) throw new Error("Install Daijishō before configuring it.");
  const paths = workspacePaths(primaryStorageForUser(user), options.folders);
  const plans = preparedPlans ?? await prepareDaijishoPlatforms(scoped, user,
    selectAbi((await scoped.shell(shellCommand("getprop", "ro.product.cpu.abilist"))).trim().split(",")), paths.roms, options);
  if (!plans.some((plan) => plan.profile)) return { library: "missing", romDirectory: paths.roms,
    platforms: plans.map((plan) => plan.result), gameplayVerified: false };
  const profilePlans = plans.flatMap(({ profile, result }) => profile ? [{ profile, result }] : []);
  const lease = await keepDeviceAwake(scoped, user, { signal: options.signal, log: options.log });
  try {
    return await withAwakeDevice(scoped, user, options, (ensureUnlocked) => withAndroidUiDump(scoped, options.signal, async () => {
      const base = { device: scoped, user, signal: options.signal, ensureUnlocked };
      const context: DaijishoUiContext = { ...base, labels: await readDaijishoLabels(base) };
      const staging = `${paths.setup}/Daijisho`;
      await createMediaStoreFolders(scoped, user, [staging, ...profilePlans.map((plan) => plan.result.romDirectory)], options.signal);
      const existing = new Set<string>();
      if (!options.freshInstall) {
        options.onStatus?.("Reading visible Daijishō platforms…");
        await visitDaijishoPlatforms(context, async (_snapshot, identity) => {
          existing.add(platformName(identity.name));
          return false;
        });
      }
      const missing = profilePlans.filter((plan) => !existing.has(platformName(plan.profile.name)));
      if (missing.length) {
        const document = daijishoPegasusDocument(missing.map((plan) => plan.profile));
        options.onStatus?.(`Importing ${missing.length} missing Daijishō platforms with Pegasus…`);
        await importDaijishoPegasus(context, await stagePegasus(context, document, staging));
      }
      const pendingFolders = new Map(profilePlans.map((plan) => [platformName(plan.profile.name), plan]));
      if (pendingFolders.size !== profilePlans.length) {
        throw new Error("Daijishō's platform names are ambiguous.");
      }
      const folders = new Map<string, boolean>();
      if (pendingFolders.size) {
        options.onStatus?.("Connecting ROM folders in Daijishō's platform order…");
        await visitDaijishoPlatforms(context, async (snapshot, identity) => {
          const name = platformName(identity.name);
          const plan = pendingFolders.get(name);
          if (plan) {
            options.onStatus?.(`Configuring Daijishō ROM folder: ${plan.profile.name} (${plan.result.platformId})…`);
            folders.set(plan.result.platformId, await configureDaijishoFolder(context, plan.result.romDirectory, snapshot));
            pendingFolders.delete(name);
          }
          return pendingFolders.size === 0;
        });
      }
      const platforms = plans.map((plan): DaijishoPlatformConfiguration => {
        if (!plan.profile) return plan.result;
        const profile = existing.has(platformName(plan.profile.name)) ? "unverified" : "accepted";
        const folder = folders.get(plan.result.platformId);
        return { ...plan.result, profile, folder: folder ? "accepted" : "missing", state: folder ? profile : "missing",
          ...(folder === undefined ? { reason: `The platform ${plan.profile.name} is not visible in Daijishō's library.` }
            : !folder ? { reason: "The ROM path or its persisted read/write permission is missing. Existing paths were preserved." } : {}) };
      });
      const library = platforms.some((platform) => platform.state === "missing") ? "missing"
        : platforms.some((platform) => platform.state === "unverified") ? "unverified" : "accepted";
      return { library, romDirectory: paths.roms, platforms, gameplayVerified: false };
    }));
  } finally { await lease.release(); }
}
