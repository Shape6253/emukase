import { grantPackagePermissions, readAndroidPackage } from "./android-package";
import { recordEsdeRecovery } from "./esde-files";
import { ESDE_PACKAGE } from "./esde-types";
import type { EsdeContext } from "./esde-types";
import { shellCommand } from "./transport";

export function normalizeEsdeComponent(component: string): string {
  const [owner, activity] = component.split("/");
  if (!owner || !activity || !/^[\w.]+\/[\w.$]+$/.test(component)) throw new Error("Invalid Android activity component.");
  return `${owner}/${activity.startsWith(".") ? owner + activity : activity}`;
}

export async function resolveEsdeLauncher(context: Pick<EsdeContext, "device" | "user">): Promise<string> {
  const output = await context.device.shell(shellCommand("cmd", "package", "resolve-activity", "--brief", "--user", String(context.user),
    "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-p", ESDE_PACKAGE));
  const components = output.trim().split(/\r?\n/).filter((line) => /^[\w.]+\/[\w.$]+$/.test(line));
  if (components.length !== 1 || !components[0]?.startsWith(`${ESDE_PACKAGE}/`)) throw new Error("ES-DE does not expose an unambiguous enabled launcher in this profile.");
  return normalizeEsdeComponent(components[0]);
}

export async function readEsdeHome(context: Pick<EsdeContext, "device" | "user">): Promise<string> {
  const output = await context.device.shell(shellCommand("cmd", "package", "resolve-activity", "--brief", "--user", String(context.user),
    "-a", "android.intent.action.MAIN", "-c", "android.intent.category.HOME"));
  const components = output.trim().split(/\r?\n/).filter((line) => /^[\w.]+\/[\w.$]+$/.test(line));
  if (components.length !== 1 || !components[0]) throw new Error("Android's current HOME could not be confirmed.");
  return normalizeEsdeComponent(components[0]);
}

type AppOpMode = "allow" | "ignore" | "deny" | "default" | "foreground";
export interface EsdeAllFilesModes { packageMode: AppOpMode; uidMode?: AppOpMode }

export function parseEsdeAllFilesModes(output: string): EsdeAllFilesModes {
  if (/Error:|Exception|Permission Denial/i.test(output)) throw new Error("Android denied inspection of ES-DE's all-files access.");
  if (/^No operations\.?(?:\s*\nDefault mode: default)?\s*$/i.test(output.trim())) return { packageMode: "default" };
  const modes = [...output.matchAll(/(?:^|\n)\s*MANAGE_EXTERNAL_STORAGE:\s*(allow|ignore|deny|default|foreground)\b/g)];
  const uid = [...output.matchAll(/(?:^|\n)\s*Uid mode:\s*MANAGE_EXTERNAL_STORAGE:\s*(allow|ignore|deny|default|foreground)\b/g)];
  if (modes.length > 1 || uid.length > 1 || !modes.length && !uid.length) throw new Error("ES-DE's all-files permission is ambiguous.");
  return { packageMode: (modes[0]?.[1] ?? "default") as AppOpMode, uidMode: uid[0]?.[1] as AppOpMode | undefined };
}

async function allFilesModes(context: EsdeContext): Promise<EsdeAllFilesModes> {
  return parseEsdeAllFilesModes(await context.device.shell(shellCommand("cmd", "appops", "get", "--user", String(context.user), ESDE_PACKAGE, "MANAGE_EXTERNAL_STORAGE")));
}

export async function assertEsdeStorageAccess(context: EsdeContext): Promise<void> {
  if (context.sdk >= 30 && context.installed.requestedPermissions.includes("android.permission.MANAGE_EXTERNAL_STORAGE")) {
    const modes = await allFilesModes(context);
    const effective = modes.uidMode && modes.uidMode !== "default" ? modes.uidMode : modes.packageMode;
    if (effective !== "allow") throw new Error("ES-DE's all-files access is not granted.");
  } else if (context.sdk === 29) {
    const current = await readAndroidPackage(context.device, ESDE_PACKAGE, context.user, context.signal);
    const required = context.installed.requestedPermissions.filter((permission) => [
      "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE",
    ].includes(permission));
    if (!current || required.some((permission) => !current.grantedPermissions.has(permission))) throw new Error("ES-DE's Android 10 storage permission is not granted.");
  }
}

