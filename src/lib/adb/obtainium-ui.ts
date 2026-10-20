import { AndroidUiStateChangedError, pressAndroidUiKey, readAndroidUi, tapAndroidUi, type AndroidUiNode, type AndroidUiSnapshot } from "./android-ui";
import type { ApplicationInstallContext } from "./application-install";
import { grantPackagePermissions } from "./android-package";
import { withAndroidUiDump } from "./android-ui-dump";
import { androidUserProcessPid } from "./android-user";
import { withAwakeDevice } from "./device-awake";
import { OBTAINIUM_PACKAGE, isUiDescendant, obtainiumDialog } from "./obtainium-ui-anchors";
import { checkAbort } from "./setup-events";
import { checkActivityStart, shellCommand } from "./transport";

export { OBTAINIUM_PACKAGE } from "./obtainium-ui-anchors";
const MAIN_ACTIVITY = `${OBTAINIUM_PACKAGE}/.MainActivity`;
export type ObtainiumContext = Pick<ApplicationInstallContext, "device" | "user" | "signal" | "reportStatus">;

export function uiLabel(node: AndroidUiNode): string {
  return node.text || node.description;
}

export function isObtainium(snapshot: AndroidUiSnapshot): boolean {
  return snapshot.component === `${OBTAINIUM_PACKAGE}/${OBTAINIUM_PACKAGE}.MainActivity`;
}

function emptyObtainiumHome(
  snapshot: AndroidUiSnapshot, descendants: readonly AndroidUiNode[], visible: (node: AndroidUiNode) => boolean,
): boolean {
  if (descendants.some((node) => node.className === "android.widget.ProgressBar")) return false;
  const buttons = descendants.filter((node) => node.className === "android.widget.Button");
  const labels = descendants.filter((node) => uiLabel(node).trim() && !buttons.includes(node));
  if (labels.length < 2 || labels.length > 3 || labels.some((node) => node.className !== "android.view.View"
    || node.clickable || !visible(node))) return false;
  for (const header of descendants.filter((node) => node.className === "android.view.View" && visible(node))) {
    const children = descendants.filter((node) => node.parent === snapshot.nodes.indexOf(header));
    const titles = children.filter((node) => labels.includes(node));
    const actions = children.filter((node) => buttons.includes(node));
    const title = titles[0];
    if (titles.length !== 1 || !title || ![1, 3].includes(actions.length)
      || actions.some((node) => !node.clickable || !node.focusable || !uiLabel(node).trim() || !visible(node))) continue;
    const list = header.parent === null ? undefined : snapshot.nodes[header.parent];
    if (!list) continue;
    // The empty app list still has its toolbar and a message beneath it; the detail pane alone is insufficient.
    const messages = labels.filter((node) => node !== title && isUiDescendant(snapshot, node, list)
      && node.bounds[0] >= header.bounds[0] && node.bounds[2] <= header.bounds[2]
      && node.bounds[1] >= header.bounds[3]);
    const message = messages[0];
    if (messages.length !== 1 || !message) continue;
    if (labels.some((node) => node !== title && node !== message
      && !(node.bounds[2] <= header.bounds[0] || node.bounds[0] >= header.bounds[2]))) continue;
    const remaining = buttons.filter((node) => !actions.includes(node));
    const add = remaining[0];
    if (actions.length === 3) {
      // The TV add action is below the empty list and may be outside the accessibility viewport.
      if (remaining.length <= 1 && (!add || (add.enabled && add.clickable && add.focusable && !!uiLabel(add).trim()))) return true;
    } else if (remaining.length === 1 && add && add.clickable && add.focusable && uiLabel(add).trim()
      && visible(add) && add.bounds[0] >= header.bounds[0] && add.bounds[2] <= header.bounds[2]
      && add.bounds[1] >= message.bounds[3]) {
      return true;
    }
  }
  return false;
}

