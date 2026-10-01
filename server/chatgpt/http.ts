import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createOverdrafterChatGptServer, type ChatGptReadDependencies } from "./tools";

const maxBytes = 64 * 1024;

function validateRequest(request: Request, origin: URL): Response | null {
  const url = new URL(request.url);
  const invalidHost = request.headers.has("host") && request.headers.get("host") !== origin.host;
  const invalidOrigin = request.headers.has("origin") && request.headers.get("origin") !== origin.origin;
  if (url.origin !== origin.origin || invalidHost || invalidOrigin ||
      request.headers.has("forwarded") || request.headers.has("x-forwarded-host")) {
    return new Response("Forbidden", { status: 403 });
  }
  if (url.pathname !== "/mcp" || url.search) return new Response("Not found", { status: 404 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return new Response("JSON required", { status: 415 });
  }
  return null;
}

async function readBody(request: Request): Promise<{ body: unknown } | { error: Response }> {
  const reader = request.body?.getReader();
  if (!reader) return { error: new Response("Invalid request", { status: 400 }) };
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
        return { error: new Response("Request too large", { status: 413 }) };
      }
      chunks.push(chunk.value);
    }
  } finally { clearTimeout(readTimeout); }
  if (timedOut) return { error: new Response("Request timeout", { status: 408 }) };
  try { return { body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }; }
  catch { return { error: new Response("Invalid JSON", { status: 400 }) }; }
}

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
      const invalidRequest = validateRequest(request, origin);
      if (invalidRequest) return invalidRequest;
      const dependencies = await options.authorize(request);
      if (!dependencies) return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Bearer scope="overdrafter:read"' } });
      const parsed = await readBody(request);
      if ("error" in parsed) return parsed.error;
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, enableJsonResponse: true,
      });
      server = createOverdrafterChatGptServer(dependencies);
      await server.connect(transport);
      const response = await transport.handleRequest(request, { parsedBody: parsed.body });
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
