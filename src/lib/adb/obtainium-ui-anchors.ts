import type { AndroidUiNode, AndroidUiSnapshot } from "./android-ui";

export const OBTAINIUM_PACKAGE = "dev.imranr.obtainium";
const DOCUMENTATION = "https://github.com/ImranR98/Obtainium/blob/main/README.md";
const GOOGLE_WARNING = "https://keepandroidopen.org/";

export interface ObtainiumDialog {
  card: AndroidUiNode;
  actions: readonly AndroidUiNode[];
  kind: "welcome" | "warning" | "import" | "unknown";
  expansion?: AndroidUiNode;
}

function label(node: AndroidUiNode): string {
  return node.text || node.description;
}

function visible(node: AndroidUiNode): boolean {
  const [left, top, right, bottom] = node.bounds;
  return node.enabled && left >= 0 && top >= 0 && right > left && bottom > top;
}

export function isUiDescendant(snapshot: AndroidUiSnapshot, node: AndroidUiNode, ancestor: AndroidUiNode): boolean {
  let index = node.parent;
  for (let depth = 0; index !== null && depth < snapshot.nodes.length; depth++) {
    const parent = snapshot.nodes[index];
    if (parent === ancestor) return true;
    index = parent?.parent ?? null;
  }
  return false;
}

function warningLayout(snapshot: AndroidUiSnapshot, body: readonly AndroidUiNode[]): boolean {
  const scrolls = body.filter((node) => node.className === "android.widget.ScrollView");
  const scroll = scrolls[0];
  const text = body.filter((node) => label(node).trim());
  const [title, first, link, last] = text;
  if (scrolls.length !== 1 || !scroll || text.length !== 4 || !title || !first || !link || !last) return false;
  // Flutter exposes the translated link text, while its target URI stays in the tap handler.
  return [title, first, last].every((node) => node.className === "android.view.View" && !node.clickable)
    && text.every((node) => node.enabled && isUiDescendant(snapshot, node, scroll))
    && body.every((node) => ["android.view.View", "android.widget.ScrollView", "android.widget.Button"].includes(node.className))
    && link.className === "android.widget.Button" && link.clickable && link.focusable
    && first.parent === link.parent && last.parent === link.parent
    && body.filter((node) => node.clickable).length === 1;
}

export function obtainiumDialog(snapshot: AndroidUiSnapshot): ObtainiumDialog | undefined {
  if (snapshot.component !== `${OBTAINIUM_PACKAGE}/${OBTAINIUM_PACKAGE}.MainActivity`) return undefined;
  const owned = snapshot.nodes.filter((node) => node.packageName === OBTAINIUM_PACKAGE);
  const contents = owned.filter((node) => node.resourceId === "android:id/content");
  const content = contents[0];
  if (contents.length !== 1 || !content) return undefined;
  const barriers = owned.filter((node) => node.className === "android.view.View" && node.clickable && node.focusable
    && visible(node) && node.bounds.every((value, index) => value === content.bounds[index])
    && !snapshot.nodes.some((child) => child.parent === snapshot.nodes.indexOf(node)));
  const cards: { card: AndroidUiNode; actions: AndroidUiNode[] }[] = [];
  for (const barrier of barriers) {
    const siblings = owned.filter((node) => node !== barrier && node.parent === barrier.parent);
    for (const sibling of siblings) {
      for (const card of owned.filter((node) => isUiDescendant(snapshot, node, sibling)
        && node.className === "android.view.View" && visible(node)
        && node.bounds[0] > content.bounds[0] && node.bounds[2] < content.bounds[2])) {
        const children = owned.filter((node) => node.parent === snapshot.nodes.indexOf(card));
        const actions = children.filter((node) => node.className === "android.widget.Button");
        const body = children.filter((node) => !actions.includes(node));
        if ((actions.length === 1 || actions.length === 2) && body.length
          && body.some((node) => ["android.view.View", "android.widget.ScrollView"].includes(node.className))
          && actions.every((node) => node.enabled && node.clickable && node.focusable
            && (node.bounds.every((value) => value === 0)
              || node.bounds[1] >= Math.max(...body.map((child) => child.bounds[3]))))) {
          cards.push({ card, actions });
          break;
        }
      }
    }
  }
  const dialog = cards[0];
  if (cards.length !== 1 || !dialog) return undefined;
  const body = owned.filter((node) => isUiDescendant(snapshot, node, dialog.card) && !dialog.actions.includes(node));
  const links = body.filter((node) => node.className === "android.widget.Button").map(label);
  const welcome = links.some((value) => value.includes(DOCUMENTATION));
  const warning = links.some((value) => value.includes(GOOGLE_WARNING)) || (!welcome && warningLayout(snapshot, body));
  if (dialog.actions.length === 1 && welcome !== warning) return { ...dialog, kind: welcome ? "welcome" : "warning" };
  const expansions = body.filter((node) => node.clickable);
  if (dialog.actions.length === 2 && expansions.length === 1
    && !body.some((node) => node.className === "android.widget.EditText") && !welcome && !warning) {
    return { ...dialog, kind: "import", expansion: expansions[0] };
  }
  return { ...dialog, kind: "unknown" };
}
