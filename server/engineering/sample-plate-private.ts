import { createHash } from "node:crypto";
import { readFileSync, realpathSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { digest, newCapability, verifiedResult, type Run } from "./sample-plate-dispatch";

export const PRIVATE_PREFIX = "/sample-plate";
const COOKIE = "__Host-ovd_phone";
type Session = { identity: string; csrf: string; expires: number };
type Config = { origin: string; identity: string; artifactRoot: string; staticRoot: string; capabilities: string[]; now?: () => number };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function contained(root: string, candidate: string) {
  const resolved = realpathSync(candidate);
  const relative = path.relative(realpathSync(root), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Path outside retained root");
  return resolved;
}
function loadRetained(root: string) {
  const lock = JSON.parse(readFileSync(path.join(root, "native-attempt.lock"), "utf8")) as { id: string };
  if (!/^[a-f0-9]{32}$/.test(lock.id)) throw new Error("Invalid retained attempt lock");
  const records = readFileSync(path.join(root, "attempts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { run: Run });
  const run = records.findLast(row => row.run?.id === lock.id)?.run;
  if (run?.status !== "succeeded" || !run.result || !verifiedResult(run.result)) throw new Error("A verified retained result is required");
  const file = (name: string) => {
    const metadata = run.result!.files.find(f => f.name === name);
    if (!metadata || !["plate.SLDPRT", "plate.STEP"].includes(name)) throw new Error("Unknown artifact");
    const bytes = readFileSync(contained(root, path.join(root, run.id, name)));
    if (bytes.length !== metadata.bytes || hash(bytes) !== metadata.sha256) throw new Error("Retained artifact changed");
    return bytes;
  };
  for (const metadata of run.result.files) file(metadata.name);
  return { run, file };
}
function loadStatic(root: string) {
  const files = new Map<string, { bytes: Buffer; type: string }>();
  files.set("/", { bytes: readFileSync(path.join(root, "sample-plate.html")), type: "text/html; charset=utf-8" });
  for (const name of readdirSync(path.join(root, "assets"))) {
    if (!/^[a-zA-Z0-9_-]+\.(?:js|css)$/.test(name)) continue;
    files.set("/assets/" + name, { bytes: readFileSync(contained(root, path.join(root, "assets", name))), type: name.endsWith(".js") ? "text/javascript" : "text/css" });
  }
  return files;
}
function reply(res: ServerResponse, code: number, body: unknown) {
  res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) { raw += String(chunk); if (Buffer.byteLength(raw) > 2048) throw new Error("Oversized request"); }
  return JSON.parse(raw) as { capability?: unknown };
}
function trustedIngress(req: IncomingMessage, config: Config) {
  return req.socket.remoteAddress === "127.0.0.1"
    && req.headers.host === new URL(config.origin).host
    && req.headers["tailscale-user-login"] === config.identity
    && !req.headers.forwarded
    && req.headers["x-forwarded-host"] === new URL(config.origin).host
    && req.headers["x-forwarded-proto"] === "https"
    && (!req.headers.origin || req.headers.origin === config.origin)
    && req.headers["sec-fetch-site"] !== "cross-site";
}

/** Dedicated Serve ingress: static UI and retained files only; no native adapter. */
export function createPrivatePlateHttp(config: Config) {
  const origin = new URL(config.origin);
  if (origin.protocol !== "https:" || origin.port || origin.pathname !== "/" || !origin.hostname.endsWith(".ts.net") || !config.identity) throw new Error("Exact private HTTPS origin and identity required");
  const now = config.now ?? Date.now;
  const retained = loadRetained(config.artifactRoot);
  const assets = loadStatic(config.staticRoot);
  const capabilities = new Set(config.capabilities.map(digest));
  const pairingExpires = now() + 10 * 60_000;
  const sessions = new Map<string, Session>();
  async function bootstrap(req: IncomingMessage, res: ServerResponse) {
    const request = await body(req);
    if (now() > pairingExpires || typeof request?.capability !== "string" || !capabilities.delete(digest(request.capability))) {
      reply(res, 401, { error: "Pairing link expired or already used" }); return;
    }
    const cookie = newCapability(); const session = { identity: config.identity, csrf: newCapability(), expires: now() + 60 * 60_000 };
    sessions.set(digest(cookie), session);
    res.setHeader("Set-Cookie", `${COOKIE}=${cookie}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
    reply(res, 200, { csrf: session.csrf });
  }
  function authenticated(req: IncomingMessage, res: ServerResponse, route: string) {
    const cookie = req.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
    const session = cookie ? sessions.get(digest(cookie)) : undefined;
    if (!session || now() > session.expires || session.identity !== req.headers["tailscale-user-login"]) { reply(res, 401, { error: "Open your private pairing link" }); return; }
    if (req.method !== "GET") {
      reply(res, 403, { error: req.headers["x-plate-csrf"] === session.csrf ? "This private view cannot start native work" : "Session confirmation required" }); return;
    }
    if (route === "/api/session") { reply(res, 200, { csrf: session.csrf, runs: [retained.run] }); return; }
    const match = /^\/api\/files\/([a-f0-9]{32})\/(plate\.SLDPRT|plate\.STEP)$/.exec(route);
    if (!match || match[1] !== retained.run.id) { reply(res, 404, { error: "Unknown route" }); return; }
    const bytes = retained.file(match[2]);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${match[2]}"`); res.end(bytes);
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!trustedIngress(req, config)) { reply(res, 403, { error: "Private paired identity required" }); return; }
    const pathname = new URL(req.url ?? "/", config.origin).pathname;
    let route = pathname;
    if (pathname === PRIVATE_PREFIX) route = "/";
    else if (pathname.startsWith(PRIVATE_PREFIX + "/")) route = pathname.slice(PRIVATE_PREFIX.length);
    if (req.method === "POST" && (req.headers.origin !== config.origin || req.headers["content-type"] !== "application/json")) { reply(res, 403, { error: "Exact origin and JSON required" }); return; }
    if (route === "/api/bootstrap" && req.method === "POST") { await bootstrap(req, res); return; }
    const asset = assets.get(route);
    if (asset && req.method === "GET") { res.setHeader("Content-Type", asset.type); res.end(asset.bytes); return; }
    authenticated(req, res, route);
  }
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try { await handle(req, res); } catch { reply(res, 409, { error: "Retained result unavailable; no native retry" }); }
  };
}
