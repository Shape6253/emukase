import type { ApplicationRelease } from "./application.ts";
import { HttpError } from "./download-policy.ts";

export const BUILDBOT = "https://buildbot.libretro.com";
// SHA-256 and size of the verified official RetroArch 1.22.2 APK.
const VERIFIED_RETROARCH_APKS: Readonly<Record<string, { sha256: string; apkSize: number }>> = {
  [`${BUILDBOT}/stable/1.22.2/android/RetroArch_aarch64.apk`]: {
    sha256: "7bd5d208dfe93cc8e2ea6c04608948ce1a045980f160a58ca2d0993aa20ad213",
    apkSize: 183_956_821,
  },
};
export type Abi = "arm64-v8a" | "armeabi-v7a" | "x86_64" | "x86";

export interface Core {
  id: string;
  name: string;
  systems: string;
}

export const CORES: readonly Core[] = [
  { id: "fceumm", name: "FCEUmm", systems: "NES / Famicom" },
  { id: "snes9x", name: "Snes9x", systems: "SNES" },
  { id: "gambatte", name: "Gambatte", systems: "Game Boy / Game Boy Color" },
  { id: "mgba", name: "mGBA", systems: "Game Boy Advance" },
  { id: "genesis_plus_gx", name: "Genesis Plus GX", systems: "Mega Drive / Mega CD / Master System / Game Gear" },
  { id: "picodrive", name: "PicoDrive", systems: "Sega 32X" },
  { id: "mednafen_pce_fast", name: "Beetle PCE Fast", systems: "PC Engine / TurboGrafx-16" },
  { id: "swanstation", name: "SwanStation", systems: "PlayStation" },
  { id: "pcsx_rearmed", name: "PCSX ReARMed", systems: "PlayStation (lightweight option)" },
  { id: "fbneo", name: "FinalBurn Neo", systems: "Arcade / Neo Geo" },
  { id: "mednafen_ngp", name: "Beetle NeoPop", systems: "Neo Geo Pocket / Color (optional)" },
  { id: "mednafen_wswan", name: "Beetle Cygne", systems: "WonderSwan / Color (optional)" },
  { id: "mednafen_lynx", name: "Beetle Lynx", systems: "Atari Lynx (optional)" },
  { id: "mednafen_supergrafx", name: "Beetle SuperGrafx", systems: "PC Engine SuperGrafx (optional)" },
];

const OPTIONAL_CORE_IDS: readonly string[] = ["mednafen_ngp", "mednafen_wswan", "mednafen_lynx", "mednafen_supergrafx"];

export function selectCores(abi: Abi): Core[] {
  if (!["arm64-v8a", "armeabi-v7a", "x86_64", "x86"].includes(abi)) throw new Error("Unsupported core architecture.");
  const ps1 = abi === "arm64-v8a" || abi === "x86_64" ? "swanstation" : "pcsx_rearmed";
  return CORES.filter((core) => !OPTIONAL_CORE_IDS.includes(core.id) &&
    (!["swanstation", "pcsx_rearmed"].includes(core.id) || core.id === ps1));
}

export function selectAbi(abis: string[]): Abi {
  for (const abi of abis) {
    if (["arm64-v8a", "armeabi-v7a", "x86_64", "x86"].includes(abi)) {
      return abi as Abi;
    }
  }
  throw new Error(`Architecture is not supported yet: ${abis.join(", ") || "not detected"}`);
}

export function coreFilename(core: Core): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(core.id)) throw new Error("Invalid Libretro core ID.");
  return `${core.id}_libretro_android.so`;
}

export function coreUrl(abi: Abi, core: Core): string {
  return `${BUILDBOT}/nightly/android/latest/${abi}/${coreFilename(core)}.zip`;
}

export function stableVersions(html: string): string[] {
  const versions = new Set<string>();
  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const url = new URL(match[1]!, `${BUILDBOT}/stable/`);
      const version = url.pathname.match(/^\/stable\/(\d+\.\d+\.\d+)\/$/)?.[1];
      if (url.origin === BUILDBOT && version) versions.add(version);
    } catch {
      // Ignore unrelated links in the directory listing.
    }
  }
  return [...versions].sort((a, b) => {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    return right[0]! - left[0]! || right[1]! - left[1]! || right[2]! - left[2]!;
  });
}

export interface Release extends ApplicationRelease {
  abi: Abi;
}

export async function latestRelease(
  abi: Abi,
  readText: (url: string) => Promise<string>,
): Promise<Release> {
  const is64 = abi === "arm64-v8a" || abi === "x86_64";
  const filename = is64 ? "RetroArch_aarch64.apk" : "RetroArch_ra32.apk";
  const versions = stableVersions(await readText(`${BUILDBOT}/stable/`));
  for (const version of versions) {
    const directory = `${BUILDBOT}/stable/${version}/android/`;
    let listing: string;
    try {
      listing = await readText(directory);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) continue;
      throw error;
    }
    const apkUrl = `${directory}${filename}`;
    for (const match of listing.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
      let link: URL;
      try {
        link = new URL(match[1]!, directory);
      } catch {
        continue;
      }
      if (link.href === apkUrl) {
        return {
          name: "RetroArch", version, abi, apkUrl,
          packageName: is64 ? "com.retroarch.aarch64" : "com.retroarch.ra32",
          ...VERIFIED_RETROARCH_APKS[apkUrl],
        };
      }
    }
  }
  throw new Error(`No stable Android build of RetroArch was found for ${abi}.`);
}
