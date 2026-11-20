import { AndroidUiStateChangedError, assertAndroidUiSnapshot, pressAndroidUiKey, tapAndroidUi, tapAndroidUiPoint, type AndroidUiSnapshot, type AndroidUiNode } from "./android-ui";
import { clickAndroidUiNode, type AndroidDocumentActionGuard } from "./android-ui-action";
import { primaryStorageForUser, runAndroidUserShellScript } from "./android-user";
import { androidResumedActivity } from "./android-document-activity";
import { AndroidUiListNotScrollableError, androidResourceText, emulatorNodeVisible, scrollEmulatorList, tapEmulatorNode, uiDescendant, uiNode, waitEmulatorUi, type EmulatorUiContext } from "./emulator-ui";
import { activateFocusedAndroidDocument, exactAndroidDocumentFocus, focusAndroidDocument, stepAndroidDocumentFocus } from "./android-document-focus";
import { androidDocumentBreadcrumbAncestor, androidDocumentBreadcrumbDirectory, androidDocumentBreadcrumbRoot, androidDocumentCommonDirectory } from "./android-document-location";
import { DeviceUnlockRequiredError } from "./device-awake";
import { shellMarker } from "./shell-marker";
import { shellCommand } from "./transport";

const PROVIDER = "com.android.externalstorage.documents";

export interface AndroidDocumentSelectionOptions {
  /** Explicit opt-in for file imports; tree selection still requires OPEN_DOCUMENT_TREE. */
  action?: "OPEN_DOCUMENT" | "GET_CONTENT";
  /** Disable title search, focus keys, and directory activation on unreliable pickers. */
  keyboardNavigation?: boolean;
  /** Prefer title search, or first reveal rows hidden by an expanded heading. */
  directoryNavigation?: "text-first" | "scroll-first";
}

type DocumentPickerAction = "OPEN_DOCUMENT" | "OPEN_DOCUMENT_TREE" | "GET_CONTENT";

function pickerPackage(component: string): string {
  const packageName = component.split("/")[0];
  if (!packageName || !["com.google.android.documentsui", "com.android.documentsui"].includes(packageName)
    || !component.endsWith("/com.android.documentsui.picker.PickActivity")) throw new Error("Unsupported Android document picker.");
  return packageName;
}

