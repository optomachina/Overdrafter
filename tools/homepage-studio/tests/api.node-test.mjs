import test from "node:test";
import assert from "node:assert/strict";
import { call, localApp, createFakeGithub, githubWithProject, freshProject } from "./helpers.mjs";
import { createApp } from "../lib/app.mjs";
import { createServer, listen } from "../server.mjs";
import { resetApp } from "../lib/vercel-handler.mjs";

const HOST = "https://studio.example";
const GOOD_ENV = { STUDIO_HOSTED: "1", STUDIO_PASSWORD: "correct horse", STUDIO_SESSION_SECRET: "x".repeat(40), STUDIO_DATA_REPO: "owner/data", GITHUB_TOKEN: "ghp_fake" };

test("copy save: lint errors block (422), warnings need confirmation (409), then save; unchanged is a no-op", async () => {
  const { app } = localApp();
  const api = app.api;
  const bad = await call(api, "POST", "/api/copy/hero-eyebrow/save", { text: "Ships next year in Q3 2027" });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error, "lint_error");
  assert.ok(bad.json.lint.errors.length >= 3);
  const warn = await call(api, "POST", "/api/copy/hero-eyebrow/save", { text: "The best way to ship" });
  assert.equal(warn.status, 409);
  assert.equal(warn.json.needsConfirm, true);
  const noError = await call(api, "POST", "/api/copy/hero-eyebrow/save", { text: "The best way to ship", overrideWarnings: true, note: "knowingly" });
  assert.equal(noError.status, 200);
  assert.equal(noError.json.field.versions.length, 2);
  assert.equal(noError.json.field.versions[1].note, "knowingly");
  assert.ok(noError.json.field.versions[1].lint.warnings.length > 0);
  const same = await call(api, "POST", "/api/copy/hero-eyebrow/save", { text: "The best way to ship", overrideWarnings: true });
  assert.equal(same.json.unchanged, true);
  assert.equal((await call(api, "POST", "/api/copy/hero-eyebrow/save", { text: "   " })).status, 400);
  const errOverride = await call(api, "POST", "/api/copy/hero-eyebrow/save", { text: "Live", overrideWarnings: true });
  assert.equal(errOverride.status, 422, "overrideWarnings never bypasses errors");
});

test("copy restore creates a new version and keeps history; star toggles without deleting", async () => {
  const { app } = localApp();
  const api = app.api;
  await call(api, "POST", "/api/copy/hero-lede/save", { text: "One." });
  await call(api, "POST", "/api/copy/hero-lede/save", { text: "Two." });
  let f = (await call(api, "GET", "/api/project")).json.project.fields["hero-lede"];
  assert.equal(f.versions.length, 3);
  const r = await call(api, "POST", "/api/copy/hero-lede/restore", { versionId: f.versions[1].id });
  assert.equal(r.status, 200);
  f = r.json.field;
  assert.equal(f.versions.length, 4);
  assert.equal(f.versions[3].kind, "restore");
  assert.equal(f.versions[3].parentId, f.versions[1].id);
  assert.equal(f.versions[3].text, "One.");
  const s = await call(api, "POST", "/api/copy/hero-lede/star", { versionId: f.versions[0].id, starred: true });
  assert.equal(s.json.field.versions[0].starred, true);
  const u = await call(api, "POST", "/api/copy/hero-lede/star", { versionId: f.versions[0].id, starred: false });
  assert.equal(u.json.field.versions[0].starred, false);
  assert.equal(u.json.field.versions.length, 4);
  assert.equal((await call(api, "POST", "/api/copy/hero-lede/restore", { versionId: "nope" })).status, 404);
});

