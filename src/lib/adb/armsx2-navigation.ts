import type { AndroidUiNode, AndroidUiSnapshot } from "./android-ui";
import { restartEmulator, scrollEmulatorList, tapEmulatorNode, waitEmulatorUi, type EmulatorUiContext } from "./emulator-ui";
import type { Armsx2LabelKey, Armsx2Labels } from "./armsx2-labels";
import { checkActivityStart, shellCommand } from "./transport";

export const ARMSX2_PACKAGE = "com.armsx2";
const ACTIVITY = `${ARMSX2_PACKAGE}/${ARMSX2_PACKAGE}.Main`;

export interface Armsx2UiContext extends EmulatorUiContext { labels: Armsx2Labels }
export type Armsx2WizardPage = 0 | 1 | 2 | 3 | 4;
export interface Armsx2WizardState { snapshot: AndroidUiSnapshot; page: Armsx2WizardPage }

export function armsx2HasLabel(context: Armsx2UiContext, snapshot: AndroidUiSnapshot, key: Armsx2LabelKey): boolean {
  return snapshot.component === ACTIVITY && snapshot.nodes.some((node) => context.labels.get(key)?.has(node.text) || context.labels.get(key)?.has(node.description));
}

export function armsx2Action(context: Armsx2UiContext, snapshot: AndroidUiSnapshot, key: Armsx2LabelKey): AndroidUiNode | undefined {
  if (snapshot.component !== ACTIVITY) return undefined;
  const labels = context.labels.get(key);
  const targets = new Set<AndroidUiNode>();
  for (const node of snapshot.nodes.filter((entry) => labels?.has(entry.text) || labels?.has(entry.description))) {
    let target: AndroidUiNode | undefined = node;
    while (target && !target.clickable) target = target.parent === null ? undefined : snapshot.nodes[target.parent];
    if (target?.enabled) targets.add(target);
  }
  if (targets.size > 1) throw new Error(`ARMSX2's ${key} action is ambiguous.`);
  return [...targets][0];
}

export async function tapArmsx2Action(context: Armsx2UiContext, key: Armsx2LabelKey, initial?: AndroidUiSnapshot): Promise<void> {
  const snapshot = initial ?? await waitEmulatorUi(context, (value) => armsx2Action(context, value, key) ? value : undefined);
  const action = armsx2Action(context, snapshot, key);
  if (!action) throw new Error(`ARMSX2's ${key} action is unavailable.`);
  await tapEmulatorNode(context, snapshot, action);
}

export function armsx2WizardPage(context: Armsx2UiContext, snapshot: AndroidUiSnapshot): Armsx2WizardPage | undefined {
  if (!armsx2HasLabel(context, snapshot, "setup.button.next") && !armsx2HasLabel(context, snapshot, "setup.button.letsGo")) return undefined;
  if (armsx2HasLabel(context, snapshot, "setup.page.welcome.title") || armsx2HasLabel(context, snapshot, "setup.welcome.heading")) return 0;
  if (armsx2HasLabel(context, snapshot, "setup.button.applyFinish")) return 4;
  if (armsx2HasLabel(context, snapshot, "setup.page.roms.title")) return 3;
  if (armsx2HasLabel(context, snapshot, "setup.page.bios.title")) return 2;
  if (armsx2HasLabel(context, snapshot, "setup.step.appData.title")) return 1;
  return undefined;
}

/** Search both ways because the wizard can retain an earlier scroll position. */
export async function findArmsx2WizardContent<T>(
  context: Armsx2UiContext, inspect: (snapshot: AndroidUiSnapshot) => T | undefined,
  firstDirection: "down" | "up" = "down", initial?: AndroidUiSnapshot,
): Promise<T | undefined> {
  let previous = "";
  let unchanged = 0;
  let direction = firstDirection;
  for (let attempt = 0; attempt < 60; attempt++) {
    const snapshot = initial ?? await waitEmulatorUi(context, (value) => value.component === ACTIVITY
      && (armsx2HasLabel(context, value, "setup.button.next") || armsx2HasLabel(context, value, "setup.button.letsGo")) ? value : undefined);
    initial = undefined;
    const result = inspect(snapshot);
    if (result !== undefined) return result;
    const lists = snapshot.nodes.filter((node) => node.scrollable && node.enabled
      && node.bounds[2] > node.bounds[0] && node.bounds[3] > node.bounds[1]);
    if (lists.length === 0) return undefined;
    if (lists.length !== 1 || !lists[0]) throw new Error("ARMSX2's setup scroll area is ambiguous.");
    const signature = JSON.stringify(snapshot.nodes.map((node) => [node.resourceId, node.text, node.description, node.bounds]));
    unchanged = signature === previous ? unchanged + 1 : 0;
    if (unchanged >= 2) {
      if (direction !== firstDirection) return undefined;
      direction = firstDirection === "down" ? "up" : "down";
      unchanged = 0;
    }
    previous = signature;
    await scrollEmulatorList(context, snapshot, lists[0], direction);
  }
  throw new Error("ARMSX2's setup content search exceeded its limit.");
}

export async function currentArmsx2Wizard(context: Armsx2UiContext): Promise<Armsx2WizardState> {
  const current = await findArmsx2WizardContent(context, (snapshot) => {
    const page = armsx2WizardPage(context, snapshot);
    return page === undefined ? undefined : { snapshot, page };
  }, "up");
  if (!current) throw new Error("ARMSX2's setup page could not be identified.");
  return current;
}

