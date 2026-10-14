import {
  officialArtifactKind, officialObtainiumArtifactKind, officialObtainiumRedirect,
} from "../adb/artifact-policy.ts";
import type { ArtifactRoute } from "../adb/artifact-policy.ts";
import { byteLengthHeader, MAX_ARTIFACT_BYTES, MAX_LISTING_BYTES } from "../adb/download-policy.ts";

export interface ArtifactProxyContext {
  request: Request;
  params: Record<string, string | string[]>;
}

export type ArtifactProvider = "libretro" | "obtainium";

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

function rejectUpstream(upstream: Response, message: string, status = 502): Response {
  cancelBody(upstream);
  return jsonError(message, status);
}

function validateSource(provider: ArtifactProvider, url: string, route: ArtifactRoute): void {
  if (provider === "libretro") officialArtifactKind(url, route);
  else officialObtainiumArtifactKind(url, route);
}

function validateRedirect(provider: ArtifactProvider, url: string, original: string, route: ArtifactRoute): void {
  if (provider === "libretro") {
    officialArtifactKind(url, route);
    if (url !== original) throw new Error("Unexpected Libretro redirect.");
  } else {
    officialObtainiumRedirect(url, original, route);
  }
}

async function fetchUpstream(
  provider: ArtifactProvider, target: string, route: ArtifactRoute, signal: AbortSignal,
): Promise<Response> {
  let url = target;
  for (let redirects = 0; ; redirects++) {
    const headers = new Headers({ "accept-encoding": "identity" });
    if (provider === "obtainium") {
      headers.set("user-agent", "Emukase");
      if (new URL(url).origin === "https://api.github.com") {
        headers.set("accept", "application/vnd.github+json");
        headers.set("x-github-api-version", "2022-11-28");
      }
    }
    const response = await fetch(url, { headers, redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    cancelBody(response);
    const location = response.headers.get("location");
    if (!location || redirects >= 3) throw new Error("Too many or invalid upstream redirects.");
    const next = new URL(location, url).href;
    validateRedirect(provider, next, target, route);
    url = next;
  }
}

export async function proxyArtifact(context: ArtifactProxyContext, provider: ArtifactProvider): Promise<Response> {
  const route = context.params["route"];
  if (route !== "text" && route !== "artifact") return jsonError("Unknown proxy route.", 404);
  if (context.request.method !== "GET") return jsonError("Only GET is allowed.", 405);

  const target = new URL(context.request.url).searchParams.get("url") ?? "";
  try {
    validateSource(provider, target, route);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Forbidden URL.", 403);
  }

  let upstream: Response;
  try {
    upstream = await fetchUpstream(provider, target, route,
      AbortSignal.any([context.request.signal, AbortSignal.timeout(180_000)]));
  } catch {
    return jsonError("Could not reach the official download source.", 502);
  }
  if (upstream.status !== 200 || !upstream.body) {
    return rejectUpstream(upstream, `Upstream responded with ${upstream.status}.`,
      upstream.status === 404 ? 404 : upstream.status === 429 ? 429 : 502);
  }
  const encoding = upstream.headers.get("content-encoding");
  if (route === "artifact" && encoding && encoding.trim().toLowerCase() !== "identity") {
    return rejectUpstream(upstream, "The official source returned an encoded artifact.");
  }
  try {
    const maximum = route === "artifact" ? MAX_ARTIFACT_BYTES : MAX_LISTING_BYTES;
    const length = byteLengthHeader(upstream.headers, maximum);
    if (route === "artifact" && !length) return rejectUpstream(upstream, "The artifact has no valid Content-Length.");
  } catch (error) {
    return rejectUpstream(upstream, error instanceof Error ? error.message : "Invalid Content-Length.");
  }

  const headers = new Headers();
  const contentType = route === "artifact" ? "application/octet-stream" : upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const length = upstream.headers.get("content-length");
  if (length) headers.set("content-length", length);
  if (encoding) headers.set("content-encoding", encoding);
  headers.set("cache-control", route === "artifact" ? "no-store, no-transform" : "no-store");
  return new Response(upstream.body, { status: 200, headers });
}