async function assertPickerCaller(
  context: EmulatorUiContext, output: string, picker: string, caller: string, action: DocumentPickerAction, token?: string,
): Promise<string> {
  const resumed = androidResumedActivity(output);
  if (!resumed || resumed.user !== String(context.user) || resumed.component !== `${picker}/com.android.documentsui.picker.PickActivity`) {
    throw new Error("Document picker is not resumed in the selected Android profile.");
  }
  if (token !== undefined && resumed.token !== token) throw new Error("Android changed its document picker activity.");
  const blocks = output.split(/(?=^\s*\* Hist\s+#\d+:)/m);
  const records = blocks.filter((value) => new RegExp(`^\\s*\\* Hist\\s+#\\d+: ActivityRecord\\{${resumed.token} u${context.user} `).test(value));
  const block = records[0];
  const resultTo = new RegExp(`resultTo=ActivityRecord\\{[a-f\\d]+ u${context.user} ${caller.replaceAll(".", "\\.")}/[^\\s]+ t${resumed.task}\\}`);
  let initiatedByCaller = block?.includes(`launchedFromPackage=${caller} `) === true;
  if (!initiatedByCaller && action === "GET_CONTENT" && block) {
    // Android's system PhotoPicker can forward GET_CONTENT to DocumentsUI
    // with FLAG_ACTIVITY_FORWARD_RESULT. The result must still target the emulator.
    const launch = /launchedFromUid=(\d+) launchedFromPackage=(\S+) /.exec(block);
    const uid = launch?.[1];
    const forwarder = launch?.[2];
    if (uid && forwarder && ["com.google.android.providers.media.module", "com.android.providers.media.module"].includes(forwarder)
      && Math.floor(Number(uid) / 100_000) === context.user) {
      const installed = await context.device.shell(shellCommand("pm", "list", "packages", "-s", "-U", "--user", String(context.user), forwarder));
      initiatedByCaller = installed.trim() === `package:${forwarder} uid:${uid}`;
    }
  }
  if (records.length !== 1 || !initiatedByCaller
    || !block.includes(`act=android.intent.action.${action} `) || !resultTo.test(block)) {
    throw new Error("Android document selection is not returning to the initiating emulator.");
  }
  return resumed.token;
}

async function primaryDirectory(context: EmulatorUiContext, token: string): Promise<string | null | undefined> {
  // Other emulators can retain their own PickActivity in the same process.
  // The caller check supplies the exact foreground token, never another task.
  const output = await context.device.shell(shellCommand("dumpsys", "activity", token));
  return primaryDirectoryFromActivity(output, context.user);
}

/** Undefined means loading; null is settled Recents or another volume. */
function primaryDirectoryFromActivity(output: string, user: number): string | null | undefined {
  const lines = output.split(/\r?\n/).filter((line) => line.includes("mArguments=Bundle[{root="));
  if (lines.length !== 1) return undefined;
  const line = lines[0] ?? "";
  if (/mArguments=Bundle\[\{root=null, document=null(?:,|\})/.test(line)) return null;
  if (!line.includes(`root=Root{userId=${user},`)) return undefined;
  if (!line.includes(`root=Root{userId=${user}, authority=${PROVIDER}, rootId=primary,`)) return null;
  if (!line.includes("mimeType=vnd.android.document/directory,")) return undefined;
  const doc = /document=DocumentInfo\{docId=(primary:[^\r\n]*), userId=(\d+), name=/.exec(line);
  const uri = /@ content:\/\/com\.android\.externalstorage\.documents\/document\/([^\s},\]]+)/.exec(line);
  if (!doc?.[1] || doc[2] !== String(user) || !uri?.[1] || decodeURIComponent(uri[1]) !== doc[1]) {
    throw new Error("Android document directory identity could not be confirmed.");
  }
  return doc[1];
}

/** Unlike the general UI helper, never retarget a document row after a stale
 * snapshot: a different directory can contain the same filename. */
async function tapDocumentRow(
  context: EmulatorUiContext, snapshot: AndroidUiSnapshot, node: AndroidUiNode,
  document: AndroidDocumentActionGuard, checkDirectory?: () => Promise<string | null | undefined>,
): Promise<void> {
  let target: AndroidUiNode | undefined = node;
  while (target && !target.clickable) target = target.parent === null ? undefined : snapshot.nodes[target.parent];
  if (!target || !uiDescendant(snapshot, target, `${target.packageName}:id/dir_list`)) {
    throw new Error("Android document row has no clickable action.");
  }
  const [left, originalTop, right, originalBottom] = target.bounds;
  const header = uiNode(snapshot, `${target.packageName}:id/app_bar`);
  const footer = uiNode(snapshot, `${target.packageName}:id/container_save`);
  const top = header && header.bounds[0] < right && header.bounds[2] > left ? Math.max(originalTop, header.bounds[3]) : originalTop;
  const bottom = footer && footer.bounds[3] > footer.bounds[1] && footer.bounds[0] < right && footer.bounds[2] > left
    ? Math.min(originalBottom, footer.bounds[1]) : originalBottom;
  if (right <= left || bottom <= top) throw new Error("Android document row is covered by the picker controls.");
  if (await clickAndroidUiNode(context.device, context.user, snapshot, node, context.signal, document)) return;
  if (checkDirectory && await checkDirectory() !== document.directory) {
    throw new AndroidUiStateChangedError("Android changed its document directory before opening a folder.");
  }
  await tapAndroidUiPoint(context.device, context.user, snapshot, target,
    [Math.floor((left + right) / 2), Math.floor((top + bottom) / 2)], context.signal);
}

/** Select real files/trees through the emulator's own callback; GET_CONTENT requires explicit opt-in. */
export async function selectAndroidDocument(
  context: EmulatorUiContext, caller: string, path: string, tree = false,
  onSelectFile?: (snapshot: AndroidUiSnapshot, node: AndroidUiNode) => Promise<void>,
  options: AndroidDocumentSelectionOptions = {},
): Promise<void> {
  const activity: { token?: string } = {};
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await selectDocument(context, caller, path, tree, onSelectFile, options, activity);
      return;
    } catch (error) {
      // Tree pickers can finish their opening animation between snapshots.
      // Resume from their observed directory; never replay a file handoff.
      if (!tree || !(error instanceof AndroidUiStateChangedError || error instanceof DeviceUnlockRequiredError) || attempt === 3) throw error;
      if (error instanceof DeviceUnlockRequiredError) await context.ensureUnlocked();
      const current = await waitEmulatorUi(context, (snapshot) => snapshot);
      if (!/documentsui.*\/com.android.documentsui.picker.PickActivity$/.test(current.component)) throw error;
    }
  }
}

