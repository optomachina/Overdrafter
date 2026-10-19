import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedProject } from "../lib/seed.mjs";
import { createApp } from "../lib/app.mjs";

export const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const seed = JSON.parse(fs.readFileSync(path.join(studioRoot, "data/seed.json"), "utf8"));

export function tmpDir(prefix = "hs-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function freshProject() {
  return seedProject(seed);
}

export const LOCAL = "http://127.0.0.1:5177";
export function req(method, p, body, { base = LOCAL, headers = {} } = {}) {
  return new Request(base + p, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
export async function call(api, method, p, body, opts) {
  const res = await api.handle(req(method, p, body, opts));
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, headers: res.headers };
}

export function localApp(extra = {}) {
  const dataDir = tmpDir();
  const app = createApp({ mode: "local", dataDir, probe: async () => ({ installed: true, loggedIn: false }), ...extra });
  return { app, dataDir };
}

// ---- Fake GitHub REST API (in-memory git-data + contents + actions) ----
export function createFakeGithub({ repo = "owner/data", branch = "main", files = {} } = {}) {
  const gh = {
    repo, branch, calls: [], dispatches: [], runs: [], failures: [], beforePatch: null,
    commits: new Map(), blobs: new Map(), trees: new Map(), head: "c0", n: 1,
  };
  const t0 = new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
  gh.trees.set("t0", t0);
  gh.commits.set("c0", { tree: "t0", parent: null });
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const treeAt = (ref) => {
    const sha = ref === branch ? gh.head : ref;
    const c = gh.commits.get(sha);
    return c ? gh.trees.get(c.tree) : null;
  };
  gh.externalCommit = (p, content) => {
    const tree = new Map(gh.trees.get(gh.commits.get(gh.head).tree));
    tree.set(p, Buffer.from(content));
    const tid = `t${++gh.n}`;
    const cid = `c${++gh.n}`;
    gh.trees.set(tid, tree);
    gh.commits.set(cid, { tree: tid, parent: gh.head, message: "external" });
    gh.head = cid;
  };
  gh.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    const p = u.pathname.replace(`/repos/${repo}`, "");
    const body = init.body ? JSON.parse(init.body) : null;
    gh.calls.push({ method, path: p, query: u.search, auth: init.headers?.Authorization, body });
    const fi = gh.failures.findIndex((f) => f.match(method, p));
    if (fi >= 0) {
      const f = gh.failures[fi];
      if (!f.persist) gh.failures.splice(fi, 1);
      return json({ message: f.message || "failure" }, f.status, f.headers || {});
    }
    let m;
    if (method === "GET" && p === `/git/ref/heads/${branch}`) return json({ object: { sha: gh.head } });
    if (method === "GET" && (m = p.match(/^\/git\/commits\/(.+)$/))) {
      const c = gh.commits.get(m[1]);
      return c ? json({ sha: m[1], tree: { sha: c.tree } }) : json({ message: "Not Found" }, 404);
    }
    if (method === "POST" && p === "/git/blobs") {
      const id = `b${++gh.n}`;
      gh.blobs.set(id, Buffer.from(body.content, "base64"));
      return json({ sha: id }, 201);
    }
    if (method === "POST" && p === "/git/trees") {
      const tree = new Map(gh.trees.get(body.base_tree));
      for (const e of body.tree) tree.set(e.path, gh.blobs.get(e.sha));
      const id = `t${++gh.n}`;
      gh.trees.set(id, tree);
      return json({ sha: id }, 201);
    }
    if (method === "POST" && p === "/git/commits") {
      const id = `c${++gh.n}`;
      gh.commits.set(id, { tree: body.tree, parent: body.parents[0], message: body.message });
      return json({ sha: id }, 201);
    }
    if (method === "PATCH" && p === `/git/refs/heads/${branch}`) {
      if (gh.beforePatch) {
        const fn = gh.beforePatch;
        gh.beforePatch = null;
        fn();
      }
      if (body.force) return json({ message: "force not allowed in this fake" }, 400);
      if (gh.commits.get(body.sha).parent !== gh.head) return json({ message: "Update is not a fast forward" }, 422);
      gh.head = body.sha;
      return json({ ref: `refs/heads/${branch}` });
    }
    if (method === "GET" && (m = p.match(/^\/contents\/(.*)$/))) {
      const tree = treeAt(u.searchParams.get("ref") || branch);
      const key = decodeURIComponent(m[1]);
      if (tree && tree.has(key)) return new Response(tree.get(key), { status: 200 });
      const dir = [...(tree || new Map()).keys()].filter((k) => k.startsWith(`${key}/`));
      if (dir.length) return json(dir.map((k) => ({ name: k.slice(key.length + 1), type: "file", path: k })));
      return json({ message: "Not Found" }, 404);
    }
    if (method === "POST" && (m = p.match(/^\/actions\/workflows\/([^/]+)\/dispatches$/))) {
      gh.dispatches.push({ workflow: m[1], ...body });
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && /^\/actions\/workflows\/[^/]+\/runs$/.test(p)) return json({ workflow_runs: gh.runs });
    return json({ message: `unhandled ${method} ${p}` }, 500);
  };
  gh.file = (p) => {
    const t = gh.trees.get(gh.commits.get(gh.head).tree);
    return t.has(p) ? t.get(p).toString("utf8") : null;
  };
  gh.commitMessages = () => {
    const out = [];
    for (let c = gh.head; c && gh.commits.get(c).parent !== null; c = gh.commits.get(c).parent) out.push(gh.commits.get(c).message);
    return out.reverse();
  };
  return gh;
}

export function githubWithProject() {
  const project = freshProject();
  return createFakeGithub({ files: { "project.json": JSON.stringify(project) } });
}
