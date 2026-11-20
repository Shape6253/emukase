import { AndroidUiStateChangedError, type AndroidUiNode, type AndroidUiSnapshot } from "./android-ui";
import { runAndroidUiAction } from "./android-ui-dump";
import { DeviceUnlockRequiredError } from "./device-awake";
import { EMULATORS } from "./emulators";
import type { DeviceTransport } from "./transport";

// Keep the helper's emulatorOwner allowlist in sync.
const emulatorPackages = new Set<string>([...EMULATORS.azahar.packages, ...EMULATORS.melonds.packages]);
type UiAction = "click" | "focus" | "scroll-forward" | "scroll-backward";

export interface AndroidDocumentActionGuard {
  token: string;
  directory: string;
}

function identity(node: AndroidUiNode): {
  id: string; text: string; description: string; className: string; enabled: boolean; clickable: boolean; checked: boolean; selected: boolean;
} {
  return { id: node.resourceId, text: node.text, description: node.description,
    className: node.className, enabled: node.enabled, clickable: node.clickable, checked: node.checked, selected: node.selected };
}

function hierarchy(snapshot: AndroidUiSnapshot) {
  return snapshot.nodes.map((entry) => ({ ...identity(entry), parent: entry.parent,
    focusable: entry.focusable, scrollable: entry.scrollable }));
}

/** A stale action can only reuse the original review, not approve changed toggles or paths. */
export function sameEmulatorUiActionState(before: AndroidUiSnapshot, after: AndroidUiSnapshot): boolean {
  return before.user === after.user && before.component === after.component && before.windowId === after.windowId
    && before.rotation === after.rotation && before.nodes.every((node, index) => node.packageName === after.nodes[index]?.packageName)
    && JSON.stringify(hierarchy(before)) === JSON.stringify(hierarchy(after));
}

function actionResult(result: string | undefined, action: UiAction): boolean {
  if (result === undefined || result === "ui-action:unsupported") return false;
  if (result === "ui-action:locked") throw new DeviceUnlockRequiredError();
  if (/^ui-action:stale:[a-z-]+$/.test(result)) {
    throw new AndroidUiStateChangedError(`Android changed the addressed control before the action (${result.slice("ui-action:stale:".length)}).`);
  }
  const confirmed = action === "click" ? "clicked" : action === "focus" ? "focused" : "scrolled";
  if (result === `ui-action:${confirmed}`) return true;
  throw new Error("Android UI action did not return a confirmed response; it will not be replayed.");
}

/** Compose wizard buttons lack view IDs. Address the reviewed button by its
 * position in the complete visible hierarchy and verify every node on Android. */
export async function clickEsdeWizardNode(
  device: DeviceTransport, user: number, snapshot: AndroidUiSnapshot, node: AndroidUiNode, signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const owner = "org.es_de.frontend";
  if (!Number.isSafeInteger(user) || user < 0 || snapshot.user !== user || !snapshot.nodes.includes(node)
    || !snapshot.component.startsWith(`${owner}/`) || node.packageName !== owner || !node.enabled || !node.clickable) {
    throw new Error("ES-DE wizard action targets an unreviewed control.");
  }
  return performTreeAction(device, user, snapshot, node, "click", signal);
}

/** Keep the semantic path limited to the reviewed app integrations. */
export function supportsEmulatorUiAction(node: AndroidUiNode): boolean {
  return emulatorPackages.has(node.packageName);
}

/** Address a reviewed app node even when its own ID is missing or virtual. */
export async function actOnEmulatorUiNode(
  device: DeviceTransport, user: number, snapshot: AndroidUiSnapshot, node: AndroidUiNode,
  action: Exclude<UiAction, "focus">, signal?: AbortSignal,
): Promise<boolean> {
  if (!supportsEmulatorUiAction(node)) return false;
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(user) || user < 0 || snapshot.user !== user || !snapshot.nodes.includes(node)
    || !snapshot.component.startsWith(`${node.packageName}/`) || !node.enabled) {
    throw new Error("Android UI action targets an unreviewed emulator control.");
  }
  return performTreeAction(device, user, snapshot, node, action, signal);
}