async function selectDocument(
  context: EmulatorUiContext, caller: string, path: string, tree: boolean,
  onSelectFile: ((snapshot: AndroidUiSnapshot, node: AndroidUiNode) => Promise<void>) | undefined,
  options: AndroidDocumentSelectionOptions,
  activity: { token?: string },
): Promise<void> {
  if (!/^[A-Za-z][\w]*(?:\.[\w]+)+$/.test(caller)) throw new Error("Invalid document picker caller.");
  if (options.action !== undefined && options.action !== "OPEN_DOCUMENT" && options.action !== "GET_CONTENT") {
    throw new Error("Unsupported Android document selection action.");
  }
  if (tree && options.action === "GET_CONTENT") throw new Error("GET_CONTENT cannot select an Android document tree.");
  if (options.keyboardNavigation !== undefined && typeof options.keyboardNavigation !== "boolean") {
    throw new Error("Invalid Android document keyboard-navigation option.");
  }
  const action: DocumentPickerAction = tree ? "OPEN_DOCUMENT_TREE" : options.action ?? "OPEN_DOCUMENT";
  const prefix = `${primaryStorageForUser(context.user)}/`;
  if (!path.startsWith(prefix)) throw new Error("Document selection requires the selected profile's primary storage.");
  const parts = path.slice(prefix.length).split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\x00-\x1f\x7f]/.test(part))) throw new Error("Invalid document path.");
  const initial = await waitEmulatorUi(context, (snapshot) => {
    // AOSP DocumentsUI and Google's Android 14 build route GET_CONTENT to PickActivity.
    // Do not forward through resolvers, choosers, or unverified GetContentActivity variants.
    if (/documentsui.*\/com.android.documentsui.picker.PickActivity$/.test(snapshot.component)) return snapshot;
    if (action === "GET_CONTENT" && !snapshot.component.startsWith(`${caller}/`)) {
      throw new Error("Unsupported Android GET_CONTENT picker or chooser. Open the system DocumentsUI picker directly in the emulator.");
    }
    return undefined;
  });
  const picker = pickerPackage(initial.component);
  const activitiesCommand = shellCommand("dumpsys", "activity", "activities");
  const token = await assertPickerCaller(context, await context.device.shell(activitiesCommand), picker, caller, action, activity.token);
  activity.token = token;
  const scrollFirst = tree && options.directoryNavigation === "scroll-first";
  let breadcrumbRoot: string | undefined;
  const systemDirectory = async (): Promise<string | null | undefined> => {
    if (!tree) {
      await assertPickerCaller(context, await context.device.shell(activitiesCommand), picker, caller, action, token);
      return primaryDirectory(context, token);
    }
    // Recheck the caller and exact directory in one profile-scoped shell call.
    const marker = `\n${shellMarker("picker")}\n`;
    const output = await runAndroidUserShellScript(context.device, context.user, [
      activitiesCommand, shellCommand("printf", "%s", marker), shellCommand("dumpsys", "activity", token),
    ], context.signal);
    const [activities, directory, extra] = output.split(marker);
    if (!activities || directory === undefined || extra !== undefined) throw new Error("Android did not confirm the document picker state.");
    await assertPickerCaller(context, activities, picker, caller, action, token);
    return primaryDirectoryFromActivity(directory, context.user);
  };
  const observedDirectory = async (snapshot: AndroidUiSnapshot, callerJustChecked = false): Promise<string | null | undefined> => {
    if (snapshot.component !== initial.component) return undefined;
    const directory = androidDocumentBreadcrumbDirectory(snapshot, picker, breadcrumbRoot);
    if (directory !== undefined) return directory;
    const confirmed = await (callerJustChecked ? primaryDirectory(context, token) : systemDirectory());
    if (breadcrumbRoot === undefined && confirmed != null) {
      const root = androidDocumentBreadcrumbRoot(snapshot, picker, confirmed);
      if (root !== undefined) {
        // The fast path uses the breadcrumb only for observation. Navigation
        // checks the exact docId on-device (or before any coordinate fallback).
        if (!scrollFirst) await assertAndroidUiSnapshot(context.device, context.user, snapshot, context.signal);
        breadcrumbRoot = root;
      }
    }
    return confirmed;
  };
  // Bind a fresh snapshot before any input. Layout changes can retry here
  // for file imports too, without ever replaying a file handoff.
  const locate = async (snapshot: AndroidUiSnapshot, callerJustChecked = false) => {
    if (snapshot.component !== initial.component) return undefined;
    const directory = await observedDirectory(snapshot, callerJustChecked);
    // An opening picker can expose its window before its directory fragment.
    // Never interpret that transient state as a reason to open the drawer.
    return directory === undefined ? undefined : { directory: directory ?? undefined, snapshot };
  };
  const location = (scrollFirst ? await locate(initial, true) : undefined) ?? await waitEmulatorUi(context, locate);
  let current = location.directory;
  let readySnapshot: AndroidUiSnapshot | undefined = location.snapshot;
  // A confirmed navigation result is already the next reviewed snapshot.
  // Actions still recheck window identity and the exact system docId in DEX.
  const waitDirectory = async (directory: string): Promise<AndroidUiSnapshot> => {
    const snapshot = await waitEmulatorUi(context, async (value) =>
      await observedDirectory(value) === directory ? value : undefined);
    readySnapshot = snapshot;
    return snapshot;
  };
  const folders = tree ? parts : parts.slice(0, -1);
  const wanted = `primary:${folders.join("/")}`;
  const id = (name: string): string => `${picker}:id/${name}`;
  const onPath = (directory: string | undefined): boolean => directory !== undefined
    && (directory === "primary:" || directory === wanted || wanted.startsWith(`${directory}/`));
  const common = androidDocumentCommonDirectory(current, wanted);
  // Jump to a visible common ancestor, including the volume root. BACK remains
  // the fallback for clipped breadcrumbs; every action retains the exact docId.
  if (current !== undefined && !onPath(current) && common !== undefined) {
    while (current !== common) {
      const from: string = current;
      const parent: string = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "primary:";
      if (!scrollFirst) await context.ensureUnlocked();
      const navigate = async (snapshot: AndroidUiSnapshot): Promise<string | undefined> => {
        if (snapshot.component !== initial.component) return undefined;
        if (await systemDirectory() !== from) throw new AndroidUiStateChangedError("Android changed its document directory before parent navigation.");
        // ES-DE starts at primary:ES-DE or primary:ROMs. One BACK reaches
        // their confirmed parent without opening or addressing the drawer.
        if (common === parent) {
          await pressAndroidUiKey(context.device, context.user, snapshot, "KEYCODE_BACK", context.signal);
          return parent;
        }
        const ancestor = androidDocumentBreadcrumbAncestor(snapshot, picker, from, common);
        if (ancestor) {
          if (!await clickAndroidUiNode(context.device, context.user, snapshot, ancestor, context.signal, { token, directory: from })) {
            const [left, top, right, bottom] = ancestor.bounds;
            await tapAndroidUiPoint(context.device, context.user, snapshot, ancestor,
              [Math.floor((left + right) / 2), Math.floor((top + bottom) / 2)], context.signal);
          }
          return common;
        }
        await pressAndroidUiKey(context.device, context.user, snapshot, "KEYCODE_BACK", context.signal);
        return parent;
      };
      let destination: string | undefined;
      try {
        if (scrollFirst && readySnapshot) destination = await navigate(readySnapshot);
      } catch (error) {
        if (error instanceof DeviceUnlockRequiredError) await context.ensureUnlocked();
        else if (!(error instanceof AndroidUiStateChangedError)) throw error;
      }
      current = destination ?? await waitEmulatorUi(context, navigate);
      await waitDirectory(current);
    }
  }
  // Continue from an already-open parent instead of returning to the volume root.
  if (!onPath(current)) {
    // The primary volume title is supplied by Android, usually the device model.
    const [model, internal] = await Promise.all([
      context.device.shell(shellCommand("getprop", "ro.product.model")).then((value) => value.trim()),
      androidResourceText(context, picker, "android:string/storage_internal"),
    ]);
    let snapshot = await waitEmulatorUi(context, (value) => value.component === initial.component ? value : undefined);
    if (!uiNode(snapshot, id("roots_list"))) {
      const buttons = snapshot.nodes.filter((node) => node.className === "android.widget.ImageButton"
        && uiDescendant(snapshot, node, id("toolbar")) && node.clickable);
      if (buttons.length !== 1 || !buttons[0]) throw new Error("Document picker navigation drawer is unavailable.");
      await tapEmulatorNode(context, snapshot, buttons[0]);
    }
    let root: AndroidUiNode | undefined;
    let previous = "";
    let unchanged = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      snapshot = await waitEmulatorUi(context, (value) => value.component === initial.component && uiNode(value, id("roots_list")) ? value : undefined);
      const roots = snapshot.nodes.filter((node) => node.resourceId === "android:id/title"
        && [model, internal].includes(node.text) && uiDescendant(snapshot, node, id("roots_list")));
      if (roots.length > 1) throw new Error("The primary storage volume is ambiguous in Android's picker.");
      if (roots[0] && emulatorNodeVisible(snapshot, roots[0])) { root = roots[0]; break; }
      const signature = JSON.stringify(snapshot.nodes.map((node) => [node.text, node.bounds]));
      unchanged = signature === previous ? unchanged + 1 : 0;
      const list = uiNode(snapshot, id("roots_list"));
      if (unchanged >= 2 || !list?.scrollable) break;
      previous = signature;
      await scrollEmulatorList(context, snapshot, list);
    }
    if (!root) throw new Error("The primary storage volume was not found in Android's picker.");
    await tapEmulatorNode(context, snapshot, root);
    await waitDirectory("primary:");
    current = "primary:";
  }

  const row = async (name: string, directory: string, nextDirectory?: string, handoff?: typeof onSelectFile): Promise<void> => {
    let previous = "";
    let repeated = 0;
    let triedFocus = false;
    let focusRetries = 0;
    let focusSteps = 0;
    let activations = 0;
    // Parent folders use the same guarded title search as the final entry.
    const textFirst = nextDirectory !== undefined && options.directoryNavigation === "text-first";
    const keyboard = !textFirst && action !== "GET_CONTENT" && options.keyboardNavigation !== false;
    let direction: "down" | "up" = "down";
    let focusSnapshot: AndroidUiSnapshot | undefined;
    let revealScrolls = 0;
    const observe = async (): Promise<AndroidUiSnapshot> => {
      const snapshot = await waitEmulatorUi(context, (value) => {
        if (value.component !== initial.component) return undefined;
        const actual = androidDocumentBreadcrumbDirectory(value, picker, breadcrumbRoot);
        // Missing breadcrumbs permit only harmless focus/scroll observation.
        // Every row activation below still needs the full chain or a system check.
        return actual === undefined || actual === directory || activations > 0 && actual === nextDirectory ? value : undefined;
      });
      focusSnapshot = snapshot;
      return snapshot;
    };
    const activated = (expected: string): Promise<boolean> => {
      let previous = "";
      let observations = 0;
      return waitEmulatorUi(context, async (snapshot) => {
        const actual = await observedDirectory(snapshot);
        if (actual === expected) { readySnapshot = snapshot; return true; }
        if (actual !== directory) return undefined;
        const signature = JSON.stringify(snapshot);
        // Two stable observations (or four changing ones) bound a search-ending
        // ENTER. Only a fresh exact focus in the old directory permits a retry.
        if (++observations >= 4 || signature === previous) return false;
        previous = signature;
        return undefined;
      });
    };
    // Large libraries need more than sixty observations, especially while
    // scrolling snapshots settle. Bound elapsed navigation time instead.
    const navigationDeadline = Date.now() + 180_000;
    while (Date.now() < navigationDeadline) {
      const snapshot = readySnapshot ?? await observe();
      readySnapshot = undefined;
      // ENTER may finish opening the folder after activated() permits a retry.
      if (activations > 0 && nextDirectory !== undefined && await observedDirectory(snapshot) === nextDirectory) return;
      const matches = snapshot.nodes.filter((node) => node.resourceId === "android:id/title" && node.text === name
        && node.packageName === picker && uiDescendant(snapshot, node, id("dir_list")));
      if (matches.length > 1) throw new Error("The Android document name is ambiguous.");
      if (matches[0] && emulatorNodeVisible(snapshot, matches[0])) {
        try {
          // Folder movement uses the anchored chain, but every file handoff still
          // verifies the foreground token, exact caller, primary root, and docId.
          if (nextDirectory === undefined) {
            if (await systemDirectory() !== directory) throw new Error("Android changed its document directory.");
            if (handoff) await assertAndroidUiSnapshot(context.device, context.user, snapshot, context.signal);
          } else if (await observedDirectory(snapshot) !== directory) {
            throw new AndroidUiStateChangedError("Android changed its document directory before opening a folder.");
          }
          if (!handoff) await tapDocumentRow(context, snapshot, matches[0], { token, directory }, scrollFirst ? systemDirectory : undefined);
        } catch (error) {
          // These checks reject stale snapshots before sending document input.
          // Reobserve and revalidate the path; never retarget a stale row.
          if (error instanceof DeviceUnlockRequiredError) {
            await context.ensureUnlocked();
            continue;
          }
          if (error instanceof AndroidUiStateChangedError) continue;
          throw error;
        }
        // A handoff can already have imported a file before throwing. Never
        // include it in the pre-input retry above.
        if (handoff) await handoff(snapshot, matches[0]);
        if (nextDirectory !== undefined) await waitDirectory(nextDirectory);
        return;
      }
      if (nextDirectory !== undefined && keyboard && activations < 2 && exactAndroidDocumentFocus(snapshot, picker, name)) {
        if (await (scrollFirst ? systemDirectory() : observedDirectory(snapshot)) !== directory) {
          throw new AndroidUiStateChangedError("Android changed its document directory before keyboard activation.");
        }
        activations++;
        if (await activateFocusedAndroidDocument(context, picker, snapshot, name, { token, directory }) && await activated(nextDirectory)) return;
        previous = "";
        repeated = 0;
        continue;
      }
      const listView = uiNode(snapshot, id("sub_menu_list"));
      if (listView?.enabled) {
        // Large landscape grids can clip filenames below the visible viewport.
        await tapEmulatorNode(context, snapshot, listView);
        previous = "";
        repeated = 0;
        continue;
      }
      if (scrollFirst && revealScrolls < 2) {
        const header = uiNode(snapshot, id("app_bar"));
        const toolbar = uiNode(snapshot, id("toolbar"));
        const list = uiNode(snapshot, id("dir_list"));
        // The nested header consumes space above the list and may not collapse
        // on an accessibility scroll. Allow one more gesture if the first only
        // collapsed the header. Long lists still use the bounded title search.
        const expanded = header && toolbar && header.bounds[3] > toolbar.bounds[3];
        if ((expanded || revealScrolls === 1) && list?.enabled) {
          revealScrolls++;
          if (await systemDirectory() !== directory) throw new AndroidUiStateChangedError("Android changed its document directory before scrolling.");
          try {
            await scrollEmulatorList(context, snapshot, list);
            // A rejected snapshot is no longer suitable for title search.
            continue;
          } catch (error) {
            if (!(error instanceof AndroidUiListNotScrollableError)) throw error;
          }
        }
        revealScrolls = 2;
      }
      // GET_CONTENT adds focusable media filters above the directory; prefer
      // observed scrolling rather than advancing an unreported keyboard focus.
      if ((keyboard || textFirst) && !triedFocus) {
        focusSnapshot = undefined;
        const result = await focusAndroidDocument(context, picker, snapshot, name, observe,
          `${prefix}${directory.slice("primary:".length)}`, { token, directory }, scrollFirst);
        triedFocus = result !== "retry" || scrollFirst && ++focusRetries >= 3 || !scrollFirst && !textFirst;
        readySnapshot = focusSnapshot;
        continue;
      }
      if (keyboard && direction === "down" && focusSteps < 8 && await stepAndroidDocumentFocus(context, picker, snapshot, name)) {
        focusSteps++;
        // A stalled focus is not a scroll boundary. Give the pointer fallback
        // its own observed down/up pass once the bounded key attempts finish.
        previous = "";
        repeated = 0;
        continue;
      }
      if (textFirst && matches[0]) {
        const list = uiNode(snapshot, id("dir_list"));
        const header = uiNode(snapshot, id("app_bar"));
        const footer = uiNode(snapshot, id("container_save"));
        const top = Math.max(list?.bounds[1] ?? 0, header?.bounds[3] ?? 0);
        const bottom = Math.min(list?.bounds[3] ?? Infinity, footer?.bounds[1] ?? Infinity);
        const target = matches[0];
        const towards = target.bounds[3] <= top ? "up" : target.bounds[1] >= bottom ? "down" : undefined;
        if (towards && direction !== towards) { direction = towards; previous = ""; repeated = 0; }
      }
      const signature = JSON.stringify(snapshot.nodes.map((node) => [node.text, node.bounds, node.focused, node.selected]));
      repeated = signature === previous ? repeated + 1 : 0;
      if (repeated >= 2) {
        if (direction === "up") {
          throw new Error(`Android could not find ${name} in the selected folder.`);
        }
        // A reopened directory can start below the requested child.
        direction = "up";
        repeated = 0;
        previous = "";
      } else previous = signature;
      const list = uiNode(snapshot, id("dir_list"));
      if (!list) throw new Error("Android document list is unavailable.");
      await scrollEmulatorList(context, snapshot, list, direction);
    }
    throw new Error("Android document navigation exceeded its limit.");
  };
  if (current !== wanted) {
    if (!current || !onPath(current)) throw new AndroidUiStateChangedError("Android changed its document directory.");
    const depth = current === "primary:" ? 0 : current.slice("primary:".length).split("/").length;
    for (const part of folders.slice(depth)) {
      const expected: string = `${current}${current === "primary:" ? "" : "/"}${part}`;
      await row(part, current, expected);
      current = expected;
    }
  }
  if (!tree) {
    const filename = parts.at(-1);
    if (!filename) throw new Error("Missing document filename.");
    await row(filename, wanted, undefined, onSelectFile);
    return;
  }
  const selectControl = (value: AndroidUiSnapshot): AndroidUiNode | undefined => {
    const controls = value.nodes.filter((node) => node.enabled && (node.resourceId === id("action_menu_select")
      || (node.resourceId === "android:id/button1" && uiDescendant(value, node, id("container_save")))));
    if (controls.length > 1) throw new Error("Android folder selection is ambiguous.");
    return controls[0];
  };
  const clickTreeButton = async (value: AndroidUiSnapshot, node: AndroidUiNode): Promise<true> => {
    if (await systemDirectory() !== wanted) throw new Error("Android did not confirm the selected game folder.");
    if (!await clickAndroidUiNode(context.device, context.user, value, node, context.signal, { token, directory: wanted })) {
      let target: AndroidUiNode | undefined = node;
      while (target && !target.clickable) target = target.parent === null ? undefined : value.nodes[target.parent];
      if (!target) throw new Error("Android folder permission action is unavailable.");
      // Do not retarget a confirmation after a stale coordinate check.
      await tapAndroidUi(context.device, context.user, value, target, context.signal);
    }
    return true;
  };
  const useFolder = async (value: AndroidUiSnapshot): Promise<true | undefined> => {
    if (value.component !== initial.component) return undefined;
    const select = selectControl(value);
    return select ? clickTreeButton(value, select) : undefined;
  };
  let selected = false;
  try {
    if (readySnapshot) selected = await useFolder(readySnapshot) === true;
  } catch (error) {
    if (error instanceof DeviceUnlockRequiredError) await context.ensureUnlocked();
    else if (!(error instanceof AndroidUiStateChangedError)) throw error;
  }
  // A stale button during a layout transition only needs a fresh review of
  // this picker and directory, not a restart of the navigation.
  if (!selected) await waitEmulatorUi(context, useFolder);
  await waitEmulatorUi(context, (value) => {
    if (value.component !== initial.component || selectControl(value)) return undefined;
    const allow = uiNode(value, "android:id/button1");
    const cancel = uiNode(value, "android:id/button2");
    return allow?.enabled && cancel?.enabled && ["android:id/buttonPanel", id("buttonPanel")].some((panel) =>
      uiDescendant(value, allow, panel) && uiDescendant(value, cancel, panel)) ? clickTreeButton(value, allow) : undefined;
  });
}

