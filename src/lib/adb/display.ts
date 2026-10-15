import { shellCommand, type DeviceTransport } from "./transport";

/** One logical Android display observed once at connect time. Display-only evidence. */
export interface DeviceDisplay {
  id: number;
  width: number;
  height: number;
  /** Reduced W:H ratio in reported orientation, e.g. "9:20". */
  ratio: string;
  type?: string;
}

function gcd(a: number, b: number): number {
  let x = a,
    y = b;
  while (y) [x, y] = [y, x % y];
  return x;
}

export function displayRatio(width: number, height: number): string {
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

/** Parse logical displays, preferring WindowManager's rotated/overridden size.
 * Nested mode/address objects are common on Android; a flat brace regex truncates
 * their records. Older releases put the ID in the enclosing logical-display section. */
export function parseDisplayDump(output: string): DeviceDisplay[] {
  if (output.length > 2_097_152 || /Permission Denial|SecurityException|^Error:/m.test(output)) {
    throw new Error("Display inspection was unavailable.");
  }
  const byId = new Map<number, { display: DeviceDisplay; priority: number }>();
  for (const match of output.matchAll(/(?:(mOverrideDisplayInfo|mBaseDisplayInfo)\s*=\s*)?\bDisplayInfo\{/g)) {
    const start = match.index! + match[0].length;
    let end = start,
      depth = 1,
      quoted = false;
    for (; end < output.length && depth; end++) {
      const char = output[end];
      if (char === '"' && output[end - 1] !== "\\") quoted = !quoted;
      if (!quoted) {
        if (char === "{") depth++;
        else if (char === "}") depth--;
      }
    }
    if (depth) throw new Error("Android returned incomplete display evidence.");
    const block = output.slice(start, end - 1);
    const section = output.slice(0, match.index).split(/\r?\n/).slice(-16).join("\n");
    const id =
      /\bdisplayId[=\s]+(\d+)/.exec(block)?.[1] ?? /\bmDisplayId\s*=\s*(\d+)/.exec(section)?.[1];
    const size = /\breal[=\s]+(\d+)\s*x\s*(\d+)/.exec(block);
    if (id === undefined || !size) throw new Error("Android returned unrecognized display evidence.");
    const displayId = Number(id);
    const width = Number(size[1]);
    const height = Number(size[2]);
    if (
      !Number.isSafeInteger(displayId) ||
      displayId < 0 ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width > 32_768 ||
      height > 32_768
    ) {
      throw new Error("Android returned invalid display evidence.");
    }
    const type = /\btype[=\s]+([A-Z_]+)/.exec(block)?.[1];
    const priority = match[1] === "mOverrideDisplayInfo" ? 2 : match[1] === "mBaseDisplayInfo" ? 0 : 1;
    const seen = byId.get(displayId);
    if (seen?.priority === priority && (seen.display.width !== width || seen.display.height !== height)) {
      throw new Error("Android returned ambiguous display evidence.");
    }
    if (byId.size >= 32 && !seen) throw new Error("Android returned ambiguous display evidence.");
    if (!seen || priority > seen.priority)
      byId.set(displayId, {
        priority,
        display: {
          id: displayId,
          width,
          height,
          ratio: displayRatio(width, height),
          ...(type ? { type } : {}),
        },
      });
  }
  if (!byId.size) throw new Error("Android returned unrecognized display evidence.");
  return [...byId.values()]
    .map(({ display }) => display)
    .sort((a, b) => a.id - b.id);
}

/** Read-only single-shot display probe for connect-time device info. Never throws: [] means unknown. */
export async function probeDisplays(device: DeviceTransport): Promise<DeviceDisplay[]> {
  try {
    return parseDisplayDump(await device.shell(shellCommand("dumpsys", "display")));
  } catch {
    return [];
  }
}

export function formatDisplays(displays: readonly DeviceDisplay[]): string {
  if (!displays.length) return "Display info unavailable";
  const parts = displays.map(
    (display) => `${display.width} × ${display.height} (${display.ratio})`,
  );
  return `${displays.length === 1 ? "1 display" : `${displays.length} displays`} · ${parts.join(" + ")}`;
}
