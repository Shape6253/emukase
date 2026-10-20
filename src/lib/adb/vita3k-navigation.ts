import type { AndroidUiNode, AndroidUiSnapshot } from "./android-ui";
import { EMULATORS } from "./emulators";
import { androidResourceText, emulatorNodeVisible, scrollEmulatorList, tapEmulatorNode, uiWithin, waitEmulatorUi, type EmulatorUiContext } from "./emulator-ui";
import { checkActivityStart, shellCommand } from "./transport";

export const VITA3K_PACKAGE = EMULATORS.vita3k.packages[0];
export const VITA3K_ACTIVITY = `${VITA3K_PACKAGE}/org.vita3k.emulator.MainActivity`;

// Source recipe: Vita3K/Vita3K 86b8e2eb5cabd9be9d937e29b22dddf3904dd661,
// android/app/src/main/java/org/vita3k/emulator/ui/{navigation/AppNavigation.kt,
// screens/InitialSetupScreen.kt,screens/AppsListScreen.kt,screens/InstallSheet.kt}.
const RESOURCES = [
  "initial_setup_next", "initial_setup_skip", "initial_setup_open_library", "initial_setup_main_title",
  "initial_setup_font_title", "initial_setup_preinstall_title", "initial_setup_install_pup",
  "initial_setup_status_installed", "initial_setup_status_missing", "initial_setup_status_optional",
  "apps_list_cd_more_options", "apps_list_menu_welcome", "apps_list_cd_install",
  "install_firmware_title", "install_result_success_title", "install_result_partial_title",
  "install_result_failed_title", "install_progress_title", "action_ok", "emulation_exit",
  "apps_list_empty_firmware_title", "apps_list_empty_no_apps", "apps_list_init_failed",
  "settings_title",
] as const;

export type Vita3kLabel = typeof RESOURCES[number];
export interface Vita3kUiContext extends EmulatorUiContext {
  labels: ReadonlyMap<Vita3kLabel, string>;
}

export async function readVita3kLabels(context: EmulatorUiContext): Promise<ReadonlyMap<Vita3kLabel, string>> {
  return new Map(await Promise.all(RESOURCES.map(async (key) =>
    [key, await androidResourceText(context, VITA3K_PACKAGE, `${VITA3K_PACKAGE}:string/${key}`)] as const)));
}

export function isVita3k(snapshot: AndroidUiSnapshot): boolean {
  return snapshot.component === VITA3K_ACTIVITY || snapshot.component === `${VITA3K_PACKAGE}/.MainActivity`;
}

function matches(context: Vita3kUiContext, node: AndroidUiNode, key: Vita3kLabel): boolean {
  const label = context.labels.get(key);
  return label !== undefined && [node.text, node.description].some((value) => value.split(/\r?\n/).includes(label));
}

export function vita3kNode(context: Vita3kUiContext, snapshot: AndroidUiSnapshot, key: Vita3kLabel, scope?: AndroidUiNode): AndroidUiNode | undefined {
  if (!isVita3k(snapshot)) return undefined;
  const nodes = snapshot.nodes.filter((node) => matches(context, node, key) && (!scope || uiWithin(snapshot, node, scope)));
  if (nodes.length > 1) throw new Error(`Vita3K's ${key} control is ambiguous.`);
  return nodes[0];
}

export async function tapVita3k(context: Vita3kUiContext, key: Vita3kLabel, snapshot?: AndroidUiSnapshot): Promise<void> {
  const current = snapshot ?? await waitEmulatorUi(context, (value) => vita3kNode(context, value, key) ? value : undefined);
  const node = vita3kNode(context, current, key);
  if (!node || !emulatorNodeVisible(current, node)) throw new Error(`Vita3K's ${key} action is unavailable.`);
  await tapEmulatorNode(context, current, node);
}

/** Reject the SDL/legacy frontend before launching anything. */
export async function resolveModernVita3k(context: Pick<EmulatorUiContext, "device" | "user">): Promise<void> {
  const output = await context.device.shell(shellCommand("cmd", "package", "resolve-activity", "--brief", "--user", String(context.user),
    "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", VITA3K_PACKAGE));
  const components = output.trim().split(/\r?\n/).filter((line) => line.includes("/"));
  if (components.length !== 1 || ![VITA3K_ACTIVITY, `${VITA3K_PACKAGE}/.MainActivity`].includes(components[0] ?? "")) {
    throw new Error("This Vita3K build does not expose the modern native MainActivity. Legacy Android builds are not supported.");
  }
}