export interface AndroidTreeGrants {
  has(directory: string, writeRequired?: boolean): boolean;
}

/** One observation can check several folders during a read-only inspection.
 * Do not reuse it across a picker/permission change. */
export async function readAndroidTreeGrants(context: EmulatorUiContext, packageName: string): Promise<AndroidTreeGrants> {
  if (!/^[A-Za-z][\w]*(?:\.[\w]+)+$/.test(packageName)) throw new Error("Invalid Android package.");
  const prefix = `${primaryStorageForUser(context.user)}/`;
  const [packages, output] = await Promise.all([
    context.device.shell(shellCommand("pm", "list", "packages", "-U", "--user", String(context.user), packageName)),
    context.device.shell(shellCommand("dumpsys", "activity", "permissions")),
  ]);
  const uid = new RegExp(`^package:${packageName.replaceAll(".", "\\.")} uid:(\\d+)$`).exec(packages.trim())?.[1];
  if (!uid || Math.floor(Number(uid) / 100_000) !== context.user) throw new Error("Android did not confirm the emulator's profile UID.");
  return { has(directory, writeRequired = false) {
    if (!directory.startsWith(prefix)) throw new Error("Tree permission belongs to another Android profile.");
    const tree = `content://com.android.externalstorage.documents/tree/${encodeURIComponent(`primary:${directory.slice(prefix.length)}`)}`;
    let owner: string | undefined;
    let matched = false;
    let target = false;
    const modes: number[] = [];
    for (const line of output.split(/\r?\n/)) {
      const holder = /^\s*\* UID (\d+) holds:/.exec(line);
      if (holder) { owner = holder[1]; matched = false; target = false; }
      const uri = /^\s*UriPermission\{\S+ (content:\/\/\S+) \[user (\d+)\](?: \[prefix\])?\}/.exec(line);
      if (uri) { matched = uri[1] === tree && uri[2] === String(context.user); target = false; }
      if (matched && line.trim() === `targetUserId=${context.user} sourcePkg=com.android.externalstorage targetPkg=${packageName}`) target = true;
      const persisted = /\bpersisted=0x([a-f\d]+)/i.exec(line)?.[1];
      if (persisted && owner === uid && matched && target) modes.push(Number.parseInt(persisted, 16));
    }
    if (modes.length > 1) throw new Error("Android reported ambiguous tree permissions.");
    const flags = modes[0];
    const required = writeRequired ? 3 : 1;
    return flags !== undefined && (flags & required) === required;
  } };
}

