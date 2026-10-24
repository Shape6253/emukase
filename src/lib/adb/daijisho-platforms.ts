import { AndroidUiStateChangedError, pressAndroidUiKey, type AndroidUiSnapshot } from "./android-ui";
import { daijishoId, isDaijisho, openDaijishoTab, type DaijishoUiContext } from "./daijisho-navigation";
import { tapEmulatorNode, uiDescendant, uiNode, waitEmulatorUi } from "./emulator-ui";

export interface DaijishoPlatformIdentity {
  name: string;
}

const THUMBNAILS = daijishoId("library_collection_thumbnails_view_recycler_view");
const WALLPAPER_PLATFORMS = daijishoId("library_collection_wallpaper_view_recycler_view");

/** TextSwitcher children alternate complete titles; they are never name fragments. */
export function readDaijishoPlatformIdentity(snapshot: AndroidUiSnapshot): DaijishoPlatformIdentity | undefined {
  if (!isDaijisho(snapshot)) return undefined;
  for (const layout of ["wallpaper", "thumbnails"]) {
    const prefix = `library_collection_${layout}_view_platform_title_`;
    const names = ["first_text_view", "second_text_view"].flatMap((suffix) => {
      const node = uiNode(snapshot, daijishoId(prefix + suffix));
      return node && node.bounds[2] > node.bounds[0] && node.bounds[3] > node.bounds[1] && node.text.trim() ? [node.text.trim()] : [];
    });
    const name = names[0];
    if (name) return new Set(names).size === 1 ? { name } : undefined;
    const title = uiNode(snapshot, daijishoId(prefix + "text_view"));
    if (title?.text.trim()) return { name: title.text.trim() };
  }
  return undefined;
}

function emptyLibrary(snapshot: AndroidUiSnapshot): boolean {
  return isDaijisho(snapshot) && !!uiNode(snapshot, daijishoId("fragment_library_empty_button"));
}

function focusedIdentity(snapshot: AndroidUiSnapshot): string {
  return JSON.stringify(snapshot.nodes.filter((node) => node.focused)
    .map((node) => [node.resourceId, node.className, node.text, node.description, node.bounds]));
}

function decimalInteger(value: string): number {
  let number = 0;
  for (const digit of value) {
    const code = digit.codePointAt(0);
    if (code === undefined) return NaN;
    let zero = code;
    while (/\p{Decimal_Number}/u.test(String.fromCodePoint(zero - 1))) zero--;
    number = number * 10 + (code - zero) % 10;
  }
  return number;
}

/** Match the app's translated format at the end of its decorated subtitle. */
function platformCount(context: DaijishoUiContext, snapshot: AndroidUiSnapshot): number | undefined {
  const subtitle = uiNode(snapshot, daijishoId("library_collection_wallpaper_view_platform_description_text_view"))?.text;
  if (!subtitle) return undefined;
  const escape = (value: string): string => value.replace(/%%/g, "%").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const format of context.labels.get("description_platform_index_format") ?? []) {
    const placeholders = [...format.matchAll(/%(?:([12])\$)?d/g)];
    if (placeholders.length !== 2) continue;
    let pattern = "", offset = 0;
    const positions: number[] = [];
    for (const [index, placeholder] of placeholders.entries()) {
      pattern += escape(format.slice(offset, placeholder.index)) + "(\\p{Decimal_Number}+)";
      positions.push(placeholder[1] ? Number(placeholder[1]) - 1 : index);
      offset = placeholder.index + placeholder[0].length;
    }
    const matched = new RegExp(pattern + escape(format.slice(offset)) + "$", "u").exec(subtitle);
    if (!matched || new Set(positions).size !== 2) continue;
    const values: number[] = [];
    for (const [index, position] of positions.entries()) {
      const value = matched[index + 1];
      if (value) values[position] = decimalInteger(value);
    }
    const selected = values[0], count = values[1];
    if (selected !== undefined && count !== undefined && Number.isSafeInteger(selected) && Number.isSafeInteger(count)
      && selected > 0 && selected <= count) return count;
  }
  return undefined;
}

function singleWallpaperPlatform(snapshot: AndroidUiSnapshot): boolean {
  const list = uiNode(snapshot, WALLPAPER_PLATFORMS);
  if (!list?.enabled || list.scrollable || list.bounds[2] <= list.bounds[0] || list.bounds[3] <= list.bounds[1]) return false;
  const titles = snapshot.nodes.filter((node) => node.resourceId === daijishoId("list_item_library_collection_wallpaper_view_text_view")
    && uiDescendant(snapshot, node, WALLPAPER_PLATFORMS));
  const title = titles[0];
  // A non-scrollable native list exposes every entry, even when the subtitle is hidden.
  return titles.length === 1 && !!title?.selected && !!title.text.trim()
    && title.bounds[2] > title.bounds[0] && title.bounds[3] > title.bounds[1];
}

