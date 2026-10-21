import { AndroidUiStateChangedError, type AndroidUiSnapshot } from "./android-ui";
import { hasAndroidTreeReadGrant, selectAndroidDocument } from "./android-document-picker";
import { activateCocoon, cocoonAction, cocoonHas, waitCocoonUi, isCocoon, pressCocoonKey, COCOON_ONBOARDING_ACTIVITY, COCOON_PACKAGE, type CocoonLabel, type CocoonUiContext } from "./cocoon-navigation";
import type { CocoonSetupOptions } from "./cocoon-types";

const PAGES = [
  "onboarding_v2_welcome_title", "onboarding_v2_screen_check_title", "onboarding_v2_default_launcher_title",
  "onboarding_v2_usage_title", "onboarding_v2_storage_title", "onboarding_v2_data_dir_title",
  "onboarding_v2_personalize_title", "onboarding_v2_org_mode_title", "onboarding_v2_login_title",
  "onboarding_v2_restore_title", "onboarding_v2_platform_title", "onboarding_v2_rom_title",
  "onboarding_v2_game_players_title", "onboarding_v2_scrape_title", "onboarding_v2_complete_title",
  "onboarding_v2_zoom_title",
] as const satisfies readonly CocoonLabel[];

function page(context: CocoonUiContext, snapshot: AndroidUiSnapshot): CocoonLabel | undefined {
  return PAGES.find((key) => cocoonHas(context, snapshot, key));
}

function pageAdvanced(context: CocoonUiContext, snapshot: AndroidUiSnapshot, previous: CocoonLabel): boolean {
  if (!isCocoon(snapshot)) return false;
  const current = page(context, snapshot);
  return snapshot.component !== COCOON_ONBOARDING_ACTIVITY || (current !== undefined && current !== previous);
}

async function advance(
  context: CocoonUiContext, key: CocoonLabel, previous: CocoonLabel, initial?: AndroidUiSnapshot,
): Promise<AndroidUiSnapshot> {
  const ready = (value: AndroidUiSnapshot): boolean => page(context, value) === previous && !!(
    cocoonAction(context, value, key) || (key === "onboarding_v2_button_continue" && cocoonAction(context, value, "onboarding_v2_button_ok")));
  const snapshot = initial && ready(initial) ? initial : await waitCocoonUi(context, (value) => ready(value) ? value : undefined);
  const skip = key === "onboarding_v2_button_skip" || key === "onboarding_v2_restore_continue_without"
    || ["onboarding_v2_personalize_title", "onboarding_v2_game_players_title", "onboarding_v2_complete_title"].includes(previous);
  return activateCocoon(context, cocoonAction(context, snapshot, key) ? key : "onboarding_v2_button_ok",
    (value) => pageAdvanced(context, value, previous), snapshot, async (value) => {
      // Select Continue rather than a language, folder or display toggle. Smart
      // folders use the first option; Y skips optional setup and the tutorial.
      if (["onboarding_v2_welcome_title", "onboarding_v2_data_dir_title", "onboarding_v2_screen_check_title",
        "onboarding_v2_org_mode_title"].includes(previous)) {
        await pressCocoonKey(context, previous === "onboarding_v2_org_mode_title" ? "KEYCODE_DPAD_UP" : "KEYCODE_DPAD_DOWN", value);
        await pressCocoonKey(context, "KEYCODE_BUTTON_A");
      } else await pressCocoonKey(context, skip ? "KEYCODE_BUTTON_Y" : "KEYCODE_BUTTON_A", value);
    });
}

/** Cocoon 3.07 has no exported import activity, and its restore UI excludes Sources & Players.
 * Complete its required native setup without changing Android's Home role or linking accounts. */
