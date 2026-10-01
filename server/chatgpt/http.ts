import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createOverdrafterChatGptServer, type ChatGptReadDependencies } from "./tools";

const maxBytes = 64 * 1024;

/** Local-only HTTP composition. No listener/production route is installed here. */
export function createLocalChatGptHttp(options: {
  origin: string;
  isEnabled: () => boolean;
  /** Must validate the request and bind dependencies to that request's identity. */
  authorize: (request: Request) => Promise<ChatGptReadDependencies | null>;
}) {
  const origin = new URL(options.origin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.origin !== options.origin) {
    throw new Error("Only an exact loopback HTTP origin is supported by this development harness.");
  }
  return async (request: Request): Promise<Response> => {
    let server: ReturnType<typeof createOverdrafterChatGptServer> | undefined;
    try {
      if (!options.isEnabled()) return new Response("Not found", { status: 404 });
      const url = new URL(request.url);
      if (url.origin !== origin.origin || (request.headers.has("host") && request.headers.get("host") !== origin.host) ||
          (request.headers.has("origin") && request.headers.get("origin") !== origin.origin) ||
          request.headers.has("forwarded") || request.headers.has("x-forwarded-host")) {
        return new Response("Forbidden", { status: 403 });
      }
      if (url.pathname !== "/mcp" || url.search) return new Response("Not found", { status: 404 });
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        return new Response("JSON required", { status: 415 });
      }
      const dependencies = await options.authorize(request);
      if (!dependencies) return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Bearer scope="overdrafter:read"' } });
      const reader = request.body?.getReader();
      if (!reader) return new Response("Invalid request", { status: 400 });
      const chunks: Uint8Array[] = [];
      let size = 0;
      let timedOut = false;
      const readTimeout = setTimeout(() => { timedOut = true; void reader.cancel(); }, 5000);
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            return new Response("Request too large", { status: 413 });
          }
          chunks.push(chunk.value);
        }
      } finally { clearTimeout(readTimeout); }
      if (timedOut) return new Response("Request timeout", { status: 408 });
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return new Response("Invalid JSON", { status: 400 }); }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, enableJsonResponse: true,
      });
      server = createOverdrafterChatGptServer(dependencies);
      await server.connect(transport);
      const response = await transport.handleRequest(request, { parsedBody: body });
      // JSON responses are fully consumed before closing this request's server.
      const bytes = await response.arrayBuffer();
      return new Response(response.status === 202 ? null : bytes, {
        status: response.status, headers: { ...Object.fromEntries(response.headers), "Cache-Control": "no-store" },
      });
    } catch {
      return new Response("Overdrafter integration unavailable", { status: 503 });
    } finally {
      await server?.close().catch(() => undefined);
    }
  };
}
