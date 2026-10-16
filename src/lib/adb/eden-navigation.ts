import { shellCommand, checkActivityStart } from "./transport";
import { androidResourceText, tapEmulatorNode, uiNode, waitEmulatorUi, type EmulatorUiContext } from "./emulator-ui";
import type { AndroidUiSnapshot } from "./android-ui";
import { EMULATORS } from "./emulators";

const PACKAGE = EMULATORS.eden.packages[0];
const ACTIVITY = `${PACKAGE}/org.yuzu.yuzu_emu.ui.main.MainActivity`;

/** Android Navigation accepts explicit destination IDs on Eden's exported main activity. */
export async function navigateEden(
  context: EmulatorUiContext,
  destination: "homeSettingsFragment" | "gameFoldersFragment" | "installableFragment" | "firstTimeSetupFragment" | "gamesFragment",
  toolbar: "toolbar_home_settings" | "toolbar_folders" | "toolbar_installables" | "viewPager2" | "settings_button",
): Promise<AndroidUiSnapshot> {
  const resolve = async (name: string): Promise<number> => {
    const resource = `${PACKAGE}:id/${name}`;
    const output = await context.device.shell(shellCommand("cmd", "overlay", "lookup", "--user", String(context.user), "--verbose", PACKAGE, resource));
    const matches = [...output.matchAll(/^Resolution for (0x[\da-f]+) (\S+)\r?$/gm)];
    const match = matches[0];
    if (matches.length !== 1 || match?.[2] !== resource || !match[1]) throw new Error(`Eden's ${name} destination could not be resolved.`);
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fffffff) throw new Error("Eden returned an invalid navigation ID.");
    return value;
  };
  const [graph, target] = await Promise.all([resolve("home_navigation"), resolve(destination)]);
  const missingKeys = await androidResourceText(context, PACKAGE, `${PACKAGE}:string/keys_missing`);
  await context.ensureUnlocked();
  checkActivityStart(await context.device.shell(shellCommand("am", "start", "--user", String(context.user), "--display", "0", "-W",
    "-f", "0x10008000", "-n", ACTIVITY, "--eia", "android-support-nav:controller:deepLinkIds", `${graph},${target}`)));
  return waitEmulatorUi(context, async (snapshot) => {
    if (!snapshot.component.startsWith(`${PACKAGE}/`)) return undefined;
    // A new MainActivity repeats this report when keys are missing. Preserve
    // that setup result while allowing inspection/import of the other items.
    const title = uiNode(snapshot, `${PACKAGE}:id/alertTitle`) ?? uiNode(snapshot, "android:id/alertTitle");
    if (title?.text === missingKeys) {
      const dismiss = uiNode(snapshot, "android:id/button1");
      if (!dismiss) throw new Error("Eden's missing-keys report cannot be confirmed.");
      await tapEmulatorNode(context, snapshot, dismiss);
      return undefined;
    }
    return uiNode(snapshot, `${PACKAGE}:id/${toolbar}`) ? snapshot : undefined;
  });
}
