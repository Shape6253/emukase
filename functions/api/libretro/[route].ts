import { officialArtifactKind } from "../../../src/lib/adb/artifact-policy.ts";
import { byteLengthHeader, MAX_ARTIFACT_BYTES, MAX_LISTING_BYTES } from "../../../src/lib/adb/download-policy.ts";

interface RouteContext {
  request: Request;
  params: Record<string, string | string[]>;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}

function rejectUpstream(upstream: Response, message: string, status = 502): Response {
  void upstream.body?.cancel().catch(() => {});
  return jsonError(message, status);
}

export async function onRequest(context: RouteContext): Promise<Response> {
  const route = context.params["route"];
  if (route !== "text" && route !== "artifact") return jsonError("Unknown proxy route.", 404);
  if (context.request.method !== "GET") return jsonError("Only GET is allowed.", 405);

  const target = new URL(context.request.url).searchParams.get("url") ?? "";
  try {
    officialArtifactKind(target, route);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Forbidden URL.", 403);
  }

  const maximum = route === "artifact" ? MAX_ARTIFACT_BYTES : MAX_LISTING_BYTES;
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      headers: { "accept-encoding": "identity" },
      redirect: "follow",
      signal: AbortSignal.any([context.request.signal, AbortSignal.timeout(180_000)]),
    });
  } catch {
    return jsonError("Could not reach the Libretro buildbot.", 502);
  }
  try {
    officialArtifactKind(upstream.url, route);
  } catch {
    return rejectUpstream(upstream, "Unexpected download redirect.");
  }
  if (upstream.status !== 200 || !upstream.body) {
    return rejectUpstream(upstream, `Upstream responded with ${upstream.status}.`, upstream.status === 404 ? 404 : 502);
  }

  const encoding = upstream.headers.get("content-encoding");
  if (route === "artifact" && encoding && encoding.toLowerCase() !== "identity") {
    return rejectUpstream(upstream, "The buildbot returned an encoded artifact.");
  }
  try {
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