test("asset generate, restore, star, log and exports through the API", async () => {
  const { app } = localApp();
  const api = app.api;
  const g = await call(api, "POST", "/api/generate", { kind: "asset", sectionId: "ch5", prompt: "hello", tool: "hand-built", engine: "template-demo" });
  assert.equal(g.status, 202);
  await app.jobs.idle();
  const job = (await call(api, "GET", `/api/jobs/${g.json.job.id}`)).json.job;
  assert.equal(job.state, "succeeded");
  const blocked = await call(api, "POST", "/api/generate", { kind: "asset", sectionId: "ch5", prompt: "x", tool: "hand-built", engine: "claude-cli" });
  await app.jobs.idle();
  const bj = (await call(api, "GET", `/api/jobs/${blocked.json.job.id}`)).json.job;
  assert.equal(bj.state, "blocked");
  assert.equal(bj.message, "Claude CLI is not logged in: run `claude auth login`");
  const retried = await call(api, "POST", `/api/jobs/${bj.id}/retry`, { engine: "template-demo", tool: "hand-built" });
  assert.equal(retried.status, 202);
  await app.jobs.idle();
  const proj = (await call(api, "GET", "/api/project")).json;
  const a = proj.project.assets["asset-ch5"];
  assert.equal(a.versions.length, 2);
  const restored = await call(api, "POST", "/api/asset/ch5/restore", { versionId: a.versions[0].id });
  assert.equal(restored.json.asset.versions.length, 3);
  assert.equal(restored.json.asset.versions[2].kind, "restore");
  assert.equal(restored.json.asset.versions[2].assetPath, a.versions[0].assetPath);
  const st = await call(api, "POST", "/api/asset/ch5/star", { versionId: a.versions[0].id });
  assert.equal(st.json.asset.versions[0].starred, true);
  assert.deepEqual(proj.engines.map((e) => e.id), ["template-demo", "claude-cli", "github-actions"]);
  assert.ok(proj.tools.every((t) => !("skillPath" in t) && !("resolvedPath" in t)), "no filesystem paths reach the UI");
  assert.ok(!JSON.stringify(proj).includes("/.homepage-studio"), "no local paths in the payload");
  const copy = await call(api, "GET", "/api/export/copy.json");
  assert.match(copy.headers.get("content-disposition"), /copy\.json/);
  assert.ok(copy.json.sections.find((s) => s.id === "ch5").asset.versionId);
  const md = await call(api, "GET", "/api/export/handoff.md");
  assert.match(md.text, /# Homepage Studio handoff/);
  assert.equal((await call(api, "GET", "/api/nothing")).status, 404);
  assert.equal((await call(api, "GET", "/api/shared/lint.mjs")).status, 200);
});

test("failed asset job exposes its log through /api/log", async () => {
  const { app } = localApp({ extraEngines: [] });
  const api = app.api;
  // A copy job the demo engine cannot do => failed with a log.
  await call(api, "POST", "/api/generate", { kind: "copy", sectionId: "hero", fieldId: "hero-eyebrow", prompt: "make it poetic", tool: "hand-built", engine: "template-demo" });
  await app.jobs.idle();
  const f = (await call(api, "GET", "/api/project")).json.project.fields["hero-eyebrow"];
  const failed = f.versions.find((v) => v.kind === "failed");
  assert.ok(failed);
  const log = await call(api, "GET", `/api/log/${failed.id}`);
  assert.equal(log.status, 200);
  assert.match(log.text, /demo engine|shorten/);
});

// ---- hosted: auth + github storage + demo engine, all with a fake fetch ----
function hostedApp(gh) {
  return createApp({ env: GOOD_ENV, mode: "hosted", fetchImpl: gh.fetch, probe: async () => ({ installed: false, loggedIn: false }) });
}
async function login(app) {
  const r = await app.api.handle(new Request(HOST + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: GOOD_ENV.STUDIO_PASSWORD }) }));
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie").split(";")[0];
}
const hcall = (app, cookie, method, p, body) => call(app.api, method, p, body, { base: HOST, headers: cookie ? { cookie } : {} });

