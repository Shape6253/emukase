import { AndroidUiStateChangedError, assertAndroidUiSnapshot, readAndroidUi, tapAndroidUiPoint, type AndroidUiNode, type AndroidUiSnapshot } from "./android-ui";
import { shellCommand, type DeviceTransport } from "./transport";

export interface EmulatorUiContext {
  device: DeviceTransport;
  user: number;
  signal?: AbortSignal;
  ensureUnlocked: () => Promise<boolean>;
}

export function uiDescendant(snapshot: AndroidUiSnapshot, node: AndroidUiNode, resourceId: string): boolean {
  let current: AndroidUiNode | undefined = node;
  while (current) {
    if (current.resourceId === resourceId) return true;
    current = current.parent === null ? undefined : snapshot.nodes[current.parent];
  }
  return false;
}

export function uiWithin(snapshot: AndroidUiSnapshot, node: AndroidUiNode, ancestor: AndroidUiNode): boolean {
  let current: AndroidUiNode | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent === null ? undefined : snapshot.nodes[current.parent];
  }
  return false;
}

export function uiNode(snapshot: AndroidUiSnapshot, resourceId: string, text?: string): AndroidUiNode | undefined {
  const matches = snapshot.nodes.filter((node) => node.resourceId === resourceId && (text === undefined || node.text === text));
  if (matches.length > 1) throw new Error(`Android control is ambiguous: ${resourceId}.`);
  return matches[0];
}

function uncoveredBounds(snapshot: AndroidUiSnapshot, node: AndroidUiNode): readonly [number, number, number, number] {
  const [left, originalTop, right, originalBottom] = node.bounds;
  let top = originalTop;
  let bottom = originalBottom;
  if (uiDescendant(snapshot, node, `${node.packageName}:id/dir_list`)) {
    const appBar = uiNode(snapshot, `${node.packageName}:id/app_bar`);
    const footer = uiNode(snapshot, `${node.packageName}:id/container_save`);
    if (appBar && appBar.bounds[0] < right && appBar.bounds[2] > left) top = Math.max(top, appBar.bounds[3]);
    if (footer && footer.bounds[3] > footer.bounds[1] && footer.bounds[0] < right && footer.bounds[2] > left) bottom = Math.min(bottom, footer.bounds[1]);
  }
  return [left, top, right, bottom];
}

export function emulatorNodeVisible(snapshot: AndroidUiSnapshot, node: AndroidUiNode): boolean {
  let target: AndroidUiNode | undefined = node;
  while (target && !target.clickable) target = target.parent === null ? undefined : snapshot.nodes[target.parent];
  if (!target) return false;
  const [left, top, right, bottom] = uncoveredBounds(snapshot, target);
  return target.enabled && right > left && bottom > top;
}

export async function waitEmulatorUi<T>(
  context: EmulatorUiContext, inspect: (snapshot: AndroidUiSnapshot) => T | undefined | Promise<T | undefined>, timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    context.signal?.throwIfAborted();
    await context.ensureUnlocked();
    try {
      const result = await inspect(await readAndroidUi(context.device, context.user, context.signal));
      if (result !== undefined) return result;
    } catch (error) {
      if (!(error instanceof AndroidUiStateChangedError)) throw error;
    }
  }
  throw new Error("The emulator interface did not become ready. Retry with the device unlocked.");
}

export async function tapEmulatorNode(context: EmulatorUiContext, snapshot: AndroidUiSnapshot, node: AndroidUiNode): Promise<void> {
  const signature = (view: AndroidUiSnapshot, source: AndroidUiNode): string => {
    const labels: unknown[] = [source.resourceId, source.className, source.text, source.description, source.enabled];
    let parent = source.parent;
    for (let depth = 0; depth < 2 && parent !== null; depth++) {
      const ancestor = view.nodes[parent];
      if (!ancestor) break;
      const descendants = view.nodes.filter((entry) => {
        let index = entry.parent;
        while (index !== null) {
          if (index === parent) return true;
          index = view.nodes[index]?.parent ?? null;
        }
        return false;
      });
      labels.push(ancestor.resourceId, descendants.map((entry) => [entry.resourceId, entry.text, entry.description]));
      parent = ancestor.parent;
    }
    return JSON.stringify(labels);
  };
  const expected = signature(snapshot, node);
  const component = snapshot.component;
  for (let attempt = 0; attempt < 4; attempt++) {
    let target: AndroidUiNode | undefined = node;
    while (target && !target.clickable) target = target.parent === null ? undefined : snapshot.nodes[target.parent];
    if (!target) throw new Error("Android control has no clickable action.");
    await context.ensureUnlocked();
    try {
      // DocumentsUI exposes rows behind its collapsing toolbar/footer. Use only
      // the area that the current snapshot confirms is uncovered.
      const [left, top, right, bottom] = uncoveredBounds(snapshot, target);
      if (right <= left || bottom <= top) throw new Error("Android control is covered by the app toolbar.");
      await tapAndroidUiPoint(context.device, context.user, snapshot, target,
        [Math.floor((left + right) / 2), Math.floor((top + bottom) / 2)], context.signal);
      return;
    } catch (error) {
      if (!(error instanceof AndroidUiStateChangedError) || attempt === 3) throw error;
      snapshot = await readAndroidUi(context.device, context.user, context.signal);
      const matches = snapshot.nodes.filter((entry) => entry.resourceId === node.resourceId && signature(snapshot, entry) === expected);
      if (snapshot.component !== component || matches.length !== 1 || !matches[0]) throw error;
      node = matches[0];
    }
  }
}

/** Resolve resource IDs on Android so translated labels never become selectors in code. */
export async function androidResourceText(context: EmulatorUiContext, packageName: string, resource: string): Promise<string> {
  if (!/^[\w.]+$/.test(packageName) || !/^[\w.]+:string\/[\w]+$/.test(resource)) throw new Error("Invalid Android text resource.");
  const output = (await context.device.shell(shellCommand("cmd", "overlay", "lookup", "--user", String(context.user), packageName, resource))).trim();
  if (!output || output.length > 4096 || /[\r\n]|^Error:/.test(output)) throw new Error(`Android could not resolve ${resource}.`);
  return output;
}

export async function scrollEmulatorList(context: EmulatorUiContext, snapshot: AndroidUiSnapshot, list: AndroidUiNode): Promise<void> {
  // Legacy DocumentsUI uses a nested collapsing header: a list gesture must
  // span that header to advance. Its complete observed bounds remain the
  // gesture reference; taps still use the uncovered row bounds above.
  const [left, visibleTop, right, bottom] = uncoveredBounds(snapshot, list);
  const top = list.className === "android.widget.GridView" ? list.bounds[1] : visibleTop;
  if (!list.enabled || !list.scrollable || right <= left || bottom <= visibleTop) throw new Error("Android list cannot be scrolled.");
  await context.ensureUnlocked();
  try {
    await assertAndroidUiSnapshot(context.device, context.user, snapshot, context.signal);
  } catch (error) {
    // No gesture has been sent. Let the bounded navigation loop observe the
    // current layout after a drawer or scrolling animation changes its bounds.
    if (error instanceof AndroidUiStateChangedError) return;
    throw error;
  }
  const x = Math.floor((left + right) / 2);
  // Begin inside the uncovered rows even when a large header leaves only a
  // small strip visible, then cross the nested header so it can collapse.
  const margin = Math.floor((bottom - visibleTop) / 5);
  await context.device.shell(shellCommand("input", "swipe", String(x), String(bottom - margin), String(x), String(top + margin), "250"));
}