export async function launchVita3k(context: Vita3kUiContext): Promise<AndroidUiSnapshot> {
  context.signal?.throwIfAborted();
  await context.ensureUnlocked();
  const activities = await context.device.shell(shellCommand("dumpsys", "activity", "activities"));
  const emulation = activities.split(/(?=^\s*\* Hist\s+#\d+:)/m).some((block) =>
    new RegExp(`^\\s*\\* Hist\\s+#\\d+: ActivityRecord\\{[a-f\\d]+ u${context.user} ${VITA3K_PACKAGE.replaceAll(".", "\\.")}/(?:\\.Emulator|org\\.vita3k\\.emulator\\.Emulator)\\s`).test(block)
    && !/\bfinishing=true\b|^\s+state=DESTROYED\b/m.test(block));
  if (emulation) throw new Error("Close Vita3K's running emulation before configuring its firmware.");
  // Reuse MainActivity so a pending native install keeps its ViewModel and
  // result dialog. Clear only activities above it, such as a cancelled picker.
  checkActivityStart(await context.device.shell(shellCommand("am", "start", "--user", String(context.user), "--display", "0", "-W",
    "--activity-clear-top", "--activity-single-top", "-n", VITA3K_ACTIVITY)));
  return waitEmulatorUi(context, (snapshot) => isVita3k(snapshot) && ["initial_setup_next", "initial_setup_open_library", "apps_list_cd_more_options", "apps_list_menu_welcome", "settings_title", "install_progress_title", "install_result_success_title", "install_result_partial_title", "install_result_failed_title"]
    .some((key) => vita3kNode(context, snapshot, key as Vita3kLabel)) ? snapshot : undefined);
}

export type Vita3kRoute = "apps_list" | "initial_setup/manual" | "settings";

export interface Vita3kNavigationResult {
  snapshot: AndroidUiSnapshot;
  reached: boolean;
}

function libraryScreen(context: Vita3kUiContext, snapshot: AndroidUiSnapshot): boolean {
  return !!vita3kNode(context, snapshot, "apps_list_cd_more_options") && !!vita3kNode(context, snapshot, "apps_list_cd_install");
}

function routeReached(context: Vita3kUiContext, snapshot: AndroidUiSnapshot, route: Vita3kRoute): boolean {
  if (route === "apps_list") return libraryScreen(context, snapshot);
  if (route === "settings") return !!vita3kNode(context, snapshot, "settings_title");
  return !!vita3kNode(context, snapshot, "emulation_exit")
    && !!(vita3kNode(context, snapshot, "initial_setup_next") || vita3kNode(context, snapshot, "initial_setup_open_library"));
}

/** Compose Navigation hashes route URIs with Java's signed 32-bit String hash. */
export async function navigateVita3k(
  context: Vita3kUiContext, route: Vita3kRoute, snapshot?: AndroidUiSnapshot,
): Promise<Vita3kNavigationResult> {
  context.signal?.throwIfAborted();
  if (!["apps_list", "initial_setup/manual", "settings"].includes(route)) throw new Error("Unsupported Vita3K route.");
  const current = snapshot ?? await launchVita3k(context);
  if (!isVita3k(current)) throw new Error("Vita3K's main interface is unavailable.");
  const pendingInstall = (value: AndroidUiSnapshot): boolean =>
    (["install_progress_title", "install_result_success_title", "install_result_partial_title", "install_result_failed_title"] as const)
      .some((key) => vita3kNode(context, value, key));
  if (pendingInstall(current)) throw new Error("Finish Vita3K's pending native installation before navigating.");
  if (routeReached(context, current, route)) return { snapshot: current, reached: true };
  let destination = 0;
  for (const character of `android-app://androidx.navigation/${route}`) {
    destination = (Math.imul(destination, 31) + character.charCodeAt(0)) | 0;
  }
  await context.ensureUnlocked();
  checkActivityStart(await context.device.shell(shellCommand("am", "start", "--user", String(context.user), "--display", "0", "-W",
    "-f", "0x10008000", "-n", VITA3K_ACTIVITY, "--eia", "android-support-nav:controller:deepLinkIds", `0,${destination}`)));
  let previous = "";
  return waitEmulatorUi(context, (value) => {
    if (!isVita3k(value)) return undefined;
    if (pendingInstall(value)) throw new Error("Vita3K has a pending native installation.");
    if (routeReached(context, value, route)) return { snapshot: value, reached: true };
    // A changed graph may ignore the intent. Fall back only after observing a
    // stable, recognized page, not a transient startup frame or unknown window.
    if (!libraryScreen(context, value) && !vita3kNode(context, value, "initial_setup_next")
      && !vita3kNode(context, value, "initial_setup_open_library") && !vita3kNode(context, value, "settings_title")) return undefined;
    const signature = JSON.stringify(value.nodes.map((node) => [node.text, node.description, node.bounds]));
    if (signature === previous) return { snapshot: value, reached: false };
    previous = signature;
    return undefined;
  });
}

/** Reopening the manual welcome route preserves the completed-onboarding flag. */
export async function openVita3kFirmware(
  context: Vita3kUiContext, initial?: AndroidUiSnapshot, useDirectNavigation = true,
): Promise<{ snapshot: AndroidUiSnapshot; setupComplete: boolean }> {
  let snapshot = initial ?? await launchVita3k(context);
  let setupComplete = false;
  if (!vita3kNode(context, snapshot, "initial_setup_next") && !vita3kNode(context, snapshot, "initial_setup_open_library")) {
    setupComplete = true;
    const navigation = useDirectNavigation ? await navigateVita3k(context, "initial_setup/manual", snapshot) : undefined;
    snapshot = navigation?.snapshot ?? snapshot;
    if (!navigation?.reached) {
      if (!libraryScreen(context, snapshot)) throw new Error("This Vita3K build did not expose its manual setup route.");
      await waitVita3kLibrary(context);
      await tapVita3k(context, "apps_list_cd_more_options", snapshot);
      await tapVita3k(context, "apps_list_menu_welcome");
      snapshot = await waitEmulatorUi(context, (value) => vita3kNode(context, value, "initial_setup_next") ? value : undefined);
    }
  } else {
    setupComplete = !!vita3kNode(context, snapshot, "emulation_exit");
  }
  if (vita3kNode(context, snapshot, "initial_setup_next")) {
    await tapVita3k(context, "initial_setup_next", snapshot);
    snapshot = await waitEmulatorUi(context, (value) => vita3kNode(context, value, "initial_setup_open_library") ? value : undefined);
  }
  return { snapshot, setupComplete };
}

function visible(snapshot: AndroidUiSnapshot, node: AndroidUiNode): boolean {
  const [left, top, right, bottom] = node.bounds;
  if (right <= left || bottom <= top) return false;
  let parent = node.parent;
  while (parent !== null) {
    const ancestor = snapshot.nodes[parent];
    if (!ancestor) return false;
    if (ancestor.scrollable && (top < ancestor.bounds[1] || bottom > ancestor.bounds[3])) return false;
    parent = ancestor.parent;
  }
  return true;
}

export interface Vita3kFirmwareCard {
  snapshot: AndroidUiSnapshot;
  scope: AndroidUiNode;
  state: "accepted" | "missing";
}

function firmwareCard(context: Vita3kUiContext, snapshot: AndroidUiSnapshot, key: "initial_setup_main_title" | "initial_setup_font_title"): Vita3kFirmwareCard | undefined {
  const title = vita3kNode(context, snapshot, key);
  if (!title || !visible(snapshot, title)) return undefined;
  let ancestor = title.parent === null ? undefined : snapshot.nodes[title.parent];
  while (ancestor) {
    const current = ancestor;
    const titles = snapshot.nodes.filter((node) => uiWithin(snapshot, node, current)
      && ["initial_setup_main_title", "initial_setup_font_title", "initial_setup_preinstall_title"].some((entry) => matches(context, node, entry as Vita3kLabel)));
    // Compose may expose only a clipped title at the viewport edge, without
    // its status. Never expand into adjacent cards; scroll and inspect again.
    if (titles.length !== 1) return undefined;
    const statuses = snapshot.nodes.filter((node) => uiWithin(snapshot, node, current)
      && ["initial_setup_status_installed", "initial_setup_status_missing"].some((entry) => matches(context, node, entry as Vita3kLabel)));
    if (statuses.length > 1) throw new Error("Vita3K's firmware status is ambiguous.");
    const status = statuses[0];
    if (status && visible(snapshot, status)) {
      // Expand from the header row only as far as the single component card.
      let scope = ancestor;
      while (scope.parent !== null) {
        const parent = snapshot.nodes[scope.parent];
        if (!parent || snapshot.nodes.some((node) => uiWithin(snapshot, node, parent)
          && node !== title && ["initial_setup_main_title", "initial_setup_font_title", "initial_setup_preinstall_title"].some((entry) => matches(context, node, entry as Vita3kLabel)))) break;
        scope = parent;
      }
      return { snapshot, scope, state: matches(context, status, "initial_setup_status_installed") ? "accepted" : "missing" };
    }
    ancestor = ancestor.parent === null ? undefined : snapshot.nodes[ancestor.parent];
  }
  return undefined;
}

type FirmwareCardKey = "initial_setup_main_title" | "initial_setup_font_title";

/** Inspect all requested cards during one traversal; Compose virtualizes offscreen nodes. */
async function findVita3kCards(
  context: Vita3kUiContext, keys: readonly FirmwareCardKey[], initial?: AndroidUiSnapshot, requireInstall = false,
): Promise<{ cards: ReadonlyMap<FirmwareCardKey, Vita3kFirmwareCard>; snapshot: AndroidUiSnapshot }> {
  if (initial && (initial.user !== context.user || !isVita3k(initial))) throw new Error("Vita3K's firmware page belongs to another interface or profile.");
  context.signal?.throwIfAborted();
  const cards = new Map<FirmwareCardKey, Vita3kFirmwareCard>();
  const deadline = Date.now() + 60_000;
  const first = initial ?? await waitEmulatorUi(context, (value) => vita3kNode(context, value, "initial_setup_open_library") ? value : undefined);
  let snapshot: AndroidUiSnapshot | undefined = first;
  const title = keys.map((key) => vita3kNode(context, first, key)).find((node) => node);
  const list = first.nodes.find((node) => node.scrollable && node.enabled);
  const preferred = title && list && title.bounds[1] < list.bounds[1] ? "up" : "down";
  for (const direction of [preferred, preferred === "down" ? "up" : "down"] as const) {
    let previous = "";
    for (let attempt = 0; attempt < 20 && Date.now() < deadline; attempt++) {
      context.signal?.throwIfAborted();
      snapshot ??= await waitEmulatorUi(context, (value) => vita3kNode(context, value, "initial_setup_open_library") ? value : undefined, deadline - Date.now());
      for (const key of keys) {
        const card = firmwareCard(context, snapshot, key);
        const install = card && requireInstall ? vita3kNode(context, snapshot, "initial_setup_install_pup", card.scope) : undefined;
        if (card && (!requireInstall || (install && emulatorNodeVisible(snapshot, install)))) cards.set(key, card);
      }
      if (keys.every((key) => cards.has(key))) return { cards, snapshot };
      const lists = snapshot.nodes.filter((node) => node.scrollable && node.enabled);
      if (lists.length !== 1) throw new Error("Vita3K's setup scroll container is missing or ambiguous.");
      const signature = JSON.stringify(snapshot.nodes.map((node) => [node.text, node.description, node.bounds]));
      if (signature === previous) break;
      const list = lists[0];
      if (!list) break;
      previous = await scrollEmulatorList(context, snapshot, list, direction) ? signature : "";
      snapshot = undefined;
    }
  }
  throw new Error("Vita3K's firmware status cards were not found within the navigation limit.");
}

export async function findVita3kCard(context: Vita3kUiContext, key: FirmwareCardKey, requireInstall = false): Promise<Vita3kFirmwareCard> {
  const card = (await findVita3kCards(context, [key], undefined, requireInstall)).cards.get(key);
  if (!card) throw new Error(`Vita3K's ${key} card is unavailable.`);
  return card;
}

export interface Vita3kFirmwareStatus {
  firmware: "accepted" | "missing";
  fonts: "accepted" | "missing";
  snapshot: AndroidUiSnapshot;
}

export async function readVita3kFirmware(context: Vita3kUiContext, initial: AndroidUiSnapshot): Promise<Vita3kFirmwareStatus> {
  const { cards, snapshot } = await findVita3kCards(context, ["initial_setup_main_title", "initial_setup_font_title"], initial);
  const firmware = cards.get("initial_setup_main_title");
  const fonts = cards.get("initial_setup_font_title");
  if (!firmware || !fonts) throw new Error("Vita3K's main firmware and font statuses are incomplete.");
  return { firmware: firmware.state, fonts: fonts.state, snapshot };
}

export async function openVita3kImport(context: Vita3kUiContext, target: FirmwareCardKey): Promise<void> {
  let snapshot = await launchVita3k(context);
  if (vita3kNode(context, snapshot, "initial_setup_next") || vita3kNode(context, snapshot, "initial_setup_open_library")) {
    snapshot = (await openVita3kFirmware(context, snapshot)).snapshot;
    const card = (await findVita3kCards(context, [target], snapshot)).cards.get(target);
    if (!card) throw new Error("Vita3K's requested firmware card is unavailable.");
    snapshot = card.snapshot;
    const button = card.state === "missing" ? vita3kNode(context, card.snapshot, "initial_setup_install_pup", card.scope) : undefined;
    if (button && emulatorNodeVisible(card.snapshot, button)) {
      const actionable = (await findVita3kCards(context, [target], card.snapshot, true)).cards.get(target);
      const install = actionable && vita3kNode(context, actionable.snapshot, "initial_setup_install_pup", actionable.scope);
      if (!actionable || !install) throw new Error("Vita3K's firmware card does not expose its PUP installer.");
      // This is the same firmware picker as the Library's install sheet, without
      // completing/skipping onboarding or navigating away from its status cards.
      await tapEmulatorNode(context, actionable.snapshot, install);
      return;
    }
    // Installed or clipped cards may not expose an actionable button. Keep the
    // Library's picker as a fallback, never another card's identical label.
  }
  if (!libraryScreen(context, snapshot)) {
    const navigation = await navigateVita3k(context, "apps_list", snapshot);
    snapshot = navigation.snapshot;
  }
  if (vita3kNode(context, snapshot, "initial_setup_skip")) {
    await tapVita3k(context, "initial_setup_skip", snapshot);
  } else if (vita3kNode(context, snapshot, "emulation_exit")) {
    await tapVita3k(context, "emulation_exit", snapshot);
  }
  await waitVita3kLibrary(context);
  await tapVita3k(context, "apps_list_cd_install");
  await tapVita3k(context, "install_firmware_title");
}

/** These contents appear only after the native scan, unlike the welcome badges. */
export async function waitVita3kLibrary(context: Vita3kUiContext, initial?: AndroidUiSnapshot): Promise<AndroidUiSnapshot> {
  context.signal?.throwIfAborted();
  if (initial && initial.user !== context.user) throw new Error("Vita3K's library page belongs to another profile.");
  const ready = (snapshot: AndroidUiSnapshot): AndroidUiSnapshot | undefined => {
    if (!vita3kNode(context, snapshot, "apps_list_cd_more_options")) return undefined;
    if (vita3kNode(context, snapshot, "apps_list_init_failed")) throw new Error("Vita3K could not initialize its native storage.");
    if (snapshot.nodes.some((node) => node.className === "android.widget.ProgressBar")) return undefined;
    return vita3kNode(context, snapshot, "apps_list_empty_firmware_title")
      || vita3kNode(context, snapshot, "apps_list_empty_no_apps")
      || snapshot.nodes.some((node) => node.scrollable && node.packageName === VITA3K_PACKAGE) ? snapshot : undefined;
  };
  return (initial ? ready(initial) : undefined) ?? waitEmulatorUi(context, ready, 60_000);
}
