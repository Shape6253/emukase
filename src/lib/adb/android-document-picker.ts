import { assertAndroidUiSnapshot, type AndroidUiSnapshot, type AndroidUiNode } from "./android-ui";
import { primaryStorageForUser } from "./android-user";
import { androidResourceText, emulatorNodeVisible, scrollEmulatorList, tapEmulatorNode, uiDescendant, uiNode, waitEmulatorUi, type EmulatorUiContext } from "./emulator-ui";
import { focusAndroidDocument, stepAndroidDocumentFocus } from "./android-document-focus";
import { shellCommand } from "./transport";

const PROVIDER = "com.android.externalstorage.documents";

function pickerPackage(component: string): string {
  const packageName = component.split("/")[0];
  if (!packageName || !["com.google.android.documentsui", "com.android.documentsui"].includes(packageName)
    || !component.endsWith("/com.android.documentsui.picker.PickActivity")) throw new Error("Unsupported Android document picker.");
  return packageName;
}

async function assertPickerCaller(context: EmulatorUiContext, picker: string, caller: string, tree: boolean): Promise<void> {
  const output = await context.device.shell(shellCommand("dumpsys", "activity", "activities"));
  const resumed = /topResumedActivity=ActivityRecord\{([a-f\d]+) u(\d+) (\S+) t(\d+)\}/.exec(output);
  if (!resumed || resumed[2] !== String(context.user) || resumed[3] !== `${picker}/com.android.documentsui.picker.PickActivity`) {
    throw new Error("Document picker is not resumed in the selected Android profile.");
  }
  const blocks = output.split(/(?=^\s*\* Hist\s+#\d+:)/m);
  const records = blocks.filter((value) => new RegExp(`^\\s*\\* Hist\\s+#\\d+: ActivityRecord\\{${resumed[1]} u${context.user} `).test(value));
  const block = records[0];
  const action = tree ? "OPEN_DOCUMENT_TREE" : "OPEN_DOCUMENT";
  const resultTo = new RegExp(`resultTo=ActivityRecord\\{[a-f\\d]+ u${context.user} ${caller.replaceAll(".", "\\.")}/[^\\s]+ t${resumed[4]}\\}`);
  if (records.length !== 1 || !block?.includes(`launchedFromPackage=${caller} `)
    || !block.includes(`act=android.intent.action.${action} `) || !resultTo.test(block)) {
    throw new Error("Android document selection is not returning to the initiating emulator.");
  }
}

async function primaryDirectory(context: EmulatorUiContext, picker: string): Promise<string | undefined> {
  const output = await context.device.shell(shellCommand("dumpsys", "activity", picker));
  const lines = output.split(/\r?\n/).filter((line) => line.includes("mArguments=Bundle[{root=Root{"));
  if (lines.length !== 1) return undefined;
  const line = lines[0] ?? "";
  if (!line.includes(`root=Root{userId=${context.user}, authority=${PROVIDER}, rootId=primary,`)
    || !line.includes("mimeType=vnd.android.document/directory,")) return undefined;
  const doc = /document=DocumentInfo\{docId=(primary:[^\r\n]*), userId=(\d+), name=/.exec(line);
  const uri = /@ content:\/\/com\.android\.externalstorage\.documents\/document\/([^\s},\]]+)/.exec(line);
  if (!doc?.[1] || doc[2] !== String(context.user) || !uri?.[1] || decodeURIComponent(uri[1]) !== doc[1]) {
    throw new Error("Android document directory identity could not be confirmed.");
  }
  return doc[1];
}

/** Select real files/trees through the emulator's own SAF callback. */
export async function selectAndroidDocument(
  context: EmulatorUiContext, caller: string, path: string, tree = false,
  onSelectFile?: (snapshot: AndroidUiSnapshot, node: AndroidUiNode) => Promise<void>,
): Promise<void> {
  if (!/^[A-Za-z][\w]*(?:\.[\w]+)+$/.test(caller)) throw new Error("Invalid document picker caller.");
  const prefix = `${primaryStorageForUser(context.user)}/`;
  if (!path.startsWith(prefix)) throw new Error("Document selection requires the selected profile's primary storage.");
  const parts = path.slice(prefix.length).split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\x00-\x1f\x7f]/.test(part))) throw new Error("Invalid document path.");
  const initial = await waitEmulatorUi(context, (snapshot) => /documentsui.*\/com.android.documentsui.picker.PickActivity$/.test(snapshot.component) ? snapshot : undefined);
  const picker = pickerPackage(initial.component);
  await assertPickerCaller(context, picker, caller, tree);
  const wanted = `primary:${(tree ? parts : parts.slice(0, -1)).join("/")}`;
  const id = (name: string): string => `${picker}:id/${name}`;
  if (await primaryDirectory(context, picker) !== wanted) {
    // The primary volume title is supplied by Android, usually the device model.
    const model = (await context.device.shell(shellCommand("getprop", "ro.product.model"))).trim();
    const internal = await androidResourceText(context, picker, "android:string/storage_internal");
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
    await waitEmulatorUi(context, async (value) => value.component === initial.component
      && await primaryDirectory(context, picker) === "primary:" ? true : undefined);
  }

  const row = async (name: string, directory: string, handoff?: typeof onSelectFile): Promise<void> => {
    let previous = "";
    let repeated = 0;
    let triedFocus = false;
    const observe = (): Promise<AndroidUiSnapshot> => waitEmulatorUi(context, async (value) => value.component === initial.component
      && await primaryDirectory(context, picker) === directory ? value : undefined);
    for (let attempt = 0; attempt < 60; attempt++) {
      const snapshot = await observe();
      const matches = snapshot.nodes.filter((node) => node.resourceId === "android:id/title" && node.text === name
        && uiDescendant(snapshot, node, id("dir_list")));
      if (matches.length > 1) throw new Error("The Android document name is ambiguous.");
      if (matches[0] && emulatorNodeVisible(snapshot, matches[0])) {
        await assertPickerCaller(context, picker, caller, tree);
        if (await primaryDirectory(context, picker) !== directory) throw new Error("Android changed its document directory.");
        if (handoff) await handoff(snapshot, matches[0]);
        else await tapEmulatorNode(context, snapshot, matches[0]);
        return;
      }
      const listView = uiNode(snapshot, id("sub_menu_list"));
      if (listView?.enabled) {
        // Large landscape grids can clip filenames below the visible viewport.
        await tapEmulatorNode(context, snapshot, listView);
        previous = "";
        continue;
      }
      if (!triedFocus) {
        triedFocus = true;
        await focusAndroidDocument(context, picker, snapshot, name, observe);
        continue;
      }
      const signature = JSON.stringify(snapshot.nodes.map((node) => [node.text, node.bounds, node.focused, node.selected]));
      repeated = signature === previous ? repeated + 1 : 0;
      const unreportedSelection = uiNode(snapshot, id("dir_list"))?.className === "android.widget.GridView"
        && !snapshot.nodes.some((node) => (node.focused || node.selected) && uiDescendant(snapshot, node, id("dir_list")));
      if (repeated >= 2 && !unreportedSelection) throw new Error(`Android could not find ${name} in the selected folder.`);
      previous = signature;
      if (await stepAndroidDocumentFocus(context, picker, snapshot, name)) continue;
      const list = uiNode(snapshot, id("dir_list"));
      if (!list) throw new Error("Android document list is unavailable.");
      await scrollEmulatorList(context, snapshot, list);
    }
    throw new Error("Android document navigation exceeded its limit.");
  };
  let current = await primaryDirectory(context, picker);
  if (current !== wanted) {
    current = "primary:";
    for (const part of tree ? parts : parts.slice(0, -1)) {
      await row(part, current);
      current = `${current}${current === "primary:" ? "" : "/"}${part}`;
      const expected = current;
      await waitEmulatorUi(context, async () => await primaryDirectory(context, picker) === expected ? true : undefined);
    }
  }
  if (!tree) {
    const filename = parts.at(-1);
    if (!filename) throw new Error("Missing document filename.");
    await row(filename, wanted, onSelectFile);
    return;
  }
  const selectControl = (value: AndroidUiSnapshot): AndroidUiNode | undefined => {
    const controls = value.nodes.filter((node) => node.enabled && (node.resourceId === id("action_menu_select")
      || (node.resourceId === "android:id/button1" && uiDescendant(value, node, id("container_save")))));
    if (controls.length > 1) throw new Error("Android folder selection is ambiguous.");
    return controls[0];
  };
  const snapshot = await waitEmulatorUi(context, (value) => value.component === initial.component && selectControl(value) ? value : undefined);
  const select = selectControl(snapshot);
  if (!select || await primaryDirectory(context, picker) !== wanted) throw new Error("Android did not confirm the selected game folder.");
  await assertPickerCaller(context, picker, caller, true);
  await tapEmulatorNode(context, snapshot, select);
  const confirmation = await waitEmulatorUi(context, (value) => uiNode(value, "android:id/button1") ? value : undefined);
  const allow = uiNode(confirmation, "android:id/button1");
  if (!allow || !confirmation.component.startsWith(`${picker}/`)) throw new Error("Android folder permission confirmation is unavailable.");
  await assertPickerCaller(context, picker, caller, true);
  if (await primaryDirectory(context, picker) !== wanted) throw new Error("Android changed the game folder before granting access.");
  await assertAndroidUiSnapshot(context.device, context.user, confirmation, context.signal);
  await tapEmulatorNode(context, confirmation, allow);
}

/** Read the persisted grant for this exact tree and the app's current-profile UID. */
export async function hasAndroidTreeReadGrant(context: EmulatorUiContext, packageName: string, directory: string, writeRequired = false): Promise<boolean> {
  if (!/^[A-Za-z][\w]*(?:\.[\w]+)+$/.test(packageName)) throw new Error("Invalid Android package.");
  const prefix = `${primaryStorageForUser(context.user)}/`;
  if (!directory.startsWith(prefix)) throw new Error("Tree permission belongs to another Android profile.");
  const packages = await context.device.shell(shellCommand("pm", "list", "packages", "-U", "--user", String(context.user), packageName));
  const uid = new RegExp(`^package:${packageName.replaceAll(".", "\\.")} uid:(\\d+)$`).exec(packages.trim())?.[1];
  if (!uid || Math.floor(Number(uid) / 100_000) !== context.user) throw new Error("Android did not confirm the emulator's profile UID.");
  const tree = `content://com.android.externalstorage.documents/tree/${encodeURIComponent(`primary:${directory.slice(prefix.length)}`)}`;
  const output = await context.device.shell(shellCommand("dumpsys", "activity", "permissions"));
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
}
