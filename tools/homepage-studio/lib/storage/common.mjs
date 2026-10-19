// Shared by every storage adapter.
import { assertValidProject, assertAppendOnly, assertValidJob } from "../schema.mjs";
import { isAllowedStoragePath } from "../paths.mjs";

export class StorageError extends Error {
  // code: not_initialized | bad_credentials | forbidden | rate_limited | not_found | conflict | conflict_exhausted | repo_not_ready | invalid | upstream
  constructor(code, message, status = 502, extra = {}) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

/**
 * Run one update against a freshly read project. `fn(draft)` may mutate the
 * draft and returns {result, files:[{path,content}], jobs:[job]}.
 * Returns {project, changed, files, jobs, result} or throws.
 */
export async function planUpdate(current, fn) {
  const draft = structuredClone(current);
  const out = (await fn(draft)) || {};
  assertValidProject(draft);
  assertAppendOnly(current, draft);
  const files = (out.files || []).map((f) => {
    if (!isAllowedStoragePath(f.path)) throw new StorageError("invalid", `Path not allowed: ${f.path}`, 400);
    if (f.path === "project.json") throw new StorageError("invalid", "project.json is written by the storage layer only.", 400);
    return { path: f.path, content: typeof f.content === "string" ? Buffer.from(f.content) : f.content };
  });
  const jobs = (out.jobs || []).map((j) => assertValidJob(j));
  const changed = JSON.stringify(draft) !== JSON.stringify(current);
  return { project: draft, changed, files, jobs, result: out.result };
}

export function jobFile(job) {
  return { path: `jobs/${job.id}.json`, content: Buffer.from(JSON.stringify(job, null, 2) + "\n") };
}

export function serializeProject(project) {
  return Buffer.from(JSON.stringify(project, null, 2) + "\n");
}

export function newestFirst(names) {
  return [...names].sort().reverse();
}
