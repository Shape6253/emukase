import { Inflate } from "fflate";

const MIN_BIOS_BYTES = 4 * 1024 * 1024;
const MAX_BIOS_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_BYTES = 32 * 1024 * 1024;

export interface Ps2BiosInfo {
  romver: string;
  version: string;
  zone: string;
}

/** Read the ROM filesystem and ROMVER, as ARMSX2's native BIOS probe does. */
export function inspectPs2Bios(bytes: Uint8Array): Ps2BiosInfo | undefined {
  if (bytes.length < MIN_BIOS_BYTES || bytes.length > MAX_BIOS_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const text = (offset: number, length: number): string => decoder.decode(bytes.subarray(offset, offset + length));
  let remainingRecords = 65_536;
  for (let start = 0; start + 16 <= bytes.length; start += 16) {
    if (bytes[start] !== 82 || bytes[start + 1] !== 69 || bytes[start + 2] !== 83 || bytes[start + 3] !== 69 || bytes[start + 4] !== 84) continue;
    if (text(start, 10) !== "RESET\0\0\0\0\0") continue;
    let fileOffset = 0;
    let directoryFound = false;
    let romver: string | undefined;
    for (let position = start, count = 0; count < 2048 && position + 16 <= bytes.length; position += 16, count++) {
      if (--remainingRecords < 0) return undefined;
      const name = text(position, 10).split("\0")[0];
      if (!name) {
        if (!directoryFound || !romver) break;
        const match = /^(\d{2})(\d{2})([JAEHCTXP])([CDZ])(\d{4})(\d{2})(\d{2})$/.exec(romver);
        if (!match || match[4] === "Z") break;
        const date = new Date(`${match[5]}-${match[6]}-${match[7]}T00:00:00Z`);
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== `${match[5]}-${match[6]}-${match[7]}`) break;
        const zones: Readonly<Record<string, string>> = { J: "Japan", A: "USA", E: "Europe", H: "Asia", C: "China", T: "T10K", X: "Test", P: "Free" };
        const zone = zones[match[3] ?? ""];
        if (!zone) break;
        return { romver, version: `${Number(match[1])}.${match[2]}`, zone };
      }
      if (!/^[\x21-\x7e]{1,9}$/.test(name)) break;
      const size = view.getUint32(position + 12, true);
      if (fileOffset + size > bytes.length) break;
      if (name === "ROMDIR") directoryFound = fileOffset === start && size >= 32 && size % 16 === 0;
      if (name === "ROMVER" && size >= 14) romver = text(fileOffset, 14);
      fileOffset += Math.ceil(size / 16) * 16;
    }
  }
  return undefined;
}

interface ZipEntry { size: number; crc: number; method: number; dataStart: number; dataEnd: number }

