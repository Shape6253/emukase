import type { ApplicationExtraStep, ApplicationInstallContext } from "./application-install";
import type { Core, Release } from "./catalog";
import { checkActivityStart, shellCommand, type DeviceTransport } from "./transport";
import { checkAbort } from "./setup-events";
import { androidUserProcessPid, assertAndroidUser, primaryStorageForUser, userScopedDevice } from "./android-user";
import { withAwakeDevice } from "./device-awake";
import { androidUiForeground } from "./android-ui";
import { installRetroArchCores } from "./retroarch-cores";

const LAUNCHER = "com.retroarch.browser.mainmenu.MainMenuActivity";
const NATIVE_ACTIVITY = "com.retroarch.browser.retroactivity.RetroActivityFuture";
const MAX_CONFIG_LENGTH = 2_097_152;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Read the full config at the process/profile path validated by startupConfigPath. */
export async function readRetroArchConfig(
  device: DeviceTransport, path: string, signal?: AbortSignal,
): Promise<string | undefined> {
  checkAbort(signal);
  const complete = "\nEMUKASE_ASSET_CONFIG:complete\n";
  const output = await device.shell(shellCommand("sh", "-c", [
    `if ${shellCommand("test", "-f", path)} && ${shellCommand("test", "-r", path)}; then`,
    `  if ${shellCommand("cat", path)}; then`,
    `    ${shellCommand("printf", complete)}`,
    "  else printf '\\nEMUKASE_ASSET_CONFIG:error\\n'",
    "  fi",
    "else printf 'EMUKASE_ASSET_CONFIG:unavailable\\n'",
    "fi",
  ].join("\n")));
  checkAbort(signal);
  if (output === "EMUKASE_ASSET_CONFIG:unavailable\n") return undefined;
  if (!output.endsWith(complete)) throw new Error("RetroArch config could not be read completely.");
  const config = output.slice(0, -complete.length);
  if (config.length > MAX_CONFIG_LENGTH || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(config)) {
    throw new Error("RetroArch config is invalid or too large.");
  }
  return config;
}

export function startupConfigPath(log: string, pid: string, user: number, packageName: string): string | undefined {
  for (const line of log.split(/\r?\n/).reverse()) {
    const match = /^\S+\s+\S+\s+(\d+)\s+\d+\s+I\s+RetroArch\s*:\s*\[ENV\] Config file: "([^"\x00-\x1f]+)"\.$/.exec(line);
    if (match?.[1] !== pid) continue;
    const path = match[2];
    if (!path || path.split("/").some((part) => part === "." || part === "..")) return undefined;
    const roots = [`/storage/emulated/${user}/`, `/data/user/${user}/${packageName}/`];
    if (user === 0) roots.push("/sdcard/", `/data/data/${packageName}/`);
    return path.endsWith(".cfg") && roots.some((root) => path.startsWith(root)) ? path : undefined;
  }
  return undefined;
}

export function startupAssetsReady(config: string): boolean {
  const values = new Map<string, string>();
  for (const line of config.split(/\r?\n/)) {
    if (!/^\s*bundle_assets_extract_(?:enable|version_current|last_version)\b/.test(line)) continue;
    const match = /^\s*(bundle_assets_extract_(?:enable|version_current|last_version))\s*=\s*(?:"([^"\s]+)"|([^"\s]+))\s*$/.exec(line);
    const value = match?.[2] ?? match?.[3];
    if (!match?.[1] || !value || values.has(match[1])) return false;
    values.set(match[1], value);
  }
  const enabled = values.get("bundle_assets_extract_enable");
  if (enabled !== undefined && enabled !== "true" && enabled !== "false") return false;
  const current = values.get("bundle_assets_extract_version_current");
  return !!current && /^[1-9]\d*$/.test(current) && current === values.get("bundle_assets_extract_last_version");
}

export function latestPresentedFrame(output: string): bigint {
  let latest = 0n;
  for (const line of output.split(/\r?\n/)) {
    const match = /^\d+\s+(\d+)\s+\d+$/.exec(line.trim());
    if (!match?.[1]) continue;
    const timestamp = BigInt(match[1]);
    if (timestamp > latest && timestamp < 9_223_372_036_854_775_807n) latest = timestamp;
  }
  return latest;
}

export function startupConfirmed(log: string, pid: string): boolean {
  if (log.length > 2_097_152 || !/^[1-9]\d*$/.test(pid)) return false;
  return log.split(/\r?\n/).some((line) => {
    const match = /^\S+\s+\S+\s+(\d+)\s+\d+\s+[VDIWEF]\s+RetroActivity\s*:\s*(.*)$/.exec(line);
    return match?.[1] === pid && /^isPlayStoreBuild: (?:true|false)$/.test(match[2] ?? "");
  });
}

