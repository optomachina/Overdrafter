// Pure request handlers on Web-standard Request/Response. Mounted by server.mjs
// (local node:http adapter) and by api/[...route].mjs (Vercel). No filesystem
// assumptions leak to the UI: it only ever talks JSON to /api/*.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkRequest } from "./guard.mjs";
import { lintCopy, lintContextForField } from "./lint.mjs";
import { assertId, isValidId, resolveInside, PathError } from "./paths.mjs";
import { appendVersion, restoreVersion, addMark, decorate, findVersion, assetIdFor, currentVersion } from "./ops.mjs";
import { newId } from "./ids.mjs";
import { publicTools, localToolStatus } from "./config.mjs";
import { buildCopyJson, buildHandoffMarkdown } from "./handoff.mjs";
import { seedProject } from "./seed.mjs";
import { StorageError } from "./storage/common.mjs";
import { SchemaError } from "./schema.mjs";
import { JobError } from "./jobs.mjs";
import { injectEditor } from "./editor-inject.mjs";

const libDir = path.dirname(fileURLToPath(import.meta.url));
export const MAX_BODY = 1_000_000;

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox allow-scripts; frame-ancestors 'self'";

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", ...extra } });
}
const fail = (status, error, message, extra = {}) => json({ error, message, ...extra }, status);

export function injectTheme(html, theme) {
  const t = theme === "light" || theme === "dark" ? theme : null;
  const script =
    "<script>(function(){var t=" + JSON.stringify(t) + ";function s(x){try{document.documentElement.setAttribute('data-theme',x)}catch(e){}}" +
    "if(t)s(t);addEventListener('message',function(e){var d=e.data;if(e.source===parent&&d&&d.type==='od-studio-theme'&&(d.theme==='dark'||d.theme==='light'))s(d.theme)})})()</script>";
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + script) : script + html;
}

function previewResponse(html, theme, editorOrigin = null) {
  // The editor is appended last (before </body>) so the page's own scripts have already built their DOM.
  const themed = injectTheme(html, theme);
  return new Response(editorOrigin ? injectEditor(themed, editorOrigin) : themed, {
    status: 200,
    headers: { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PREVIEW_CSP },
  });
}

async function readJson(request) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BODY) throw Object.assign(new Error("Request body too large (limit 1 MB)."), { status: 413, code: "too_large" });
  const text = await request.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error("Request body too large (limit 1 MB)."), { status: 413, code: "too_large" });
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v;
  } catch {
    throw Object.assign(new Error("Body must be a JSON object."), { status: 400, code: "bad_json" });
  }
}

const str = (v, max, name) => {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw Object.assign(new Error(`${name} must be a string.`), { status: 400, code: "invalid" });
  if (v.length > max) throw Object.assign(new Error(`${name} is too long (max ${max}).`), { status: 400, code: "invalid" });
  return v;
};

