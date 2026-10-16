import { AndroidUiStateChangedError, assertAndroidUiSnapshot, type AndroidUiSnapshot, type AndroidUiNode } from "./android-ui";
import { emulatorNodeVisible, uiDescendant, uiNode, uiWithin, type EmulatorUiContext } from "./emulator-ui";
import { shellCommand } from "./transport";

export function focusedAndroidDocument(snapshot: AndroidUiSnapshot, picker: string): AndroidUiNode | undefined {
  const focused = snapshot.nodes.filter((node) => node.focused);
  const node = focused[0];
  if (focused.length !== 1 || !node?.enabled || node.packageName !== picker || /EditText/.test(node.className)
    || !uiDescendant(snapshot, node, `${picker}:id/dir_list`)) return undefined;
  const titles = snapshot.nodes.filter((title) => title.resourceId === "android:id/title"
    && (uiWithin(snapshot, title, node) || uiWithin(snapshot, node, title)));
  return titles.length === 1 ? titles[0] : undefined;
}

/** Adapted from emularchy's SAF picker: AOSP TitleSearchHelper indexes even
 * offscreen names. Keyboard input only moves focus; selection stays separate. */
export async function focusAndroidDocument(
  context: EmulatorUiContext, picker: string, snapshot: AndroidUiSnapshot, name: string,
  observe: () => Promise<AndroidUiSnapshot>,
): Promise<void> {
  // Android `input text` interprets spaces/%s. Other names keep row navigation.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || snapshot.nodes.some((node) => node.focused && /EditText/.test(node.className))) return;
  const list = uiNode(snapshot, `${picker}:id/dir_list`);
  // The legacy GridView picker has no TitleSearchHelper and can move focus to
  // its breadcrumbs on text input. Keep its observed scrolling path instead.
  if (!list?.className.endsWith("RecyclerView")) return;
  const titles = snapshot.nodes.filter((node) => node.resourceId === "android:id/title"
    && uiDescendant(snapshot, node, `${picker}:id/dir_list`));
  if (!titles.length) return;
  const input = async (...args: string[]): Promise<void> => {
    await context.ensureUnlocked();
    await assertAndroidUiSnapshot(context.device, context.user, snapshot, context.signal);
    const output = await context.device.shell(shellCommand("input", ...args));
    if (/Error:|Exception|Permission Denial/i.test(output)) throw new Error("Android rejected document keyboard navigation.");
    snapshot = await observe();
  };
  if (!focusedAndroidDocument(snapshot, picker)) await input("keyevent", "KEYCODE_DPAD_DOWN");
  if (!focusedAndroidDocument(snapshot, picker)) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) {
      // Directional input resets the preceding search and reveals rows clipped
      // by the footer. Recheck focus before typing; never send ENTER.
      await input("keyevent", "KEYCODE_DPAD_DOWN", "KEYCODE_DPAD_DOWN", "KEYCODE_DPAD_DOWN");
      if (!focusedAndroidDocument(snapshot, picker)) return;
    }
    await input("text", name);
    if (snapshot.nodes.some((node) => node.resourceId === "android:id/title" && node.text === name
      && uiDescendant(snapshot, node, `${picker}:id/dir_list`))) return;
    if (!focusedAndroidDocument(snapshot, picker)) {
      // Older DocumentsUI builds can drop focus while aligning a search result.
      // Restore row focus for the bounded directional-navigation fallback.
      await input("keyevent", "KEYCODE_DPAD_DOWN");
      if (!focusedAndroidDocument(snapshot, picker)) return;
    }
  }
}

export async function stepAndroidDocumentFocus(
  context: EmulatorUiContext, picker: string, snapshot: AndroidUiSnapshot, name: string,
): Promise<boolean> {
  const list = uiNode(snapshot, `${picker}:id/dir_list`);
  const legacy = list?.className === "android.widget.GridView";
  if (!legacy && !list?.className.endsWith("RecyclerView")) return false;
  if (snapshot.nodes.some((node) => node.focused && /EditText/.test(node.className))) return false;
  const focused = focusedAndroidDocument(snapshot, picker);
  // Legacy GridView drops reported row focus while still advancing its native
  // selection. Direction keys remain safe; typing stays RecyclerView-only.
  if (!legacy && !focused) return false;
  const target = snapshot.nodes.find((node) => node.resourceId === "android:id/title" && node.text === name
    && uiDescendant(snapshot, node, `${picker}:id/dir_list`));
  const header = uiNode(snapshot, `${picker}:id/app_bar`);
  const clippedAbove = target && header && target.bounds[1] < header.bounds[3];
  const key = clippedAbove ? "KEYCODE_DPAD_UP" : "KEYCODE_DPAD_DOWN";
  const levels = new Set(snapshot.nodes.filter((node) => node.resourceId === "android:id/title"
    && uiDescendant(snapshot, node, `${picker}:id/dir_list`) && emulatorNodeVisible(snapshot, node)).map((node) => node.bounds[1]));
  const count = legacy ? 1 : Math.max(1, Math.min(3, Math.floor(levels.size / 2)));
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
