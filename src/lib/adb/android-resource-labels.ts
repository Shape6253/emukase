import { assertAndroidUser } from "./android-user";
import { checkAbort } from "./setup-events";
import { shellCommand, type DeviceTransport } from "./transport";

export type AndroidResourceLabels = ReadonlyMap<string, ReadonlySet<string>>;
const MAX_RESOURCE_BYTES = 16_777_216;

interface Chunk { type: number; header: number; start: number; end: number }

function invalid(): never {
  throw new Error("The installed application's Android string resources are invalid or unsupported.");
}

/** Read string translations from the installed resource table, including app-specific languages. */
export function parseAndroidResourceLabels(
  bytes: Uint8Array, packageName: string, resources: readonly string[],
): AndroidResourceLabels {
  if (!/^[A-Za-z][\w]*(?:\.[\w]+)+$/.test(packageName) || !resources.length || resources.length > 128
    || resources.some((key) => !/^[A-Za-z_][\w]*$/.test(key)) || new Set(resources).size !== resources.length
    || bytes.length < 12 || bytes.length > MAX_RESOURCE_BYTES) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const range = (start: number, size: number, end = bytes.length): void => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0 || start + size > end) invalid();
  };
  const chunkAt = (start: number, end = bytes.length): Chunk => {
    range(start, 8, end);
    const header = view.getUint16(start + 2, true);
    const size = view.getUint32(start + 4, true);
    if (header < 8 || size < header) invalid();
    range(start, size, end);
    return { type: view.getUint16(start, true), header, start, end: start + size };
  };
  const stringPool = (chunk: Chunk): string[] => {
    if (chunk.type !== 1 || chunk.header < 28) invalid();
    const count = view.getUint32(chunk.start + 8, true);
    const flags = view.getUint32(chunk.start + 16, true);
    const start = chunk.start + view.getUint32(chunk.start + 20, true);
    if (count > 262_144 || start < chunk.start + chunk.header + count * 4 || start > chunk.end) invalid();
    range(chunk.start + chunk.header, count * 4, chunk.end);
    const utf8 = (flags & 256) !== 0;
    const decoder = new TextDecoder(utf8 ? "utf-8" : "utf-16le", { fatal: true });
    const strings: string[] = [];
    for (let index = 0; index < count; index++) {
      let position = start + view.getUint32(chunk.start + chunk.header + index * 4, true);
      const length = (): number => {
        range(position, utf8 ? 1 : 2, chunk.end);
        const first = utf8 ? view.getUint8(position++) : view.getUint16(position, true);
        if (!utf8) position += 2;
        if (first < (utf8 ? 128 : 32768)) return first;
        range(position, utf8 ? 1 : 2, chunk.end);
        if (utf8) return (first & 127) * 256 + view.getUint8(position++);
        const result = (first & 32767) * 65536 + view.getUint16(position, true);
        position += 2;
        return result;
      };
      let size = length();
      size = utf8 ? length() : size * 2;
      range(position, size + (utf8 ? 1 : 2), chunk.end);
      if (bytes[position + size] !== 0 || (!utf8 && bytes[position + size + 1] !== 0)) invalid();
      strings.push(decoder.decode(bytes.subarray(position, position + size)));
    }
    return strings;
  };
  const table = chunkAt(0);
  if (table.type !== 2 || table.header < 12 || table.end !== bytes.length) invalid();
  const values = new Map<number, Set<string | number>>();
  const ids = new Map<string, number>();
  let globalStrings: string[] | undefined;
  for (let position = table.header; position < table.end;) {
    const chunk = chunkAt(position, table.end);
    if (chunk.type === 1) {
      if (globalStrings) invalid();
      globalStrings = stringPool(chunk);
    } else if (chunk.type === 0x200) {
      if (chunk.header < 284 || !globalStrings) invalid();
      const owner = new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(position + 12, position + 268)).replace(/\0.*$/s, "");
      if (owner === packageName) {
        const packageId = view.getUint32(position + 8, true);
        const typeOffset = chunk.header >= 288 ? view.getUint32(position + 284, true) : 0;
        const types = stringPool(chunkAt(position + view.getUint32(position + 268, true), chunk.end));
        const keys = stringPool(chunkAt(position + view.getUint32(position + 276, true), chunk.end));
        if (packageId < 1 || packageId > 255) invalid();
        for (let part = position + chunk.header; part < chunk.end;) {
          const type = chunkAt(part, chunk.end);
          if (type.type === 0x201) {
            if (type.header < 24) invalid();
            const typeId = view.getUint8(part + 8);
            if (types[typeId - 1] === "string") {
              const flags = view.getUint8(part + 9);
              const count = view.getUint32(part + 12, true);
              const entries = part + view.getUint32(part + 16, true);
              if (flags !== 0 || !typeId || typeId + typeOffset > 255 || count > 65536
                || entries < part + type.header + count * 4 || entries > type.end) invalid();
              range(part + type.header, count * 4, entries);
              for (let index = 0; index < count; index++) {
                const relative = view.getUint32(part + type.header + index * 4, true);
                if (relative === 0xffffffff) continue;
                const entry = entries + relative;
                range(entry, 8, type.end);
                const size = view.getUint16(entry, true);
                const entryFlags = view.getUint16(entry + 2, true);
                const key = keys[view.getUint32(entry + 4, true)];
                if (!key || size < 8 || (entryFlags & 9) !== 0) invalid();
                const value = entry + size;
                range(value, 8, type.end);
                if (view.getUint16(value, true) < 8) invalid();
                const kind = view.getUint8(value + 3);
                const data = view.getUint32(value + 4, true);
                const id = ((packageId << 24) | ((typeId + typeOffset) << 16) | index) >>> 0;
                if (resources.includes(key)) {
                  if (ids.has(key) && ids.get(key) !== id) invalid();
                  ids.set(key, id);
                }
                if (kind !== 1 && kind !== 3) continue;
                const text = kind === 3 ? globalStrings[data] : data;
                if (text === undefined) invalid();
                const translations = values.get(id) ?? new Set<string | number>();
                translations.add(text);
                values.set(id, translations);
              }
            }
          }
          part = type.end;
        }
      }
    }
    position = chunk.end;
  }
  const resolve = (id: number, visited: ReadonlySet<number>): Set<string> => {
    if (visited.has(id) || visited.size > 32) invalid();
    const labels = new Set<string>();
    const next = new Set([...visited, id]);
    for (const value of values.get(id) ?? []) {
      if (typeof value === "number") {
        for (const label of resolve(value, next)) labels.add(label);
      } else if (value.trim() && value.length <= 4096 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) labels.add(value);
    }
    return labels;
  };
  const result = new Map<string, ReadonlySet<string>>();
  for (const resource of resources) {
    const id = ids.get(resource);
    const labels = id === undefined ? undefined : resolve(id, new Set());
    if (!labels?.size) throw new Error(`The installed application does not expose the required string resource: ${resource}.`);
    result.set(resource, labels);
  }
  return result;
}

