import { AndroidUiStateChangedError, assertAndroidUiSnapshot, type AndroidUiSnapshot, type AndroidUiNode } from "./android-ui";
import { clickAndroidUiNode, type AndroidDocumentActionGuard } from "./android-ui-action";
import { emulatorNodeVisible, uiDescendant, uiNode, uiWithin, type EmulatorUiContext } from "./emulator-ui";
import { shellCommand } from "./transport";

async function documentSearchPrefix(context: EmulatorUiContext, directory: string, name: string): Promise<string> {
  const first = name.slice(0, 1);
  if (name.length <= 1) return first;
  const marker = `emukase-document-names-${crypto.randomUUID()}`;
  let output: string;
  try {
    output = await context.device.shell(shellCommand("sh", "-c", ["set -e",
      shellCommand("find", directory, "-mindepth", "1", "-maxdepth", "1", "-print0"), shellCommand("printf", marker),
    ].join("\n")));
  } catch {
    context.signal?.throwIfAborted();
    return first;
  }
  context.signal?.throwIfAborted();
  // A complete listing bounds the highlight length even on a recycled row.
  // Missing or unreadable entries leave the one-character approximation.
  if (output.length > 2_097_152 || !output.endsWith(`\0${marker}`)) return first;
  const parent = `${directory.replace(/\/$/, "")}/`;
  const paths = output.slice(0, -marker.length - 1).split("\0");
  if (paths.some((path) => !path.startsWith(parent) || path.slice(parent.length).includes("/"))) return first;
  const names = paths.map((path) => path.slice(parent.length));
  if (!names.includes(name) || names.some((entry) => !entry)) return first;
  // The highlighter can run on any recycled row, not just matching names.
  // Even a unique prefix must fit the shortest entry in the complete listing.
  const limit = names.reduce((length, entry) => Math.min(length, entry.length), name.length);
  const others = names.filter((entry) => entry !== name).map((entry) => entry.toLowerCase());
  for (let length = 1; length < limit; length++) {
    const prefix = name.slice(0, length);
    if (!others.some((entry) => entry.startsWith(prefix.toLowerCase()))) return prefix;
  }
  return name.slice(0, limit);
}

export function focusedAndroidDocument(snapshot: AndroidUiSnapshot, picker: string): AndroidUiNode | undefined {
  const focused = snapshot.nodes.filter((node) => node.focused);
  const node = focused[0];
  if (focused.length !== 1 || !node?.enabled || node.packageName !== picker || /EditText/.test(node.className)
    || !uiDescendant(snapshot, node, `${picker}:id/dir_list`)) return undefined;
  const titles = snapshot.nodes.filter((title) => title.resourceId === "android:id/title"
    && title.packageName === picker && uiDescendant(snapshot, title, `${picker}:id/dir_list`)
    && (uiWithin(snapshot, title, node) || uiWithin(snapshot, node, title)));
  return titles.length === 1 ? titles[0] : undefined;
}

export function exactAndroidDocumentFocus(snapshot: AndroidUiSnapshot, picker: string, name: string): boolean {
  const matches = snapshot.nodes.filter((node) => node.resourceId === "android:id/title" && node.text === name
    && node.packageName === picker && uiDescendant(snapshot, node, `${picker}:id/dir_list`));
  return matches.length === 1 && matches[0] === focusedAndroidDocument(snapshot, picker);
}

/** Directory navigation only. The caller must observe the resulting directory,
 * since ENTER can merely finish an active DocumentsUI title search. */
export async function activateFocusedAndroidDocument(
  context: EmulatorUiContext, picker: string, snapshot: AndroidUiSnapshot, name: string, document?: AndroidDocumentActionGuard,
): Promise<boolean> {
  if (!exactAndroidDocumentFocus(snapshot, picker, name)) return false;
  await context.ensureUnlocked();
  try {
    const node = focusedAndroidDocument(snapshot, picker);
    if (node && await clickAndroidUiNode(context.device, context.user, snapshot, node, context.signal, document, true)) return true;
    await assertAndroidUiSnapshot(context.device, context.user, snapshot, context.signal);
  } catch (error) {
    if (error instanceof AndroidUiStateChangedError) return false;
    throw error;
  }
  context.signal?.throwIfAborted();
  const output = await context.device.shell(shellCommand("input", "keyevent", "KEYCODE_ENTER"));
  if (/Error:|Exception|Permission Denial/i.test(output)) throw new Error("Android rejected document directory activation.");
  context.signal?.throwIfAborted();
  return true;
}

/** AOSP TitleSearchHelper indexes offscreen names. Use a short prefix to
 * approach the row; the caller still requires its exact name before selection. */
