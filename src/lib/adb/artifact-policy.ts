import { BUILDBOT } from "./catalog.ts";
import { ELEMENTERIAL_THEME } from "./esde-theme-source.ts";

export const OBTAINIUM_REPOSITORY = "ImranR98/Obtainium";
export const OBTAINIUM_REPOSITORY_ID = "523534328";
export const OBTAINIUM_LATEST_RELEASE = `https://api.github.com/repos/${OBTAINIUM_REPOSITORY}/releases/latest`;
export type ArtifactRoute = "text" | "artifact";

export function officialEsdeThemeArtifactKind(value: string, route: ArtifactRoute): void {
  if (route !== "artifact" || value !== ELEMENTERIAL_THEME.url) throw new Error("Only the configured Elementerial theme archive is allowed.");
}

export function officialArtifactKind(value: string, route: "text" | "artifact"): void {
  const url = new URL(value);
  if (url.origin !== BUILDBOT || url.href !== value || url.username || url.password || url.search || url.hash) {
    throw new Error("Only canonical official Libretro URLs are allowed.");
  }
  if (route === "text") {
    if (url.pathname === "/stable/" || /^\/stable\/\d+\.\d+\.\d+\/android\/$/.test(url.pathname)) return;
  } else {
    if (/^\/stable\/\d+\.\d+\.\d+\/android\/RetroArch_(aarch64|ra32)\.apk$/.test(url.pathname)) return;
    if (/^\/nightly\/android\/latest\/(arm64-v8a|armeabi-v7a|x86_64|x86)\/[a-z0-9][a-z0-9_-]*_libretro_android\.so\.zip$/.test(url.pathname)) return;
  }
  throw new Error("This Libretro path is not in the artifact allowlist.");
}

function canonicalHttps(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.href !== value || url.username || url.password || url.hash) {
    throw new Error("Only canonical official HTTPS URLs are allowed.");
  }
  return url;
}

export function officialObtainiumArtifactKind(value: string, route: ArtifactRoute): void {
  const url = canonicalHttps(value);
  if (url.search) throw new Error("Obtainium source URLs must not contain query parameters.");
  if (route === "text" && value === OBTAINIUM_LATEST_RELEASE) return;
  const suffix = route === "artifact" ? "\\.apk" : "\\.apk\\.sha256";
  const path = new RegExp(`^/${OBTAINIUM_REPOSITORY}/releases/download/v\\d+\\.\\d+\\.\\d+/app(?:-(?:arm64-v8a|armeabi-v7a|x86_64))?-release${suffix}$`);
  if (url.origin === "https://github.com" && path.test(url.pathname)) return;
  throw new Error("This Obtainium URL is not in the official release allowlist.");
}

export function officialObtainiumRedirect(value: string, original: string, route: ArtifactRoute): void {
  officialObtainiumArtifactKind(original, route);
  if (value === original) return;
  if (original === OBTAINIUM_LATEST_RELEASE) throw new Error("Unexpected Obtainium metadata redirect.");
  const url = canonicalHttps(value);
  const path = new RegExp(`^/github-production-release-asset/${OBTAINIUM_REPOSITORY_ID}/[a-f\\d]{8}(?:-[a-f\\d]{4}){3}-[a-f\\d]{12}$`);
  if (url.origin !== "https://release-assets.githubusercontent.com" || !path.test(url.pathname)) {
    throw new Error("Unexpected Obtainium asset redirect.");
  }
}
