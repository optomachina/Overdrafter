import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { isValidId, assertId, resolveInside, PathError, isAllowedStoragePath } from "../lib/paths.mjs";
import { checkRequest } from "../lib/guard.mjs";
import { createAuth, signToken, verifyToken, safeEqual, parseCookies, COOKIE_NAME, SESSION_TTL_MS, NOT_CONFIGURED_MESSAGE } from "../lib/auth.mjs";
import { call, localApp, req, LOCAL } from "./helpers.mjs";

test("id validation and path containment reject traversal", () => {
  assert.ok(isValidId("ch3-abc"));
  for (const bad of ["../x", "a/b", "A", "a b", "", "x".repeat(81), "a.b", "%2e%2e", null, 5]) assert.equal(isValidId(bad), false, String(bad));
  assert.throws(() => assertId("../etc"), PathError);
  const base = "/tmp/data";
  assert.equal(resolveInside(base, "versions", "a", "index.html"), path.join(base, "versions/a/index.html"));
  assert.throws(() => resolveInside(base, "..", "etc"), PathError);
  assert.throws(() => resolveInside(base, "/etc/passwd"), PathError);
  assert.throws(() => resolveInside(base, "versions/../../x"), PathError);
  assert.ok(isAllowedStoragePath("project.json"));
  assert.ok(isAllowedStoragePath("versions/ch3/abc/index.html"));
  assert.equal(isAllowedStoragePath("../project.json"), false);
  assert.equal(isAllowedStoragePath("versions/ch3/abc/../../x/index.html"), false);
  assert.equal(isAllowedStoragePath(".github/workflows/studio-generate.yml"), false);
});

test("guard: loopback host and same-origin only", () => {
  const r = (url, headers = {}, method = "GET") => new Request(url, { method, headers });
  assert.equal(checkRequest(r("http://127.0.0.1:5177/api/project")), null);
  assert.equal(checkRequest(r("http://localhost:5177/api/project")), null);
  assert.equal(checkRequest(r("http://evil.example/api/project")).status, 403);
  assert.equal(checkRequest(r("http://192.168.1.5:5177/api/project")).status, 403);
  assert.equal(checkRequest(r("http://127.0.0.1:5177/api/project", { origin: "http://evil.example" })).status, 403);
  assert.equal(checkRequest(r("http://127.0.0.1:5177/api/project", { origin: "null" })).status, 403);
  assert.equal(checkRequest(r("http://127.0.0.1:5177/api/project", { origin: "http://127.0.0.1:5177" })), null);
  assert.equal(checkRequest(r("http://127.0.0.1:5177/api/x", { "content-type": "text/plain" }, "POST")).status, 415);
  assert.equal(checkRequest(r("http://127.0.0.1:5177/api/x", { "content-type": "application/json", "sec-fetch-site": "cross-site" }, "POST")).status, 403);
  assert.equal(checkRequest(r("https://studio.example/api/x", { "content-type": "application/json" }, "POST"), { mode: "hosted" }), null);
});

