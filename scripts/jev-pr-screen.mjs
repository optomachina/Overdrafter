/**
 * Jev PR risk screen (advisory). Sizes review: low stops after an independent
 * QA or Sonnet review, normal gets a Sonnet review, risky gets an Opus review. Jev can only raise the tier set by
 * the deterministic sensitive-path match (OVD-873: any file matching docs/sensitive-paths.json through
 * scripts/lib/sensitive-paths.mjs raises the declared tier to "risky"); a failed or low-confidence Jev call
 * raises the tier to at least "normal", and an unknown deterministic tier counts
 * as "risky". Every decision is appended to the JSONL
 * log with Jev's confidence and incident probability so rule changes can be
 * replayed over past decisions.
 *
 * The sensitive-path list comes from --base-ref (the PR's base, for example
 * origin/main) so a PR that narrows docs/sensitive-paths.json cannot lower its
 * own tier; without it the working tree's copy is used. When the list cannot be
 * loaded (a base ref that does not resolve, "" included, or a missing or
 * invalid list) every PR screens "risky" (fail closed).
 *
 * files must be a non-empty list of raw repository paths, as strings or as
 * gh's {path} objects (`gh pr view --json files`). A missing, empty or
 * malformed list screens "risky" and the record names the problem
 * (filesProblem), because an empty list is what a failed fetch looks like.
 *
 * Usage: NODE_USE_ENV_PROXY=1 node scripts/jev-pr-screen.mjs [--base-ref <ref>] <input.json> [log.jsonl]
 * input.json: [{ pr, sha, title, files: [path | {path}, ...], additions?, deletions?, deterministic: "low"|"normal"|"risky", notes? }]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { askJev, gatedChoice, sanitizeToken, JEV_MODEL } from "./jev-client.mjs";
import { SENSITIVE_PATHS_FILE, classifyPaths, loadSensitivePaths, parseSensitivePaths } from "./lib/sensitive-paths.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORK_DIR = `${homedir()}/work/claude-jobs`;
export const DEFAULT_LOG = `${WORK_DIR}/jev-decisions.jsonl`;
export const DEFAULT_CACHE = `${WORK_DIR}/jev-screen-cache.json`;
export const TIERS = ["low", "normal", "risky"];
export const DEFAULT_MIN_CONFIDENCE = 0.5;
const MAX_CONCURRENT_CALLS = 4;

const isProbability = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const floorOf = (value) => (isProbability(value) ? value : DEFAULT_MIN_CONFIDENCE);

/**
 * Cache key for dedupe: (pr, sha, model). Returns null for invalid inputs.
 */
export function cacheKey(pr, sha, model) {
  const prNum = Number.isInteger(pr) ? pr : null;
  const shaTok = sanitizeToken(sha);
  const modelTok = sanitizeToken(model);
  if (prNum === null || !shaTok || !modelTok) return null;
  return `${prNum}:${shaTok}:${modelTok}`;
}

/**
 * Load the cache file (a JSON object mapping cache keys to cached results).
 * Returns {} if the file does not exist or is invalid.
 */