export function obtainiumHome(snapshot: AndroidUiSnapshot): boolean {
  if (!isObtainium(snapshot)) return false;
  const owned = snapshot.nodes.filter((node) => node.packageName === OBTAINIUM_PACKAGE);
  const contents = owned.filter((node) => node.resourceId === "android:id/content");
  const content = contents[0];
  if (contents.length !== 1 || !content) return false;
  const visible = (node: AndroidUiNode): boolean => node.enabled && node.bounds[0] >= content.bounds[0]
    && node.bounds[1] >= content.bounds[1] && node.bounds[2] <= content.bounds[2]
    && node.bounds[3] <= content.bounds[3] && node.bounds[2] > node.bounds[0] && node.bounds[3] > node.bounds[1];
  const descendants = owned.filter((node) => isUiDescendant(snapshot, node, content));
  if (descendants.some((node) => node.className === "android.view.View" && node.clickable && node.focusable
    && node.bounds.every((value, index) => value === content.bounds[index])
    && !snapshot.nodes.some((child) => child.parent === snapshot.nodes.indexOf(node)))) return false;
  const fields = descendants.filter((node) => node.className === "android.widget.EditText");
  const field = fields[0];
  if (!fields.length) return emptyObtainiumHome(snapshot, descendants, visible);
  if (fields.length !== 1 || !field || !visible(field)) return false;
  // The home search area contains selection, optional clear-filter, and filter actions.
  // Obtainium 1.7.1 exposes a translated selection description instead of just the app count.
  let parent = field.parent;
  while (parent !== null) {
    const area = snapshot.nodes[parent];
    if (!area || area === content) break;
    const areaButtons = descendants.filter((node) => node.className === "android.widget.Button"
      && isUiDescendant(snapshot, node, area));
    if (areaButtons.length) {
      // Use the search row's structure, not label wording, digits, or left-to-right ordering.
      return areaButtons.length >= 2 && areaButtons.length <= 3
        && areaButtons.every((node) => node.clickable && node.focusable && visible(node) && !!uiLabel(node).trim()
          && node.bounds[1] < field.bounds[3] && node.bounds[3] > field.bounds[1]);
    }
    parent = area.parent;
  }
  return false;
}

function onboardingSnapshot(snapshot: AndroidUiSnapshot): AndroidUiSnapshot | undefined {
  if (!isObtainium(snapshot)) return undefined;
  // Unknown dialogs reach the first-run handler so it can refuse confirmation.
  return obtainiumDialog(snapshot) || obtainiumHome(snapshot) ? snapshot : undefined;
}

class ObtainiumUiTimeoutError extends Error {
  constructor(observation: string) {
    super(`Obtainium's interface did not become ready. Retry setup. ${observation}`);
    this.name = "ObtainiumUiTimeoutError";
  }
}

function uiObservation(snapshot: AndroidUiSnapshot): string {
  const owned = snapshot.nodes.filter((node) => node.packageName === OBTAINIUM_PACKAGE);
  const fields = owned.filter((node) => node.className === "android.widget.EditText").length;
  const buttons = owned.filter((node) => node.className === "android.widget.Button");
  const visibleButtons = buttons.filter((node) => node.enabled && node.bounds[2] > node.bounds[0]
    && node.bounds[3] > node.bounds[1]).length;
  // Report structure only, never app names, source URLs, or other screen text.
  return `Last UI: profile ${snapshot.user}, foreground ${snapshot.component}, ${owned.length} Obtainium nodes, `
    + `${fields} input fields, ${visibleButtons}/${buttons.length} visible buttons.`;
}

export async function waitObtainiumState<T>(
  context: ObtainiumContext, ensureUnlocked: () => Promise<boolean>,
  inspect: (snapshot: AndroidUiSnapshot) => T | undefined | Promise<T | undefined>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let observation = "No UI snapshot was captured.";
  const confirmRunning = async (): Promise<void> => {
    if (!(await androidUserProcessPid(context.device, OBTAINIUM_PACKAGE, context.user, context.signal))) {
      throw new Error("Obtainium stopped before its interface became ready. Retry setup.");
    }
  };
  // Each serial device snapshot is the next readiness check; elapsed time cannot confirm the UI.
  while (Date.now() < deadline) {
    checkAbort(context.signal);
    await ensureUnlocked();
    let snapshot: AndroidUiSnapshot;
    try {
      snapshot = await readAndroidUi(context.device, context.user, context.signal);
    } catch (error) {
      if (!(error instanceof AndroidUiStateChangedError)) throw error;
      observation = `Last UI snapshot: ${error.message}`;
      await confirmRunning();
      continue;
    }
    const result = await inspect(snapshot);
    checkAbort(context.signal);
    if (result !== undefined) return result;
    observation = uiObservation(snapshot);
    if (!isObtainium(snapshot)) await confirmRunning();
  }
  checkAbort(context.signal);
  throw new ObtainiumUiTimeoutError(observation);
}

export async function openObtainiumUri(context: ObtainiumContext, uri?: string): Promise<void> {
  checkAbort(context.signal);
  if (uri !== undefined && (!uri.startsWith("obtainium://") || new TextEncoder().encode(uri).length > 32_000)) {
    throw new Error("Obtainium configuration link is invalid or too large.");
  }
  const argumentsList = ["am", "start", "--user", String(context.user), "--display", "0", "-W", "-n", MAIN_ACTIVITY];
  if (uri !== undefined) argumentsList.push("-a", "android.intent.action.VIEW", "-d", uri);
  const output = await context.device.shell(shellCommand(...argumentsList));
  checkActivityStart(output);
  if (!/Status:\s*ok\b/.test(output)) throw new Error("Android did not confirm the Obtainium launch.");
  checkAbort(context.signal);
}

