import { svelte } from "@sveltejs/vite-plugin-svelte"
import tailwindcss from "@tailwindcss/vite"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"
import { defineConfig } from "vite"
import type { Plugin, PreviewServer, ViteDevServer } from "vite"
import { onRequest as libretroRequest } from "./functions/api/libretro/[route].ts"
import { onRequest as obtainiumRequest } from "./functions/api/obtainium/[route].ts"
import { onRequest as esdeThemeRequest } from "./functions/api/esde-theme/[route].ts"
import type { ArtifactProxyContext } from "./src/lib/server/artifact-proxy.ts"

function configureArtifactProxy(server: ViteDevServer | PreviewServer): void {
  for (const [path, handler] of [
    ["/api/libretro", libretroRequest], ["/api/obtainium", obtainiumRequest],
    ["/api/esde-theme", esdeThemeRequest],
  ] satisfies [string, (context: ArtifactProxyContext) => Promise<Response>][]) {
    server.middlewares.use(path, (request, response, next) => {
      if (!request.url || !request.method) {
        response.writeHead(400).end()
        return
      }
      const url = new URL(request.url, "http://localhost")
      const controller = new AbortController()
      const abort = () => {
        if (!response.writableFinished) controller.abort()
      }
      response.once("close", abort)
      const incoming = new Request(url.href, { method: request.method, signal: controller.signal })
      void (async () => {
        const result = await handler({ request: incoming, params: { route: url.pathname.slice(1) } })
        if (response.destroyed) {
          await result.body?.cancel()
          return
        }
        // Node fetch decodes compressed bodies but retains their original headers.
        const encoding = result.headers.get("content-encoding")
        if (encoding && encoding.toLowerCase() !== "identity") {
          result.headers.delete("content-encoding")
          result.headers.delete("content-length")
        }
        response.statusCode = result.status
        result.headers.forEach((value, name) => response.setHeader(name, value))
        if (result.body) await pipeline(Readable.fromWeb(result.body as NodeReadableStream<Uint8Array>), response)
        else response.end()
      })().catch((error: unknown) => {
        if (!response.destroyed) next(error)
      }).finally(() => response.removeListener("close", abort))
    })
  }
}

const artifactProxy: Plugin = {
  name: "official-artifact-proxy",
  configureServer: configureArtifactProxy,
  configurePreviewServer: configureArtifactProxy,
}

export default defineConfig({
  plugins: [tailwindcss(), svelte(), artifactProxy],
})
