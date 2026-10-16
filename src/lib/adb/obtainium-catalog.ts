import { BUILDBOT, type Abi } from "./catalog";
import { EMULATORS, retroArchPackageName } from "./emulators";
import type { DeviceInfo } from "./device-info";

export interface ObtainiumAppImport {
  readonly id: string;
  readonly url: string;
  readonly author: string;
  readonly name: string;
  readonly preferredApkIndex: number;
  readonly additionalSettings: string;
  readonly overrideSource: "HTML" | "GitHub" | "Codeberg" | null;
  readonly allowIdChange: false;
}

type CatalogDevice = Pick<DeviceInfo, "sdk" | "hardware">;

interface TrackedApp {
  id: string;
  name: string;
  author: string;
  url: string;
  abis: readonly Abi[];
  source: ObtainiumAppImport["overrideSource"];
  settings: Readonly<Record<string, unknown>>;
  supports?: (device: CatalogDevice) => boolean;
}

const NORMAL_ABIS: readonly Abi[] = ["arm64-v8a", "armeabi-v7a", "x86_64"];
const BIT64_ABIS: readonly Abi[] = ["arm64-v8a", "x86_64"];
const ARM64_ABIS: readonly Abi[] = ["arm64-v8a"];

const TRACKED_APPS: readonly TrackedApp[] = [
  {
    id: EMULATORS.ppsspp.packages[0], name: EMULATORS.ppsspp.name, author: "PPSSPP",
    url: "https://www.ppsspp.org/download/", abis: NORMAL_ABIS, source: "HTML",
    settings: {
      customLinkFilterRegex: "^https://www\\.ppsspp\\.org/files/\\d+(?:_\\d+){1,3}/ppsspp\\.apk$",
      apkFilterRegEx: "(?:^|[-/])ppsspp\\.apk$",
      versionExtractWholePage: true,
      versionExtractionRegEx: "What's new in (\\d+(?:\\.\\d+){1,3})\\?",
      matchGroupToUse: "$1",
    },
  },
  {
    id: EMULATORS.dolphin.packages[0], name: EMULATORS.dolphin.name, author: "Dolphin Emulator Project",
    // The official updater's beta endpoint is the current release channel.
    url: "https://dolphin-emu.org/update/latest/beta/", abis: BIT64_ABIS, source: "HTML",
    settings: {
      customLinkFilterRegex: "^https://dl\\.dolphin-emu\\.org/releases/\\d{4}[a-z]?/dolphin-\\d{4}[a-z]?\\.apk$",
      matchLinksOutsideATags: true,
      apkFilterRegEx: "(?:^|[-/])dolphin-\\d{4}[a-z]?\\.apk$",
      versionExtractionRegEx: "/releases/(\\d{4}[a-z]?)/",
      matchGroupToUse: "$1",
    },
  },
  {
    id: EMULATORS.azahar.packages[0], name: EMULATORS.azahar.name, author: "Azahar Emulator Project",
    url: "https://github.com/azahar-emu/azahar", abis: BIT64_ABIS, source: null,
    settings: {
      apkFilterRegEx: "^azahar-android-vanilla-v?\\d+(?:\\.\\d+){0,5}\\.apk$",
      versionExtractionRegEx: "^v?(\\d+(?:\\.\\d+){0,5})$",
      matchGroupToUse: "$1-vanilla",
    },
  },
  {
    id: EMULATORS.melonds.packages[0], name: EMULATORS.melonds.name, author: "Rafael V. Caetano",
    url: "https://github.com/rafaelvcaetano/melonDS-android", abis: BIT64_ABIS, source: null,
    settings: {
      apkFilterRegEx: "^app-gitHub-prod-release\\.apk$",
      versionExtractionRegEx: "^v?(\\d+(?:\\.\\d+){0,5})$",
      matchGroupToUse: "$1 GH",
    },
  },
  {
    id: EMULATORS.armsx2.packages[0], name: EMULATORS.armsx2.name, author: "ARMSX2",
    url: "https://github.com/ARMSX2/ARMSX2", abis: ARM64_ABIS, source: null,
    // ABI alone does not establish ARMv8.2 extensions or a newer Android API.
    settings: { apkFilterRegEx: "^ARMSX2-v?\\d+(?:\\.\\d+){0,5}-legacy-armv8\\.0-sdk26\\.apk$" },
  },
  {
    id: EMULATORS.eden.packages[0], name: EMULATORS.eden.name, author: "Eden Emulator Project",
    url: "https://git.eden-emu.dev/eden-emu/eden", abis: ARM64_ABIS, source: "Codeberg",
    settings: { apkFilterRegEx: "^Eden-Android-v?\\d+(?:\\.\\d+){0,5}-standard\\.apk$" },
  },
  {
    id: EMULATORS.vita3k.packages[0], name: EMULATORS.vita3k.name, author: "Vita3K",
    url: "https://github.com/Vita3K/Vita3K", abis: ARM64_ABIS, source: null,
    // The continuous tag and Android version stay fixed while the APK changes.
    settings: {
      apkFilterRegEx: "^android-latest\\.apk$",
      filterReleaseTitlesByRegEx: "^Automatic CI builds$",
      useLatestAssetDateAsReleaseDate: true,
      releaseDateAsVersion: true,
      versionDetection: false,
    },
  },
  {
    id: "com.droiddeck.launcher", name: "DroidDeck", author: "Droid-Deck",
    url: "https://github.com/Droid-Deck/DroidDeck", abis: ARM64_ABIS, source: "GitHub",
    // Select the standard package, excluding the benchmark/game package variants.
    settings: { apkFilterRegEx: "^DroidDeck-v?\\d+(?:\\.\\d+){0,5}\\.apk$" },
    // https://github.com/Droid-Deck/DroidDeck#requirements-and-install
    // Adreno 6xx is experimental; require the supported 730+ or 8xx GPUs.
    supports: ({ sdk, hardware }) => Number.isSafeInteger(sdk) && sdk >= 28 && hardware !== undefined
      && /\bAdreno(?:\s*\(TM\))?\s+(?:7[3-9]\d|8\d{2})\b/i.test(hardware.gpu),
  },
];

