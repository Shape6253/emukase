import { BUILDBOT } from "./catalog.ts";

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
