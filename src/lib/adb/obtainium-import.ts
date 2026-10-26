import { AndroidUiStateChangedError, pressAndroidUiKey, tapAndroidUi, type AndroidUiSnapshot } from "./android-ui";
import { withAndroidUiDump } from "./android-ui-dump";
import type { ObtainiumAppImport } from "./obtainium-catalog";
import { canonicalJson, obtainiumImportAcknowledged, obtainiumPayloadObserved, obtainiumSourceDetailVisible } from "./obtainium-import-anchors";
import { isObtainium, obtainiumHome, openObtainiumUri, uiLabel, waitObtainiumState, withObtainiumAwake, type ObtainiumContext } from "./obtainium-ui";
import { OBTAINIUM_PACKAGE, obtainiumDialog } from "./obtainium-ui-anchors";
import { checkAbort } from "./setup-events";
import { shellCommand } from "./transport";

type ObtainiumImportContext = ObtainiumContext & { log: (message: string) => void };

export function validateObtainiumApps(apps: readonly ObtainiumAppImport[]): void {
  if (!apps.length || apps.length > 32 || new Set(apps.map((app) => app.id)).size !== apps.length
    || new Set(apps.map((app) => app.url)).size !== apps.length) {
    throw new Error("Obtainium sources require a nonempty list of unique apps and URLs.");
  }
  for (const app of apps) {
    const url = new URL(app.url);
    const settings: unknown = JSON.parse(app.additionalSettings);
    if (!/^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/.test(app.id) || !app.name.trim() || app.name.length > 100
      || url.protocol !== "https:" || url.username || url.password || url.hash || url.href !== app.url
      || app.allowIdChange !== false || app.preferredApkIndex !== 0
      || ![null, "HTML", "GitHub", "Codeberg"].includes(app.overrideSource)
      || settings === null || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("Obtainium app configuration is invalid.");
    }
  }
}

async function activateImportControl(
  context: ObtainiumImportContext, snapshot: AndroidUiSnapshot, action: "expand" | "confirm",
  ensureUnlocked: () => Promise<boolean>, payload: string, keyboardOnly = false,
): Promise<void> {
  const dialog = obtainiumDialog(snapshot);
  if (!dialog || dialog.kind !== "import"
    || (action === "confirm" && !obtainiumPayloadObserved(snapshot, payload))) {
    throw new Error("Obtainium's dialog does not match the expected import action.");
  }
  const target = action === "expand" ? dialog.expansion : dialog.actions.at(-1);
  if (!target) throw new Error("Obtainium's import control was not recognized.");
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
      (value) => isObtainium(value) ? value : undefined);
    const currentDialog = obtainiumDialog(current);
    if (!currentDialog || signature(current) !== expected
      || (action === "confirm" && !obtainiumPayloadObserved(current, payload))) {
      throw new Error("Obtainium's dialog changed before keyboard confirmation.");
    }
    const focused = current.nodes.filter((node) => node.packageName === OBTAINIUM_PACKAGE && node.focused && node.clickable);
    const control = action === "expand" ? currentDialog.expansion : currentDialog.actions.at(-1);
    if (control?.focused && focused.length === 1 && focused[0] === control) {
      await pressAndroidUiKey(context.device, context.user, current, "KEYCODE_ENTER", context.signal);
      return;
    }
    if (index < 8) await pressAndroidUiKey(context.device, context.user, current, "KEYCODE_TAB", context.signal);
  }
  throw new Error("Obtainium's import control did not receive keyboard focus.");
}

async function confirmImport(
  context: ObtainiumImportContext, snapshot: AndroidUiSnapshot, ensureUnlocked: () => Promise<boolean>, payload: string, count: number,
): Promise<void> {
  for (const keyboardOnly of [false, true]) {
    await activateImportControl(context, snapshot, "confirm", ensureUnlocked, payload, keyboardOnly);
    let previous: string | undefined;
    let unchanged = 0;
    snapshot = await waitObtainiumState(context, ensureUnlocked, (value) => {
      if (obtainiumHome(value) && obtainiumImportAcknowledged(value, count)) return value;
      if (obtainiumDialog(value)?.kind !== "import") return undefined;
      if (!obtainiumPayloadObserved(value, payload)) throw new Error("Obtainium's import payload changed after confirmation.");
      const current = JSON.stringify(value);
      unchanged = current === previous ? unchanged + 1 : 1;
      previous = current;
      return unchanged >= 3 ? value : undefined;
    });
    if (!obtainiumDialog(snapshot)) return;
  }
  throw new Error("Obtainium did not finish the confirmed app import.");
}