async function nativeForeground(context: ApplicationInstallContext<Release>): Promise<boolean> {
  const { device, release, user, signal } = context;
  try {
    return await androidUiForeground(device, user, signal) === `${release.packageName}/${NATIVE_ACTIVITY}`;
  } catch {
    checkAbort(signal);
    await assertAndroidUser(device, user, signal);
    return false;
  }
}

function nativeLayers(output: string, packageName: string): string[] {
  const components = [`${packageName}/${NATIVE_ACTIVITY}`, `${packageName}/.browser.retroactivity.RetroActivityFuture`];
  return output.split(/\r?\n/).flatMap((line) => {
    const name = line.trim().replace(/^RequestedLayerState\{(.*?)(?: parentId=| relativeParentId=| mirrorId=| !handle| z=| layerStack=|\}).*$/, "$1");
    if (components.some((component) => name.includes(component))) return [name];
    const [prefix, suffix] = name.split("[...]");
    if (!prefix || !suffix) return [];
    const end = suffix.indexOf("RetroActivityFuture");
    if (end < 0) return [];
    const tail = suffix.slice(end + "RetroActivityFuture".length);
    return components.map((component) => `${component}${tail}`).filter((candidate) => candidate.startsWith(prefix) && candidate.endsWith(suffix));
  });
}

export interface RetroArchOptions {
  importTimeoutMs?: number;
  startupTimeoutMs?: number;
  unlockTimeoutMs?: number;
}

function startupStorageProbe(user: number, packageName: string): string {
  const root = primaryStorageForUser(user);
  const directory = `${root}/Android/data/${packageName}/files`;
  const parents = [`${root}/Android`, `${root}/Android/data`, `${root}/Android/data/${packageName}`, directory];
  return shellCommand("sh", "-c", [
    "blocked() { printf 'blocked\\n'; exit 0; }",
    `${shellCommand("test", "-d", root)} && ${shellCommand("test", "-r", root)} && ${shellCommand("test", "-x", root)} && ${shellCommand("ls", root)} >/dev/null 2>&1 || blocked`,
    `for directory in ${parents.map((path) => shellCommand(path)).join(" ")}; do`,
    "  if test -d \"$directory\"; then",
    "    test -r \"$directory\" && test -x \"$directory\" && ls \"$directory\" >/dev/null 2>&1 || blocked",
    "  elif test -e \"$directory\"; then blocked",
    "  else printf 'parent\\n'; exit 0",
    "  fi",
    "done",
    `if ${shellCommand("test", "-e", `${directory}/retroarch.cfg`)}; then`,
    `  ${shellCommand("test", "-f", `${directory}/retroarch.cfg`)} && ${shellCommand("test", "-r", `${directory}/retroarch.cfg`)} && ${shellCommand("cat", `${directory}/retroarch.cfg`)} >/dev/null 2>&1 || blocked`,
    "fi",
    "printf 'directory\\n'",
  ].join("\n"));
}

async function checkStartupSupport(context: ApplicationInstallContext<Release>, requireAssets: boolean): Promise<void> {
  const { device, release, user, signal, log } = context;
  checkAbort(signal);
  log("Checking RetroArch startup support…");
  await androidUserProcessPid(device, release.packageName, user, signal);
  if (!requireAssets) return;
  const command = startupStorageProbe(user, release.packageName);
  const access = (await device.shell(command)).trim();
  checkAbort(signal);
  if (access === "directory") return;
  if (access === "parent") {
    // A helper's readable parent does not prove access to another app's future Android/data directory.
    const direct = userScopedDevice(device.restorationDevice ?? device, user, signal);
    if (["directory", "parent"].includes((await direct.shell(command)).trim())) return;
  }
  throw new Error(user === 0
    ? "RetroArch startup needs ADB access to its app files. Check that shared storage is available before installing."
    : "Android blocks access to RetroArch app files in this profile. Connect from the owner profile or provide access to this profile's app files before installing.");
}

async function launchRetroArch(
  context: ApplicationInstallContext<Release>,
  options: RetroArchOptions,
  requireAssets: boolean,
): Promise<void> {
  await withAwakeDevice(context.device, context.user, {
    signal: context.signal,
    unlockTimeoutMs: options.unlockTimeoutMs,
    onUnlockRequired(required) {
      if (context.signal?.aborted) return;
      return context.reportStatus(required
        ? "Unlock your Android device to continue. Keep it connected over USB."
        : "Verifying RetroArch startup…", { unlockRequired: required });
    },
  }, (ensureUnlocked) => verifyRetroArchStartup(context, options, ensureUnlocked, requireAssets));
}