test("hosted smoke: login, edit copy, demo generation, preview, history, all stored as commits in the data repo", async () => {
  const gh = githubWithProject();
  const app = hostedApp(gh);
  assert.equal((await hcall(app, null, "GET", "/api/project")).status, 401, "no cookie, no data");
  const me = await hcall(app, null, "GET", "/api/me");
  assert.equal(me.json.authenticated, false);
  const wrong = await call(app.api, "POST", "/api/login", { password: "nope" }, { base: HOST });
  assert.equal(wrong.status, 401);
  const cookie = await login(app);
  assert.equal((await hcall(app, cookie, "GET", "/api/me")).json.authenticated, true);

  const proj = await hcall(app, cookie, "GET", "/api/project");
  assert.equal(proj.status, 200);
  assert.equal(proj.json.mode, "hosted");
  assert.equal(proj.json.storage.kind, "github");
  const byId = Object.fromEntries(proj.json.engines.map((e) => [e.id, e]));
  assert.equal(byId["template-demo"].available, true);
  assert.equal(byId["claude-cli"].available, false);
  assert.match(byId["claude-cli"].reason, /runs only on a machine with the CLI/);
  assert.equal(byId["github-actions"].available, true);

  const save = await hcall(app, cookie, "POST", "/api/copy/hero-eyebrow/save", { text: "One part, from idea to shelf", note: "hosted edit" });
  assert.equal(save.status, 200);
  assert.equal(JSON.parse(gh.file("project.json")).fields["hero-eyebrow"].versions.length, 2);
  assert.match(gh.commitMessages().at(-1), /^studio: manual hero /);

  const gen = await hcall(app, cookie, "POST", "/api/generate", { kind: "asset", sectionId: "ch3", prompt: "demo please", tool: "hand-built", engine: "template-demo" });
  assert.equal(gen.status, 200, "inline demo jobs finish inside the request on serverless");
  assert.equal(gen.json.job.state, "succeeded");
  const vid = gen.json.job.resultVersionId;
  assert.match(gh.commitMessages().at(-1), new RegExp(`^studio: generated ch3 ${vid}`));
  const proj2 = (await hcall(app, cookie, "GET", "/api/project")).json.project;
  assert.equal(proj2.assets["asset-ch3"].versions[0].id, vid);
  const prev = await hcall(app, cookie, "GET", `/api/preview/asset/${vid}?theme=dark`);
  assert.equal(prev.status, 200);
  assert.match(prev.headers.get("content-security-policy"), /sandbox allow-scripts/);
  assert.match(prev.text, /demo engine, not generated by a model/);
  assert.equal((await hcall(app, null, "GET", `/api/preview/asset/${vid}`)).status, 401);

  const rs = await hcall(app, cookie, "POST", "/api/asset/ch3/restore", { versionId: vid });
  assert.equal(rs.json.asset.versions.length, 2);
  assert.ok(!gh.calls.some((c) => c.method === "DELETE" || (c.body && c.body.force)), "append-only, never forced");

  const blocked = await hcall(app, cookie, "POST", "/api/generate", { kind: "asset", sectionId: "ch3", prompt: "x", tool: "hand-built", engine: "claude-cli" });
  assert.equal(blocked.json.job.state, "blocked");
  assert.match(blocked.json.job.message, /runs only on a machine with the CLI/);

  const queued = await hcall(app, cookie, "POST", "/api/generate", { kind: "asset", sectionId: "ch4", prompt: "worker please", tool: "hand-built", engine: "github-actions" });
  assert.equal(queued.json.job.state, "queued");
  assert.equal(gh.dispatches.length, 1);
  assert.equal((await hcall(app, cookie, "GET", `/api/jobs/${queued.json.job.id}`)).json.job.state, "queued");

  const out = await hcall(app, cookie, "POST", "/api/logout", {});
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
});

