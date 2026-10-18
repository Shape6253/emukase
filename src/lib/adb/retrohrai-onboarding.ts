import { hasAndroidTreeReadGrant, selectAndroidDocument } from "./android-document-picker";
import type { AndroidUiSnapshot } from "./android-ui";
import { tapEmulatorNode, uiWithin } from "./emulator-ui";
import { activateRetroHrai, isRetroHrai, retroHraiAction, retroHraiCount, retroHraiHas,
  retroHraiMatches, waitRetroHraiUi, type RetroHraiContext, type RetroHraiLabel } from "./retrohrai-navigation";
import { RETROHRAI_PACKAGE } from "./retrohrai-types";
import type { RetroHraiSetupOptions } from "./retrohrai-types";

const PAGES = ["onboarding_welcome_title", "setup_assets_title", "setup_migration_title", "setup_scraper_title",
  "setup_scraper_ready_title", "onboarding_library_source_title", "onboarding_platform_existing_title", "setup_platform_title",
  "onboarding_browsing_style_title", "onboarding_initial_scan_title", "setup_detecting_title"] as const satisfies readonly RetroHraiLabel[];

export function retroHraiOnboarding(context: RetroHraiContext, snapshot: AndroidUiSnapshot): boolean {
  return PAGES.some((key) => retroHraiHas(context, snapshot, key)) || retroHraiHas(context, snapshot, "onboarding_tour_skip");
}

export function retroHraiHome(context: RetroHraiContext, snapshot: AndroidUiSnapshot): boolean {
  return isRetroHrai(snapshot) && !retroHraiOnboarding(context, snapshot) && (retroHraiHas(context, snapshot, "action_open_virtual_screen")
    || retroHraiHas(context, snapshot, "action_swap_screens")
    || retroHraiHas(context, snapshot, "home_no_roms_title") || retroHraiHas(context, snapshot, "home_no_platforms_title"));
}

async function chooseFolder(context: RetroHraiContext, key: RetroHraiLabel, path: string, snapshot: AndroidUiSnapshot): Promise<void> {
  await activateRetroHrai(context, key, (value) => !isRetroHrai(value), snapshot);
  await selectAndroidDocument(context, RETROHRAI_PACKAGE, path, true, undefined, { keyboardNavigation: false });
}

/** Complete native onboarding using its bulk system selection, including empty folders. */
export async function finishRetroHraiOnboarding(
  context: RetroHraiContext, dataDirectory: string, romDirectory: string, options: RetroHraiSetupOptions, initial: AndroidUiSnapshot,
): Promise<AndroidUiSnapshot> {
  let snapshot = initial;
  for (let attempt = 0; attempt < 48; attempt++) {
    context.signal?.throwIfAborted();
    if (retroHraiHome(context, snapshot)) return snapshot;
    const page = PAGES.find((key) => retroHraiHas(context, snapshot, key));
    if (page) options.onStatus?.(`Configuring RetroHrai: ${[...(context.labels.get(page) ?? [])][0]}…`);
    if (page === "setup_assets_title") {
      await chooseFolder(context, retroHraiAction(context, snapshot, "setup_assets_choose_location")
        ? "setup_assets_choose_location" : "setup_assets_choose_different", dataDirectory, snapshot);
      if (!await hasAndroidTreeReadGrant(context, RETROHRAI_PACKAGE, dataDirectory, true)) throw new Error("RetroHrai did not retain access to its artwork folder.");
    } else if (page === "onboarding_library_source_title") {
      if (!await hasAndroidTreeReadGrant(context, RETROHRAI_PACKAGE, romDirectory)) {
        const key = retroHraiAction(context, snapshot, "onboarding_library_choose_different_folder") ? "onboarding_library_choose_different_folder"
          : retroHraiAction(context, snapshot, "onboarding_library_add_another_folder") ? "onboarding_library_add_another_folder" : "onboarding_library_choose_folder";
        await chooseFolder(context, key, romDirectory, snapshot);
        if (!await hasAndroidTreeReadGrant(context, RETROHRAI_PACKAGE, romDirectory)) throw new Error("RetroHrai did not retain access to the shared ROM folder.");
      } else {
        // The fresh wizard also lists automatically detected roots without SAF
        // access. Remove only those unconnected suggestions, never saved roots.
        const missing = snapshot.nodes.find((node) => retroHraiMatches(context, node, "onboarding_library_folder_needs_access"));
        const row = missing?.parent === null || missing?.parent === undefined ? undefined : snapshot.nodes[missing.parent];
        if (row) {
          const remove = retroHraiAction(context, snapshot, "setup_rom_roots_remove", [], row);
          if (!remove || !snapshot.nodes.some((node) => node.text.startsWith("/storage/") && uiWithin(snapshot, node, row))) {
            throw new Error("RetroHrai's unconnected ROM folder suggestion could not be identified.");
          }
          await tapEmulatorNode(context, snapshot, remove);
        } else {
          const count = snapshot.nodes.map((node) => retroHraiCount(context, node, "onboarding_library_use_folders")).find((value) => value !== undefined);
          if (!count) throw new Error("RetroHrai did not confirm any connected ROM folders.");
          await activateRetroHrai(context, "onboarding_library_use_folders", (value) => !retroHraiHas(context, value, page), snapshot, [String(count)]);
        }
      }
    } else if (page === "setup_platform_title" || page === "onboarding_platform_existing_title") {
      if (retroHraiAction(context, snapshot, "setup_platform_select_all")) {
        await activateRetroHrai(context, "setup_platform_select_all", (value) => !!retroHraiAction(context, value, "setup_platform_deselect_all"), snapshot);
      } else {
        const count = snapshot.nodes.map((node) => retroHraiCount(context, node, "setup_platform_add_selected")).find((value) => value !== undefined);
        if (!count) throw new Error("RetroHrai did not detect compatible systems in the shared ROM folders.");
        await activateRetroHrai(context, "setup_platform_add_selected", (value) => !retroHraiHas(context, value, page), snapshot, [String(count)]);
      }
    } else {
      const action: RetroHraiLabel | undefined = page === "onboarding_welcome_title" ? "onboarding_start_setup"
        : page === "setup_migration_title" ? "setup_migration_skip_button"
        : page === "setup_scraper_title" ? "setup_scraper_skip_button"
        : page === "setup_scraper_ready_title" ? "setup_scraper_skip_step_button"
        : page === "onboarding_browsing_style_title" ? "onboarding_choose_style"
        : retroHraiAction(context, snapshot, "onboarding_tour_skip") ? "onboarding_tour_skip"
        : retroHraiAction(context, snapshot, "onboarding_start_browsing") ? "onboarding_start_browsing" : undefined;
      if (action) await activateRetroHrai(context, action, (value) => page ? !retroHraiHas(context, value, page) : retroHraiHome(context, value), snapshot);
      else if (!page) throw new Error("This RetroHrai setup screen is unsupported.");
    }
    snapshot = await waitRetroHraiUi(context, (value) => isRetroHrai(value) && (retroHraiHome(context, value)
      || retroHraiOnboarding(context, value)) ? value : undefined, 180_000);
    if (retroHraiHas(context, snapshot, "setup_detecting_title") || retroHraiHas(context, snapshot, "onboarding_initial_scan_title")) {
      snapshot = await waitRetroHraiUi(context, (value) => isRetroHrai(value) && !retroHraiHas(context, value, "setup_detecting_title")
        && !retroHraiHas(context, value, "onboarding_initial_scan_title") ? value : undefined, 180_000);
    }
  }
  throw new Error("RetroHrai's initial setup exceeded its navigation limit.");
}
