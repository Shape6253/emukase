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

/** Returns false only when no action was dispatched and the legacy path is safe. */
export async function clickAndroidUiNode(
  device: DeviceTransport, user: number, snapshot: AndroidUiSnapshot, node: AndroidUiNode,
  signal?: AbortSignal, document?: AndroidDocumentActionGuard, allowFocusedOffscreen = false,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(user) || user < 0 || snapshot.user !== user || !snapshot.nodes.includes(node) || !node.enabled
    || !snapshot.component.startsWith(`${node.packageName}/`)) throw new Error("Android UI action targets an unreviewed control.");
  const picker = ["com.android.documentsui", "com.google.android.documentsui"].includes(node.packageName);
  const installer = ["com.android.packageinstaller", "com.google.android.packageinstaller"].includes(node.packageName);
  if ((!picker && !installer) || snapshot.windowId === undefined || !node.resourceId) return false;
  // DocumentsUI window IDs survive folder changes: bind actions to the system docId too.
  if (picker && !document) return false;
  if (document && (!/^[a-f0-9]{1,16}$/.test(document.token) || !document.directory.startsWith("primary:")
    || /[\x00-\x1f\x7f]/.test(document.directory))) throw new Error("Invalid Android document action guard.");
  const ancestors: ReturnType<typeof identity>[] = [];
  let target = node;
  while (!target.clickable) {
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
    windowId: snapshot.windowId, rotation: snapshot.rotation, source: identity(node), ancestors, guards, document, allowFocusedOffscreen }), signal);
  if (result === undefined || result === "ui-action:unsupported") return false;
  if (result === "ui-action:locked") throw new DeviceUnlockRequiredError();
  if (/^ui-action:stale:[a-z-]+$/.test(result)) {
    throw new AndroidUiStateChangedError(`Android changed the addressed control before the action (${result.slice("ui-action:stale:".length)}).`);
  }
  // A false accessibility result is not permission to send a second confirmation.
  if (result === "ui-action:clicked") return true;
  throw new Error("Android UI action did not return a confirmed response; it will not be replayed.");
}