export async function withObtainiumAwake<T>(
  context: ObtainiumContext, action: (ensureUnlocked: () => Promise<boolean>) => Promise<T>,
): Promise<T> {
  return withAwakeDevice(context.device, context.user, {
    signal: context.signal,
    onUnlockRequired(required) {
      if (context.signal?.aborted) return;
      return context.reportStatus(required ? "Unlock your Android device to continue setup." : "Configuring Obtainium…", { unlockRequired: required });
    },
  }, action);
}

function appOpAllowed(output: string): boolean {
  if (/Error:|Exception|Permission Denial/i.test(output)) return false;
  const uidModes = [...output.matchAll(/Uid mode:\s*REQUEST_INSTALL_PACKAGES:\s*(\w+)/g)];
  if (uidModes.length > 1) return false;
  const uid = uidModes[0]?.[1];
  if (uid !== undefined && uid !== "default") return uid === "allow";
  const packageOutput = output.replace(/Uid mode:[^\r\n]*/g, "");
  const modes = [...packageOutput.matchAll(/REQUEST_INSTALL_PACKAGES:\s*(\w+)/g)];
  return modes.length === 1 && modes[0]?.[1] === "allow";
}

export async function prepareObtainium(context: ApplicationInstallContext): Promise<void> {
  const { device, user, signal } = context;
  await context.reportStatus("Allowing Obtainium to install apps in this profile…");
  const grant = await device.shell(shellCommand("cmd", "appops", "set", "--user", String(user), OBTAINIUM_PACKAGE, "REQUEST_INSTALL_PACKAGES", "allow"));
  if (/Error:|Exception|Permission Denial/i.test(grant)) throw new Error("Android denied Obtainium's app installation permission.");
  checkAbort(signal);
  const permission = await device.shell(shellCommand("cmd", "appops", "get", "--user", String(user), OBTAINIUM_PACKAGE, "REQUEST_INSTALL_PACKAGES"));
  if (!appOpAllowed(permission)) throw new Error("Android did not confirm Obtainium's app installation permission.");
  const sdk = (await device.shell(shellCommand("getprop", "ro.build.version.sdk"))).trim();
  if (!/^[1-9]\d*$/.test(sdk) || !Number.isSafeInteger(Number(sdk))) {
    throw new Error("Android version was not confirmed for Obtainium permissions.");
  }
  if (Number(sdk) >= 33) {
    await context.reportStatus("Allowing Obtainium notifications in this profile…");
    await grantPackagePermissions(device, OBTAINIUM_PACKAGE, user, ["android.permission.POST_NOTIFICATIONS"], signal);
  }
  await withObtainiumAwake(context, async (ensureUnlocked) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ready = await withAndroidUiDump(device, signal, async () => {
        await device.shell(shellCommand("am", "force-stop", "--user", String(user), OBTAINIUM_PACKAGE));
        await openObtainiumUri(context);
        await context.reportStatus("Waiting for Obtainium's first-run dialog or home screen…");
        let snapshot: AndroidUiSnapshot;
        try {
          snapshot = await waitObtainiumState(context, ensureUnlocked, onboardingSnapshot);
        } catch (error) {
          if (!(error instanceof ObtainiumUiTimeoutError) || attempt > 0) throw error;
          checkAbort(signal);
          context.log(error.message);
          return false;
        }
        await confirmFirstRunDialogs(context, snapshot, ensureUnlocked);
        return true;
      });
      if (ready) return;
      // Only initial readiness can restart. Never replay a confirmation or interrupt an import.
      const message = "Obtainium's screen could not be confirmed. Restarting its UI snapshot session once…";
      await context.reportStatus(message);
      context.log(message);
    }
  });
}

async function confirmFirstRunDialogs(
  context: ApplicationInstallContext, snapshot: AndroidUiSnapshot, ensureUnlocked: () => Promise<boolean>,
): Promise<void> {
  const seen = new Set<string>();
  let confirmations = 0;
  let snapshotRetries = 0;
  while (confirmations <= 2) {
    const dialog = obtainiumDialog(snapshot);
    if (!dialog) {
      if (!obtainiumHome(snapshot)) {
        throw new Error("Obtainium's home screen was not confirmed.");
      }
      return;
    }
    if (dialog.kind === "import" || dialog.kind === "unknown" || seen.has(dialog.kind) || confirmations === 2) {
      throw new Error("Obtainium displayed an unexpected first-run dialog.");
    }
    const confirm = dialog.actions[0];
    if (!confirm || dialog.actions.length !== 1) {
      throw new Error("Obtainium's first-run confirmation was not recognized.");
    }
    try {
      snapshot = await confirmDialogTransition(context, snapshot, ensureUnlocked);
    } catch (error) {
      if (!(error instanceof AndroidUiStateChangedError) || ++snapshotRetries > 3) throw error;
      await context.reportStatus("Waiting for Obtainium's first-run dialog or home screen…");
      snapshot = await waitObtainiumState(context, ensureUnlocked, onboardingSnapshot);
      continue;
    }
    seen.add(dialog.kind);
    confirmations++;
    snapshotRetries = 0;
  }
}