/** Read the persisted grant for this exact tree and the app's current-profile UID. */
export async function hasAndroidTreeReadGrant(context: EmulatorUiContext, packageName: string, directory: string, writeRequired = false): Promise<boolean> {
  return (await readAndroidTreeGrants(context, packageName)).has(directory, writeRequired);
}

/** A cancelled setup may leave DocumentsUI above an already stopped emulator,
 * especially when its result proxy lives in a separate task. Dismiss only a
 * foreground tree picker whose launch and return target both belong to it. */
export async function dismissEmulatorDocumentPicker(context: EmulatorUiContext, caller: string): Promise<void> {
  if (!/^[A-Za-z][\w]*(?:\.[\w]+)+$/.test(caller)) throw new Error("Invalid document picker caller.");
  const target = new RegExp(`resultTo=ActivityRecord\\{[a-f\\d]+ u${context.user} ${caller.replaceAll(".", "\\.")}/`);
  const picker = /documentsui.*\/com.android.documentsui.picker.PickActivity$/;
  const activities = shellCommand("dumpsys", "activity", "activities");
  const foreground = androidResumedActivity(await context.device.shell(activities));
  if (foreground?.user === String(context.user) && !picker.test(foreground.component)) return;
  let token: string | undefined;
  const deadline = Date.now() + 60_000;
  for (let step = 0; step < 64 && Date.now() < deadline; step++) {
    const snapshot = await waitEmulatorUi(context, (value) => value);
    if (!picker.test(snapshot.component)) return;
    const output = await context.device.shell(activities);
    const resumed = androidResumedActivity(output);
    if (!resumed || resumed.user !== String(context.user) || resumed.component !== snapshot.component
      || token !== undefined && resumed.token !== token) return;
    const records = output.split(/(?=^\s*\* Hist\s+#\d+:)/m).filter((block) =>
      new RegExp(`^\\s*\\* Hist\\s+#\\d+: ActivityRecord\\{${resumed.token} u${context.user} `).test(block));
    const block = records.length === 1 ? records[0] : undefined;
    if (!block?.includes(`launchedFromPackage=${caller} `) || !target.test(block)
      || !block.includes("act=android.intent.action.OPEN_DOCUMENT_TREE ")) return;
    token = resumed.token;
    try {
      await assertAndroidUiSnapshot(context.device, context.user, snapshot, context.signal);
    } catch (error) {
      if (error instanceof AndroidUiStateChangedError) continue;
      throw error;
    }
    const result = await context.device.shell(shellCommand("input", "keyevent", "KEYCODE_BACK"));
    if (/Error:|Exception|Permission Denial/i.test(result)) throw new Error("Android could not close the emulator's interrupted folder picker.");
    // Back can close a permission dialog or navigate to the parent directory.
    // Observe and revalidate the same picker before taking another step.
  }
  throw new Error("Close the emulator's interrupted folder picker on the device, then retry.");
}
