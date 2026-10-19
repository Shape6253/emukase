import type { AndroidUiNode, AndroidUiSnapshot } from "./android-ui";
import { uiWithin } from "./emulator-ui";

function primaryParts(directory: string): string[] | undefined {
  if (!directory.startsWith("primary:")) return undefined;
  const path = directory.slice("primary:".length);
  const parts = path ? path.split("/") : [];
  return parts.some((part) => !part || part === "." || part === ".." || /[\x00-\x1f\x7f]/.test(part)) ? undefined : parts;
}

function breadcrumbs(snapshot: AndroidUiSnapshot, picker: string): AndroidUiNode[] | undefined {
  const containers = snapshot.nodes.filter((node) => node.resourceId === `${picker}:id/horizontal_breadcrumb`);
  const container = containers[0];
  // A scrolling breadcrumb may have recycled its root or intermediate parents.
  // Never turn a visible suffix into a primary-storage identity.
  if (containers.length !== 1 || !container || container.packageName !== picker || container.scrollable
    || container.bounds[2] <= container.bounds[0] || container.bounds[3] <= container.bounds[1]) return undefined;
  const titles = snapshot.nodes.filter((node) => node.resourceId === `${picker}:id/breadcrumb_text`
    && uiWithin(snapshot, node, container));
  if (!titles.length || titles.some((node, index) => node.packageName !== picker || !node.text
    || /[\/\x00-\x1f\x7f\u2026]/.test(node.text) || node.text.endsWith("...")
    || node.enabled !== (index === titles.length - 1)
    || node.bounds[0] < container.bounds[0] || node.bounds[2] > container.bounds[2]
    || node.bounds[1] < container.bounds[1] || node.bounds[3] > container.bounds[3]
    || node.bounds[2] <= node.bounds[0] || node.bounds[3] <= node.bounds[1])) return undefined;
  const root = titles[0]?.text;
  // A repeated root label could also be a truncated chain beginning at a folder.
  if (!root || titles.slice(1).some((node) => node.text === root)) return undefined;
  return titles;
}

/** Bind the complete UI chain only after this snapshot's primary docId was confirmed by Android. */
export function androidDocumentBreadcrumbRoot(snapshot: AndroidUiSnapshot, picker: string, directory: string): string | undefined {
  const parts = primaryParts(directory);
  const titles = breadcrumbs(snapshot, picker);
  if (!parts || !titles || titles.length !== parts.length + 1
    || parts.some((part, index) => titles[index + 1]?.text !== part)) return undefined;
  return titles[0]?.text;
}

/** Missing, clipped, scrolling, or unanchored chains require a system docId check. */
export function androidDocumentBreadcrumbDirectory(snapshot: AndroidUiSnapshot, picker: string, root: string | undefined): string | undefined {
  if (root === undefined) return undefined;
  const titles = breadcrumbs(snapshot, picker);
  if (!titles || titles[0]?.text !== root) return undefined;
  const directory = `primary:${titles.slice(1).map((node) => node.text).join("/")}`;
  return primaryParts(directory) ? directory : undefined;
}
