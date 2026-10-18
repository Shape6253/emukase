import { hasAndroidTreeReadGrant, selectAndroidDocument } from "./android-document-picker";
import { pressAndroidUiKey } from "./android-ui";
import type { AndroidUiNode, AndroidUiSnapshot } from "./android-ui";
import { assertEsdeStorageAccess } from "./esde-environment";
import { recordEsdeRecovery } from "./esde-files";
import { ESDE_PACKAGE } from "./esde-types";
import type { EsdeContext } from "./esde-types";
import { uiWithin, waitEmulatorUi } from "./emulator-ui";

type WizardPage = "welcome" | "single" | "directories";

/** Runtime Compose semantics, independent of activity names, captions, screen
 * coordinates, app version and APK hash. Unrecognized layouts receive no input. */
export function esdeWizardActions(snapshot: AndroidUiSnapshot, page: WizardPage): readonly AndroidUiNode[] | undefined {
  if (!snapshot.component.startsWith(`${ESDE_PACKAGE}/`)) return undefined;
  const contents = snapshot.nodes.filter((node) => node.packageName === ESDE_PACKAGE && node.resourceId === "android:id/content");
  const content = contents[0];
  if (contents.length !== 1 || !content) return undefined;
  const owned = snapshot.nodes.filter((node) => node.packageName === ESDE_PACKAGE && uiWithin(snapshot, node, content));
  const actions = owned.filter((node) => node.clickable);
  if (actions.length !== (page === "directories" ? 2 : 1)) return undefined;
  for (const action of actions) {
    if (!action.enabled || !action.focusable || action.bounds[2] <= action.bounds[0] || action.bounds[3] <= action.bounds[1]) return undefined;
    const children = owned.filter((node) => node.parent === snapshot.nodes.indexOf(action));
    const nativeButton = action.className === "android.widget.Button" && !children.some((node) => node.clickable);
    const composeButton = action.className === "android.view.View"
      && children.some((node) => node.className === "android.widget.Button" && !node.clickable)
      && children.some((node) => node.className === "android.widget.TextView" && !node.clickable);
    if (!nativeButton && !composeButton) return undefined;
  }
  const prose = owned.filter((node) => node.className === "android.widget.TextView" && !actions.some((action) => uiWithin(snapshot, node, action)));
  const images = owned.filter((node) => node.className === "android.widget.ImageView");
  if (prose.length !== 2 || images.length !== (page === "welcome" ? 1 : 0)
    || actions.some((node) => node.parent !== actions[0]?.parent)) return undefined;
  return actions;
}

function wizardSignature(snapshot: AndroidUiSnapshot): string {
  return JSON.stringify([snapshot.component, snapshot.rotation, snapshot.nodes.map((node) => [
    node.packageName, node.resourceId, node.className, node.text, node.description, node.parent, node.enabled, node.clickable, node.bounds,
  ])]);
}

async function activate(context: EsdeContext, page: WizardPage, stage: string): Promise<string> {
  const before = await waitEmulatorUi(context, (value) => esdeWizardActions(value, page) ? value : undefined);
  const expected = wizardSignature(before);
  const token = await recordEsdeRecovery(context, stage, "intent", { component: before.component });
  try {
    for (let tabs = 0; tabs <= 12; tabs++) {
      const current = await waitEmulatorUi(context, (value) => value.component === before.component ? value : undefined);
      if (wizardSignature(current) !== expected) throw new Error("ES-DE's setup page changed before confirmation.");
      const actions = esdeWizardActions(current, page);
      // After the two real picker callbacks, this is the optional directory
      // generation page. Its secondary action skips generation; both choices
      // only concern the folder structure, never emulator or presentation settings.
      const target = page === "directories" ? actions?.at(-1) : actions?.[0];
      const focused = current.nodes.filter((node) => node.packageName === ESDE_PACKAGE && node.focused && node.clickable);
      if (target?.focused && focused.length === 1 && focused[0] === target) {
        await assertEsdeStorageAccess(context);
        await pressAndroidUiKey(context.device, context.user, current, "KEYCODE_ENTER", context.signal);
        await recordEsdeRecovery(context, stage, "verified", { component: current.component, inputSent: true }, token);
        return expected;
      }
      if (tabs < 12) await pressAndroidUiKey(context.device, context.user, current, "KEYCODE_TAB", context.signal);
    }
    throw new Error("ES-DE's setup action did not acquire observable keyboard focus.");
  } catch (error) {
    await recordEsdeRecovery(context, stage, "uncertain", { component: before.component }, token).catch(() => {});
    throw error;
  }
}

async function nextSingle(context: EsdeContext, previous: string): Promise<void> {
  await waitEmulatorUi(context, (value) => esdeWizardActions(value, "single") && wizardSignature(value) !== previous ? true : undefined);
}

/** Used only after a cold launch has exposed a recognizable welcome page.
 * Existing completed onboarding is never reset just to import settings. */
export async function completeEsdeOnboarding(context: EsdeContext): Promise<void> {
  context.options.onStatus?.("Completing ES-DE's storage setup…");
  const welcome = await activate(context, "welcome", "welcome");
  await nextSingle(context, welcome);
  if (context.installed.requestedPermissions.includes("android.permission.MANAGE_EXTERNAL_STORAGE") || context.sdk === 29) {
    const permission = await activate(context, "single", "storage-already-granted");
    await nextSingle(context, permission);
  }
  for (const [stage, path] of [["data-directory", context.workspace.esde], ["rom-directory", context.workspace.roms]] as const) {
    context.options.onStatus?.(`Connecting ES-DE to ${path}…`);
    await activate(context, "single", stage);
    // Reuse the shared picker: it checks resultTo, user, exact directory and
    // the initiating app instead of fabricating private preferences/SAF grants.
    await selectAndroidDocument(context, ESDE_PACKAGE, path, true);
    if (!await hasAndroidTreeReadGrant(context, ESDE_PACKAGE, path, true)) throw new Error("ES-DE did not retain read/write access to its selected folder.");
    await recordEsdeRecovery(context, stage, "verified", { path, persistedReadWrite: true });
  }
  await waitEmulatorUi(context, (value) => esdeWizardActions(value, "directories") ? true : undefined);
  const directories = await activate(context, "directories", "skip-directory-generation");
  await nextSingle(context, directories);
  const finished = await activate(context, "single", "finish-onboarding");
  await waitEmulatorUi(context, (value) => value.component.startsWith(`${ESDE_PACKAGE}/`)
    && wizardSignature(value) !== finished && !esdeWizardActions(value, "single")
    && !esdeWizardActions(value, "welcome") && !esdeWizardActions(value, "directories") ? true : undefined);
}
