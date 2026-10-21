import { Unzip, UnzipInflate } from "fflate";

export type EdenInputKind = "keys" | "firmware";

export interface EdenInput {
  file: File;
  kind: EdenInputKind;
  ncaCount?: number;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

async function checkArchiveContents(file: File, manifest: ReadonlyMap<string, { bytes: number; crc: number }>, signal?: AbortSignal): Promise<void> {
  const seen = new Set<string>();
  let completed = 0;
  let failure: Error | undefined;
  const unzip = new Unzip((entry) => {
    const expected = manifest.get(entry.name);
    if (!expected || seen.has(entry.name)) throw new Error("The firmware ZIP entries disagree with its directory.");
    seen.add(entry.name);
    let bytes = 0;
    let crc = 0xffffffff;
    entry.ondata = (error, data, final) => {
      if (error) { failure = error; return; }
      bytes += data.length;
      if (bytes > expected.bytes) throw new Error("A firmware ZIP entry exceeds its declared size.");
      for (const byte of data) crc = (crcTable[(crc ^ byte) & 255] ?? 0) ^ (crc >>> 8);
      if (final) {
        if (bytes !== expected.bytes || ((crc ^ 0xffffffff) >>> 0) !== expected.crc) throw new Error("A firmware ZIP entry is incomplete or has an invalid checksum.");
        completed++;
      }
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  const reader = file.stream().getReader();
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      unzip.push(value ?? new Uint8Array(), done);
      if (failure) throw failure;
      if (done) break;
    }
    if (completed !== manifest.size) throw new Error("The firmware ZIP is missing complete NCA entries.");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

async function validateKeys(file: File): Promise<void> {
  if (file.size > 1_048_576) throw new Error("Switch key files must be smaller than 1 MiB.");
  const text = await file.text();
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const value = line.replace(/#.*/, "").trim();
    if (!value) continue;
    const entry = /^([a-zA-Z0-9_]+)\s*=\s*(?:0x)?([a-fA-F\d]+)$/.exec(value);
    const name = entry?.[1]?.toLowerCase();
    const key = entry?.[2];
    if (!name || !key || key.length < 32 || key.length > 2048 || key.length % 2 || names.has(name)) {
      throw new Error("The selected keys file contains invalid or duplicate entries.");
    }
    names.add(name);
  }
  if (!names.size || (file.name === "prod.keys" && ![...names].some((name) => /^master_key_[a-f\d]{2}$/.test(name)))) {
    throw new Error("The selected keys file does not contain the expected Switch keys.");
  }
}

/** Bound the ZIP manifest, then stream every entry to check names, sizes and CRCs. */
async function validateFirmware(file: File, signal?: AbortSignal): Promise<number> {
  if (file.size > 1_073_741_824) throw new Error("Firmware archives larger than 1 GiB are not supported.");
  const tail = new Uint8Array(await file.slice(-65_557).arrayBuffer());
  const view = new DataView(tail.buffer);
  let end = -1;
  for (let index = tail.length - 22; index >= 0; index--) {
    if (view.getUint32(index, true) === 0x06054b50 && index + 22 + view.getUint16(index + 20, true) === tail.length) {
      end = index;
      break;
    }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error("Choose a complete, single-volume firmware ZIP.");
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const offset = view.getUint32(end + 16, true);
  if (!count || count > 2048 || view.getUint16(end + 8, true) !== count || size > 1_048_576
    || offset + size !== file.size - tail.length + end) throw new Error("The firmware ZIP directory is invalid or unsupported.");
  const bytes = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer());
  const directory = new DataView(bytes.buffer);
  const names = new Set<string>();
  const manifest = new Map<string, { bytes: number; crc: number }>();
  let position = 0;
  let totalBytes = 0;
  for (let index = 0; index < count; index++) {
    if (position + 46 > bytes.length || directory.getUint32(position, true) !== 0x02014b50) throw new Error("The firmware ZIP directory is incomplete.");
    const flags = directory.getUint16(position + 8, true);
    const compression = directory.getUint16(position + 10, true);
    const unpacked = directory.getUint32(position + 24, true);
    const nameLength = directory.getUint16(position + 28, true);
    const next = position + 46 + nameLength + directory.getUint16(position + 30, true) + directory.getUint16(position + 32, true);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(position + 46, position + 46 + nameLength));
    if (next > bytes.length || !/^[a-f\d]{32}(?:\.cnmt)?\.nca$/.test(name) || names.has(name)
      || flags & 1 || ![0, 8].includes(compression) || !unpacked
      || directory.getUint16(position + 34, true) || directory.getUint32(position + 42, true) >= offset) {
      throw new Error("Firmware ZIPs must contain only unique NCA files at the archive root, without folders or encryption.");
    }
    totalBytes += unpacked;
    if (totalBytes > 2_147_483_648) throw new Error("The extracted firmware exceeds 2 GiB.");
    names.add(name);
    manifest.set(name, { bytes: unpacked, crc: directory.getUint32(position + 16, true) });
    position = next;
  }
  if (position !== bytes.length) throw new Error("Unexpected data in the firmware ZIP directory.");
  await checkArchiveContents(file, manifest, signal);
  return count;
}

export async function validateEdenInputs(files: readonly File[], signal?: AbortSignal): Promise<readonly EdenInput[]> {
  if (!files.length) throw new Error("Choose prod.keys, optional title.keys, or a firmware ZIP.");
  const names = new Set<string>();
  const result: EdenInput[] = [];
  for (const file of files) {
    signal?.throwIfAborted();
    if (!(file instanceof File) || !Number.isSafeInteger(file.size) || file.size <= 0 || names.has(file.name)
      || /[\x00-\x1f\x7f/\\"*:<>?|]/.test(file.name) || new TextEncoder().encode(file.name).length > 255) {
      throw new Error("Choose nonempty files with unique, valid Android file names.");
    }
    names.add(file.name);
    if (["prod.keys", "title.keys"].includes(file.name)) {
      await validateKeys(file);
      result.push({ file, kind: "keys" });
    } else if (/\.zip$/i.test(file.name)) {
      if (result.some((input) => input.kind === "firmware")) throw new Error("Choose one firmware ZIP at a time.");
      result.push({ file, kind: "firmware", ncaCount: await validateFirmware(file, signal) });
    } else {
      throw new Error("Eden accepts prod.keys, optional title.keys, and a firmware ZIP here. Add games under ROM files.");
    }
  }
  signal?.throwIfAborted();
  // Eden needs prod.keys to initialize keys and completed onboarding to add
  // title.keys through its installer after the setup keys button is disabled.
  const order = (input: EdenInput): number => input.file.name === "prod.keys" ? 0 : input.kind === "firmware" ? 1 : 2;
  return result.sort((left, right) => order(left) - order(right));
}
