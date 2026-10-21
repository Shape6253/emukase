import { AndroidUiStateChangedError, type AndroidUiNode, type AndroidUiSnapshot } from "./android-ui";
import { runAndroidUiAction } from "./android-ui-dump";
import { DeviceUnlockRequiredError } from "./device-awake";
import type { DeviceTransport } from "./transport";

export interface AndroidDocumentActionGuard {
  token: string;
  directory: string;
}

function identity(node: AndroidUiNode): {
  id: string; text: string; description: string; className: string; enabled: boolean; clickable: boolean;
} {
  return { id: node.resourceId, text: node.text, description: node.description,
    className: node.className, enabled: node.enabled, clickable: node.clickable };
}

function actionResult(result: string | undefined, action: "click" | "focus" = "click"): boolean {
  if (result === undefined || result === "ui-action:unsupported") return false;
  if (result === "ui-action:locked") throw new DeviceUnlockRequiredError();
  if (/^ui-action:stale:[a-z-]+$/.test(result)) {
    throw new AndroidUiStateChangedError(`Android changed the addressed control before the action (${result.slice("ui-action:stale:".length)}).`);
  }
  if (result === (action === "focus" ? "ui-action:focused" : "ui-action:clicked")) return true;
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
  if (snapshot.windowId === undefined || snapshot.nodes.some((entry) => entry.packageName !== owner)) return false;
  return actionResult(await runAndroidUiAction(device, JSON.stringify({
    user, packageName: owner, windowId: snapshot.windowId, rotation: snapshot.rotation,
    source: identity(node), sourceIndex: snapshot.nodes.indexOf(node), ancestors: [], guards: [],
    hierarchy: snapshot.nodes.map((entry) => ({ ...identity(entry), parent: entry.parent, focusable: entry.focusable })),
  }), signal));
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
  const ancestors: ReturnType<typeof identity>[] = [];
  let target = node;
  while (!(action === "focus" ? target.focusable : target.clickable)) {
    const parent = target.parent === null ? undefined : snapshot.nodes[target.parent];
    if (!parent || ancestors.length >= 32) return false;
    ancestors.push(identity(parent));
    target = parent;
  }
  const guardIds = new Set(snapshot.nodes.filter((entry) => entry.packageName === node.packageName && entry.resourceId
    && (installer || ["android:id/alertTitle", "android:id/message"].includes(entry.resourceId)
      || ["breadcrumb_text", "header_title"].some((id) => entry.resourceId === `${node.packageName}:id/${id}`)))
    .map((entry) => entry.resourceId));
  if (guardIds.size > 64) return false;
  const guards = [...guardIds].map((id) => ({ id,
    nodes: snapshot.nodes.filter((entry) => entry.resourceId === id && entry.packageName === node.packageName).map(identity),
  }));
  const result = await runAndroidUiAction(device, JSON.stringify({ user, packageName: node.packageName,
    windowId: snapshot.windowId, rotation: snapshot.rotation, source: identity(node), ancestors, guards, document, allowFocusedOffscreen, action }), signal);
  return actionResult(result, action);
}