test("api rejects bad Origin, bad Host, traversal ids and oversize bodies", async () => {
  const { app } = localApp();
  const api = app.api;
  assert.equal((await call(api, "GET", "/api/project", undefined, { headers: { origin: "http://evil.example" } })).status, 403);
  assert.equal((await call(api, "GET", "/api/project", undefined, { base: "http://evil.example" })).status, 403);
  assert.equal((await call(api, "GET", "/api/project")).status, 200);
  assert.equal((await call(api, "POST", "/api/copy/..%2fx/save", { text: "x" })).status, 400);
  assert.equal((await call(api, "POST", "/api/copy/NOPE/save", { text: "x" })).status, 400);
  assert.equal((await call(api, "GET", "/api/preview/asset/..%2f..%2fproject.json")).status, 400);
  assert.equal((await call(api, "GET", "/api/preview/baseline/v9%2f..%2f..")).status, 400);
  assert.equal((await call(api, "GET", "/api/preview/baseline/not-registered")).status, 404);
  const big = await api.handle(new Request(LOCAL + "/api/copy/hero-eyebrow/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(1_100_000) }) }));
  assert.equal(big.status, 413);
  assert.equal((await call(api, "POST", "/api/generate", { kind: "asset", sectionId: "../x", prompt: "", tool: "hand-built", engine: "template-demo" })).status, 400);
});

test("preview responses carry a strict sandbox CSP and the theme script", async () => {
  const { app } = localApp();
  await call(app.api, "POST", "/api/generate", { kind: "asset", sectionId: "ch1", prompt: "p", tool: "hand-built", engine: "template-demo" });
  await app.jobs.idle();
  const p = (await call(app.api, "GET", "/api/project")).json.project;
  const vid = p.assets["asset-ch1"].currentVersionId;
  const r = await call(app.api, "GET", `/api/preview/asset/${vid}?theme=light`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy"), /sandbox allow-scripts/);
  assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(r.headers.get("content-type"), /^text\/html/);
  assert.match(r.text, /"light"/);
  const evil = await call(app.api, "GET", `/api/preview/asset/${vid}?theme=%3Cscript%3E`);
  assert.doesNotMatch(evil.text, /<script>alert/);
});

// ---- auth ----
const SECRET = "s".repeat(32);

test("auth: sign, verify, tamper, expiry", () => {
  const t = signToken({ exp: 2000 }, SECRET);
  assert.deepEqual(verifyToken(t, SECRET, 1000), { exp: 2000 });
  assert.equal(verifyToken(t, SECRET, 2000), null, "expired");
  assert.equal(verifyToken(t, "other-secret-other-secret-xx", 1000), null, "wrong secret");
  const [body, mac] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ exp: 9_999_999 })).toString("base64url");
  assert.equal(verifyToken(`${forged}.${mac}`, SECRET, 1000), null, "tampered payload");
  assert.equal(verifyToken(`${body}.${mac.slice(0, -2)}xx`, SECRET, 1000), null, "tampered mac");
  assert.equal(verifyToken("garbage", SECRET, 1000), null);
  assert.equal(verifyToken(t, "", 1000), null);
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("abc", "abcd"));
  assert.equal(parseCookies("a=1; studio_session=xyz").studio_session, "xyz");
});

test("auth: hosted login issues HttpOnly Secure SameSite=Strict 12h cookie and logout clears it", () => {
  let now = 1_000_000;
  const auth = createAuth({ mode: "hosted", password: "pw-correct", secret: SECRET, now: () => now });
  assert.equal(auth.configured, true);
  const bad = auth.login("wrong", "1.1.1.1");
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
  const ok = auth.login("pw-correct", "1.1.1.1");
  assert.equal(ok.ok, true);
  assert.match(ok.setCookie, /HttpOnly/);
  assert.match(ok.setCookie, /Secure/);
  assert.match(ok.setCookie, /SameSite=Strict/);
  assert.match(ok.setCookie, new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}`));
  const cookie = ok.setCookie.split(";")[0];
  const withCookie = new Request("https://s.example/api/project", { headers: { cookie } });
  assert.equal(auth.isAuthenticated(withCookie), true);
  now += SESSION_TTL_MS + 1;
  assert.equal(auth.isAuthenticated(withCookie), false, "expired after 12h");
  assert.equal(auth.isAuthenticated(new Request("https://s.example/api/project")), false);
  assert.match(auth.logoutCookie(), /Max-Age=0/);
  assert.ok(auth.logoutCookie().startsWith(COOKIE_NAME));
});

test("auth: login rate limit locks an ip after repeated failures and resets", () => {
  let now = 0;
  const auth = createAuth({ mode: "hosted", password: "pw", secret: SECRET, now: () => now, maxFailures: 3, windowMs: 1000 });
  for (let i = 0; i < 3; i++) assert.equal(auth.login("x", "ip").status, 401);
  assert.equal(auth.login("pw", "ip").status, 429, "even the right password is refused while limited");
  assert.equal(auth.login("pw", "other-ip").ok, true);
  now = 2000;
  assert.equal(auth.login("pw", "ip").ok, true);
});

test("auth: hosted mode fails closed when not configured", async () => {
  for (const cfg of [{}, { password: "pw" }, { secret: SECRET }, { password: "pw", secret: "short" }]) {
    const auth = createAuth({ mode: "hosted", ...cfg });
    assert.equal(auth.configured, false);
    assert.equal(auth.login("pw", "ip").status, 503);
    assert.equal(auth.isAuthenticated(new Request("https://s.example/api/project")), false);
  }
  const { app } = localApp({ mode: "hosted", env: {} });
  for (const p of ["/api/project", "/api/me", "/api/export/copy.json", "/api/jobs"]) {
    const r = await call(app.api, "GET", p, undefined, { base: "https://s.example" });
    assert.equal(r.status, 503, p);
    assert.equal(r.json.message, NOT_CONFIGURED_MESSAGE);
  }
  const login = await call(app.api, "POST", "/api/login", { password: "pw" }, { base: "https://s.example" });
  assert.equal(login.status, 503);
  assert.equal(req("GET", "/").method, "GET");
});
