import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createLocalChatGptHttp } from "./http";
import { createSyntheticChatGptReader } from "./synthetic-fixture";

/** Starts only an explicitly enabled, synthetic, loopback-only development server. */
export async function startLocalChatGptDemo(enabled = false) {
  if (!enabled) throw new Error("Set OVD_CHATGPT_LOCAL_DEMO=1 to start the synthetic demo.");
  const bearer = randomBytes(32).toString("hex");
  let origin = "";
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      }
      const response = await handler(new Request(new URL(req.url ?? "/", origin), {
        method: req.method, headers,
        body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
      }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { if (!res.headersSent) res.writeHead(503); res.end(); }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local address.");
  origin = `http://127.0.0.1:${address.port}`;
  const handler = createLocalChatGptHttp({
    origin, isEnabled: () => true,
    authorize: async (request) => {
      const actual = Buffer.from(request.headers.get("authorization") ?? "");
      const expected = Buffer.from(`Bearer ${bearer}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
      return createSyntheticChatGptReader();
    },
  });
  return {
    origin, bearer,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
