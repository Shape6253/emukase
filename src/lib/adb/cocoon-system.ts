import { AndroidUiStateChangedError, type AndroidUiNode, type AndroidUiSnapshot } from "./android-ui";
import { uiWithin } from "./emulator-ui";
import { activateCocoon, cocoonAction, cocoonHas, cocoonMatches, isCocoon, launchCocoon, restartCocoon, tapCocoonNode, waitCocoonUi,
  COCOON_PACKAGE, COCOON_SETTINGS_ACTIVITY, type CocoonUiContext } from "./cocoon-navigation";
import { findCocoonListItem, findCocoonSetting, openCocoonTab } from "./cocoon-settings";
import type { CocoonSystemConfiguration } from "./cocoon-types";
import { shellCommand } from "./transport";

/** Count connected physical panels, including panels currently turned off. */
export function cocoonPhysicalDisplayCount(output: string): number {
  if (output.length > 2_097_152 || /Permission Denial|SecurityException|^Error:/m.test(output)) {
    throw new Error("Android's physical displays could not be inspected.");
  }
  const section = /(?:^|\n)Display Devices: size=(\d+)\r?\n([\s\S]*?)(?=\n\S|$)/.exec(output);
  const records = section?.[2]?.split(/\r?\n/).filter((line) => /^\s+DisplayDeviceInfo\{/.test(line));
  if (!section || !records?.length || records.length !== Number(section[1])) {
    throw new Error("Android's physical display inventory is unavailable or incomplete.");
  }
  const panels = new Set<string>();
  for (const record of records) {
    const id = /\buniqueId="([^"]+)"/.exec(record)?.[1];
    const type = /\btype (\w+),/.exec(record)?.[1];
    if (!id || !type) throw new Error("Android returned an unrecognized display device.");
    if (["INTERNAL", "EXTERNAL", "BUILT_IN", "HDMI"].includes(type)) {
      if (!id.startsWith("local:") || panels.has(id)) throw new Error("Android's physical displays are ambiguous.");
      panels.add(id);
    } else if (!["VIRTUAL", "WIFI", "OVERLAY"].includes(type)) {
      throw new Error("Android returned an unsupported display type.");
    }
  }
  if (!panels.size || panels.size > 16) throw new Error("Android's physical screen count could not be confirmed.");
  return panels.size;
}

/** Cocoon 3.07 draws a custom switch without checked semantics. Its two children
 * expose the track and animated thumb. Accept only the observed switch anatomy
 * and a settled thumb near either end; never infer state from checked=false. */
export function cocoonSwitchState(snapshot: AndroidUiSnapshot, control: AndroidUiNode, rtl: boolean): boolean | undefined {
  const children = snapshot.nodes.filter((node) => node.parent === snapshot.nodes.indexOf(control));
  if (children.length !== 2 || children.some((node) => node.packageName !== COCOON_PACKAGE || node.className !== "android.view.View"
    || node.clickable || node.text || node.description)) throw new Error("Cocoon's custom screen switch is unsupported.");
  const tracks = children.filter((child) => control.bounds.every((value, index) => Math.abs(value - (child.bounds[index] ?? Infinity)) <= 2));
  const track = tracks[0];
  const thumb = children.find((child) => child !== track);
  if (tracks.length !== 1 || !track || !thumb) return undefined;
  const width = track.bounds[2] - track.bounds[0];
  const height = track.bounds[3] - track.bounds[1];
  if (width <= 0 || height <= 0 || width / height < 1 || width / height > 2.2
    || Math.abs((thumb.bounds[1] + thumb.bounds[3]) - (track.bounds[1] + track.bounds[3])) > 4
    || thumb.bounds[2] <= thumb.bounds[0] || thumb.bounds[3] <= thumb.bounds[1]) {
    return undefined;
  }
  const position = ((thumb.bounds[0] + thumb.bounds[2]) / 2 - track.bounds[0]) / width;
  if (position > 0.18 && position < 0.4) return rtl;
  if (position > 0.6 && position < 0.82) return !rtl;
  return undefined;
}

function screenSwitch(context: CocoonUiContext, snapshot: AndroidUiSnapshot): AndroidUiNode {
  const row = cocoonAction(context, snapshot, "settings_system_title_single_screen");
  const controls = row ? snapshot.nodes.filter((node) => node.parent === snapshot.nodes.indexOf(row) && node.clickable && node.enabled) : [];
  if (controls.length !== 1 || !controls[0]) throw new Error("Cocoon's single-screen switch could not be identified.");
  return controls[0];
}

