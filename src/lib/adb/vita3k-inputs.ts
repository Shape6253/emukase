export const VITA3K_FIRMWARE_FILENAME = "PSVUPDAT.PUP";

const HEADER_BYTES = 0x80;
const RECORD_BYTES = 0x20;
// Application resource limit, not a claim about a firmware format maximum.
const MAX_TABLE_BYTES = 1024 * 1024;
const MAGIC = [0x53, 0x43, 0x45, 0x55, 0x46] as const;

export interface Vita3kFirmwareInfo {
  pupVersion: number;
  firmwareVersion: number;
  buildNumber: number;
  fileCount: number;
  /** Bytes needed to inspect the fixed header and complete file table. */
  tableEnd: number;
}

export interface Vita3kInput {
  file: File;
  kind: "firmware";
  info: Vita3kFirmwareInfo;
}

/** Inspect only the fixed header; this does not validate file records or payloads.
 * Layout: Vita3K/vita3k/packages/src/pup.cpp and TeamMolecule/sceutils/pup_fiction.py.
 * Unknown/reserved fields and firmware versions are deliberately not constrained.
 */
export function inspectVita3kFirmwareHeader(header: Uint8Array, totalBytes: number): Vita3kFirmwareInfo | undefined {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < HEADER_BYTES || header.length < HEADER_BYTES
    || MAGIC.some((byte, index) => header[index] !== byte)) return undefined;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const fileCount = view.getUint32(0x18, true);
  const tableEnd = HEADER_BYTES + fileCount * RECORD_BYTES;
  if (!fileCount || tableEnd > totalBytes || tableEnd > MAX_TABLE_BYTES) return undefined;
  return {
    pupVersion: view.getUint32(0x08, true),
    firmwareVersion: view.getUint32(0x10, true),
    buildNumber: view.getUint32(0x14, true),
    fileCount,
    tableEnd,
  };
}

/** Accept a complete stored PUP or just its header/table plus the actual file size.
 * Checks container structure only, not Sony signatures or encrypted payload integrity.
 */
export function inspectVita3kFirmware(bytes: Uint8Array, totalBytes: number = bytes.byteLength): Vita3kFirmwareInfo | undefined {
  const info = inspectVita3kFirmwareHeader(bytes, totalBytes);
  if (!info || bytes.length < info.tableEnd) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const limit = BigInt(totalBytes);
  const ranges: { start: bigint; end: bigint }[] = [];
  for (let index = 0; index < info.fileCount; index++) {
    const position = HEADER_BYTES + index * RECORD_BYTES;
    const offset = view.getBigUint64(position + 8, true);
    const length = view.getBigUint64(position + 16, true);
    if (offset < BigInt(info.tableEnd) || !length || offset + length > limit) return undefined;
    ranges.push({ start: offset, end: offset + length });
  }
  ranges.sort((left, right) => left.start < right.start ? -1 : left.start > right.start ? 1 : 0);
  for (let index = 1; index < ranges.length; index++) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (previous && current && previous.end > current.start) return undefined;
  }
  return info;
}

/** Read at most 1 MiB of metadata; never load a complete firmware into memory. */
export async function validateVita3kInputs(files: readonly File[], signal?: AbortSignal): Promise<Vita3kInput> {
  signal?.throwIfAborted();
  const file = files[0];
  if (files.length !== 1 || !(file instanceof File) || file.name !== VITA3K_FIRMWARE_FILENAME
    || !Number.isSafeInteger(file.size) || file.size < HEADER_BYTES) {
    throw new Error("Choose one official Vita firmware update named PSVUPDAT.PUP.");
  }
  const header = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
  signal?.throwIfAborted();
  const headerInfo = inspectVita3kFirmwareHeader(header, file.size);
  if (!headerInfo) throw new Error("The selected file does not contain a valid, supported Vita PUP header.");
  const table = new Uint8Array(await file.slice(0, headerInfo.tableEnd).arrayBuffer());
  signal?.throwIfAborted();
  const info = inspectVita3kFirmware(table, file.size);
  if (!info) throw new Error("The Vita firmware container has truncated, overlapping, or invalid file records.");
  return {
    file,
    kind: "firmware",
    info,
  };
}