async function performTreeAction(
  device: DeviceTransport, user: number, snapshot: AndroidUiSnapshot, node: AndroidUiNode, action: Exclude<UiAction, "focus">,
  signal?: AbortSignal,
): Promise<boolean> {
  const owner = node.packageName;
  if (snapshot.windowId === undefined || snapshot.nodes.some((entry) => entry.packageName !== owner)) return false;
  const ancestors = action === "click" ? clickableAncestors(snapshot, node) : node.scrollable ? [] : undefined;
  if (!ancestors) return false;
  return actionResult(await runAndroidUiAction(device, user, JSON.stringify({
    user, packageName: owner, windowId: snapshot.windowId, rotation: snapshot.rotation, action,
    source: identity(node), sourceIndex: snapshot.nodes.indexOf(node), ancestors, guards: [],
    hierarchy: hierarchy(snapshot),
  }), signal), action);
}

function clickableAncestors(snapshot: AndroidUiSnapshot, node: AndroidUiNode, focus = false): ReturnType<typeof identity>[] | undefined {
  const ancestors: ReturnType<typeof identity>[] = [];
  let target = node;
  while (!(focus ? target.focusable : target.clickable)) {
    const parent = target.parent === null ? undefined : snapshot.nodes[target.parent];
    if (!parent || ancestors.length >= 32) return undefined;
    ancestors.push(identity(parent));
    target = parent;
  }
  return ancestors;
}

/** Returns false only when no action was dispatched and the legacy path is safe. */
export async function clickAndroidUiNode(
  device: DeviceTransport, user: number, snapshot: AndroidUiSnapshot, node: AndroidUiNode,
  signal?: AbortSignal, document?: AndroidDocumentActionGuard, allowFocusedOffscreen = false,
): Promise<boolean> {
  return performAndroidUiNode(device, user, snapshot, node, signal, document, allowFocusedOffscreen, "click");
}

/** Focus a visible DocumentsUI row without opening it or advancing global keys. */
export async function focusAndroidUiNode(
  device: DeviceTransport, user: number, snapshot: AndroidUiSnapshot, node: AndroidUiNode,
  signal: AbortSignal | undefined, document: AndroidDocumentActionGuard,
): Promise<boolean> {
  return performAndroidUiNode(device, user, snapshot, node, signal, document, false, "focus");
}

async function performAndroidUiNode(
  device: DeviceTransport, user: number, snapshot: AndroidUiSnapshot, node: AndroidUiNode,
  signal: AbortSignal | undefined, document: AndroidDocumentActionGuard | undefined,
  allowFocusedOffscreen: boolean, action: "click" | "focus",
): Promise<boolean> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(user) || user < 0 || snapshot.user !== user || !snapshot.nodes.includes(node) || !node.enabled
    || !snapshot.component.startsWith(`${node.packageName}/`)) throw new Error("Android UI action targets an unreviewed control.");
  const picker = ["com.android.documentsui", "com.google.android.documentsui"].includes(node.packageName);
  const installer = ["com.android.packageinstaller", "com.google.android.packageinstaller"].includes(node.packageName);
  if (action === "focus" && !picker) return false;
  if ((!picker && !installer) || snapshot.windowId === undefined || !node.resourceId) return false;
  // DocumentsUI window IDs survive folder changes: bind actions to the system docId too.
  if (picker && !document) return false;
  if (document && (!/^[a-f0-9]{1,16}$/.test(document.token) || !document.directory.startsWith("primary:")
    || /[\x00-\x1f\x7f]/.test(document.directory))) throw new Error("Invalid Android document action guard.");
  const ancestors = clickableAncestors(snapshot, node, action === "focus");
  if (!ancestors) return false;
  const guardNodes = new Map<string, ReturnType<typeof identity>[]>();
  for (const entry of snapshot.nodes) {
    if (entry.packageName !== node.packageName || !entry.resourceId) continue;
    if (!(installer || ["android:id/alertTitle", "android:id/message"].includes(entry.resourceId)
      || ["breadcrumb_text", "header_title"].some((id) => entry.resourceId === `${node.packageName}:id/${id}`))) continue;
    const group = guardNodes.get(entry.resourceId);
    if (group) group.push(identity(entry));
    else guardNodes.set(entry.resourceId, [identity(entry)]);
    if (guardNodes.size > 64) return false;
  }
  const guards = [...guardNodes].map(([id, nodes]) => ({ id, nodes }));
  const result = await runAndroidUiAction(device, user, JSON.stringify({ user, packageName: node.packageName,
    windowId: snapshot.windowId, rotation: snapshot.rotation, source: identity(node), ancestors, guards, document, allowFocusedOffscreen, action }), signal);
  return actionResult(result, action);
}
