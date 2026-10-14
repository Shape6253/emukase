import { assertAndroidUser } from "./android-user";
import { dumpAndroidUi } from "./android-ui-dump";
import { checkAbort } from "./setup-events";
import { shellCommand, type DeviceTransport } from "./transport";

export interface AndroidUiNode {
  packageName: string;
  text: string;
  description: string;
  resourceId: string;
  className: string;
  bounds: readonly [number, number, number, number];
  parent: number | null;
  enabled: boolean;
  clickable: boolean;
  focusable: boolean;
  focused: boolean;
  scrollable: boolean;
  checked: boolean;
  selected: boolean;
}

export interface AndroidUiSnapshot {
  nodes: readonly AndroidUiNode[];
  rotation: number;
  user: number;
  component: string;
}

export class AndroidUiStateChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AndroidUiStateChangedError";
  }
}

function xmlText(value: string): string {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(value)) {
    throw new Error("Android UI contains an invalid XML entity.");
  }
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_, entity: string) => {
    const names: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
    if (!entity.startsWith("#")) return names[entity] ?? "";
    const code = entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isSafeInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
      || (code < 0x20 && ![9, 10, 13].includes(code))) {
      throw new Error("Android UI contains an invalid XML character.");
    }
    return String.fromCodePoint(code);
  });
}