async function verifyRetroArchStartup(
  context: ApplicationInstallContext<Release>,
  options: RetroArchOptions,
  ensureUnlocked: () => Promise<boolean>,
  requireAssets: boolean,
): Promise<void> {
  const { device, release, user, signal, log } = context;
  const check = () => checkAbort(signal);
  check();
  const sdk = (await device.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
  if (!/^[1-9]\d*$/.test(sdk) || !Number.isSafeInteger(Number(sdk)) || Number(sdk) < 24) {
    throw new Error("RetroArch startup requires a confirmed Android API 24 or newer.");
  }
  const display = Number(sdk) >= 26 ? ["--display", "0"] : [];
  await device.shell(shellCommand("am", "force-stop", "--user", String(user), release.packageName));
  await ensureUnlocked();
  checkActivityStart(
    await device.shell(shellCommand("am", "start", "--user", String(user), ...display, "-W", "-n", `${release.packageName}/${LAUNCHER}`)),
  );
  log("Checking RetroArch startup…");
  await context.reportStatus("Verifying RetroArch startup…");
  let startupDeadline = Date.now() + (options.startupTimeoutMs ?? 120_000);
  let ready = false;
  let lastPid = "";
  let configPath: string | undefined;
  let javaReady = false;
  const frames = new Map<string, bigint>();
  while (Date.now() < startupDeadline) {
    check();
    // RetroArch's native activity keeps the screen on; also handle locking before it starts.
    const waitStarted = Date.now();
    if (await ensureUnlocked()) {
      startupDeadline += Date.now() - waitStarted;
      frames.clear();
    }
    const pid = await androidUserProcessPid(device, release.packageName, user, signal);
    if (pid !== lastPid) {
      frames.clear();
      configPath = undefined;
      javaReady = false;
      lastPid = pid;
    }
    if (/^\d+$/.test(pid)) {
      if (!javaReady || (requireAssets && !configPath)) {
        const output = await device.shell(shellCommand("logcat", "-d", "-v", "threadtime", "-s", "RetroActivity:I", "RetroArch:I", "*:S"));
        javaReady = startupConfirmed(output, pid);
        if (requireAssets) configPath = startupConfigPath(output, pid, user, release.packageName);
      }
      let assetsReady = !requireAssets;
      if (requireAssets && configPath) {
        const config = await readRetroArchConfig(device, configPath, signal);
        assetsReady = config !== undefined && startupAssetsReady(config);
      }
      if (javaReady && assetsReady) {
        // Window focus identifies the active profile; activity top can dump only the owner.
        if (!await nativeForeground(context)) {
          frames.clear();
          await pause(500);
          continue;
        }
        const layers = nativeLayers(await device.shell(shellCommand("dumpsys", "SurfaceFlinger", "--list")), release.packageName);
        for (const layer of layers) {
          const frame = latestPresentedFrame(await device.shell(shellCommand("dumpsys", "SurfaceFlinger", "--latency", layer)));
          const previous = frames.get(layer);
          frames.set(layer, frame);
          // Require a new native frame; stale surfaces cannot establish readiness.
          if (previous !== undefined && frame > previous && frame > 0n) ready = true;
        }
        if (ready && await nativeForeground(context)
          && (await androidUserProcessPid(device, release.packageName, user, signal)) === pid) break;
        if (ready) frames.clear();
        ready = false;
      } else frames.clear();
    }
    await pause(500);
  }
  if (!ready) throw new Error(requireAssets
    ? "RetroArch startup and asset extraction could not be verified. Check the app on the device."
    : "RetroArch's first launch could not be verified. Unlock the device and check the app on its screen.");
  check();
}

export function createRetroArchSteps(
  cores: readonly Core[] = [],
  options: RetroArchOptions = {},
): readonly ApplicationExtraStep<Release>[] {
  for (const timeout of [options.startupTimeoutMs, options.importTimeoutMs, options.unlockTimeoutMs]) {
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0)) {
      throw new Error("Invalid RetroArch setup timeout.");
    }
  }
  const selectedCores = cores.slice();
  const requireAssets = selectedCores.length > 0;
  const steps: ApplicationExtraStep<Release>[] = [
    {
      id: "launch", label: "Verify first launch",
      preflight: (context) => checkStartupSupport(context, requireAssets),
      run: (context) => launchRetroArch(context, options, requireAssets),
    },
  ];
  if (selectedCores.length) {
    steps.push({
      id: "cores", label: "Install RetroArch cores",
      async run(context) {
        await installRetroArchCores(context, selectedCores, options.importTimeoutMs);
        await launchRetroArch(context, options, requireAssets);
      },
    });
  }
  return steps;
}