async function settledPlatform(
  context: DaijishoUiContext, ready: (snapshot: AndroidUiSnapshot) => boolean = () => true,
): Promise<AndroidUiSnapshot> {
  let previous: string | undefined;
  return waitEmulatorUi(context, (snapshot) => {
    if (!isDaijisho(snapshot) || !ready(snapshot)) { previous = undefined; return undefined; }
    const identity = readDaijishoPlatformIdentity(snapshot);
    if (!identity && !emptyLibrary(snapshot)) { previous = undefined; return undefined; }
    const signature = JSON.stringify([snapshot.component, snapshot.rotation, identity?.name, emptyLibrary(snapshot),
      focusedIdentity(snapshot), singleWallpaperPlatform(snapshot)]);
    const settled = signature === previous;
    previous = signature;
    return settled ? snapshot : undefined;
  });
}

function thumbnailFocused(snapshot: AndroidUiSnapshot): boolean {
  return snapshot.nodes.some((node) => node.focused && uiDescendant(snapshot, node, THUMBNAILS));
}

async function focusThumbnails(context: DaijishoUiContext, initial: AndroidUiSnapshot): Promise<AndroidUiSnapshot> {
  const visited = new Set<string>();
  let snapshot = initial;
  for (let step = 0; step < 32; step++) {
    if (thumbnailFocused(snapshot)) return snapshot;
    const focus = focusedIdentity(snapshot);
    if (visited.has(focus)) throw new Error("Daijishō's thumbnail list could not receive keyboard focus.");
    visited.add(focus);
    try { await pressAndroidUiKey(context.device, context.user, snapshot, "KEYCODE_TAB", context.signal); }
    catch (error) {
      if (!(error instanceof AndroidUiStateChangedError)) throw error;
      visited.delete(focus);
      snapshot = await settledPlatform(context);
      continue;
    }
    snapshot = await settledPlatform(context, (value) => focusedIdentity(value) !== focus || thumbnailFocused(value));
  }
  throw new Error("Daijishō's thumbnail focus search exceeded its limit.");
}

/** Visit in native order once; a visitor returns true when its remaining work is complete. */
export async function visitDaijishoPlatforms(
  context: DaijishoUiContext,
  visitor: (snapshot: AndroidUiSnapshot, identity: DaijishoPlatformIdentity) => Promise<boolean>,
): Promise<void> {
  await openDaijishoTab(context, "platforms");
  let snapshot = await settledPlatform(context);
  const visited = new Set<string>();
  let direction: "right" | "left" = "right";
  for (let step = 0; step < 512; step++) {
    context.signal?.throwIfAborted();
    if (emptyLibrary(snapshot)) return;
    const identity = readDaijishoPlatformIdentity(snapshot);
    if (!identity) throw new Error("Daijishō's current platform title is unavailable.");
    if (!visited.has(identity.name)) {
      visited.add(identity.name);
      if (await visitor(snapshot, identity)) return;
      snapshot = await settledPlatform(context);
      if (readDaijishoPlatformIdentity(snapshot)?.name !== identity.name) throw new Error("Daijishō changed platforms while configuring its ROM folder.");
    }
    const thumbnails = !!uiNode(snapshot, THUMBNAILS);
    // The native list works independently of the optional translated subtitle.
    if (!thumbnails && (singleWallpaperPlatform(snapshot) || platformCount(context, snapshot) === 1)) return;
    try {
      if (thumbnails) {
        snapshot = await focusThumbnails(context, snapshot);
        // Acquiring focus can select a different thumbnail; visit it before moving on.
        if (readDaijishoPlatformIdentity(snapshot)?.name !== identity.name) continue;
        await pressAndroidUiKey(context.device, context.user, snapshot,
          direction === "right" ? "KEYCODE_DPAD_RIGHT" : "KEYCODE_DPAD_LEFT", context.signal);
      } else {
        const next = uiNode(snapshot, daijishoId("library_collection_wallpaper_view_next_view"));
        if (!next) throw new Error("Daijishō's platform layout does not expose native navigation.");
        await tapEmulatorNode(context, snapshot, next);
      }
    } catch (error) {
      if (!(error instanceof AndroidUiStateChangedError)) throw error;
      snapshot = await settledPlatform(context);
      continue;
    }
    // A completed input can precede the app's title update. The wallpaper
    // carousel must visibly advance before an earlier title can prove a wrap.
    snapshot = await settledPlatform(context, (value) => thumbnails || readDaijishoPlatformIdentity(value)?.name !== identity.name);
    const next = readDaijishoPlatformIdentity(snapshot);
    if (!next) throw new Error("Daijishō's next platform title is unavailable.");
    if (!thumbnails) {
      // The wallpaper layout wraps; one previously visited selection closes the traversal.
      if (visited.has(next.name)) return;
    } else if (next.name === identity.name || !thumbnailFocused(snapshot)) {
      // Thumbnail focus stops at the ends. Sweep the other side only once.
      if (direction === "left") return;
      direction = "left";
    }
  }
  throw new Error("Daijishō's platform traversal exceeded its limit; absence was not assumed.");
}