export async function focusAndroidDocument(
  context: EmulatorUiContext, picker: string, snapshot: AndroidUiSnapshot, name: string,
  observe: () => Promise<AndroidUiSnapshot>, directory: string,
): Promise<void> {
  // Android `input text` interprets spaces/%s. Other names keep row navigation.
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || snapshot.nodes.some((node) => node.focused && /EditText/.test(node.className))) return;
  const list = uiNode(snapshot, `${picker}:id/dir_list`);
  // RecyclerView can report GridView as its accessibility class. Both support
  // DocumentsUI's title search, including names outside the visible viewport.
  if (list?.className !== "android.widget.GridView" && !list?.className.endsWith("RecyclerView")) return;
  const titles = snapshot.nodes.filter((node) => node.resourceId === "android:id/title"
    && uiDescendant(snapshot, node, `${picker}:id/dir_list`));
  if (!titles.length) return;
  const input = async (...args: string[]): Promise<void> => {
    await context.ensureUnlocked();
    try {
      await assertAndroidUiSnapshot(context.device, context.user, snapshot, context.signal);
    } catch (error) {
      if (!(error instanceof AndroidUiStateChangedError)) throw error;
      snapshot = await observe();
      return;
    }
    const output = await context.device.shell(shellCommand("input", ...args));
    if (/Error:|Exception|Permission Denial/i.test(output)) throw new Error("Android rejected document keyboard navigation.");
    snapshot = await observe();
    if (args[0] === "text") {
      // Title search scrolls asynchronously. Observe its settled row before the
      // caller chooses between exact activation and the scrolling fallback.
      for (let attempt = 0; attempt < 6 && !exactAndroidDocumentFocus(snapshot, picker, name); attempt++) {
        const previous = JSON.stringify(snapshot);
        snapshot = await observe();
        if (JSON.stringify(snapshot) === previous) break;
      }
    }
  };
  const listFocused = (): boolean => !!focusedAndroidDocument(snapshot, picker)
    || snapshot.nodes.some((node) => node.focused && node.resourceId === `${picker}:id/dir_list`);
  // Directional input clears a retained title query before another prefix.
  if (listFocused()) await input("keyevent", "KEYCODE_DPAD_DOWN");
  // The tree picker's privacy notice initially owns focus; DOWN stays there.
  for (let attempt = 0; attempt < 3 && !listFocused(); attempt++) {
    const noticeFocused = snapshot.nodes.some((node) => node.focused && node.resourceId === `${picker}:id/action_button`);
    await input("keyevent", noticeFocused ? "KEYCODE_TAB" : "KEYCODE_DPAD_DOWN");
  }
  if (!listFocused()) return;
  // Uniqueness never overrides the highlighter's shortest-row safety limit.
  await input("text", await documentSearchPrefix(context, directory, name));
}

export async function stepAndroidDocumentFocus(
  context: EmulatorUiContext, picker: string, snapshot: AndroidUiSnapshot, name: string,
): Promise<boolean> {
  const list = uiNode(snapshot, `${picker}:id/dir_list`);
  const gridAccessibility = list?.className === "android.widget.GridView";
  if (!gridAccessibility && !list?.className.endsWith("RecyclerView")) return false;
  if (snapshot.nodes.some((node) => node.focused && /EditText/.test(node.className))) return false;
  const focused = focusedAndroidDocument(snapshot, picker);
  // GridView can be RecyclerView's accessibility class. An unreported native
  // selection is not enough to keep sending keys; return to observed scrolling.
  if (!focused) return false;
  const target = snapshot.nodes.find((node) => node.resourceId === "android:id/title" && node.text === name
    && uiDescendant(snapshot, node, `${picker}:id/dir_list`));
  const header = uiNode(snapshot, `${picker}:id/app_bar`);
  const clippedAbove = target && header && target.bounds[1] < header.bounds[3];
  const key = clippedAbove ? "KEYCODE_DPAD_UP" : "KEYCODE_DPAD_DOWN";
  const levels = new Set(snapshot.nodes.filter((node) => node.resourceId === "android:id/title"
    && uiDescendant(snapshot, node, `${picker}:id/dir_list`) && emulatorNodeVisible(snapshot, node)).map((node) => node.bounds[1]));
  const count = gridAccessibility ? 1 : Math.max(1, Math.min(3, Math.floor(levels.size / 2)));
  await context.ensureUnlocked();
  try {
    await assertAndroidUiSnapshot(context.device, context.user, snapshot, context.signal);
  } catch (error) {
    if (error instanceof AndroidUiStateChangedError) return true;
    throw error;
  }
  const output = await context.device.shell(shellCommand("input", "keyevent", ...Array<string>(count).fill(key)));
  if (/Error:|Exception|Permission Denial/i.test(output)) throw new Error("Android rejected document focus navigation.");
  return true;
}
