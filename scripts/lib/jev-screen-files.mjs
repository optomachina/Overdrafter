/** Authoritative file acquisition; callers' supplied lists are never evidence. */
import { execFileSync } from "node:child_process";
import { DEFAULT_OWNER, DEFAULT_REPO, isValidSha, runGh } from "./jev-screen-marker.mjs";

export const FILES_INCOMPLETE = "files-incomplete";
const validPath = (path) => typeof path === "string" && path.trim() !== "" && !path.includes("\0");

function prSnapshot(pr, run, endpoint) {
  const data = JSON.parse(run(["api", `${endpoint}/pulls/${pr}`]));
  if (!isValidSha(data?.head?.sha) || !isValidSha(data?.base?.sha) || !Number.isSafeInteger(data.changed_files) || data.changed_files < 1 || data.changed_files >= 3000) {
    throw new Error(FILES_INCOMPLETE);
  }
  return { head: data.head.sha.toLowerCase(), base: data.base.sha.toLowerCase(), count: data.changed_files };
}

/** Read every page and reconcile count and head/base snapshots. Throws closed. */
export function verifiedPrFiles(pr, sha, { run = runGh, owner = DEFAULT_OWNER, repo = DEFAULT_REPO } = {}) {
  if (!Number.isInteger(pr) || pr <= 0 || !isValidSha(sha)) throw new Error(FILES_INCOMPLETE);
  const endpoint = `repos/${owner}/${repo}`;
  const before = prSnapshot(pr, run, endpoint);
  if (before.head !== sha.toLowerCase()) throw new Error(FILES_INCOMPLETE);
  const paths = [];
  for (let page = 1; page <= 30; page += 1) {
    const batch = JSON.parse(run(["api", `${endpoint}/pulls/${pr}/files?per_page=100&page=${page}`]));
    if (!Array.isArray(batch) || batch.length > 100 || batch.some((entry) => !validPath(entry?.filename))) throw new Error(FILES_INCOMPLETE);
    paths.push(...batch.map((entry) => entry.filename));
    if (paths.length >= 3000 || paths.length > before.count || new Set(paths).size !== paths.length) throw new Error(FILES_INCOMPLETE);
    if (batch.length < 100) break;
  }
  const after = prSnapshot(pr, run, endpoint);
  if (paths.length !== before.count || JSON.stringify(before) !== JSON.stringify(after)) throw new Error(FILES_INCOMPLETE);
  return paths;
}

/** Resolve an explicit base and derive raw NUL-delimited paths from the local diff. */
export function localDiffFiles(root, baseRef) {
  if (typeof baseRef !== "string" || !baseRef || baseRef.startsWith("-")) throw new Error(FILES_INCOMPLETE);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  const base = git("rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`).trim();
  if (!isValidSha(base)) throw new Error(FILES_INCOMPLETE);
  const output = git("diff", "--name-only", "-z", `${base}...HEAD`, "--");
  const paths = output.endsWith("\0") ? output.slice(0, -1).split("\0") : [];
  if (!paths.length || paths.some((path) => !validPath(path))) throw new Error(FILES_INCOMPLETE);
  return paths;
}
