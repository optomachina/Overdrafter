/** Authoritative file acquisition; callers' supplied lists are never evidence. */
import { execFileSync } from "node:child_process";
import { DEFAULT_OWNER, DEFAULT_REPO, isValidSha, runGh } from "./lib/jev-screen-marker.mjs";

export const FILES_INCOMPLETE = "files-incomplete";
// GitHub REST diff-entry status values. Unknown values cannot prove path completeness.
const FILE_STATUSES = new Set(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]);
const validPath = (path) => typeof path === "string" && path.trim() !== "" && !path.includes("\0");

function prSnapshot(pr, run, endpoint) {
  const data = JSON.parse(run(["api", `${endpoint}/pulls/${pr}`]));
  if (!isValidSha(data?.head?.sha) || !isValidSha(data?.base?.sha) || !Number.isSafeInteger(data.changed_files) || data.changed_files < 1 || data.changed_files >= 3000) {
    throw new Error(FILES_INCOMPLETE);
  }
  return { head: data.head.sha.toLowerCase(), base: data.base.sha.toLowerCase(), count: data.changed_files };
}

/** Validate rename metadata and retain both affected paths. */
function affectedPaths(entry) {
  if (!validPath(entry?.filename) || !FILE_STATUSES.has(entry.status)) throw new Error(FILES_INCOMPLETE);
  if (entry.status === "renamed" || entry.status === "copied") {
    if (!validPath(entry.previous_filename) || entry.previous_filename === entry.filename) throw new Error(FILES_INCOMPLETE);
    return [entry.filename, entry.previous_filename];
  }
  if (entry.previous_filename !== undefined) throw new Error(FILES_INCOMPLETE);
  return [entry.filename];
}

/** Read every record, counting records separately from expanded affected paths. */
function filePages(pr, before, run, endpoint) {
  const records = [];
  const paths = [];
  for (let page = 1; page <= 30; page += 1) {
    const batch = JSON.parse(run(["api", `${endpoint}/pulls/${pr}/files?per_page=100&page=${page}`]));
    if (!Array.isArray(batch) || batch.length > 100) throw new Error(FILES_INCOMPLETE);
    paths.push(...batch.flatMap(affectedPaths));
    records.push(...batch.map((entry) => entry.filename));
    if (records.length >= 3000 || records.length > before.count || new Set(records).size !== records.length) throw new Error(FILES_INCOMPLETE);
    if (batch.length < 100) break;
  }
  if (records.length !== before.count) throw new Error(FILES_INCOMPLETE);
  return [...new Set(paths)];
}

/** Acquire complete affected paths with an identity check reusable after screening. */
export function verifiedPrFiles(pr, sha, { run = runGh, owner = DEFAULT_OWNER, repo = DEFAULT_REPO } = {}) {
  if (!Number.isInteger(pr) || pr <= 0 || !isValidSha(sha)) throw new Error(FILES_INCOMPLETE);
  const endpoint = `repos/${owner}/${repo}`;
  const snapshot = Object.freeze(prSnapshot(pr, run, endpoint));
  if (snapshot.head !== sha.toLowerCase()) throw new Error(FILES_INCOMPLETE);
  const paths = filePages(pr, snapshot, run, endpoint);
  const revalidate = () => {
    if (JSON.stringify(snapshot) !== JSON.stringify(prSnapshot(pr, run, endpoint))) throw new Error(FILES_INCOMPLETE);
  };
  revalidate();
  return { paths, snapshot, revalidate };
}

/** Resolve an explicit base and derive raw NUL-delimited paths from the local diff. */
export function localDiffFiles(root, baseRef) {
  if (typeof baseRef !== "string" || !baseRef || baseRef.startsWith("-")) throw new Error(FILES_INCOMPLETE);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  const base = git("rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`).trim();
  if (!isValidSha(base)) throw new Error(FILES_INCOMPLETE);
  const output = git("diff", "--no-renames", "--name-only", "-z", `${base}...HEAD`, "--");
  const paths = output.endsWith("\0") ? output.slice(0, -1).split("\0") : [];
  if (!paths.length || paths.some((path) => !validPath(path))) throw new Error(FILES_INCOMPLETE);
  return paths;
}
