// GitHub data-repo storage. Uses only the REST API through an injected fetch.
// Every append is ONE commit (git-data API: blobs -> tree -> commit -> fast-forward
// ref update, never forced). On 409/422 the update is re-planned against the latest
// head and retried (max 3 retries). Nothing is ever deleted.
import { StorageError, planUpdate, jobFile, serializeProject, newestFirst } from "./common.mjs";
import { isAllowedStoragePath, assertId } from "../paths.mjs";

const API = "https://api.github.com";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * GitHub API base URL. Always https://api.github.com unless BOTH STUDIO_ALLOW_TEST_API_BASE=1 and
 * STUDIO_GITHUB_API_BASE is a plain http URL on a loopback host (used only by the e2e suite). Anything else is ignored,
 * so this can never send a real token to another host.
 */
export function resolveApiBase(env = process.env) {
  if (env.STUDIO_ALLOW_TEST_API_BASE !== "1" || !env.STUDIO_GITHUB_API_BASE) return API;
  try {
    const u = new URL(env.STUDIO_GITHUB_API_BASE);
    if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname) && !u.username && !u.password) return u.origin;
  } catch {
    /* not a URL: ignored */
  }
  return API;
}

export function createGithubStorage({ repo, branch = "main", token, fetchImpl = globalThis.fetch, maxRetries = 3, workflowFile = "studio-generate.yml", apiBase = API }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "")) throw new StorageError("invalid", "STUDIO_DATA_REPO must look like owner/name.", 500);
  if (!token) throw new StorageError("bad_credentials", "GITHUB_TOKEN is not set.", 503);
  let queue = Promise.resolve();

  async function gh(method, urlPath, { body, raw = false, okStatuses = [] } = {}) {
    const res = await fetchImpl(`${apiBase}/repos/${repo}${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "homepage-studio",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok || okStatuses.includes(res.status)) return res;
    throw await mapError(res, urlPath);
  }

  async function mapError(res, urlPath) {
    let msg = "";
    try {
      msg = (await res.clone().json()).message || "";
    } catch {
      /* not json */
    }
    const remaining = res.headers.get?.("x-ratelimit-remaining");
    const reset = res.headers.get?.("x-ratelimit-reset");
    if (res.status === 401) return new StorageError("bad_credentials", "GitHub rejected GITHUB_TOKEN (401). It is wrong, expired or revoked.", 502);
    if (res.status === 429 || (res.status === 403 && (remaining === "0" || /rate limit/i.test(msg)))) {
      const when = reset ? ` Resets at ${new Date(Number(reset) * 1000).toISOString()}.` : "";
      return new StorageError("rate_limited", `GitHub rate limit reached.${when}`, 429, { resetAt: reset ? Number(reset) : null });
    }
    if (res.status === 403) return new StorageError("forbidden", "GITHUB_TOKEN lacks permission for the data repo (needs Contents: read and write, and Actions: write for generation).", 502);
    if (res.status === 404) return new StorageError("not_found", `Data repo, branch or file not found, or the token cannot see ${repo}.`, 502, { path: urlPath });
    if (res.status === 409 || res.status === 422) return new StorageError("conflict", `GitHub reported a conflict (${res.status}): ${msg}`, 409, { upstreamStatus: res.status, upstreamMessage: msg });
    return new StorageError("upstream", `GitHub returned ${res.status}: ${msg}`, 502);
  }

  async function head() {
    try {
      const ref = await (await gh("GET", `/git/ref/heads/${branch}`)).json();
      return ref.object.sha;
    } catch (e) {
      if (e.code === "conflict") throw new StorageError("repo_not_ready", "The data repo is empty. Create it with a README so the branch exists.", 503);
      throw e;
    }
  }

  async function readRaw(rel, ref) {
    const res = await gh("GET", `/contents/${rel}?ref=${encodeURIComponent(ref)}`, { raw: true, okStatuses: [404] });
    if (res.status === 404) return null;
    return Buffer.from(await res.arrayBuffer());
  }

  async function readProject() {
    const b = await readRaw("project.json", branch);
    return b ? JSON.parse(b.toString("utf8")) : null;
  }

  async function commitFiles(parentSha, message, files) {
    const parent = await (await gh("GET", `/git/commits/${parentSha}`)).json();
    const tree = [];
    for (const f of files) {
      const blob = await (await gh("POST", "/git/blobs", { body: { content: f.content.toString("base64"), encoding: "base64" } })).json();
      tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const newTree = await (await gh("POST", "/git/trees", { body: { base_tree: parent.tree.sha, tree } })).json();
    const commit = await (await gh("POST", "/git/commits", { body: { message, tree: newTree.sha, parents: [parentSha] } })).json();
    await gh("PATCH", `/git/refs/heads/${branch}`, { body: { sha: commit.sha, force: false } });
    return commit.sha;
  }

  function update(label, fn) {
    const run = async () => {
      let attempt = 0;
      for (;;) {
        const headSha = await head();
        const raw = await readRaw("project.json", headSha);
        if (!raw) throw new StorageError("not_initialized", "The data repo has no project.json yet. Copy data/ into it (see HOSTING.md).", 503);
        const cur = JSON.parse(raw.toString("utf8"));
        const plan = await planUpdate(cur, fn);
        const files = [...plan.files, ...plan.jobs.map(jobFile)];
        if (plan.changed) files.push({ path: "project.json", content: serializeProject(plan.project) });
        if (files.length === 0) return plan.result;
        try {
          await commitFiles(headSha, `studio: ${label}`, files);
          return plan.result;
        } catch (e) {
          if (e.code === "conflict" && attempt < maxRetries) {
            attempt++;
            continue;
          }
          if (e.code === "conflict") throw new StorageError("conflict_exhausted", `Could not save after ${maxRetries} retries: the data repo kept changing. Try again.`, 409);
          throw e;
        }
      }
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  async function initProject(project) {
    // Creates project.json only when absent (single commit).
    const headSha = await head();
    if (await readRaw("project.json", headSha)) return false;
    await commitFiles(headSha, "studio: seed project", [{ path: "project.json", content: serializeProject(project) }]);
    return true;
  }

  return {
    kind: "github",
    ephemeral: false,
    cheapWrites: false,
    repo,
    branch,
    readProject,
    update,
    initProject,
    async readAsset(rel) {
      if (!isAllowedStoragePath(rel)) throw new StorageError("invalid", "Path not allowed.", 400);
      return readRaw(rel, branch);
    },
    async readJob(id) {
      assertId(id, "job id");
      const b = await readRaw(`jobs/${id}.json`, branch);
      return b ? JSON.parse(b.toString("utf8")) : null;
    },
    writeJob(job, label = "job") {
      return update(label, () => ({ jobs: [job] }));
    },
    async listJobs(limit = 10) {
      const res = await gh("GET", `/contents/jobs?ref=${encodeURIComponent(branch)}`, { okStatuses: [404] });
      if (res.status === 404) return [];
      const names = newestFirst((await res.json()).filter((e) => e.type === "file" && /^[a-z0-9-]+\.json$/.test(e.name)).map((e) => e.name)).slice(0, limit);
      const out = [];
      for (const n of names) out.push(JSON.parse((await readRaw(`jobs/${n}`, branch)).toString("utf8")));
      return out;
    },
    async listVersions(kind, id) {
      const p = await readProject();
      const ent = p && (kind === "field" ? p.fields[id] : p.assets[id]);
      return ent ? ent.versions : [];
    },
    // Hosted generation: trigger the worker workflow in the data repo.
    async dispatch(inputs) {
      await gh("POST", `/actions/workflows/${workflowFile}/dispatches`, { body: { ref: branch, inputs } });
    },
    async findRun(jobId) {
      const res = await gh("GET", `/actions/workflows/${workflowFile}/runs?event=workflow_dispatch&per_page=20`);
      const runs = (await res.json()).workflow_runs || [];
      const run = runs.find((r) => String(r.display_title || r.name || "").includes(jobId));
      return run ? { id: run.id, status: run.status, conclusion: run.conclusion, url: run.html_url } : null;
    },
  };
}
