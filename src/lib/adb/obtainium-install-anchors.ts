import type { AndroidUiNode, AndroidUiSnapshot } from "./android-ui";
import type { ObtainiumAppImport } from "./obtainium-catalog";
import { isObtainium, uiLabel } from "./obtainium-ui";
import { OBTAINIUM_PACKAGE, isUiDescendant, obtainiumDialog } from "./obtainium-ui-anchors";

function sharesDetailPane(
  snapshot: AndroidUiSnapshot, fields: readonly AndroidUiNode[], title: AndroidUiNode,
  button: AndroidUiNode, content: AndroidUiNode,
): boolean {
  let parent = title.parent;
  for (let depth = 0; parent !== null && depth < snapshot.nodes.length; depth++) {
    const pane = snapshot.nodes[parent];
    if (!pane || pane.packageName !== OBTAINIUM_PACKAGE) return false;
    // Names inside app-list buttons do not identify an open app detail pane.
    if (pane.className === "android.widget.Button") return false;
    if (isUiDescendant(snapshot, button, pane)) {
      // A common area containing search/add fields belongs to the list or a form.
      return !fields.some((node) => isUiDescendant(snapshot, node, pane));
    }
    if (pane === content) break;
    parent = pane.parent;
  }
  return false;
}

function normalizeLabel(value: string): string {
  return value.normalize("NFKC").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim().replace(/\s+/g, " ");
}

function installLabel(value: string, labels: readonly string[]): boolean {
  const text = normalizeLabel(value);
  return labels.some((action) => {
    // The download size may be a second line or an inline suffix.
    return text === action || (text.startsWith(action) && /^(?:\s*[·•(]\s*|\s+)\p{N}/u.test(text.slice(action.length)));
  });
}

export function obtainiumInstallAction(
  snapshot: AndroidUiSnapshot, app: ObtainiumAppImport, labels: ReadonlySet<string>,
): AndroidUiNode | undefined {
  if (!isObtainium(snapshot) || obtainiumDialog(snapshot)) return undefined;
  const owned = snapshot.nodes.filter((node) => node.packageName === OBTAINIUM_PACKAGE);
  const contents = owned.filter((node) => node.resourceId === "android:id/content");
  const content = contents[0];
  if (contents.length !== 1 || !content) return undefined;
  // The source URL is selected by the deep link and may be below the viewport.
  const titles = owned.filter((node) => !node.clickable && node.className !== "android.widget.Button"
    && uiLabel(node) === app.name && isUiDescendant(snapshot, node, content));
  if (!titles.length) return undefined;
  const installLabels = [...labels].map(normalizeLabel);
  const fields = owned.filter((node) => ["android.widget.EditText", "android.webkit.WebView"].includes(node.className));
  const buttons = owned.filter((node) => node.className === "android.widget.Button"
    && isUiDescendant(snapshot, node, content) && (installLabel(uiLabel(node), installLabels)
      || (!uiLabel(node).trim() && owned.some((child) => isUiDescendant(snapshot, child, node)
        && installLabel(uiLabel(child), installLabels))))
    && titles.some((title) => sharesDetailPane(snapshot, fields, title, node, content)));
  // Match the installed app's own translations; wrappers, order and layout do not select the action.
  const matches = buttons.filter((node) => !buttons.some((other) => other !== node && isUiDescendant(snapshot, node, other)));
  const primary = matches.length === 1 ? matches[0] : undefined;
  if (!primary || !primary.enabled || !primary.clickable || !primary.focusable) return undefined;
  const [left, top, right, bottom] = primary.bounds;
  return left >= content.bounds[0] && top >= content.bounds[1] && right <= content.bounds[2]
    && bottom <= content.bounds[3] && right > left && bottom > top ? primary : undefined;
}