async function missingObtainiumApps(
  context: ObtainiumImportContext, apps: readonly ObtainiumAppImport[], ensureUnlocked: () => Promise<boolean>,
): Promise<readonly ObtainiumAppImport[]> {
  const missing: ObtainiumAppImport[] = [];
  for (const app of apps) {
    checkAbort(context.signal);
    await context.reportStatus(`Checking ${app.name}'s update source in Obtainium…`);
    // Obtainium resolves this URL against its saved sources, but architectures
    // can share a URL. Only skip importing when the saved package also matches.
    await openObtainiumUri(context, `obtainium://add/${encodeURIComponent(app.url)}`);
    const observed = await waitObtainiumState(context, ensureUnlocked, (snapshot) => {
      if (!isObtainium(snapshot) || obtainiumDialog(snapshot)) return undefined;
      const addForm = snapshot.nodes.some((node) => node.packageName === OBTAINIUM_PACKAGE
        && node.className === "android.widget.EditText" && uiLabel(node) === app.url);
      return addForm || obtainiumSourceDetailVisible(snapshot)
        ? { snapshot, missing: addForm || !obtainiumSourceDetailVisible(snapshot, app.id) } : undefined;
    });
    if (observed.missing) missing.push(app);
    let snapshot = observed.snapshot;
    // The first BACK can dismiss the add form's keyboard. Stop as soon as the
    // unchanged app list is visible, rather than leaving nested detail pages.
    const homeReady = (value: AndroidUiSnapshot): boolean => obtainiumHome(value)
      && !obtainiumSourceDetailVisible(value) && !obtainiumDialog(value);
    let backPresses = 0;
    for (let attempt = 0; attempt < 6 && backPresses < 3 && !homeReady(snapshot); attempt++) {
      const previous = JSON.stringify(snapshot);
      try {
        await pressAndroidUiKey(context.device, context.user, snapshot, "KEYCODE_BACK", context.signal);
        backPresses++;
      } catch (error) {
        if (!(error instanceof AndroidUiStateChangedError)) throw error;
        snapshot = await waitObtainiumState(context, ensureUnlocked, (value) => isObtainium(value) ? value : undefined);
        continue;
      }
      snapshot = await waitObtainiumState(context, ensureUnlocked, (value) => isObtainium(value)
        && (homeReady(value) || JSON.stringify(value) !== previous) ? value : undefined);
    }
    if (!homeReady(snapshot)) await waitObtainiumState(context, ensureUnlocked, (value) => homeReady(value) ? true : undefined);
  }
  return missing;
}

export async function importObtainiumApps(
  context: ObtainiumImportContext, apps: readonly ObtainiumAppImport[],
): Promise<void> {
  apps = structuredClone(apps);
  validateObtainiumApps(apps);
  const started = performance.now();
  await withAndroidUiDump(context.device, context.signal, () => withObtainiumAwake(context, async (ensureUnlocked) => {
    await waitObtainiumState(context, ensureUnlocked, (value) => obtainiumHome(value) && !obtainiumDialog(value) ? true : undefined);
    apps = await missingObtainiumApps(context, apps, ensureUnlocked);
    if (!apps.length) {
      context.log("Obtainium's selected update sources are already configured.");
      return;
    }
    const payload = canonicalJson(apps);
    const uri = `obtainium://apps/${encodeURIComponent(JSON.stringify(apps))}`;
    await context.reportStatus("Adding missing emulator update sources to Obtainium…");
    await openObtainiumUri(context, uri);
    let snapshot = await waitObtainiumState(context, ensureUnlocked, (value) =>
      obtainiumDialog(value)?.kind === "import" ? value : undefined);
    if (!obtainiumPayloadObserved(snapshot, payload)) {
      await activateImportControl(context, snapshot, "expand", ensureUnlocked, payload);
      snapshot = await waitObtainiumState(context, ensureUnlocked, (value) =>
        obtainiumPayloadObserved(value, payload) ? value : undefined);
    }
    try {
      await confirmImport(context, snapshot, ensureUnlocked, payload, apps.length);
    } catch (error) {
      if (!(error instanceof AndroidUiStateChangedError)) throw error;
      snapshot = await waitObtainiumState(context, ensureUnlocked, (value) =>
        obtainiumPayloadObserved(value, payload) ? value : undefined);
      await confirmImport(context, snapshot, ensureUnlocked, payload, apps.length);
    }
    context.log(`Imported ${apps.length} emulator sources in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
    // Obtainium can replay its initial import link when the next URI arrives.
    // Restart with no URI even when the caller will open just one app next.
    await context.device.shell(shellCommand("am", "force-stop", "--user", String(context.user), OBTAINIUM_PACKAGE));
    await openObtainiumUri(context);
    await waitObtainiumState(context, ensureUnlocked, (value) => obtainiumHome(value) && !obtainiumDialog(value) ? true : undefined);
    checkAbort(context.signal);
  }));
}