function zipManifest(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let position = bytes.length - 22; position >= Math.max(0, bytes.length - 65_557); position--) {
    if (view.getUint32(position, true) === 0x06054b50 && position + 22 + view.getUint16(position + 20, true) === bytes.length) { end = position; break; }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error("Choose a complete, single-volume BIOS ZIP.");
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const offset = view.getUint32(end + 16, true);
  if (!count || count > 128 || view.getUint16(end + 8, true) !== count || directorySize > 65_536 || offset + directorySize !== end) {
    throw new Error("The BIOS ZIP directory is invalid or too large.");
  }
  const entries = new Map<string, ZipEntry>();
  const ranges: { start: number; end: number }[] = [];
  let position = offset;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || view.getUint32(position, true) !== 0x02014b50) throw new Error("The BIOS ZIP directory is incomplete.");
    const flags = view.getUint16(position + 8, true);
    const method = view.getUint16(position + 10, true);
    const compressedSize = view.getUint32(position + 20, true);
    const size = view.getUint32(position + 24, true);
    const crc = view.getUint32(position + 16, true);
    const nameLength = view.getUint16(position + 28, true);
    const next = position + 46 + nameLength + view.getUint16(position + 30, true) + view.getUint16(position + 32, true);
    const local = view.getUint32(position + 42, true);
    if (next > end || size > MAX_BIOS_BYTES || flags & ~0x080e || ![0, 8].includes(method) || view.getUint16(position + 34, true)
      || local + 30 > offset || view.getUint32(local, true) !== 0x04034b50) throw new Error("The BIOS ZIP contains invalid or unsupported entries.");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(position + 46, position + 46 + nameLength));
    const parts = name.replace(/\/$/, "").split("/");
    if (!name || /[\x00-\x1f\x7f\\]/.test(name) || parts.some((part) => !part || part === "." || part === "..") || entries.has(name)) {
      throw new Error("The BIOS ZIP contains unsafe or duplicate paths.");
    }
    const localNameLength = view.getUint16(local + 26, true);
    const dataStart = local + 30 + localNameLength + view.getUint16(local + 28, true);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > offset || localNameLength !== nameLength || view.getUint16(local + 6, true) !== flags
      || view.getUint16(local + 8, true) !== method || (method === 0 && compressedSize !== size)
      || bytes.subarray(local + 30, local + 30 + nameLength).some((byte, index) => byte !== bytes[position + 46 + index])) {
      throw new Error("A BIOS ZIP entry has inconsistent headers or sizes.");
    }
    const descriptor = !!(flags & 8);
    for (const [field, expected] of [[14, crc], [18, compressedSize], [22, size]] as const) {
      const actual = view.getUint32(local + field, true);
      if (actual !== expected && (!descriptor || actual !== 0)) throw new Error("A BIOS ZIP entry has inconsistent metadata.");
    }
    let rangeEnd = dataEnd;
    if (descriptor) {
      if (rangeEnd + 12 > offset) throw new Error("A BIOS ZIP data descriptor is truncated.");
      if (view.getUint32(rangeEnd, true) === 0x08074b50) rangeEnd += 4;
      if (rangeEnd + 12 > offset || view.getUint32(rangeEnd, true) !== crc
        || view.getUint32(rangeEnd + 4, true) !== compressedSize || view.getUint32(rangeEnd + 8, true) !== size) {
        throw new Error("A BIOS ZIP data descriptor is invalid.");
      }
      rangeEnd += 12;
    }
    if (ranges.some((range) => local < range.end && rangeEnd > range.start)) throw new Error("The BIOS ZIP contains overlapping entries.");
    ranges.push({ start: local, end: rangeEnd });
    total += size;
    if (total > 64 * 1024 * 1024) throw new Error("The extracted BIOS ZIP exceeds 64 MiB.");
    entries.set(name, { size, crc, method, dataStart, dataEnd });
    position = next;
  }
  if (position !== end) throw new Error("Unexpected data in the BIOS ZIP directory.");
  return entries;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function extractDeflated(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const output = new Uint8Array(entry.size);
  let written = 0;
  let finished = false;
  const stream = new Inflate((chunk, final) => {
    if (chunk.length > output.length - written) throw new Error("A BIOS ZIP entry exceeds its declared size.");
    output.set(chunk, written);
    written += chunk.length;
    finished = final;
  });
  // Small compressed chunks bound each decoder allocation and stop oversized
  // streams immediately, rather than silently truncating a fixed output buffer.
  for (let start = entry.dataStart; start < entry.dataEnd; start += 1024) {
    const end = Math.min(start + 1024, entry.dataEnd);
    stream.push(bytes.subarray(start, end), end === entry.dataEnd);
  }
  if (!finished || written !== entry.size) throw new Error("A BIOS ZIP entry is incomplete.");
  return output;
}

export interface Armsx2Input { file: File; info: Ps2BiosInfo }

/** Identify content before naming it; ZIP paths and user filenames never become device paths. */
export async function validateArmsx2Inputs(files: readonly File[], signal?: AbortSignal): Promise<Armsx2Input> {
  const file = files[0];
  if (files.length !== 1 || !(file instanceof File) || file.size <= 0 || file.size > MAX_ZIP_BYTES) {
    throw new Error("Choose one PS2 BIOS image or ZIP, up to 32 MiB.");
  }
  signal?.throwIfAborted();
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal?.throwIfAborted();
  let candidates: Uint8Array[];
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) {
    const manifest = zipManifest(bytes);
    candidates = [...manifest.values()].filter((entry) => entry.size >= MIN_BIOS_BYTES).map((entry) => {
      const compressed = bytes.subarray(entry.dataStart, entry.dataEnd);
      const data = entry.method === 0 ? compressed : extractDeflated(bytes, entry);
      if (data.length !== entry.size || crc32(data) !== entry.crc) throw new Error("A BIOS ZIP entry failed its integrity check.");
      return data;
    });
  } else candidates = [bytes];
  const identified = candidates.map((data) => ({ data, info: inspectPs2Bios(data) })).filter((item) => item.info !== undefined);
  const selected = identified[0];
  if (identified.length !== 1 || !selected?.info) throw new Error("Choose exactly one valid PS2 console BIOS. This file or ZIP could not be identified unambiguously.");
  signal?.throwIfAborted();
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(selected.data));
  signal?.throwIfAborted();
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
  const name = `ps2-${selected.info.romver.slice(0, 5).toLowerCase()}-${selected.info.romver.slice(6)}-${hash}.bin`;
  return { file: new File([Uint8Array.from(selected.data)], name, { type: "application/octet-stream" }), info: selected.info };
}
