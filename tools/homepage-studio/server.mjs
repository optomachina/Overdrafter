#!/usr/bin/env node
// Local Homepage Studio server: node:http bound to 127.0.0.1 only. A thin adapter
// from IncomingMessage to the Web-standard handler in lib/api.mjs, plus static UI.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createApp, studioRoot } from "./lib/app.mjs";
import { checkRequest } from "./lib/guard.mjs";
import { MAX_BODY } from "./lib/api.mjs";

const UI_DIR = path.join(studioRoot, "ui");
const STATIC = {
  "/": "index.html", "/index.html": "index.html", "/outline.html": "outline.html", "/outline": "outline.html",
  "/studio.css": "studio.css", "/studio.js": "studio.js", "/core.js": "core.js", "/page.js": "page.js", "/page.css": "page.css", "/favicon.svg": "favicon.svg",
};
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
export const UI_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", (c) => {
      size += c.length;
      if (rejected) return; // keep draining and discard, so the client can read the 413
      if (size > MAX_BODY) {
        rejected = true;
        chunks.length = 0;
        reject(Object.assign(new Error("too large"), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createServer(app = createApp()) {
  return http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || "127.0.0.1";
      const url = new URL(req.url, `http://${host}`);
      const method = req.method || "GET";
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      let body;
      if (!["GET", "HEAD"].includes(method)) {
        try {
          body = await readBody(req);
        } catch (e) {
          res.writeHead(e.status || 400, { "Content-Type": "application/json", Connection: "close" });
          res.end(JSON.stringify({ error: "too_large", message: "Request body too large (limit 1 MB)." }));
          return;
        }
      }
      const request = new Request(url, { method, headers, body });
      let response;
      if (url.pathname.startsWith("/api/")) {
        response = await app.api.handle(request);
      } else {
        const blocked = checkRequest(request, { mode: app.mode });
        if (blocked) response = new Response(blocked.message, { status: blocked.status });
        else if (method === "GET" && STATIC[url.pathname] && fs.existsSync(path.join(UI_DIR, STATIC[url.pathname]))) {
          const file = path.join(UI_DIR, STATIC[url.pathname]);
          response = new Response(fs.readFileSync(file), {
            status: 200,
            headers: { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Content-Security-Policy": UI_CSP, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" },
          });
        } else response = new Response("Not found", { status: 404 });
      }
      const out = {};
      response.headers.forEach((v, k) => {
        out[k] = v;
      });
      const cookies = response.headers.getSetCookie?.();
      if (cookies && cookies.length) out["set-cookie"] = cookies;
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      console.error(e);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal", message: "Internal error." }));
    }
  });
}

export function listen(server, port = Number(process.env.PORT) || 5177) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address()));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp({ mode: "local" });
  const server = createServer(app);
  const addr = await listen(server);
  console.log(`Homepage Studio: http://127.0.0.1:${addr.port}/  (loopback only, Ctrl+C to stop)`);
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