async function screenSetting(context: CocoonUiContext): Promise<AndroidUiSnapshot> {
  const initial = await findCocoonSetting(context, "settings_system_title_single_screen");
  const snapshot = await findCocoonListItem(context, (value) => {
    if (!cocoonAction(context, value, "settings_system_title_single_screen")) return false;
    const control = screenSwitch(context, value);
    const width = control.bounds[2] - control.bounds[0];
    const height = control.bounds[3] - control.bounds[1];
    // A partially clipped row can expose its title before the switch is readable.
    return width > 0 && height / width > 0.85 && height / width < 1.05
      && cocoonSwitchState(value, control, false) !== undefined;
  }, "down", initial);
  if (!snapshot) throw new Error("Cocoon's single-screen setting could not be brought fully into view.");
  return snapshot;
}

async function appRtl(context: CocoonUiContext): Promise<boolean> {
  const output = await context.device.shell(shellCommand("dumpsys", "activity", COCOON_SETTINGS_ACTIVITY));
  const directions = [...output.matchAll(/^\s*mCurrentConfig=\{[^\r\n]*\b(ldltr|ldrtl)\b/gm)];
  if (directions.length !== 1 || !directions[0]) throw new Error("Cocoon's layout direction could not be confirmed.");
  return directions[0][1] === "ldrtl";
}

export async function inspectCocoonSystem(
  context: CocoonUiContext, physicalDisplays: number, configure: boolean,
): Promise<CocoonSystemConfiguration> {
  if (!Number.isSafeInteger(physicalDisplays) || physicalDisplays < 1 || physicalDisplays > 16) {
    throw new Error("Cocoon requires a confirmed physical-screen count.");
  }
  const opened = await openCocoonTab(context, "settings_tab_system");
  let snapshot = await findCocoonSetting(context, "settings_system_title_language", opened);
  const languageSelected = (value: AndroidUiSnapshot): boolean => {
    const row = cocoonAction(context, value, "settings_system_title_language");
    return !!row && value.nodes.some((node) => uiWithin(value, node, row) && cocoonMatches(context, node, "language_system_default"));
  };
  if (configure && !languageSelected(snapshot)) {
    context.onMutation?.();
    snapshot = await activateCocoon(context, "settings_system_title_language",
      (value) => value.component === `${COCOON_PACKAGE}/${COCOON_PACKAGE}.ui.activity.LanguageSettingsActivity`, snapshot);
    snapshot = await activateCocoon(context, "language_system_default", (value) => isCocoon(value)
      && !value.component.endsWith(".LanguageSettingsActivity"), snapshot);
    // A locale change recreates Settings asynchronously and resets its category.
    // Stop after Android flushes preferences, then navigate in the new instance.
    await restartCocoon(context);
    await launchCocoon(context);
    await openCocoonTab(context, "settings_tab_system");
    snapshot = await findCocoonSetting(context, "settings_system_title_language");
  }
  const language = languageSelected(snapshot) ? "accepted" : "missing";
  snapshot = await screenSetting(context);
  const rtl = await appRtl(context);
  const wanted = physicalDisplays === 1;
  let state = cocoonSwitchState(snapshot, screenSwitch(context, snapshot), rtl);
  for (let attempt = 0; configure && state !== wanted && attempt < 6; attempt++) {
    if (state === undefined) {
      snapshot = await waitCocoonUi(context, (value) => cocoonHas(context, value, "settings_system_title_single_screen")
        && cocoonSwitchState(value, screenSwitch(context, value), rtl) !== undefined ? value : undefined);
      state = cocoonSwitchState(snapshot, screenSwitch(context, snapshot), rtl);
      continue;
    }
    try {
      context.onMutation?.();
      await tapCocoonNode(context, snapshot, screenSwitch(context, snapshot));
    }
    catch (error) {
      if (!(error instanceof AndroidUiStateChangedError)) throw error;
      snapshot = await screenSetting(context);
      state = cocoonSwitchState(snapshot, screenSwitch(context, snapshot), rtl);
      continue;
    }
    snapshot = await waitCocoonUi(context, async (value) => {
      if (cocoonHas(context, value, "single_screen_mode_title") && cocoonAction(context, value, "single_screen_mode_main")) {
        await activateCocoon(context, "single_screen_mode_main", (next) => !cocoonHas(context, next, "single_screen_mode_title"), value);
        return undefined;
      }
      return value.component === COCOON_SETTINGS_ACTIVITY && cocoonHas(context, value, "settings_system_title_single_screen")
        && cocoonSwitchState(value, screenSwitch(context, value), rtl) === wanted ? value : undefined;
    });
    state = cocoonSwitchState(snapshot, screenSwitch(context, snapshot), rtl);
  }
  if (configure && (language !== "accepted" || state !== wanted)) throw new Error("Cocoon did not retain its system language and screen mode.");
  return { language, screenMode: state === wanted ? "accepted" : state === undefined ? "unverified" : "missing",
    physicalDisplays, singleScreen: state ?? null };
}