export async function finishCocoonOnboarding(
  context: CocoonUiContext, dataDirectory: string, romDirectory: string, options: CocoonSetupOptions,
  initial: AndroidUiSnapshot,
): Promise<AndroidUiSnapshot> {
  let snapshot = initial;
  let previous: CocoonLabel | undefined;
  for (let attempt = 0; attempt < 64; attempt++) {
    context.signal?.throwIfAborted();
    if (snapshot.component !== COCOON_ONBOARDING_ACTIVITY && isCocoon(snapshot)) return snapshot;
    const current = page(context, snapshot);
    if (!current) {
      snapshot = await waitCocoonUi(context, (value) => isCocoon(value) && (page(context, value)
        || value.component !== COCOON_ONBOARDING_ACTIVITY) ? value : undefined);
      continue;
    }
    if (current !== previous) {
      const title = [...(context.labels.get(current) ?? [])][0];
      if (!title) throw new Error("Cocoon's setup page title could not be resolved.");
      options.onStatus?.(`Configuring Cocoon: ${title}…`);
      previous = current;
    }
    try {
      if (current === "onboarding_v2_welcome_title") {
        snapshot = await advance(context, "onboarding_v2_button_ok", current, snapshot);
      } else if (["onboarding_v2_default_launcher_title", "onboarding_v2_usage_title", "onboarding_v2_storage_title",
        "onboarding_v2_login_title", "onboarding_v2_scrape_title"].includes(current)) {
        snapshot = await advance(context, "onboarding_v2_button_skip", current, snapshot);
      } else if (current === "onboarding_v2_restore_title") {
        snapshot = await advance(context, "onboarding_v2_restore_continue_without", current, snapshot);
      } else if (current === "onboarding_v2_data_dir_title") {
        if (!await hasAndroidTreeReadGrant(context, COCOON_PACKAGE, dataDirectory, true)) {
          await activateCocoon(context, "onboarding_v2_data_dir_choose", (value) => !isCocoon(value), undefined,
            (value) => pressCocoonKey(context, "KEYCODE_BUTTON_A", value));
          await selectAndroidDocument(context, COCOON_PACKAGE, dataDirectory, true, undefined, { keyboardNavigation: true });
          if (!await hasAndroidTreeReadGrant(context, COCOON_PACKAGE, dataDirectory, true)) {
            throw new Error("Cocoon did not retain write access to its selected data folder.");
          }
        }
        snapshot = await advance(context, "onboarding_v2_button_continue", current);
      } else if (current === "onboarding_v2_platform_title") {
        const state = await waitCocoonUi(context, (value) => isCocoon(value) && (
          cocoonAction(context, value, "onboarding_v2_platform_download_now") || cocoonAction(context, value, "onboarding_v2_button_continue")
          || cocoonAction(context, value, "onboarding_v2_button_ok") || cocoonAction(context, value, "onboarding_v2_platform_finish")) ? value : undefined, 180_000);
        if (cocoonAction(context, state, "onboarding_v2_platform_download_now")) {
          await activateCocoon(context, "onboarding_v2_platform_download_now",
            (value) => pageAdvanced(context, value, current) || !cocoonHas(context, value, "onboarding_v2_platform_download_now"),
            state, (value) => pressCocoonKey(context, "KEYCODE_BUTTON_A", value));
          snapshot = await waitCocoonUi(context, (value) => {
            if (cocoonHas(context, value, "onboarding_v2_platform_error_generic")) throw new Error("Cocoon could not download its platform definitions.");
            return isCocoon(value) && (page(context, value) !== current || cocoonAction(context, value, "onboarding_v2_platform_finish")
              || cocoonAction(context, value, "onboarding_v2_button_continue") || cocoonAction(context, value, "onboarding_v2_button_ok")) ? value : undefined;
          }, 180_000);
        } else snapshot = state;
        if (page(context, snapshot) === current) {
          snapshot = await advance(context, cocoonAction(context, snapshot, "onboarding_v2_platform_finish")
            ? "onboarding_v2_platform_finish" : "onboarding_v2_button_continue", current, snapshot);
        }
      } else if (current === "onboarding_v2_rom_title") {
        if (!await hasAndroidTreeReadGrant(context, COCOON_PACKAGE, romDirectory)) {
          await activateCocoon(context, "onboarding_v2_rom_select", (value) => !isCocoon(value), undefined,
            (value) => pressCocoonKey(context, "KEYCODE_BUTTON_A", value));
          await selectAndroidDocument(context, COCOON_PACKAGE, romDirectory, true, undefined, { keyboardNavigation: true });
        }
        snapshot = await waitCocoonUi(context, (value) => {
          if (cocoonHas(context, value, "onboarding_v2_rom_error_generic")) throw new Error("Cocoon could not scan the shared ROM folder.");
          return isCocoon(value) && (page(context, value) !== current || cocoonAction(context, value, "onboarding_v2_button_continue")
            || cocoonAction(context, value, "onboarding_v2_button_ok")) ? value : undefined;
        }, 180_000);
        if (page(context, snapshot) === current) snapshot = await advance(context, "onboarding_v2_button_continue", current, snapshot);
      } else if (current === "onboarding_v2_org_mode_title") {
        // Selecting the mode commits this page and advances immediately.
        snapshot = await advance(context, "onboarding_v2_smart_folders", current, snapshot);
      } else if (current === "onboarding_v2_complete_title") {
        snapshot = await advance(context, "onboarding_v2_complete_start", current, snapshot);
      } else if (current === "onboarding_v2_zoom_title") {
        // Intro and grid selection share a title. A completes narration, then
        // advances the intro and commits the current grid on successive captures.
        await pressCocoonKey(context, "KEYCODE_BUTTON_A", snapshot);
        snapshot = await waitCocoonUi(context, (value) => isCocoon(value) && (page(context, value)
          || value.component !== COCOON_ONBOARDING_ACTIVITY) ? value : undefined);
      } else {
        snapshot = await advance(context, "onboarding_v2_button_continue", current, snapshot);
      }
    } catch (error) {
      context.signal?.throwIfAborted();
      if (!(error instanceof AndroidUiStateChangedError)) {
        throw new Error(`Cocoon could not finish its ${[...(context.labels.get(current) ?? [])][0]} step. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      snapshot = await waitCocoonUi(context, (value) => isCocoon(value) ? value : undefined);
    }
  }
  throw new Error("Cocoon's setup did not finish within its navigation limit.");
}