function dialogIdentity(snapshot: AndroidUiSnapshot): string {
  const dialog = obtainiumDialog(snapshot);
  const nodes = dialog ? snapshot.nodes.filter((node) => node === dialog.card
    || isUiDescendant(snapshot, node, dialog.card)) : [];
  return JSON.stringify([snapshot.user, snapshot.component, snapshot.rotation, dialog?.kind,
    nodes.map((node) => {
      const parent = node.parent === null ? undefined : snapshot.nodes[node.parent];
      return { ...node, bounds: undefined, parent: parent ? nodes.indexOf(parent) : null, focused: false };
    })]);
}

async function confirmDialogTransition(
  context: ApplicationInstallContext, snapshot: AndroidUiSnapshot,
  ensureUnlocked: () => Promise<boolean>,
): Promise<AndroidUiSnapshot> {
  const kind = obtainiumDialog(snapshot)?.kind;
  const expected = dialogIdentity(snapshot);
  for (const keyboardOnly of [false, true]) {
    if (keyboardOnly) {
      const message = "Obtainium's dialog is still open; retrying its confirmation…";
      await context.reportStatus(message);
      context.log(message);
    }
    await activateDialogControl(context, snapshot, ensureUnlocked, keyboardOnly);
    await context.reportStatus("Waiting for Obtainium to finish the confirmed dialog…");
    let previous: string | undefined;
    let unchanged = 0;
    snapshot = await waitObtainiumState(context, ensureUnlocked, (value) => {
      if (!onboardingSnapshot(value)) {
        previous = undefined;
        unchanged = 0;
        return undefined;
      }
      if (obtainiumDialog(value)?.kind !== kind) return value;
      if (dialogIdentity(value) !== expected) {
        throw new Error("Obtainium's first-run dialog changed after confirmation.");
      }
      const current = JSON.stringify(value);
      unchanged = current === previous ? unchanged + 1 : 1;
      previous = current;
      return unchanged >= 3 ? value : undefined;
    });
    if (obtainiumDialog(snapshot)?.kind !== kind) return snapshot;
    // A tap can be ignored during first-run animations; retry only this unchanged, reviewed dialog.
  }
  throw new Error("Obtainium did not dismiss its confirmed first-run dialog. Retry setup.");
}

async function activateDialogControl(
  context: ApplicationInstallContext, snapshot: AndroidUiSnapshot,
  ensureUnlocked: () => Promise<boolean>, keyboardOnly = false,
): Promise<void> {
  const dialog = obtainiumDialog(snapshot);
  if (!dialog || !["welcome", "warning"].includes(dialog.kind) || dialog.actions.length !== 1) {
    throw new Error("Obtainium's first-run dialog action was not recognized.");
  }
  const target = dialog.actions[0];
  if (!target) throw new Error("Obtainium's first-run confirmation was not recognized.");
  const content = snapshot.nodes.find((node) => node.packageName === OBTAINIUM_PACKAGE && node.resourceId === "android:id/content");
  const [left, top, right, bottom] = target.bounds;
  if (!keyboardOnly && content && left >= content.bounds[0] && top >= content.bounds[1] && right <= content.bounds[2]
    && bottom <= content.bounds[3] && right > left && bottom > top) {
    await tapAndroidUi(context.device, context.user, snapshot, target, context.signal);
    return;
  }
  const signature = (value: AndroidUiSnapshot): string => {
    const current = obtainiumDialog(value);
    return JSON.stringify([value.rotation, current?.kind, current?.card.bounds, current?.actions.map(uiLabel)]);
  };
  const expected = signature(snapshot);
  for (let index = 0; index <= 8; index++) {
    const current = index === 0 ? snapshot : await waitObtainiumState(context, ensureUnlocked,
      onboardingSnapshot);
    const currentDialog = obtainiumDialog(current);
    if (!currentDialog || signature(current) !== expected) {
      throw new Error("Obtainium's dialog changed before keyboard confirmation.");
    }
    const focused = current.nodes.filter((node) => node.packageName === OBTAINIUM_PACKAGE && node.focused && node.clickable);
    const control = currentDialog.actions[0];
    if (control?.focused && focused.length === 1 && focused[0] === control) {
      await pressAndroidUiKey(context.device, context.user, current, "KEYCODE_ENTER", context.signal);
      return;
    }
    if (index < 8) await pressAndroidUiKey(context.device, context.user, current, "KEYCODE_TAB", context.signal);
  }
  throw new Error("Obtainium's dialog control did not receive keyboard focus.");
}