function requireSupportedAbi(abi: Abi): void {
  if (!NORMAL_ABIS.includes(abi)) throw new Error("Unsupported Obtainium catalog architecture.");
}

function importApp(definition: TrackedApp): ObtainiumAppImport {
  return {
    id: definition.id, name: definition.name, author: definition.author, url: definition.url,
    preferredApkIndex: 0, overrideSource: definition.source, allowIdChange: false,
    additionalSettings: JSON.stringify({
      appName: definition.name,
      trackOnly: false,
      autoApkFilterByArch: true,
      includePrereleases: false,
      fallbackToOlderReleases: false,
      sortMethodChoice: "date",
      versionDetection: true,
      ...definition.settings,
    }),
  };
}

export function getObtainiumTrackedApps(abi: Abi, device?: CatalogDevice): readonly ObtainiumAppImport[] {
  requireSupportedAbi(abi);
  return TRACKED_APPS.filter((definition) => definition.abis.includes(abi)
    && (!definition.supports || (device !== undefined && definition.supports(device)))).map(importApp);
}

export function createRetroArchObtainiumApp(abi: Abi): ObtainiumAppImport {
  requireSupportedAbi(abi);
  const is64 = abi === "arm64-v8a" || abi === "x86_64";
  const filename = is64 ? "RetroArch_aarch64.apk" : "RetroArch_ra32.apk";
  const packageName = retroArchPackageName(abi);
  return importApp({
    id: packageName, name: EMULATORS.retroarch.name, author: "Libretro", abis: [abi], source: "HTML",
    url: `${BUILDBOT}/stable/`,
    settings: {
      intermediateLink: [
        {
          customLinkFilterRegex: "^https://buildbot\\.libretro\\.com/stable/\\d+\\.\\d+\\.\\d+/$",
          sortByLastLinkSegment: true,
        },
        { customLinkFilterRegex: "^https://buildbot\\.libretro\\.com/stable/\\d+\\.\\d+\\.\\d+/android/$" },
      ],
      customLinkFilterRegex: `^https://buildbot\\.libretro\\.com/stable/\\d+\\.\\d+\\.\\d+/android/${filename.replace(".", "\\.")}$`,
      apkFilterRegEx: `${filename.replace(".", "\\.")}$`,
      versionExtractionRegEx: "/stable/(\\d+\\.\\d+\\.\\d+)/",
      matchGroupToUse: "$1_GIT",
    },
  });
}