test("hosted: GitHub permission and rate-limit problems reach the caller as specific messages", async () => {
  const gh = githubWithProject();
  const app = hostedApp(gh);
  const cookie = await login(app);
  gh.failures.push({ status: 403, message: "Resource not accessible", persist: true, match: (m, p) => p.startsWith("/git/ref/") });
  const r = await hcall(app, cookie, "POST", "/api/copy/hero-lede/save", { text: "New lede." });
  assert.equal(r.status, 502);
  assert.equal(r.json.error, "forbidden");
  assert.match(r.json.message, /Contents: read and write/);
  gh.failures.length = 0;
  gh.failures.push({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1900000000" }, message: "rate limit", persist: true, match: (m, p) => p.startsWith("/git/ref/") });
  const rl = await hcall(app, cookie, "POST", "/api/copy/hero-lede/save", { text: "Newer lede." });
  assert.equal(rl.status, 429);
  assert.equal(rl.json.error, "rate_limited");
});

test("hosted without a data repo uses temporary storage and says so", async () => {
  const env = { ...GOOD_ENV };
  delete env.STUDIO_DATA_REPO;
  delete env.GITHUB_TOKEN;
  const app = createApp({ env, mode: "hosted" });
  const cookie = await login(app);
  const proj = await hcall(app, cookie, "GET", "/api/project");
  assert.equal(proj.json.storage.ephemeral, true);
  const byId = Object.fromEntries(proj.json.engines.map((e) => [e.id, e]));
  assert.equal(byId["github-actions"].available, false);
  assert.match(byId["github-actions"].reason, /STUDIO_DATA_REPO and GITHUB_TOKEN/);
  const gen = await hcall(app, cookie, "POST", "/api/generate", { kind: "asset", sectionId: "ch1", prompt: "p", tool: "hand-built", engine: "template-demo" });
  assert.equal(gen.json.job.state, "succeeded", "the demo flow works before any credential exists");
});

// ---- Vercel function wrapper ----
test("vercel function wrapper delegates Request objects to the shared handlers", async () => {
  const gh = githubWithProject();
  const keep = { env: { ...process.env }, fetch: globalThis.fetch };
  Object.assign(process.env, GOOD_ENV);
  globalThis.fetch = gh.fetch;
  resetApp();
  try {
    const mod = await import("../api/index.mjs");
    assert.equal(typeof mod.default.fetch, "function");
    const r1 = await mod.default.fetch(new Request(HOST + "/api/me"));
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).authenticated, false);
    const r2 = await mod.default.fetch(new Request(HOST + "/api/project"));
    assert.equal(r2.status, 401);
    const lg = await mod.POST(new Request(HOST + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: GOOD_ENV.STUDIO_PASSWORD }) }));
    assert.equal(lg.status, 200);
    const cookie = lg.headers.get("set-cookie").split(";")[0];
    const r3 = await mod.GET(new Request(HOST + "/api/project", { headers: { cookie } }));
    assert.equal(r3.status, 200);
    assert.equal((await r3.json()).storage.kind, "github");
    const r4 = await mod.default.fetch(new Request(HOST + "/api/project", { headers: { cookie, origin: "https://evil.example" } }));
    assert.equal(r4.status, 403);
  } finally {
    for (const k of Object.keys(GOOD_ENV)) delete process.env[k];
    Object.assign(process.env, keep.env);
    globalThis.fetch = keep.fetch;
    resetApp();
  }
});

test("vercel function wrapper fails closed without configuration", async () => {
  const keep = { ...process.env };
  process.env.STUDIO_HOSTED = "1";
  delete process.env.STUDIO_PASSWORD;
  delete process.env.STUDIO_SESSION_SECRET;
  resetApp();
  try {
    const mod = await import("../api/index.mjs");
    const r = await mod.default.fetch(new Request(HOST + "/api/project"));
    assert.equal(r.status, 503);
    assert.match((await r.json()).message, /not configured/);
  } finally {
    process.env = keep;
    resetApp();
  }
});

// ---- local server smoke ----
test("local server smoke: binds loopback, serves the UI and the API, rejects foreign Origin and Host", async () => {
  const { app } = localApp();
  const server = createServer(app);
  const addr = await listen(server, 0);
  try {
    assert.equal(addr.address, "127.0.0.1");
    const base = `http://127.0.0.1:${addr.port}`;
    const ui = await fetch(base + "/");
    assert.equal(ui.status, 200);
    assert.match(ui.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    const html = await ui.text();
    assert.match(html, /Version history/);
    assert.match(html, /role="switch"/);
    assert.equal((await fetch(base + "/studio.js")).status, 200);
    assert.equal((await fetch(base + "/studio.css")).status, 200);
    const p = await fetch(base + "/api/project");
    assert.equal(p.status, 200);
    const j = await p.json();
    assert.equal(Object.keys(j.project.fields).length, 52);
    assert.equal((await fetch(base + "/api/project", { headers: { origin: "http://evil.example" } })).status, 403);
    const rebinding = await new Promise((resolve) => {
      import("node:http").then(({ default: http }) => {
        http.get({ host: "127.0.0.1", port: addr.port, path: "/api/project", headers: { host: "evil.example" } }, (res) => resolve(res.statusCode));
      });
    });
    assert.equal(rebinding, 403);
    const post = await fetch(base + "/api/copy/hero-lede/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(1_100_000) }) });
    assert.equal(post.status, 413);
    assert.equal((await fetch(base + "/../../etc/passwd")).status, 404);
    assert.equal((await fetch(base + "/data/project.json")).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("seed project fixture is stable", () => {
  assert.equal(Object.keys(freshProject().fields).length, 52);
  assert.ok(createFakeGithub());
});
