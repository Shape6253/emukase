import { proxyArtifact } from "../../../src/lib/server/artifact-proxy.ts";
import type { ArtifactProxyContext } from "../../../src/lib/server/artifact-proxy.ts";

export function onRequest(context: ArtifactProxyContext): Promise<Response> {
  return proxyArtifact(context, "esde-theme");
}
