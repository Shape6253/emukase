import type { AndroidUiNode, AndroidUiSnapshot } from "./android-ui";
import { OBTAINIUM_PACKAGE, isUiDescendant, obtainiumDialog } from "./obtainium-ui-anchors";

export function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalize(item)]));
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

export function obtainiumPayloadObserved(snapshot: AndroidUiSnapshot, payload: string): boolean {
  const dialog = obtainiumDialog(snapshot);
  if (dialog?.kind !== "import") return false;
  return snapshot.nodes.some((node) => {
    if (node.packageName !== OBTAINIUM_PACKAGE || !isUiDescendant(snapshot, node, dialog.card)) return false;
    try { return canonicalJson(JSON.parse(node.text || node.description) as unknown) === payload; } catch { return false; }
  });
}

export function obtainiumImportAcknowledged(snapshot: AndroidUiSnapshot, count: number): boolean {
  if (!Number.isSafeInteger(count) || count < 1 || count > 32 || obtainiumDialog(snapshot)) return false;
  const content = snapshot.nodes.find((node) => node.packageName === OBTAINIUM_PACKAGE && node.resourceId === "android:id/content");
  if (!content) return false;
  const expectedCount = new RegExp(`(?:^|\\D)${count}(?:\\D|$)`);
  return snapshot.nodes.some((node) => {
    const message = node.text || node.description;
    const parent = node.parent === null ? undefined : snapshot.nodes[node.parent];
    // Flutter's Snackbar is a text child of the full-size Scaffold, beside
    // its page body. Only the injected count is stable across translations.
    return node.packageName === OBTAINIUM_PACKAGE && node.className === "android.view.View" && node.enabled
      && !node.clickable && !message.includes("\n") && /\D/.test(message) && expectedCount.test(message)
      && parent?.className === "android.view.View" && !parent.clickable
      && parent.bounds.every((value, index) => value === content.bounds[index])
      && isUiDescendant(snapshot, node, content);
  });
}

export function obtainiumUpdateError(snapshot: AndroidUiSnapshot): AndroidUiNode | undefined {
  const dialog = obtainiumDialog(snapshot);
  if (dialog?.kind !== "unknown" || dialog.actions.length !== 1) return undefined;
  const body = snapshot.nodes.filter((node) => node.packageName === OBTAINIUM_PACKAGE
    && isUiDescendant(snapshot, node, dialog.card) && !dialog.actions.includes(node));
  if (body.some((node) => node.clickable || node.className === "android.widget.EditText"
    || node.className === "android.widget.Button")) return undefined;
  const labels = body.map((node) => node.text || node.description).filter(Boolean);
  // CheckUpdatesException presents an empty message followed by grouped errors.
  // Identify its structure without depending on the translated dialog title.
  return labels.length === 2 && labels.some((value) => value.startsWith("\n")
    && value.slice(1).split("\n\n").every((group) => /\S[\s\S]* \[[^\[\]\r\n]+\]$/.test(group)))
    ? dialog.actions[0] : undefined;
}