function attributes(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  const attribute = /\s+([A-Za-z][\w:-]*)\s*=\s*(["'])(.*?)\2/gy;
  let offset = 0;
  while (source.slice(offset).trim()) {
    attribute.lastIndex = offset;
    const match = attribute.exec(source);
    if (!match || match[1] === undefined || match[3] === undefined || Object.hasOwn(result, match[1])) {
      throw new Error("Android UI contains invalid XML attributes.");
    }
    result[match[1]] = xmlText(match[3]);
    offset = attribute.lastIndex;
  }
  return result;
}

function uiBoolean(values: Record<string, string>, key: string): boolean {
  if (values[key] !== "true" && values[key] !== "false") {
    throw new Error(`Android UI is missing ${key} state.`);
  }
  return values[key] === "true";
}

function uiNode(values: Record<string, string>, parent: number | null): AndroidUiNode {
  const bounds = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(values.bounds ?? "");
  if (!bounds) throw new Error("Android UI contains invalid bounds.");
  const coordinates = bounds.slice(1).map(Number);
  const [left, top, right, bottom] = coordinates;
  if (left === undefined || top === undefined || right === undefined || bottom === undefined
    || coordinates.some((value) => !Number.isSafeInteger(value) || Math.abs(value) > 100_000)
    || right < left || bottom < top) {
    throw new Error("Android UI contains invalid bounds.");
  }
  for (const key of ["package", "text", "content-desc", "resource-id", "class"]) {
    if (values[key] === undefined) throw new Error(`Android UI is missing ${key}.`);
  }
  return {
    packageName: values.package ?? "", text: values.text ?? "", description: values["content-desc"] ?? "",
    resourceId: values["resource-id"] ?? "", className: values.class ?? "", bounds: [left, top, right, bottom], parent,
    enabled: uiBoolean(values, "enabled"), clickable: uiBoolean(values, "clickable"),
    focusable: uiBoolean(values, "focusable"), focused: uiBoolean(values, "focused"),
    scrollable: uiBoolean(values, "scrollable"), checked: uiBoolean(values, "checked"),
    selected: uiBoolean(values, "selected"),
  };
}

export function parseAndroidUi(xml: string): { nodes: AndroidUiNode[]; rotation: number } {
  if (xml.length > 2_097_152 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(xml)) {
    throw new Error("Android UI hierarchy is invalid or too large.");
  }
  const source = xml.trim().replace(/^<\?xml\s+[^<>]*\?>\s*/, "");
  const nodes: AndroidUiNode[] = [];
  const stack: number[] = [];
  let rotation: number | undefined;
  let open = false;
  let closed = false;
  let offset = 0;
  const token = /<[^<>]+>|[^<]+/gy;
  while (offset < source.length) {
    token.lastIndex = offset;
    const match = token.exec(source);
    if (!match) throw new Error("Android UI contains malformed XML.");
    offset = token.lastIndex;
    const value = match[0];
    if (!value.startsWith("<")) {
      if (value.trim()) throw new Error("Android UI contains unexpected XML text.");
    } else if (/^<hierarchy\s/.test(value)) {
      if (open || closed) throw new Error("Android UI contains multiple hierarchies.");
      const values = attributes(value.slice("<hierarchy".length, -1));
      if (!/^[0-3]$/.test(values.rotation ?? "")) throw new Error("Android UI rotation is invalid.");
      rotation = Number(values.rotation);
      open = true;
    } else if (value === "</hierarchy>") {
      if (!open || stack.length || closed) throw new Error("Android UI hierarchy is incomplete.");
      open = false;
      closed = true;
    } else if (value === "</node>") {
      if (!open || !stack.length) throw new Error("Android UI contains an unmatched closing node.");
      stack.pop();
    } else if (/^<node\s/.test(value)) {
      if (!open || closed || nodes.length >= 8192 || stack.length >= 64) {
        throw new Error("Android UI node hierarchy is invalid or too large.");
      }
      const selfClosing = /\/\s*>$/.test(value);
      const body = value.slice("<node".length, -1).replace(/\/\s*$/, "");
      nodes.push(uiNode(attributes(body), stack.at(-1) ?? null));
      if (!selfClosing) stack.push(nodes.length - 1);
    } else {
      throw new Error("Android UI contains unsupported XML.");
    }
  }
  if (!closed || open || stack.length || rotation === undefined || !nodes.length) {
    throw new Error("Android UI hierarchy is incomplete.");
  }
  return { nodes, rotation };
}

function normalizeComponent(component: string): string {
  const [packageName, activity] = component.split("/");
  return activity?.startsWith(".") ? `${packageName}/${packageName}${activity}` : component;
}

export function androidUiForegroundFromOutput(output: string, user: number): string {
  if (output.length > 4_194_304 || !Number.isSafeInteger(user) || user < 0) {
    throw new Error("Android foreground window output is invalid.");
  }
  let current = output;
  const history = /^WINDOW MANAGER LAST ANR \(dumpsys window lastanr\)\r?$/m.exec(output);
  if (history) {
    // Cached ANR state includes its own display section and focus identifiers.
    const live = /^WINDOW MANAGER POLICY STATE \(dumpsys window policy\)\r?$/m.exec(output.slice(history.index));
    if (!live) throw new Error("Android current window state was not confirmed.");
    current = output.slice(history.index + live.index);
  }
  const topDisplays = [...current.matchAll(/\bmTopFocusedDisplayId=([^\s]+)/g)];
  if (topDisplays.some((match) => match[1] !== "0")) {
    throw new Error("Android UI setup requires the primary display to have focus.");
  }
  const displays = [...current.matchAll(/^\s*Display:\s*mDisplayId=(\d+)\b[^\r\n]*/gm)];
  let primary = current;
  if (displays.length) {
    const matches = displays.flatMap((match, index) => match[1] === "0" ? [index] : []);
    const index = matches[0];
    if (matches.length !== 1 || index === undefined) throw new Error("Android primary display was not confirmed.");
    const heading = displays[index];
    if (!heading) throw new Error("Android primary display was not confirmed.");
    primary = current.slice(heading.index, displays[index + 1]?.index ?? current.length);
  }
  const lines = [...primary.matchAll(/\bmCurrentFocus=[^\r\n]*/g)];
  if (lines.length === 1 && /^mCurrentFocus=null\s*$/.test(lines[0]?.[0] ?? "")) {
    throw new AndroidUiStateChangedError("Android is changing its foreground window.");
  }
  if (lines.length === 1 && /^mCurrentFocus=Window\{[a-f\d]+\s+u0\s+NotificationShade\}\s*$/.test(lines[0]?.[0] ?? "")) {
    throw new AndroidUiStateChangedError("Android's notification shade is covering the app.");
  }
  const focused = lines.map((line) => /\bu(\d+)\s+([\w.$]+\/[\w.$]+)/.exec(line[0]));
  if (focused.length !== 1 || focused.some((match) => !match || Number(match[1]) !== user)) {
    throw new Error("Android foreground window was not confirmed for this profile.");
  }
  const component = focused[0]?.[2];
  if (!component) throw new Error("Android foreground window is ambiguous.");
  return normalizeComponent(component);
}

export async function androidUiForeground(device: DeviceTransport, user: number, signal?: AbortSignal): Promise<string> {
  await assertAndroidUser(device, user, signal);
  const component = androidUiForegroundFromOutput(await device.shell(shellCommand("dumpsys", "window")), user);
  await assertAndroidUser(device, user, signal);
  return component;
}

export async function readAndroidUi(device: DeviceTransport, user: number, signal?: AbortSignal): Promise<AndroidUiSnapshot> {
  const component = await androidUiForeground(device, user, signal);
  const path = `/data/local/tmp/emukase-ui-${crypto.randomUUID()}.xml`;
  try {
    const output = await dumpAndroidUi(device, path, signal);
    checkAbort(signal);
    const dumped = output.split(/\r?\n/).some((line) => [
      `UI hierarchy dumped to: ${path}`, `UI hierchary dumped to: ${path}`,
    ].includes(line.trim()));
    if (!dumped) {
      if (/ERROR: (?:could not get idle state\.|null root node returned by UiTestAutomationBridge\.)/.test(output)) {
        throw new AndroidUiStateChangedError("Android UI is not ready for a hierarchy snapshot.");
      }
      throw new Error("Android did not provide a UI hierarchy.");
    }
    const parsed = parseAndroidUi(await device.shell(shellCommand("cat", path)));
    checkAbort(signal);
    if (await androidUiForeground(device, user, signal) !== component) {
      throw new AndroidUiStateChangedError("Android foreground changed while reading its UI.");
    }
    return { ...parsed, user, component };
  } finally {
    const cleanup = device.restorationDevice ?? device;
    await cleanup.shell(shellCommand("rm", "-f", path)).catch(() => {});
  }
}

export async function assertAndroidUiSnapshot(
  device: DeviceTransport, user: number, snapshot: AndroidUiSnapshot, signal?: AbortSignal,
): Promise<void> {
  if (snapshot.user !== user) throw new Error("Android UI action targets another profile.");
  const current = await readAndroidUi(device, user, signal);
  if (JSON.stringify(current) !== JSON.stringify(snapshot)) {
    throw new AndroidUiStateChangedError("Android UI changed before the action.");
  }
  if (await androidUiForeground(device, user, signal) !== snapshot.component) {
    throw new AndroidUiStateChangedError("Android foreground changed before the action.");
  }
}

export async function tapAndroidUi(
  device: DeviceTransport, user: number, snapshot: AndroidUiSnapshot, node: AndroidUiNode, signal?: AbortSignal,
): Promise<void> {
  if (!snapshot.nodes.includes(node) || !node.enabled || !node.clickable
    || !snapshot.component.startsWith(`${node.packageName}/`)) {
    throw new Error("Android UI action is not an enabled control in the foreground app.");
  }
  const [left, top, right, bottom] = node.bounds;
  if (left < 0 || top < 0 || right <= left || bottom <= top) throw new Error("Android UI control is not visible.");
  await tapAndroidUiPoint(device, user, snapshot, node, [Math.floor((left + right) / 2), Math.floor((top + bottom) / 2)], signal);
}

export async function tapAndroidUiPoint(
  device: DeviceTransport, user: number, snapshot: AndroidUiSnapshot, node: AndroidUiNode,
  point: readonly [number, number], signal?: AbortSignal,
): Promise<void> {
  const [x, y] = point;
  const [left, top, right, bottom] = node.bounds;
  if (!snapshot.nodes.includes(node) || !node.enabled || !snapshot.component.startsWith(`${node.packageName}/`)
    || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x < left || x >= right || y < top || y >= bottom) {
    throw new Error("Android UI point is outside the reviewed foreground control.");
  }
  await assertAndroidUiSnapshot(device, user, snapshot, signal);
  checkAbort(signal);
  const output = await device.shell(shellCommand("input", "tap", String(x), String(y)));
  if (/Error:|Exception|Permission Denial/i.test(output)) throw new Error("Android UI action failed.");
  checkAbort(signal);
}

export async function pressAndroidUiKey(
  device: DeviceTransport, user: number, snapshot: AndroidUiSnapshot,
  key: "KEYCODE_TAB" | "KEYCODE_ENTER", signal?: AbortSignal,
): Promise<void> {
  if (key !== "KEYCODE_TAB" && key !== "KEYCODE_ENTER") throw new Error("Unsupported Android UI key.");
  if (key === "KEYCODE_TAB") {
    // TAB only moves focus. Confirmation still verifies the full current UI.
    if (snapshot.user !== user || await androidUiForeground(device, user, signal) !== snapshot.component) {
      throw new Error("Android foreground changed before keyboard navigation.");
    }
  } else {
    await assertAndroidUiSnapshot(device, user, snapshot, signal);
  }
  checkAbort(signal);
  const output = await device.shell(shellCommand("input", "keyevent", key));
  if (/Error:|Exception|Permission Denial/i.test(output)) throw new Error("Android UI action failed.");
  checkAbort(signal);
}
