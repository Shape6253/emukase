import type { AndroidUiSnapshot } from "./android-ui";
import { obtainiumHome } from "./obtainium-ui";
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

export function obtainiumSourceDetailVisible(snapshot: AndroidUiSnapshot, packageId?: string): boolean {
  const owned = snapshot.nodes.filter((node) => node.packageName === OBTAINIUM_PACKAGE);
  const buttons = owned.filter((node) => node.className === "android.widget.Button");
  const fields = owned.filter((node) => node.className === "android.widget.EditText");
  // Empty home also has a scrollable title/message and a separate add button.
  if (!fields.length && obtainiumHome(snapshot)) return false;
  // Flutter may flatten the header's name/author column. Its scroll view and
  // fixed action bar are siblings, so neither exact text parents nor a button
  // inside the scrolling content are required to recognize the source detail.
  const labels = owned.filter((node) => node.className === "android.view.View" && !node.clickable && !!(node.text || node.description)
    && !buttons.some((button) => isUiDescendant(snapshot, node, button)));
  return owned.some((scroll) => {
    if (!scroll.scrollable || fields.some((field) => isUiDescendant(snapshot, field, scroll))) return false;
    const detailLabels = labels.filter((label) => isUiDescendant(snapshot, label, scroll));
    if (detailLabels.length < 2) return false;
    if (packageId !== undefined && !detailLabels.some((label) => (label.text || label.description)
      .split("\n").some((line) => line.trim() === packageId))) return false;
    let index = scroll.parent;
    while (index !== null) {
      const pane = snapshot.nodes[index];
      if (!pane || fields.some((field) => isUiDescendant(snapshot, field, pane))) return false;
      if (buttons.some((button) => isUiDescendant(snapshot, button, pane)
        && !isUiDescendant(snapshot, button, scroll))) return true;
      index = pane.parent;
    }
    return false;
  });
}
