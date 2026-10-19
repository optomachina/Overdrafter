// A tiny in-memory GitHub REST API stub (node:http, loopback only). It implements just the endpoints the
// Homepage Studio GitHub adapter uses: contents (raw file + directory listing), git-data (blobs, trees,
// commits, fast-forward ref update), workflow_dispatch and workflow runs. Every call is recorded.
import http from "node:http";

export async function startFakeGithub({ repo = "e2e/data", branch = "main", files = {} } = {}) {
  const gh = {
    repo, branch, calls: [], dispatches: [], runs: [], failures: [], beforePatch: null,
    commits: new Map(), blobs: new Map(), trees: new Map(), head: "c0", n: 1, port: 0, url: "",
  };
  gh.trees.set("t0", new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])));
  gh.commits.set("c0", { tree: "t0", parent: null, message: "initial" });

  const treeAt = (ref) => {
    const c = gh.commits.get(ref === branch ? gh.head : ref);
    return c ? gh.trees.get(c.tree) : null;
  };

  /** Make a commit that the studio did not make (simulates a worker or another editor). */
  gh.externalCommit = (p, content, message = "external") => {
    const tree = new Map(gh.trees.get(gh.commits.get(gh.head).tree));
    tree.set(p, Buffer.from(content));
    const tid = `t${++gh.n}`;
    const cid = `c${++gh.n}`;
    gh.trees.set(tid, tree);
    gh.commits.set(cid, { tree: tid, parent: gh.head, message });
    gh.head = cid;
  };
  /** Make the next matching request(s) fail. match: {method, path: RegExp}; times defaults to 1. */
  gh.failNext = ({ method, path: re, status, message = "failure", headers = {}, times = 1 }) => {
    gh.failures.push({ method, re, status, message, headers, times });
  };
  gh.file = (p) => {
    const t = gh.trees.get(gh.commits.get(gh.head).tree);
    return t.has(p) ? t.get(p).toString("utf8") : null;
  };
  gh.json = (p) => JSON.parse(gh.file(p));
  gh.commitMessages = () => {
    const out = [];
    for (let c = gh.head; c && gh.commits.get(c).parent !== null; c = gh.commits.get(c).parent) out.push(gh.commits.get(c).message);
    return out.reverse();
  };
  gh.callsMatching = (method, re) => gh.calls.filter((c) => c.method === method && re.test(c.path));

  function respond(res, status, body, headers = {}) {
    const isBuf = Buffer.isBuffer(body);
    const payload = body === null ? null : isBuf ? body : JSON.stringify(body);
    res.writeHead(status, { ...(payload === null ? {} : { "content-type": isBuf ? "application/octet-stream" : "application/json" }), ...headers });
    res.end(payload);
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const u = new URL(req.url, "http://127.0.0.1");
      const method = (req.method || "GET").toUpperCase();
      const p = u.pathname.replace(`/repos/${repo}`, "");
      let body = null;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      } catch {
        body = null;
      }
      const rec = { method, path: p, query: u.search, auth: req.headers.authorization || "", body, status: 0 };
      gh.calls.push(rec);
      const reply = (status, payload, headers) => {
        rec.status = status;
        respond(res, status, payload, headers);
      };
      if (!u.pathname.startsWith(`/repos/${repo}`)) return reply(404, { message: "Not Found" });
      const fi = gh.failures.findIndex((f) => f.method === method && f.re.test(p));
      if (fi >= 0) {
        const f = gh.failures[fi];
        if (--f.times <= 0) gh.failures.splice(fi, 1);
        return reply(f.status, { message: f.message }, f.headers);
      }
      let m;
      if (method === "GET" && p === `/git/ref/heads/${branch}`) return reply(200, { object: { sha: gh.head } });
      if (method === "GET" && (m = p.match(/^\/git\/commits\/(.+)$/))) {
        const c = gh.commits.get(m[1]);
        return c ? reply(200, { sha: m[1], tree: { sha: c.tree } }) : reply(404, { message: "Not Found" });
      }
      if (method === "POST" && p === "/git/blobs") {
        const id = `b${++gh.n}`;
        gh.blobs.set(id, Buffer.from(body.content, "base64"));
        return reply(201, { sha: id });
      }
      if (method === "POST" && p === "/git/trees") {
        const tree = new Map(gh.trees.get(body.base_tree));
        for (const e of body.tree) tree.set(e.path, gh.blobs.get(e.sha));
        const id = `t${++gh.n}`;
        gh.trees.set(id, tree);
        return reply(201, { sha: id });
      }
      if (method === "POST" && p === "/git/commits") {
        const id = `c${++gh.n}`;
        gh.commits.set(id, { tree: body.tree, parent: body.parents[0], message: body.message });
        return reply(201, { sha: id });
      }
      if (method === "PATCH" && p === `/git/refs/heads/${branch}`) {
        if (gh.beforePatch) {
          const fn = gh.beforePatch;
          gh.beforePatch = null;
          fn();
        }
        if (body.force) return reply(400, { message: "force updates are not allowed by this stub" });
        if (gh.commits.get(body.sha).parent !== gh.head) return reply(422, { message: "Update is not a fast forward" });
        gh.head = body.sha;
        return reply(200, { ref: `refs/heads/${branch}` });
      }
      if (method === "GET" && (m = p.match(/^\/contents\/(.*)$/))) {
        const tree = treeAt(u.searchParams.get("ref") || branch);
        const key = decodeURIComponent(m[1]);
        if (tree && tree.has(key)) return reply(200, tree.get(key));
        const dir = [...(tree || new Map()).keys()].filter((k) => k.startsWith(`${key}/`));
        if (dir.length) return reply(200, dir.map((k) => ({ name: k.slice(key.length + 1), type: "file", path: k })));
        return reply(404, { message: "Not Found" });
      }
      if (method === "POST" && (m = p.match(/^\/actions\/workflows\/([^/]+)\/dispatches$/))) {
        gh.dispatches.push({ workflow: m[1], ...body });
        return reply(204, null);
      }
      if (method === "GET" && /^\/actions\/workflows\/[^/]+\/runs$/.test(p)) return reply(200, { workflow_runs: gh.runs });
      return reply(500, { message: `unhandled ${method} ${p}` });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  gh.port = server.address().port;
  gh.url = `http://127.0.0.1:${gh.port}`;
  gh.close = () => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  return gh;
}
