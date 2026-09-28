import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { digest, newCapability, PlateDispatcher } from "./sample-plate-dispatch";

export const PLATE_API = "/__sample_plate";
export function createPlateHttp(dispatcher: PlateDispatcher, origin: string, capability: string, now = Date.now) {
  const expires = now() + 10 * 60_000;
  let bootstrapHash: string | null = digest(capability);
  let session: { cookie: string; csrf: string; expires: number } | null = null;
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (code: number, body: unknown) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); };
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    const url = new URL(req.url ?? "/", origin);
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)
        || req.headers["sec-fetch-site"] === "cross-site") { reply(403, { error: "Local origin required" }); return; }
      const mutation = req.method === "POST";
      if (mutation && (req.headers.origin !== origin || req.headers["content-type"] !== "application/json")) { reply(403, { error: "Origin and JSON required" }); return; }
      let body: Record<string, unknown> = {};
      if (mutation) {
        let raw = "";
        for await (const chunk of req) { raw += String(chunk); if (Buffer.byteLength(raw) > 4096) { reply(413, { error: "Request too large" }); return; } }
        body = JSON.parse(raw);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid body");
      }
      if (url.pathname === PLATE_API + "/bootstrap" && mutation) {
        if (!bootstrapHash || now() > expires || typeof body.capability !== "string" || digest(body.capability) !== bootstrapHash) { reply(401, { error: "Launch link expired or already used" }); return; }
        bootstrapHash = null; session = { cookie: newCapability(), csrf: newCapability(), expires: now() + 60 * 60_000 };
        res.setHeader("Set-Cookie", `ovd_plate=${session.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
        reply(200, { csrf: session.csrf }); return;
      }
      const cookie = req.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith("ovd_plate="))?.slice(10);
      if (!session || now() > session.expires || cookie !== session.cookie) { reply(401, { error: "Open the local launch link to sign in" }); return; }
      if (mutation && req.headers["x-plate-csrf"] !== session.csrf) { reply(403, { error: "Session confirmation required" }); return; }
      if (req.method === "GET" && url.pathname === PLATE_API + "/session") { reply(200, { csrf: session.csrf, runs: dispatcher.list() }); return; }
      if (mutation && url.pathname === PLATE_API + "/runs") {
        if (Object.keys(body).sort().join(",") !== "id,instruction" || typeof body.id !== "string" || typeof body.instruction !== "string") throw new Error("Invalid request fields");
        reply(202, dispatcher.start(body.id, body.instruction)); return;
      }
      const fileMatch = url.pathname.match(/^\/__sample_plate\/files\/([a-f0-9]{32})\/(plate\.SLDPRT|plate\.STEP)$/);
      if (req.method === "GET" && fileMatch) {
        const run = dispatcher.get(fileMatch[1]);
        const file = run?.status === "succeeded" ? run.result?.files.find(f => f.name === fileMatch[2]) : undefined;
        if (!file) { reply(404, { error: "No verified file" }); return; }
        const bytes = readFileSync(path.join(dispatcher.root, fileMatch[1], file.name));
        // Recheck bytes when serving, not just the old receipt.
        const { createHash } = await import("node:crypto");
        if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error("Artifact changed");
        res.setHeader("Content-Type", "application/octet-stream"); res.setHeader("Content-Disposition", `attachment; filename="${file.name}"`); res.end(bytes); return;
      }
      reply(404, { error: "Unknown sample route" });
    } catch { reply(409, { error: "Request rejected. Refresh status; do not retry native work with a new ID." }); }
  };
}
