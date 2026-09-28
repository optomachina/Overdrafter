import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { digest, newCapability, PlateDispatcher } from "./sample-plate-dispatch";

export const PLATE_API = "/__sample_plate";
type Session = { cookie: string; csrf: string; expires: number };
function reply(res: ServerResponse, code: number, body: unknown) {
  res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) {
    raw += String(chunk);
    if (Buffer.byteLength(raw) > 4096) throw new Error("Request too large");
  }
  const body: unknown = JSON.parse(raw);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid body");
  return body as Record<string, unknown>;
}
function hasLocalOrigin(req: IncomingMessage, origin: string) {
  return req.headers.host === new URL(origin).host
    && (!req.headers.origin || req.headers.origin === origin)
    && req.headers["sec-fetch-site"] !== "cross-site";
}
function hasSession(req: IncomingMessage, session: Session | null, now: number) {
  const cookie = req.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith("ovd_plate="))?.slice(10);
  return session !== null && now <= session.expires && cookie === session.cookie;
}
function serveFile(dispatcher: PlateDispatcher, pathname: string, res: ServerResponse) {
  const match = pathname.match(/^\/__sample_plate\/files\/([a-f0-9]{32})\/(plate\.SLDPRT|plate\.STEP)$/);
  if (!match) return false;
  const run = dispatcher.get(match[1]);
  const file = run?.status === "succeeded" ? run.result?.files.find(f => f.name === match[2]) : undefined;
  if (!file) { reply(res, 404, { error: "No verified file" }); return true; }
  const bytes = readFileSync(path.join(dispatcher.root, match[1], file.name));
  if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error("Artifact changed");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", 'attachment; filename="' + file.name + '"'); res.end(bytes);
  return true;
}
function authenticatedRoute(dispatcher: PlateDispatcher, req: IncomingMessage, res: ServerResponse, pathname: string, body: Record<string, unknown>, session: Session) {
  if (req.method === "GET") {
    if (pathname === PLATE_API + "/session") { reply(res, 200, { csrf: session.csrf, runs: dispatcher.list() }); return; }
    if (serveFile(dispatcher, pathname, res)) return;
  }
  if (req.method === "POST" && pathname === PLATE_API + "/runs") {
    if (Object.keys(body).length !== 2 || typeof body.id !== "string" || typeof body.instruction !== "string") throw new Error("Invalid request fields");
    reply(res, 202, dispatcher.start(body.id, body.instruction)); return;
  }
  reply(res, 404, { error: "Unknown sample route" });
}
export function createPlateHttp(dispatcher: PlateDispatcher, origin: string, capability: string, now = Date.now) {
  const expires = now() + 10 * 60_000;
  let bootstrapHash: string | null = digest(capability);
  let session: Session | null = null;
  function bootstrap(body: Record<string, unknown>, res: ServerResponse) {
    if (!bootstrapHash || now() > expires || typeof body.capability !== "string" || digest(body.capability) !== bootstrapHash) {
      reply(res, 401, { error: "Launch link expired or already used" }); return;
    }
    bootstrapHash = null; session = { cookie: newCapability(), csrf: newCapability(), expires: now() + 60 * 60_000 };
    res.setHeader("Set-Cookie", "ovd_plate=" + session.cookie + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600");
    reply(res, 200, { csrf: session.csrf });
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!hasLocalOrigin(req, origin)) { reply(res, 403, { error: "Local origin required" }); return; }
    const pathname = new URL(req.url ?? "/", origin).pathname;
    const mutation = req.method === "POST";
    if (mutation && (req.headers.origin !== origin || req.headers["content-type"] !== "application/json")) {
      reply(res, 403, { error: "Origin and JSON required" }); return;
    }
    const body = mutation ? await readBody(req) : {};
    if (pathname === PLATE_API + "/bootstrap" && mutation) { bootstrap(body, res); return; }
    if (!hasSession(req, session, now()) || !session) { reply(res, 401, { error: "Open the local launch link to sign in" }); return; }
    if (mutation && req.headers["x-plate-csrf"] !== session.csrf) { reply(res, 403, { error: "Session confirmation required" }); return; }
    authenticatedRoute(dispatcher, req, res, pathname, body, session);
  }
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    try { await handle(req, res); }
    catch { reply(res, 409, { error: "Request rejected. Refresh status; do not retry native work with a new ID." }); }
  };
}