export async function ensureEsdeStorageAccess(context: EsdeContext): Promise<void> {
  if (context.sdk === 29) {
    const permissions = context.installed.requestedPermissions.filter((permission) => [
      "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE",
    ].includes(permission));
    const missing = permissions.filter((permission) => !context.installed.grantedPermissions.has(permission));
    if (missing.length) {
      const token = await recordEsdeRecovery(context, "storage-permission", "intent", { permissions: missing.join(","), applied: "granted" });
      try {
        await grantPackagePermissions(context.device, ESDE_PACKAGE, context.user, missing, context.signal);
        await recordEsdeRecovery(context, "storage-permission", "verified", { permissions: missing.join(","), applied: "granted" }, token);
      } catch (error) {
        await recordEsdeRecovery(context, "storage-permission", "uncertain", { permissions: missing.join(","), applied: "granted" }, token).catch(() => {});
        throw error;
      }
    }
    await assertEsdeStorageAccess(context);
    return;
  }
  // Future SAF-only releases need no fabricated all-files permission.
  if (!context.installed.requestedPermissions.includes("android.permission.MANAGE_EXTERNAL_STORAGE")) return;
  const before = await allFilesModes(context);
  if (before.uidMode && !["default", "allow"].includes(before.uidMode)) throw new Error("A UID-wide restriction blocks ES-DE storage access; it was not changed.");
  if (before.uidMode === "allow" || before.packageMode === "allow") return;
  const token = await recordEsdeRecovery(context, "storage-permission", "intent", { previous: before.packageMode, applied: "allow" });
  try {
    if (JSON.stringify(await allFilesModes(context)) !== JSON.stringify(before)) throw new Error("ES-DE's permission changed before the grant.");
    const output = await context.device.shell(shellCommand("cmd", "appops", "set", "--user", String(context.user), ESDE_PACKAGE, "MANAGE_EXTERNAL_STORAGE", "allow"));
    if (/Error:|Exception|Permission Denial/i.test(output)) throw new Error("Android rejected ES-DE's storage grant.");
    await assertEsdeStorageAccess(context);
    await recordEsdeRecovery(context, "storage-permission", "verified", { previous: before.packageMode, applied: "allow" }, token);
  } catch (error) {
    await recordEsdeRecovery(context, "storage-permission", "uncertain", { previous: before.packageMode, applied: "allow" }, token).catch(() => {});
    throw error;
  }
}

/** Discover the installed archive entry, not the version or an APK-specific asset prefix. */
export async function readEsdeBundledSystems(context: EsdeContext): Promise<string> {
  return readBundledDefinition(context, "es_systems.xml");
}

export async function readEsdeBundledFindRules(context: EsdeContext): Promise<string> {
  return readBundledDefinition(context, "es_find_rules.xml");
}

async function readBundledDefinition(context: EsdeContext, name: "es_systems.xml" | "es_find_rules.xml"): Promise<string> {
  const paths = (await context.device.shell(shellCommand("pm", "path", "--user", String(context.user), ESDE_PACKAGE))).trim().split(/\r?\n/);
  const apks = paths.map((line) => /^package:(\/data\/app\/[^\r\n]+\.apk)$/.exec(line)?.[1]);
  const base = apks.filter((path) => path?.endsWith("/base.apk"));
  if (apks.some((path) => !path || path.split("/").some((part) => part === "." || part === "..")) || base.length !== 1 || !base[0]) {
    throw new Error("ES-DE's installed base APK could not be located.");
  }
  const listing = await context.device.shell(shellCommand("unzip", "-l", base[0]));
  if (listing.length > 2_097_152) throw new Error("ES-DE's APK entry listing is too large.");
  const entries = listing.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+\S+\s+\S+\s+([^\r\n]+)$/.exec(line);
    return match?.[2] && `/${match[2]}`.endsWith(`/systems/android/${name}`)
      ? [{ path: match[2], size: Number(match[1]) }] : [];
  });
  if (entries.length !== 1 || !entries[0] || entries[0].size > 2_097_152 || entries[0].size < 1) {
    throw new Error("This ES-DE installation does not expose a readable Android systems definition.");
  }
  const output = await context.device.shell(shellCommand("unzip", "-p", base[0], entries[0].path));
  if (new TextEncoder().encode(output).length !== entries[0].size) throw new Error("ES-DE's bundled systems XML could not be read completely.");
  return output;
}
