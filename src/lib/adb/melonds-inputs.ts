export type MelonDsConsole = "DS" | "DSi";

export interface MelonDsSupportFile {
  relativePath: string;
  bytes: number;
}

const DS_FILES: Readonly<Record<string, readonly number[]>> = {
  "bios7.bin": [0x4000], "bios9.bin": [0x1000], "firmware.bin": [0x20000, 0x40000, 0x80000],
};
const DSI_FILES: Readonly<Record<string, readonly number[]>> = {
  "bios7.bin": [0x10000], "bios9.bin": [0x10000], "firmware.bin": [0x20000], "nand.bin": [],
};
// Retail DSi boot ROM fingerprints distinguish the equally sized ARM7/ARM9 dumps.
const DSI_BOOT_ROMS: Readonly<Record<string, string>> = {
  "2946281e730e71f7cafdb125f5cb60fed944ca5d610ee1e082c441b602b5f4e2": "bios7.bin",
  "47538922a8e8a8e79b922ff1203863ef5c40d9c54656a8d2c89c56ece52029ce": "bios9.bin",
};

/** Match Android's directory verifier; NAND contents still need native validation. */
export function melonDsFileValid(console: MelonDsConsole, name: string, bytes: number): boolean {
  const required = console === "DS" ? DS_FILES : DSI_FILES;
  if (!Object.hasOwn(required, name)) return false;
  const sizes = required[name];
  return sizes !== undefined && Number.isSafeInteger(bytes) && bytes > 0 && (!sizes.length || sizes.includes(bytes));
}

export function melonDsDirectories(console: MelonDsConsole, files: readonly MelonDsSupportFile[]): string[] {
  const groups = new Map<string, Map<string, number>>();
  for (const file of files) {
    const slash = file.relativePath.lastIndexOf("/");
    const directory = file.relativePath.slice(0, slash + 1);
    const name = file.relativePath.slice(slash + 1);
    if (!melonDsFileValid(console, name, file.bytes)) continue;
    let group = groups.get(directory);
    if (!group) { group = new Map(); groups.set(directory, group); }
    group.set(name, file.bytes);
  }
  const names = Object.keys(console === "DS" ? DS_FILES : DSI_FILES);
  return [...groups].filter(([, group]) => names.every((name) => group.has(name))).map(([directory]) => directory.replace(/\/$/, ""));
}

export interface MelonDsInputs { console: MelonDsConsole; files: readonly File[] }

export async function validateMelonDsInputs(files: readonly File[], signal?: AbortSignal): Promise<MelonDsInputs> {
  signal?.throwIfAborted();
  if (files.length !== 3 && files.length !== 4) throw new Error("Choose a complete set of four DSi files or three DS files.");
  const console = files.length === 3 ? "DS" : "DSi";
  const names = new Set<string>();
  const normalized: File[] = [];
  for (const file of files) {
    if (!(file instanceof File)) throw new Error("Choose DSi BIOS, firmware and NAND files.");
    signal?.throwIfAborted();
    let name: string | undefined;
    if (console === "DS") {
      name = file.size === 0x4000 ? "bios7.bin" : file.size === 0x1000 ? "bios9.bin"
        : DS_FILES["firmware.bin"]?.includes(file.size) ? "firmware.bin" : undefined;
    } else if (file.size === 0x10000) {
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      signal?.throwIfAborted();
      const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      name = DSI_BOOT_ROMS[hash];
    } else {
      name = file.size === 0x20000 ? "firmware.bin" : "nand.bin";
    }
    if (!name || !melonDsFileValid(console, name, file.size) || names.has(name)) {
      throw new Error("The selected files do not form an identifiable DS or DSi system dump. Choose the complete BIOS, firmware and NAND set; file names can be arbitrary.");
    }
    names.add(name);
    normalized.push(name === file.name ? file : new File([file.slice()], name, { lastModified: file.lastModified, type: file.type }));
  }
  if (!melonDsDirectories(console, normalized.map((file) => ({ relativePath: file.name, bytes: file.size }))).length) {
    throw new Error("Choose all four DSi files together: bios7.bin, bios9.bin, firmware.bin and nand.bin. Supply the separate DS set in a second selection if needed.");
  }
  return { console, files: normalized };
}