export function loadCache(cachePath) {
  try {
    if (!existsSync(cachePath)) return {};
    const content = readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Save the cache to disk.
 */
export function saveCache(cache, cachePath) {
  try {
    const dir = dirname(cachePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf8");
  } catch {
    // Fail open: if we can't save the cache, just continue
  }
}

export const SCREEN_QUESTIONS = {
  tier: {
    type: "choice",
    instructions:
      "Classify the review risk of this pull request for a quoting SaaS (Supabase, worker that automates provider quote sites). Consider blast radius, security, data, money, provider dispatch, CI and deploy.",
    criteria: {
      low: "Docs, tests, UI polish, or isolated tooling with no runtime, security, data or money effect.",
      normal: "Runtime code with bounded blast radius and good tests; no auth, RLS, migrations, secrets, money, deploy or provider dispatch semantics.",
      risky: "Touches auth, RLS, SQL, migrations, secrets, billing, deploy, CI gates, provider dispatch, or guardrails other agents rely on.",
    },
  },
  incident: {
    type: "noul",
    instructions:
      "Probability that merging this PR as is causes a production incident, security exposure, or a silently weakened safety gate.",
  },
};

/** The higher of two known tiers. */
export function maxTier(a, b) {
  return TIERS.indexOf(b) > TIERS.indexOf(a) ? b : a;
}

/**
 * Combine the deterministic tier with a gated Jev answer. Jev may only raise risk.
 * An unknown deterministic tier (a typo such as "Risky") counts as "risky", and an
 * unknown or unaccepted Jev tier counts as "normal", so no typo lowers review.
 */
export function finalTier(deterministic, gate) {
  const base = TIERS.includes(deterministic) ? deterministic : "risky";
  const jevTier = gate?.status === "accepted" && TIERS.includes(gate.choice) ? gate.choice : "normal";
  return maxTier(base, jevTier);
}

/** Stands in for a sensitive-path list that could not be loaded: every PR then screens risky. */
export const SENSITIVE_PATHS_UNAVAILABLE = Object.freeze({ unavailable: true });

/**
 * The list PRs are screened against: docs/sensitive-paths.json at baseRef (the
 * PR's base), or in the working tree when baseRef is null or undefined. A ref
 * that does not resolve ("" included), or a missing or invalid file, gives
 * SENSITIVE_PATHS_UNAVAILABLE (fail closed); there is no working-tree fallback.
 */
export function loadScreenSensitivePaths({ root = REPO_ROOT, baseRef = null } = {}) {
  try {
    return loadSensitivePaths({ root, ref: baseRef });
  } catch {
    return SENSITIVE_PATHS_UNAVAILABLE;
  }
}

/**
 * The list to screen against: a valid loaded list as given, or
 * SENSITIVE_PATHS_UNAVAILABLE for anything else (false, 0, "", NaN, a string,
 * an array, an invalid object, SENSITIVE_PATHS_UNAVAILABLE itself), so no
 * value turns the path check off (fail closed).
 */
function usableSensitivePaths(value) {
  if (value === null || typeof value !== "object" || value.unavailable === true) return SENSITIVE_PATHS_UNAVAILABLE;
  try {
    parseSensitivePaths(value);
    return value;
  } catch {
    return SENSITIVE_PATHS_UNAVAILABLE;
  }
}

export const FILES_MISSING = "files_missing";
export const FILES_NOT_ARRAY = "files_not_array";
export const FILES_EMPTY = "files_empty";
export const FILES_ENTRY_INVALID = "files_entry_invalid";

/**
 * The paths in a PR's files: strings, or gh's {path} objects. Returns
 * {paths, problem: null}, or {paths: null, problem} for a missing, non-array,
 * empty or malformed list (an entry that is not a non-blank string or {path}).
 */
export function prFilePaths(files) {
  if (files === undefined || files === null) return { paths: null, problem: FILES_MISSING };
  if (!Array.isArray(files)) return { paths: null, problem: FILES_NOT_ARRAY };
  if (files.length === 0) return { paths: null, problem: FILES_EMPTY };
  const paths = files.map(entryPath);
  if (paths.some((value) => typeof value !== "string" || value.trim() === "")) return { paths: null, problem: FILES_ENTRY_INVALID };
  return { paths, problem: null };
}

/** A files entry's path: the string itself, or a {path} object's path (undefined otherwise). */
function entryPath(entry) {
  if (typeof entry === "string") return entry;
  const isRecord = entry !== null && typeof entry === "object" && !Array.isArray(entry);
  return isRecord ? entry.path : undefined;
}

/**
 * Deterministic tier: the declared tier (unknown counts as risky), raised to
 * risky when any file is on the shared sensitive-path list, when no valid
 * list is given (none, a falsy value, or SENSITIVE_PATHS_UNAVAILABLE), or when
 * files is missing, empty or malformed (filesProblem). Never lowers. The path
 * check is skipped only with the explicit { skipSensitivePaths: true }, for
 * tier-logic tests; no list value turns it off.
 */
export function deterministicTier(pr, sensitivePaths, { skipSensitivePaths = false } = {}) {
  const declared = TIERS.includes(pr.deterministic) ? pr.deterministic : "risky";
  if (skipSensitivePaths === true) return { tier: declared, sensitiveClasses: null, filesProblem: null };
  const list = usableSensitivePaths(sensitivePaths);
  const { paths, problem } = prFilePaths(pr.files);
  if (list === SENSITIVE_PATHS_UNAVAILABLE || problem) return { tier: "risky", sensitiveClasses: null, filesProblem: problem };
  const { sensitive, classes } = classifyPaths(paths, list);
  return { tier: sensitive ? "risky" : declared, sensitiveClasses: classes, filesProblem: null };
}

/**
 * One logged decision. sensitivePaths must be a loaded list; anything else
 * screens risky with sensitivePathsUnavailable. skipSensitivePaths: true
 * skips the path check (tier-logic tests only).
 */
export function decisionRecord(pr, result, now = new Date(), { minConfidence = DEFAULT_MIN_CONFIDENCE, sensitivePaths, skipSensitivePaths = false, cacheHit = false, caller = null } = {}) {
  const gate = gatedChoice(result, "tier", floorOf(minConfidence));
  const skip = skipSensitivePaths === true;
  const list = skip ? null : usableSensitivePaths(sensitivePaths);
  const { tier: deterministic, sensitiveClasses, filesProblem } = deterministicTier(pr, list, { skipSensitivePaths: skip });
  const incident = result?.ok ? result.answers?.incident?.noul : undefined;
  return {
    ts: now.toISOString(),
    kind: "pr_risk_screen",
    pr: Number.isInteger(pr.pr) ? pr.pr : null,
    sha: sanitizeToken(pr.sha),
    model: result?.ok ? sanitizeToken(result.model) : null,
    ok: result?.ok === true,
    reason: result?.ok ? null : (sanitizeToken(result?.reason) ?? "no_result"),
    jev: {
      tier: TIERS.includes(gate.choice) ? gate.choice : null,
      confidence: isProbability(gate.confidence) ? gate.confidence : null,
      status: gate.status,
      pIncident: isProbability(incident) ? incident : null,
    },
    deterministic,
    sensitiveClasses,
    sensitivePathsUnavailable: list === SENSITIVE_PATHS_UNAVAILABLE,
    filesProblem,
    final: finalTier(deterministic, gate),
    latencyMs: Number.isFinite(result?.latencyMs) ? result.latencyMs : null,
    cacheHit,
    caller: caller ? sanitizeToken(caller) : null,
  };
}

/** Recompute final tiers from logged decisions under a different confidence floor (rule replay). */
export function replay(records, { minConfidence = DEFAULT_MIN_CONFIDENCE } = {}) {
  const floor = floorOf(minConfidence);
  return records.map((record) => {
    const { tier, confidence } = record.jev ?? {};
    const accepted = record.ok === true && isProbability(confidence) && confidence >= floor;
    const final = finalTier(record.deterministic, accepted ? { status: "accepted", choice: tier } : { status: "uncertain" });
    return { pr: record.pr, sha: record.sha, before: record.final, after: final, changed: final !== record.final };
  });
}

export async function screen(
  prs,
  { ask = askJev, log = DEFAULT_LOG, append = appendFileSync, minConfidence = DEFAULT_MIN_CONFIDENCE, root = REPO_ROOT, baseRef = null, sensitivePaths: given = null, cachePath = DEFAULT_CACHE, caller = null } = {},
) {
  // Always screened against a list: only null or undefined loads it, and any
  // other value that is not a valid list (false, 0, "", NaN ...) screens every
  // PR risky. screen() has no opt-out.
  const sensitivePaths = given === null || given === undefined ? loadScreenSensitivePaths({ root, baseRef }) : usableSensitivePaths(given);
  
  // Load cache for dedupe
  const cache = loadCache(cachePath);
  let cacheChanged = false;
  
  const results = [];
  const cacheHits = [];
  
  // Check cache for each PR and only call Jev for cache misses
  for (let start = 0; start < prs.length; start += MAX_CONCURRENT_CALLS) {
    const chunkPrs = prs.slice(start, start + MAX_CONCURRENT_CALLS);
    const chunkTasks = chunkPrs.map(async (pr) => {
      // Build cache key with expected model version
      const key = cacheKey(pr.pr, pr.sha, JEV_MODEL);
      
      // Check cache first
      if (key && cache[key]) {
        // Cache hit: return cached result
        return { result: cache[key], hit: true };
      }
      
      // Cache miss: call Jev
      const state = { title: pr.title, files: pr.files, additions: pr.additions ?? null, deletions: pr.deletions ?? null, notes: pr.notes ?? "" };
      const result = await ask(state, SCREEN_QUESTIONS, { timeoutMs: 20_000 });
      
      // Save successful result to cache
      if (result?.ok && key) {
        cache[key] = result;
        cacheChanged = true;
      }
      
      return { result, hit: false };
    });
    
    const chunkResults = await Promise.all(chunkTasks);
    results.push(...chunkResults.map(r => r.result));
    cacheHits.push(...chunkResults.map(r => r.hit));
  }
  
  // Save updated cache if changed
  if (cacheChanged) {
    saveCache(cache, cachePath);
  }
  
  // Ensure log directory exists
  const logDir = dirname(log);
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
  
  // Append in input order so the log reads like the batch.
  const records = prs.map((pr, index) => 
    decisionRecord(pr, results[index], new Date(), { 
      minConfidence, 
      sensitivePaths, 
      cacheHit: cacheHits[index],
      caller 
    })
  );
  for (const record of records) append(log, `${JSON.stringify(record)}\n`);
  return records;
}

const USAGE = "usage: jev-pr-screen.mjs [--base-ref <ref>] <input.json> [log.jsonl]";

/** CLI arguments: [--base-ref <ref>] <input.json> [log.jsonl]. Throws with the usage line. */
export function parseScreenArgs(argv) {
  const positional = [];
  let baseRef = null;
  for (let k = 0; k < argv.length; k += 1) {
    if (argv[k] === "--base-ref") {
      baseRef = argv[k + 1] ?? "";
      if (baseRef === "" || baseRef.startsWith("-")) throw new Error(`--base-ref needs a ref; ${USAGE}`);
      k += 1;
    } else if (argv[k].startsWith("--")) {
      throw new Error(`unknown option ${argv[k]}; ${USAGE}`);
    } else {
      positional.push(argv[k]);
    }
  }
  if (positional.length < 1 || positional.length > 2) throw new Error(USAGE);
  return { input: positional[0], log: positional[1] ?? DEFAULT_LOG, baseRef };
}

/**
 * True when node was asked to run this file. Realpaths are compared because
 * node runs a script given through a symlinked path (macOS /tmp, for example)
 * from its real path, so comparing the given path skipped the CLI silently.
 */
function invokedAsScript(argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  let args;
  try {
    args = parseScreenArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`jev-pr-screen: ${error.message}`);
    process.exit(2);
  }
  const { input, log, baseRef } = args;
  const sensitivePaths = loadScreenSensitivePaths({ baseRef });
  if (sensitivePaths === SENSITIVE_PATHS_UNAVAILABLE) {
    console.error(`jev-pr-screen: ${SENSITIVE_PATHS_FILE} could not be loaded${baseRef == null ? "" : ` at ${baseRef}`}; every PR screens risky (fail closed)`);
  } else if (!baseRef) {
    console.error(`jev-pr-screen: no --base-ref, so the working tree's ${SENSITIVE_PATHS_FILE} is used; pass the PR base (for example --base-ref origin/main) so a PR cannot narrow its own list`);
  }
  const records = await screen(JSON.parse(readFileSync(input, "utf8")), { log, sensitivePaths });
  for (const r of records) {
    const failure = r.ok ? "" : ` (jev failed: ${r.reason})`;
    const files = r.filesProblem ? ` (${r.filesProblem}, screened risky)` : "";
    console.log(`#${r.pr} det=${r.deterministic} jev=${r.jev.tier}@${r.jev.confidence} p_incident=${r.jev.pIncident} -> ${r.final}${failure}${files}`);
  }
}