export async function readAndroidResourceLabels(
  device: DeviceTransport, user: number, packageName: string, resources: readonly string[], signal?: AbortSignal,
): Promise<AndroidResourceLabels> {
  if (!/^[A-Za-z][\w]*(?:\.[\w]+)+$/.test(packageName)) throw new Error("Invalid Android resource package.");
  await assertAndroidUser(device, user, signal);
  const output = await device.shell(shellCommand("pm", "path", "--user", String(user), packageName));
  const paths = output.trim().split(/\r?\n/).map((line) => /^package:(\/[^\x00-\x1f]+\.apk)$/.exec(line)?.[1]);
  const bases = paths.filter((path) => path?.endsWith("/base.apk"));
  const path = paths.length === 1 ? paths[0] : bases.length === 1 ? bases[0] : undefined;
  if (!path || paths.some((entry) => !entry)) throw new Error("The installed application's base APK could not be located.");
  checkAbort(signal);
  const encoded = (await device.shell(`${shellCommand("unzip", "-p", path, "resources.arsc")} | ${shellCommand("base64")}`)).replace(/[\r\n]/g, "");
  await assertAndroidUser(device, user, signal);
  if (!encoded || encoded.length > MAX_RESOURCE_BYTES * 4 / 3 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) invalid();
  const decoded = atob(encoded);
  return parseAndroidResourceLabels(Uint8Array.from(decoded, (character) => character.charCodeAt(0)), packageName, resources);
}
