import type { HardwareInfo } from "./hardware";
import { shellCommand, type DeviceTransport } from "./transport";

function packedVersion(value: string | undefined, api: "gles" | "vulkan"): number | undefined {
  if (!value || !/^(?:0x[\da-f]+|\d+)$/i.test(value.trim())) return;
  const packed = Number(value);
  if (!Number.isSafeInteger(packed) || packed <= 0 || packed > 0xffffffff) return;
  const major = api === "gles" ? packed >>> 16 : (packed >>> 22) & 0x7f;
  const minor = api === "gles" ? packed & 0xffff : (packed >>> 12) & 0x3ff;
  // Our contract uses major.minor numbers, not Android's two different packed encodings.
  if (major < 1 || major > 4 || minor > 9 || (api === "vulkan" && packed >>> 29)) return;
  return Number(`${major}.${minor}`);
}

function minimum(values: (number | undefined)[]): number | undefined {
  const valid = values.filter((value): value is number => value !== undefined);
  return valid.length ? Math.min(...valid) : undefined;
}

/** Read-only, quoted ADB commands only. Failure is recorded as unknown, never a model-based guess. */
export async function probeHardware(device: DeviceTransport): Promise<HardwareInfo> {
  const evidence: string[] = [];
  async function read(...args: string[]): Promise<string> {
    const command = shellCommand(...args);
    try {
      const output = (await device.shell(command)).trim();
      if (/permission denial|permission denied|can't find service|unknown command|not found|exception|^error:/im.test(output)) {
        evidence.push(`${command}: unavailable`);
        return "";
      }
      evidence.push(`${command}: ${output ? "read" : "empty"}`);
      return output;
    } catch {
      evidence.push(`${command}: failed`);
      return "";
    }
  }
  const [socModel, vendorSocModel, socMachine, systemSocMachine, board, hardware, glProperty, memory, features, surface] =
    await Promise.all([
      read("getprop", "ro.soc.model"),
      read("getprop", "ro.vendor.qti.soc_model"),
      read("cat", "/sys/devices/soc0/machine"),
      read("cat", "/sys/devices/system/soc/soc0/machine"),
      read("getprop", "ro.board.platform"),
      read("getprop", "ro.hardware"),
      read("getprop", "ro.opengles.version"),
      read("cat", "/proc/meminfo"),
      read("pm", "list", "features"),
      read("dumpsys", "SurfaceFlinger"),
    ]);
  const reported = (value: string) =>
    !!value && !/^(?:unknown|unavailable|none|null|n\/a)$/i.test(value) && !/[\r\n\0]/.test(value);
  // A platform such as "pineapple" or a generic "qcom" hardware string is not a
  // CPU model. Keep them in diagnostics, not as fallbacks in the chipset display.
  // Qualcomm firmware may omit ro.soc.model and put a platform codename in
  // sysfs machine, while its vendor property reports the actual chip model.
  // Preserve that reported model verbatim; do not translate it to a marketing name.
  const socSources: [string, string][] = [
    ["ro.soc.model", socModel],
    ["ro.vendor.qti.soc_model", vendorSocModel],
    ["/sys/devices/soc0/machine", socMachine],
    ["/sys/devices/system/soc/soc0/machine", systemSocMachine],
  ];
  const soc = socSources.find(([, value]) => reported(value))?.[1] || "unknown";
  for (const [source, value] of socSources) {
    if (reported(value)) evidence.push(`Reported SoC (${source}): ${value}`);
  }
  const platform = reported(board) ? board : undefined;
  // Only the GLES renderer field identifies a GPU. Never scan arbitrary dump text for "Adreno".
  const glesLine = surface.match(/^\s*GLES:\s*([^\r\n]+)$/im)?.[1];
  // ANGLE renderer descriptions can contain an inner backend version. The actual
  // context version is the last comma-delimited OpenGL ES field, not that backend.
  const glSurface = glesLine
    ? [...glesLine.matchAll(/,\s*OpenGL\s+ES(?:-[A-Z]+)?\s+(\d+)\.(\d+)\b/gi)].at(-1)
    : undefined;
  const gpu = glSurface?.index === undefined
    ? "unknown"
    : glesLine?.slice(0, glSurface.index).match(/^[^,]+,\s*(.+)$/)?.[1]?.trim() || "unknown";
  const glObserved =
    glSurface && Number(glSurface[1]) <= 4 && Number(glSurface[2]) <= 9
      ? Number(`${glSurface[1]}.${glSurface[2]}`)
      : undefined;
  const glFeature = features.match(/^feature:reqGlEsVersion=(0x[\da-f]+|\d+)\s*$/im)?.[1];
  const openGlEsVersion = minimum([packedVersion(glProperty, "gles"), packedVersion(glFeature, "gles"), glObserved]);
  // Vulkan's level, compute and dEQP flags are NOT an API version.
  const vulkanFeature = features.match(/^feature:android\.hardware\.vulkan\.version=(0x[\da-f]+|\d+)\s*$/im)?.[1];
  const vulkanVersion = packedVersion(vulkanFeature, "vulkan");
  const memTotal = memory.match(/^MemTotal:\s+(\d+)\s+kB\s*$/im)?.[1];
  const ramMb =
    memTotal && Number.isSafeInteger(Number(memTotal)) && Number(memTotal) > 0
      ? Math.floor(Number(memTotal) / 1024)
      : undefined;
  evidence.push(`Reported CPU/SoC model: ${soc}`);
  if (platform) evidence.push(`Android platform (diagnostic only): ${platform}`);
  if (reported(hardware)) evidence.push(`Android hardware identifier (diagnostic only): ${hardware}`);
  evidence.push(`SurfaceFlinger GLES renderer: ${gpu}`);
  if (glesLine) evidence.push(`SurfaceFlinger GLES: ${glesLine}`);
  if (ramMb !== undefined) evidence.push(`MemTotal: ${ramMb} MiB (kernel-visible, not advertised RAM)`);
  if (openGlEsVersion !== undefined) evidence.push(`OpenGL ES: ${openGlEsVersion} (lowest reported version)`);
  if (vulkanVersion !== undefined) evidence.push(`PackageManager Vulkan API: ${vulkanVersion}`);
  return { soc, ...(platform ? { platform } : {}), gpu, ramMb, openGlEsVersion, vulkanVersion, evidence };
}