async function openSetupFromDrawer(context: Armsx2UiContext): Promise<void> {
  let previous = "";
  for (let attempt = 0; attempt < 16; attempt++) {
    const snapshot = await waitEmulatorUi(context, (value) => value.component === ACTIVITY
      && value.nodes.some((node) => node.scrollable) ? value : undefined);
    const action = armsx2Action(context, snapshot, "games.overflow.setup");
    if (action) { await tapEmulatorNode(context, snapshot, action); return; }
    const lists = snapshot.nodes.filter((node) => node.scrollable && node.enabled);
    const signature = JSON.stringify(snapshot.nodes.map((node) => [node.text, node.description, node.bounds]));
    if (lists.length !== 1 || !lists[0] || signature === previous) break;
    previous = signature;
    await scrollEmulatorList(context, snapshot, lists[0]);
  }
  throw new Error("ARMSX2's setup entry was not found in its navigation drawer.");
}

async function startArmsx2(context: Armsx2UiContext, resetTask: boolean): Promise<void> {
  // After a deliberate restart, discard a pending picker in this app's task.
  checkActivityStart(await context.device.shell(shellCommand("am", "start", "--user", String(context.user), "--display", "0", "-W",
    ...(resetTask ? ["-f", "0x10008000"] : []), "-n", ACTIVITY)));
}

/** ARMSX2 uses its own Compose navigator and exposes no settings intent. */
export async function openArmsx2Wizard(context: Armsx2UiContext, resetTask = false): Promise<Armsx2WizardState & { setupComplete: boolean }> {
  await context.ensureUnlocked();
  await startArmsx2(context, resetTask);
  const ready = (value: AndroidUiSnapshot): AndroidUiSnapshot | undefined => value.component === ACTIVITY
    && (armsx2WizardPage(context, value) !== undefined || armsx2Action(context, value, "games.overflow.openNavigation")
      || armsx2Action(context, value, "action.back") || armsx2HasLabel(context, value, "bios.boot.title")
      || armsx2HasLabel(context, value, "games.overflow.setup")) ? value : undefined;
  let snapshot = await waitEmulatorUi(context, ready);
  for (let attempt = 0; attempt < 4; attempt++) {
    const page = armsx2WizardPage(context, snapshot);
    if (page !== undefined) return { snapshot, page, setupComplete: false };
    const navigation = armsx2Action(context, snapshot, "games.overflow.openNavigation");
    if (navigation) {
      await tapEmulatorNode(context, snapshot, navigation);
      await openSetupFromDrawer(context);
      return { ...await currentArmsx2Wizard(context), setupComplete: true };
    }
    if (armsx2HasLabel(context, snapshot, "bios.boot.title") || armsx2HasLabel(context, snapshot, "games.overflow.setup")) {
      await openSetupFromDrawer(context);
      return { ...await currentArmsx2Wizard(context), setupComplete: true };
    }
    const back = armsx2Action(context, snapshot, "action.back");
    if (!back) break;
    await tapEmulatorNode(context, snapshot, back);
    snapshot = await waitEmulatorUi(context, ready);
  }
  throw new Error("ARMSX2's setup cannot be opened. Close any running game and retry.");
}

export async function goToArmsx2WizardPage(context: Armsx2UiContext, target: Armsx2WizardPage, initial?: Armsx2WizardState): Promise<AndroidUiSnapshot> {
  // Reuse the preceding observation; taps still revalidate the current UI.
  let current = initial ?? await currentArmsx2Wizard(context);
  for (let attempt = 0; attempt < 8; attempt++) {
    const { snapshot, page } = current;
    if (page === target) return snapshot;
    const key = page < target ? "setup.button.next" : "action.back";
    const action = armsx2Action(context, snapshot, key);
    if (!action) throw new Error("Complete ARMSX2's missing setup item before continuing.");
    await tapEmulatorNode(context, snapshot, action);
    const expected = page + (page < target ? 1 : -1);
    current = await waitEmulatorUi(context, async (value) => {
      const page = armsx2WizardPage(context, value);
      if (page !== undefined) return page === expected ? { snapshot: value, page } : undefined;
      if (!armsx2HasLabel(context, value, "setup.button.next") && !armsx2HasLabel(context, value, "setup.button.letsGo")) return undefined;
      const observed = await currentArmsx2Wizard(context);
      return observed.page === expected ? observed : undefined;
    });
  }
  throw new Error("ARMSX2's setup navigation exceeded its limit.");
}

export async function finishArmsx2Wizard(context: Armsx2UiContext, initial?: Armsx2WizardState): Promise<void> {
  const snapshot = await goToArmsx2WizardPage(context, 4, initial);
  await tapArmsx2Action(context, "setup.button.letsGo", snapshot);
  await waitEmulatorUi(context, (value) => armsx2Action(context, value, "games.overflow.openNavigation") ? true : undefined, 60_000);
}

/** Close an already-completed setup editor without submitting setup again. */
export async function closeArmsx2Wizard(context: Armsx2UiContext): Promise<void> {
  await restartEmulator(context, ARMSX2_PACKAGE, "ARMSX2");
  await startArmsx2(context, true);
  await waitEmulatorUi(context, (value) => armsx2Action(context, value, "games.overflow.openNavigation") ? true : undefined, 60_000);
}
