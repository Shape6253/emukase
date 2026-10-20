import type { Abi } from "./catalog";
import { supportsEmulatorConfiguration } from "./emulator-configuration";
import { libraryPlatform, LIBRARY_PLATFORMS, type LibraryPlatform, type LibrarySupportRequirement } from "./library-catalog";
import { validateLibrarySupportSelection } from "./library-support-inputs";
import { getObtainiumTrackedApps } from "./obtainium-catalog";

/** Standalone-emulator systems that are installed and configured from
 * user-provided files right after the base setup. RetroArch systems are not
 * offered: their cores ship with the base setup, which also points RetroArch's
 * System/BIOS directory at the shared BIOS folder; their files are added on
 * the Library page. */
export function biosSystems(abi?: Abi): readonly LibraryPlatform[] {
  const tracked = abi === undefined ? undefined : new Set(installablePackages(abi));
  return LIBRARY_PLATFORMS.filter((platform) => {
    if (!platform.requirements.length || !supportsEmulatorConfiguration(platform.id)) return false;
    return tracked === undefined || platform.emulatorPackages.some((pkg) => tracked.has(pkg));
  });
}

function installablePackages(abi: Abi): readonly string[] {
  try {
    return getObtainiumTrackedApps(abi).map((app) => app.id);
  } catch {
    return []; // The Obtainium catalog does not cover this architecture; nothing can be installed.
  }
}

export interface BiosSystemInput {
  /** Slot id, unique within the system. */
  id: string;
  /** Window title: firmware, fonts, keys, DS set... */
  title: string;
  /** Button text while nothing is attached. */
  label: string;
  accept: string;
  multiple: boolean;
  hint: string;
  requirement: LibrarySupportRequirement;
}

const SLOT_IDS: Readonly<Record<string, string>> = {
  "nds-ds": "ds",
  "nds-dsi": "dsi",
  "ps2-bios": "bios",
  "switch-keys": "keys",
  "switch-firmware": "firmware",
  "psvita-firmware": "firmware",
  "psvita-fonts": "fonts",
};

/** Setup uses the same file names, descriptions and selection rules as Library. */
export function biosSystemInputs(platformId: string): readonly BiosSystemInput[] {
  return libraryPlatform(platformId).requirements.map((requirement) => ({
    id: SLOT_IDS[requirement.id] ?? requirement.id,
    title: requirement.label,
    label: requirement.picker.label.replace(/ and (?:install|configure)$/, ""),
    accept: requirement.picker.accept,
    multiple: requirement.picker.multiple,
    hint: [requirement.expected, requirement.picker.hint].filter(Boolean).join(". "),
    requirement,
  }));
}

export interface BiosSystemRun {
  platformId: string;
  /** Every picked file across the system's slots. */
  files: readonly File[];
  /** One native import per non-empty slot, in slot order. */
  groups: readonly { slot: string; files: readonly File[] }[];
  /** Files that do not match their slot's expected package. */
  unmatched: readonly { file: File; expected: string }[];
}

export function biosSystemRunIncomplete(run: BiosSystemRun): boolean {
  return run.unmatched.length > 0 || (run.platformId !== "nds" && run.files.length === 0)
    || (run.platformId === "nds" && run.groups.some((group) => group.slot === "dsi")
      && !run.groups.some((group) => group.slot === "ds"));
}

export function biosSystemRun(platformId: string, slotFiles: Readonly<Record<string, readonly File[]>>): BiosSystemRun {
  const inputs = biosSystemInputs(platformId);
  const files: File[] = [];
  const groups: { slot: string; files: readonly File[] }[] = [];
  const unmatched: { file: File; expected: string }[] = [];
  for (const input of inputs) {
    const picked = slotFiles[input.id] ?? [];
    if (!picked.length) continue;
    files.push(...picked);
    try {
      validateLibrarySupportSelection(input.requirement, picked);
      groups.push({ slot: input.id, files: picked });
    } catch {
      unmatched.push(...picked.map((file) => ({ file, expected: input.hint })));
    }
  }
  return { platformId, files, groups, unmatched };
}