export function createApi({ storage, jobs, config, engines, auth, mode = "local", seed = null, repoRoot = null, studioRoot = null, now = () => new Date(), idGen = newId, fsImpl = fs, probeTtlMs = 20_000 }) {
  let engineCache = null;

  async function ensureProject() {
    let p = await storage.readProject();
    if (!p) {
      if (!seed) throw new StorageError("not_initialized", "No project yet and no seed available.", 503);
      p = seedProject(seed, null, { now, idGen });
      await storage.initProject(p);
      p = await storage.readProject();
    }
    return p;
  }

  async function engineStatuses() {
    if (engineCache && Date.now() - engineCache.at < probeTtlMs) return engineCache.value;
    const value = [];
    for (const e of Object.values(engines)) {
      if (e.id === "fake") continue;
      const av = await e.available().catch((err) => ({ ok: false, message: err.message }));
      value.push({ id: e.id, label: e.label, description: e.description, available: av.ok, reason: av.ok ? "" : av.message, demo: !!e.demo, usesSkills: !!e.usesSkills });
    }
    engineCache = { at: Date.now(), value };
    return value;
  }

  const toolsView = () => publicTools({ ...config, tools: config.tools }, { fsImpl });

  function viewProject(p) {
    return {
      ...p,
      fields: Object.fromEntries(Object.entries(p.fields).map(([k, v]) => [k, decorate(v)])),
      assets: Object.fromEntries(Object.entries(p.assets).map(([k, v]) => [k, decorate(v)])),
    };
  }

  async function fieldFor(project, id) {
    assertId(id, "field id");
    const f = project.fields[id];
    if (!f) throw Object.assign(new Error("Unknown field."), { status: 404, code: "not_found" });
    return f;
  }

  async function saveCopy(fieldId, body, { restoreFrom = null } = {}) {
    const project = await ensureProject();
    const field = await fieldFor(project, fieldId);
    const note = str(body.note, 500, "note");
    let text;
    if (restoreFrom) {
      const old = field.versions.find((v) => v.id === restoreFrom);
      if (!old) throw Object.assign(new Error("Version not found."), { status: 404, code: "not_found" });
      if (old.kind === "failed") throw Object.assign(new Error("A failed attempt cannot be restored."), { status: 400, code: "invalid" });
      text = old.text;
    } else {
      text = str(body.text, 5000, "text");
      if (!text.trim()) throw Object.assign(new Error("Copy cannot be empty."), { status: 400, code: "invalid" });
    }
    const lint = lintCopy(text, lintContextForField(project, field));
    if (lint.errors.length) return fail(422, "lint_error", "Copy lint found errors. Fix them before saving.", { lint });
    if (lint.warnings.length && body.overrideWarnings !== true) {
      return fail(409, "lint_warning", "Copy lint found warnings. Edit the text, or save anyway.", { lint, needsConfirm: true });
    }
    const cur = currentVersion(field);
    if (!restoreFrom && cur.text === text) return json({ unchanged: true, field: decorate(field), lint });
    const vid = idGen(now().getTime());
    await storage.update(`${restoreFrom ? "restore" : "manual"} ${field.sectionId} ${vid}`, (draft) => {
      const f = draft.fields[fieldId];
      if (restoreFrom) {
        const r = restoreVersion(f, restoreFrom, "copy", { note, idGen: () => vid, now });
        if (lint.warnings.length) r.lint = { warnings: lint.warnings.map((w) => w.message) };
      } else {
        appendVersion(f, { id: vid, kind: "manual", text, note, author: "human", ...(lint.warnings.length ? { lint: { warnings: lint.warnings.map((w) => w.message) } } : {}) }, { idGen: () => vid, now });
      }
    });
    const after = await storage.readProject();
    return json({ field: decorate(after.fields[fieldId]), lint });
  }

  async function star(kind, id, body) {
    const versionId = str(body.versionId, 80, "versionId");
    assertId(versionId, "version id");
    const starred = body.starred !== false;
    await storage.update(`star ${kind} ${id} ${versionId}`, (draft) => {
      const ent = kind === "field" ? draft.fields[id] : draft.assets[id];
      if (!ent) throw Object.assign(new Error("Unknown item."), { status: 404, code: "not_found" });
      addMark(ent, versionId, starred, now);
    });
    const after = await storage.readProject();
    return json(kind === "field" ? { field: decorate(after.fields[id]) } : { asset: decorate(after.assets[id]) });
  }

  async function preview(kind, id, url) {
    const theme = url.searchParams.get("theme");
    if (kind === "asset") {
      assertId(id, "version id");
      const project = await ensureProject();
      const hit = findVersion(project, id);
      if (!hit || hit.type !== "asset" || !hit.version.assetPath) return fail(404, "not_found", "No asset for that version.");
      const buf = await storage.readAsset(hit.version.assetPath);
      if (!buf) return fail(404, "not_found", "Asset file is missing from storage.");
      return previewResponse(buf.toString("utf8"), theme);
    }
    assertId(id, "baseline id");
    // Baseline pages (never generated assets) get the page editor unless the caller opts out with editor=0.
    const editorOrigin = url.searchParams.get("editor") === "0" ? null : url.origin;
    const project = await ensureProject();
    const b = project.baselines.find((x) => x.id === id);
    if (!b) return fail(404, "not_found", "Unknown baseline page.");
    if (repoRoot && studioRoot) {
      const publicDir = path.join(repoRoot, "public");
      const file = path.resolve(studioRoot, b.path);
      if (file.startsWith(publicDir + path.sep) && fsImpl.existsSync(file)) {
        return previewResponse(fsImpl.readFileSync(file, "utf8"), theme, editorOrigin);
      }
    }
    const snap = await storage.readAsset(`baselines/${id}/index.html`);
    if (snap) return previewResponse(snap.toString("utf8"), theme, editorOrigin);
    return fail(404, "baseline_unavailable", "This baseline page is not available here. Run scripts/seed.mjs --with-baselines locally and copy data/baselines/ into the data repo.");
  }

  async function route(request, url) {
    const m = request.method.toUpperCase();
    const p = url.pathname.replace(/\/+$/, "") || "/";
    let r;

    // Public: pure code the UI imports.
    if (m === "GET" && (r = p.match(/^\/api\/shared\/(lint|diff|field-match|page-protocol|page-parent)\.mjs$/))) {
      const body = fs.readFileSync(path.join(libDir, `${r[1]}.mjs`), "utf8");
      return new Response(body, { status: 200, headers: { ...BASE_HEADERS, "Content-Type": "text/javascript; charset=utf-8" } });
    }

    if (!auth.configured) return fail(503, "not_configured", auth.notConfiguredMessage, { configured: false });

    if (m === "POST" && p === "/api/login") {
      const body = await readJson(request);
      const ip = (request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
      const res = auth.login(typeof body.password === "string" ? body.password : "", ip);
      if (!res.ok) return fail(res.status, "login_failed", res.message);
      return json({ ok: true }, 200, { "Set-Cookie": res.setCookie });
    }
    if (m === "POST" && p === "/api/logout") return json({ ok: true }, 200, { "Set-Cookie": auth.logoutCookie() });
    if (m === "GET" && p === "/api/me") {
      return json({ mode, configured: true, authenticated: auth.isAuthenticated(request), studioName: config.studioName });
    }
    if (!auth.isAuthenticated(request)) return fail(401, "unauthenticated", "Log in first.");
    await ensureProject();

    if (m === "GET" && p === "/api/project") {
      const project = await ensureProject();
      return json({
        mode,
        studioName: config.studioName,
        storage: { kind: storage.kind, ephemeral: !!storage.ephemeral },
        defaultTool: config.defaultTool,
        project: viewProject(project),
        tools: toolsView(),
        engines: await engineStatuses(),
      });
    }

    if (m === "POST" && (r = p.match(/^\/api\/copy\/([^/]+)\/(save|restore|star)$/))) {
      const body = await readJson(request);
      assertId(r[1], "field id");
      if (r[2] === "save") return saveCopy(r[1], body);
      if (r[2] === "restore") {
        assertId(String(body.versionId || ""), "version id");
        return saveCopy(r[1], body, { restoreFrom: body.versionId });
      }
      return star("field", r[1], body);
    }

    if (m === "POST" && (r = p.match(/^\/api\/asset\/([^/]+)\/(restore|star)$/))) {
      const body = await readJson(request);
      const sectionId = assertId(r[1], "section id");
      const aid = assetIdFor(sectionId);
      if (r[2] === "star") return star("asset", aid, body);
      const versionId = assertId(String(body.versionId || ""), "version id");
      const note = str(body.note, 500, "note");
      const vid = idGen(now().getTime());
      await storage.update(`restore ${sectionId} ${vid}`, (draft) => {
        if (!draft.assets[aid]) throw Object.assign(new Error("Unknown section."), { status: 404, code: "not_found" });
        restoreVersion(draft.assets[aid], versionId, "asset", { note, idGen: () => vid, now });
      });
      const after = await storage.readProject();
      return json({ asset: decorate(after.assets[aid]) });
    }

    if (m === "POST" && p === "/api/generate") {
      const body = await readJson(request);
      const job = await jobs.submit({
        kind: body.kind, sectionId: body.sectionId, fieldId: body.fieldId,
        prompt: str(body.prompt, 8000, "prompt"), tool: str(body.tool, 80, "tool"), engine: str(body.engine, 80, "engine"), model: body.model,
      });
      return json({ job }, job.state === "queued" || job.state === "running" ? 202 : 200);
    }
    if (m === "GET" && p === "/api/jobs") return json({ jobs: await jobs.list(Number(url.searchParams.get("limit")) || 8) });
    if ((r = p.match(/^\/api\/jobs\/([^/]+)(?:\/(cancel|retry))?$/))) {
      assertId(r[1], "job id");
      if (m === "GET" && !r[2]) return json({ job: await jobs.get(r[1]) });
      if (m === "POST" && r[2] === "cancel") return json({ job: await jobs.cancel(r[1]) });
      if (m === "POST" && r[2] === "retry") {
        const body = await readJson(request);
        const o = {};
        if (body.engine) o.engine = str(body.engine, 80, "engine");
        if (body.tool) o.tool = str(body.tool, 80, "tool");
        if (body.prompt !== undefined) o.prompt = str(body.prompt, 8000, "prompt");
        return json({ job: await jobs.retry(r[1], o) }, 202);
      }
    }

    if (m === "GET" && p === "/api/export/copy.json") {
      const body = JSON.stringify(buildCopyJson(await ensureProject(), now()), null, 2) + "\n";
      return new Response(body, { status: 200, headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", "Content-Disposition": 'attachment; filename="copy.json"' } });
    }
    if (m === "GET" && p === "/api/export/handoff.md") {
      return new Response(buildHandoffMarkdown(await ensureProject(), now()), { status: 200, headers: { ...BASE_HEADERS, "Content-Type": "text/markdown; charset=utf-8" } });
    }

    if (m === "GET" && (r = p.match(/^\/api\/log\/([^/]+)$/))) {
      assertId(r[1], "version id");
      const hit = findVersion(await ensureProject(), r[1]);
      if (!hit || !hit.version.logPath) return fail(404, "not_found", "No log for that version.");
      const buf = await storage.readAsset(hit.version.logPath);
      return new Response(buf ? buf.toString("utf8") : "(log file missing)", { status: 200, headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
    }

    if (m === "GET" && (r = p.match(/^\/api\/preview\/(asset|baseline)\/([^/]+)$/))) return preview(r[1], r[2], url);

    return fail(404, "not_found", "No such endpoint.");
  }

  async function handle(request) {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/")) return fail(404, "not_found", "No such endpoint.");
      const blocked = checkRequest(request, { mode });
      if (blocked) return fail(blocked.status, "rejected", blocked.message);
      return await route(request, url);
    } catch (e) {
      if (e instanceof PathError || e instanceof SchemaError || e instanceof JobError || e instanceof StorageError || e.status) {
        const status = e.status || 400;
        // Upstream failures (GitHub token, repo, rate limit) must show up in the host's logs, not only in the response.
        if (status >= 500) console.error(`[studio] ${e.code || e.name} (${status}): ${e.message}`);
        return fail(status, e.code || (e instanceof PathError ? "invalid" : "error"), e.message);
      }
      return fail(500, "internal", "Internal error. Check the server log.");
    }
  }

  return { handle, ensureProject, isValidId };
}
