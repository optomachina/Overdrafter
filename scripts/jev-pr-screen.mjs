/**
 * Jev PR risk screen (advisory). Sizes review: low stops after an independent
 * QA or Sonnet review, normal gets a Sonnet review, risky gets an Opus review. Jev can only raise the tier set by
 * the deterministic sensitive-path match (OVD-873: any file matching docs/sensitive-paths.json through
 * scripts/lib/sensitive-paths.mjs raises the declared tier to "risky"). A failed or low-confidence Jev call
 * fails closed: the PR gets no verdict (final "no_verdict", no tier at all) and the CLI exits 3, so no
 * fallback tier is ever reported as a screen result. An unknown deterministic tier counts
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
 * Supplied files are ignored: PR files are paginated and verified against the
 * current head/base and changed_files count. Pre-PR paths come from a local
 * diff against an explicit resolved base; no PR cache is used. Acquisition
 * failures get no verdict (files-incomplete) before Jev or cache access.
 *
 * Dedupe: uses GitHub commit status markers (context "jev-screen") keyed by
 * (full 40-hex SHA, screener, question-set hash, model, screen state digest). The digest covers
 * the exact state sent to Jev (verified files in the order sent, title, notes, additions,
 * deletions) and the verified base commit, so a changed title, notes, size, base or file
 * order is a miss. A marker is used only
 * when pr is a real PR number and sha is that PR's current head SHA on GitHub.
 * Reading is fail-safe: re-screens on anything missing, mismatched or
 * untrusted. Only an accepted (confident) Jev answer is written, and writing
 * fails open: a write failure never fails the screen. A hit replays the stored
 * answer at its stored confidence, and the final tier is the highest of the
 * local deterministic tier, the replayed Jev tier and the marker's tier, so a
 * hit never lowers a tier.
 *
 * Usage: NODE_USE_ENV_PROXY=1 node scripts/jev-pr-screen.mjs [--base-ref <ref>] [--caller <id>] <input.json> [log.jsonl]
 * input.json: [{ pr, sha, title, files: [path | {path}, ...], additions?, deletions?, deterministic: "low"|"normal"|"risky", notes? }]
 */
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { askJev, fallbackSourceForReason, gatedChoice, jevFallbackLine, sanitizeToken, JEV_MODEL } from "./jev-client.mjs";
import { SENSITIVE_PATHS_FILE, classifyPaths, loadSensitivePaths, parseSensitivePaths } from "./lib/sensitive-paths.mjs";
import { GITHUB_MARKER_IO, hashScreenState, hashQuestions, isValidSha, SCREENER_ID } from "./lib/jev-screen-marker.mjs";

import { FILES_INCOMPLETE, verifiedPrFiles, localDiffFiles } from "./jev-pr-screen-files.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORK_DIR = `${homedir()}/work/claude-jobs`;
export const DEFAULT_LOG = `${WORK_DIR}/jev-decisions.jsonl`;
export const TIERS = ["low", "normal", "risky"];
/** Final value when Jev failed or was below the confidence floor: no tier is reported (fail closed). */
export const NO_VERDICT = "no_verdict";
export const DEFAULT_MIN_CONFIDENCE = 0.5;
const MAX_CONCURRENT_CALLS = 4;

const isProbability = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const floorOf = (value) => (isProbability(value) ? value : DEFAULT_MIN_CONFIDENCE);

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
 * unknown or unaccepted Jev tier (failed, uncertain or not a known tier) gives NO_VERDICT:
 * the screen fails closed instead of reporting a fallback tier.
 */
export function finalTier(deterministic, gate) {
  const base = TIERS.includes(deterministic) ? deterministic : "risky";
  if (gate?.status !== "accepted" || !TIERS.includes(gate.choice)) return NO_VERDICT;
  return maxTier(base, gate.choice);
}

/**
 * Loud-fallback source for a screen result (logging only; never changes tiers).
 *   Jev success (ok + accepted + known tier) → null (no fallback)
 *   ok:false with http_401/403 → default_jev_blocked
 *   ok:false otherwise → jev_blocked
 *   ok:true but uncertain gate → safe-default
 *   ok:true but failed/unknown tier → jev_used:false
 */
export function classifyFallback(result, gate) {
  const accepted = gate?.status === "accepted" && TIERS.includes(gate.choice);
  if (result?.ok === true && accepted) return { source: null, reason: null };
  // Reasons reach the JSONL row and stderr, so they are bounded to one sanitized token.
  const token = (value) => sanitizeToken(String(value));
  if (result?.ok !== true) {
    const reason = token(result?.reason ?? gate?.reason ?? "no_result");
    return { source: fallbackSourceForReason(reason), reason };
  }
  if (gate?.status === "uncertain") return { source: "safe-default", reason: "uncertain" };
  return { source: "jev_used:false", reason: token(gate?.reason ?? gate?.status ?? "no_accepted_tier") };
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
  if (pr.filesProblem === FILES_INCOMPLETE) return { tier: "risky", sensitiveClasses: null, filesProblem: FILES_INCOMPLETE };
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
export function decisionRecord(pr, result, now = new Date(), { minConfidence = DEFAULT_MIN_CONFIDENCE, sensitivePaths, skipSensitivePaths = false, markerHit = false, markerTier = null, caller = null } = {}) {
  const gate = gatedChoice(result, "tier", floorOf(minConfidence));
  const skip = skipSensitivePaths === true;
  const list = skip ? null : usableSensitivePaths(sensitivePaths);
  const { tier: deterministic, sensitiveClasses, filesProblem } = deterministicTier(pr, list, { skipSensitivePaths: skip });
  const incident = result?.ok ? result.answers?.incident?.noul : undefined;
  const marker = markerHit ? markerFloor(markerTier) : null;
  const final = finalTier(deterministic, gate);
  const sha = sanitizeToken(pr.sha);
  const latencyMs = loggedLatency(result, markerHit);
  const fallback = classifyFallback(result, gate);
  const warning = fallback.source ? jevFallbackLine(fallback.source, fallback.reason, latencyMs) : null;
  return {
    ts: now.toISOString(),
    kind: "pr_risk_screen",
    pr: Number.isInteger(pr.pr) && pr.pr > 0 ? pr.pr : null,
    head_sha: sha,
    sha, // alias of head_sha, kept for older readers
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
    final: marker && final !== NO_VERDICT ? maxTier(final, marker) : final,
    latency_ms: latencyMs,
    tokens: loggedTokens(result, markerHit),
    cache_hit: markerHit,
    marker_hit: markerHit, // alias of cache_hit, kept for older readers
    marker_tier: marker,
    caller: caller ? sanitizeToken(caller) : null,
    screener: SCREENER_ID,
    fallback_source: fallback.source,
    fallback_reason: fallback.reason,
    warning,
  };
}

/** A marker's final tier as a floor; an unknown tier counts as risky, so a bad marker never lowers review. */
function markerFloor(tier) {
  return TIERS.includes(tier) ? tier : "risky";
}

/** Jev's latency, or null on a marker hit (no call was made) or when it is not a number. */
function loggedLatency(result, markerHit) {
  if (markerHit) return null;
  return Number.isFinite(result?.latencyMs) ? result.latencyMs : null;
}

const isTokenCount = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * Token usage from the Jev response ({ input_tokens, output_tokens }, each a
 * count or null), or null on a marker hit (no call was made) or when the
 * response carries no usable count. Never estimated.
 */
function loggedTokens(result, markerHit) {
  if (markerHit || !result?.ok) return null;
  const usage = result.usage;
  if (usage === null || typeof usage !== "object") return null;
  const input = isTokenCount(usage.input_tokens) ? usage.input_tokens : null;
  const output = isTokenCount(usage.output_tokens) ? usage.output_tokens : null;
  return input === null && output === null ? null : { input_tokens: input, output_tokens: output };
}

/** A logged row's cache hit flag: cache_hit, or its older alias marker_hit. */
const rowCacheHit = (record) => (record.cache_hit ?? record.marker_hit) === true;

/** Recompute final tiers from logged decisions under a different confidence floor (rule replay). */
export function replay(records, { minConfidence = DEFAULT_MIN_CONFIDENCE } = {}) {
  const floor = floorOf(minConfidence);
  return records.map((record) => {
    const { tier, confidence } = record.jev ?? {};
    const accepted = record.ok === true && isProbability(confidence) && confidence >= floor;
    const recomputed = finalTier(record.deterministic, accepted ? { status: "accepted", choice: tier } : { status: "uncertain" });
    const final = rowCacheHit(record) && recomputed !== NO_VERDICT ? maxTier(recomputed, markerFloor(record.marker_tier)) : recomputed;
    return { pr: record.pr, sha: record.head_sha ?? record.sha, before: record.final, after: final, changed: final !== record.final };
  });
}

/** A log failure's error code (ENOSPC, EACCES ...) or sanitized one-token message; never the record. */
function logFailure(error) {
  if (typeof error?.code === "string" && error.code !== "") return sanitizeToken(error.code);
  return sanitizeToken(String(error?.message ?? error)) ?? "unknown";
}

/** What Jev sees for one PR. */
function screenState(pr) {
  return { title: pr.title, files: pr.files, additions: pr.additions ?? null, deletions: pr.deletions ?? null, notes: pr.notes ?? "" };
}

/**
 * fn over items with at most limit calls in flight, results in input order.
 * Each worker takes the next item when its last one settles.
 */
export async function mapBounded(items, limit, fn) {
  const results = [];
  let next = 0;
  const worker = async () => {
    if (next >= items.length) return;
    const index = next;
    next += 1;
    results[index] = await fn(items[index], index);
    await worker();
  };
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * The SHA a marker may be read or written under: pr.sha (lowercase) when pr.pr
 * is a real PR number and pr.sha is that PR's current head SHA, else null
 * (screen without a marker). A stale SHA with fresh files never touches a marker.
 */
async function markerSha(pr, io, warn) {
  if (!isValidSha(pr.sha) || !Number.isInteger(pr.pr) || pr.pr <= 0) return null;
  let head = null;
  try {
    head = await io.headSha(pr.pr);
  } catch {
    head = null;
  }
  const sha = pr.sha.toLowerCase();
  if (typeof head === "string" && head.toLowerCase() === sha) return sha;
  warn(`jev-pr-screen: #${pr.pr} sha ${sanitizeToken(pr.sha)} is not the PR head (${head === null ? "head unknown" : sanitizeToken(head)}); screening without a marker`);
  return null;
}

/** A hit replayed as the Jev answer that wrote it, at its stored confidence (never a synthetic 1.0). */
function resultFromMarker(hit) {
  const answers = { tier: { type: "choice", choice: hit.jevTier, confidence: hit.confidence } };
  if (hit.pIncident !== null && hit.pIncident !== undefined) answers.incident = { type: "noul", noul: hit.pIncident };
  return { ok: true, model: hit.model, answers, latencyMs: null };
}

async function readHit(sha, io, stateHash) {
  try {
    const hit = await io.read(sha, JEV_MODEL, hashQuestions(SCREEN_QUESTIONS), stateHash);
    return hit?.found === true ? hit : null;
  } catch {
    return null;
  }
}

/**
 * Write a marker only for an accepted (confident) Jev answer. Fails open with a
 * warning. stateHash is the digest screenOne computed once and used for the
 * lookup; it is passed in, never recomputed here.
 */
async function recordMarker(pr, sha, stateHash, result, { io, floor, sensitivePaths, warn }) {
  const gate = gatedChoice(result, "tier", floor);
  if (gate.status !== "accepted" || !TIERS.includes(gate.choice)) return;
  const incident = result.answers?.incident?.noul;
  const marker = {
    tier: finalTier(deterministicTier(pr, sensitivePaths).tier, gate),
    jevTier: gate.choice,
    confidence: gate.confidence,
    pIncident: isProbability(incident) ? incident : null,
    model: result.model,
    questionHash: hashQuestions(SCREEN_QUESTIONS),
    stateHash,
  };
  let written;
  try {
    written = await io.write(sha, marker);
  } catch (error) {
    written = { success: false, reason: String(error?.message ?? error) };
  }
  if (written?.success !== true) warn(`jev-pr-screen: marker write for #${pr.pr} failed (${sanitizeToken(written?.reason) ?? "unknown"}); the screen result stands`);
}

function incomplete(pr) {
  return { pr: { ...pr, files: null, filesProblem: FILES_INCOMPLETE }, result: { ok: false, reason: FILES_INCOMPLETE }, markerHit: false, markerTier: null };
}

/** The verified base commit SHA (lowercase) of an acquisition; anything else is incomplete. */
function verifiedBase(acquisition) {
  const base = acquisition?.snapshot?.base;
  if (!isValidSha(base)) throw new Error(FILES_INCOMPLETE);
  return base.toLowerCase();
}

/** Screen one PR: a valid marker hit skips Jev; otherwise ask Jev and write a marker. */
async function screenOne(pr, context) {
  let verified;
  let acquisition;
  let base = null;
  const hasPr = Number.isInteger(pr.pr) && pr.pr > 0;
  try {
    acquisition = hasPr ? await context.files(pr.pr, pr.sha) : null;
    const files = hasPr ? acquisition.paths : localDiffFiles(context.root, context.baseRef);
    base = hasPr ? verifiedBase(acquisition) : null;
    verified = { ...pr, files };
  } catch {
    return incomplete(pr);
  }
  const sha = hasPr ? await markerSha(verified, context.io, context.warn) : null;
  if (hasPr && !sha) return incomplete(verified);
  // The screening state is built once. Its digest keys both the lookup and the write.
  const state = screenState(verified);
  const stateHash = sha ? hashScreenState(state, base) : null;
  const hit = sha ? await readHit(sha, context.io, stateHash) : null;
  // screen() writes the one WARN per fallback from the decision record, so askJev's own stderr WARN is off here.
  const result = hit ? resultFromMarker(hit) : await context.ask(state, SCREEN_QUESTIONS, { timeoutMs: 20_000, warn: false });
  if (sha && await markerSha(verified, context.io, context.warn) !== sha) return incomplete(verified);
  try {
    if (hasPr) await acquisition.revalidate();
  } catch {
    return incomplete(verified);
  }
  if (!hit && sha && result?.ok) await recordMarker(verified, sha, stateHash, result, context);
  return { pr: verified, result, markerHit: !!hit, markerTier: hit?.tier ?? null };
}

/**
 * Screen prs and append one record per PR to log. marker is the marker I/O
 * ({ read, write, headSha }); files is the authoritative acquisition seam; it defaults to GitHub and tests pass a stub.
 */
export async function screen(
  prs,
  { ask = askJev, log = DEFAULT_LOG, append = appendFileSync, minConfidence = DEFAULT_MIN_CONFIDENCE, root = REPO_ROOT, baseRef = null, sensitivePaths: given = null, caller = null, marker = GITHUB_MARKER_IO, files = verifiedPrFiles, warn = (message) => console.error(message) } = {},
) {
  // Always screened against a list: only null or undefined loads it, and any
  // other value that is not a valid list (false, 0, "", NaN ...) screens every
  // PR risky. screen() has no opt-out.
  const sensitivePaths = given === null || given === undefined ? loadScreenSensitivePaths({ root, baseRef }) : usableSensitivePaths(given);
  const context = { files, root, baseRef, ask, io: marker, floor: floorOf(minConfidence), sensitivePaths, warn };

  // A few calls at a time; titles, paths and notes leave the box, so keep the batch bounded.
  const outcomes = await mapBounded(prs, MAX_CONCURRENT_CALLS, (pr) => screenOne(pr, context));

  // Ensure log directory exists (fail open, with a warning)
  try {
    mkdirSync(dirname(log), { recursive: true });
  } catch (error) {
    warn(`jev-pr-screen: decision log directory could not be created (${logFailure(error)}); the screen result stands`);
  }

  // Append in input order so the log reads like the batch.
  const records = prs.map((pr, index) =>
    decisionRecord(outcomes[index].pr, outcomes[index].result, new Date(), {
      minConfidence,
      sensitivePaths,
      markerHit: outcomes[index].markerHit,
      markerTier: outcomes[index].markerTier,
      caller,
    }),
  );

  // One WARN per fallback, including safe-default and jev_used:false, which askJev never sees.
  for (const record of records) {
    if (record.warning) warn(record.warning);
  }

  try {
    for (const record of records) {
      append(log, `${JSON.stringify(record)}\n`);
    }
  } catch (error) {
    // Fail open: the screen still completes; the warning names the failure, never the record.
    warn(`jev-pr-screen: decision log write failed (${logFailure(error)}); the screen result stands`);
  }

  return records;
}

const USAGE = "usage: jev-pr-screen.mjs [--base-ref <ref>] [--caller <id>] <input.json> [log.jsonl]";

/** CLI arguments: [--base-ref <ref>] [--caller <id>] <input.json> [log.jsonl]. Throws with the usage line. */
export function parseScreenArgs(argv) {
  const positional = [];
  let baseRef = null;
  let caller = null;
  for (let k = 0; k < argv.length; k += 1) {
    if (argv[k] === "--base-ref") {
      baseRef = argv[k + 1] ?? "";
      if (baseRef === "" || baseRef.startsWith("-")) throw new Error(`--base-ref needs a ref; ${USAGE}`);
      k += 1;
    } else if (argv[k] === "--caller") {
      caller = argv[k + 1] ?? "";
      if (caller === "" || caller.startsWith("-")) throw new Error(`--caller needs an id; ${USAGE}`);
      k += 1;
    } else if (argv[k].startsWith("--")) {
      throw new Error(`unknown option ${argv[k]}; ${USAGE}`);
    } else {
      positional.push(argv[k]);
    }
  }
  if (positional.length < 1 || positional.length > 2) throw new Error(USAGE);
  return { input: positional[0], log: positional[1] ?? DEFAULT_LOG, baseRef, caller };
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
  const { input, log, baseRef, caller } = args;
  const sensitivePaths = loadScreenSensitivePaths({ baseRef });
  if (sensitivePaths === SENSITIVE_PATHS_UNAVAILABLE) {
    console.error(`jev-pr-screen: ${SENSITIVE_PATHS_FILE} could not be loaded${baseRef == null ? "" : ` at ${baseRef}`}; every PR screens risky (fail closed)`);
  } else if (!baseRef) {
    console.error(`jev-pr-screen: no --base-ref, so the working tree's ${SENSITIVE_PATHS_FILE} is used; pass the PR base (for example --base-ref origin/main) so a PR cannot narrow its own list`);
  }
  const records = await screen(JSON.parse(readFileSync(input, "utf8")), { log, baseRef, sensitivePaths, caller });
  for (const r of records) {
    const failure = r.ok ? "" : ` (jev failed: ${r.reason})`;
    const files = r.filesProblem ? ` (${r.filesProblem})` : "";
    const marker = r.cache_hit ? " (cache hit)" : "";
    const fallback = r.warning ? ` | ${r.warning}` : "";
    const final = r.final === NO_VERDICT ? "no verdict" : r.final;
    console.log(`#${r.pr} det=${r.deterministic} jev=${r.jev.tier}@${r.jev.confidence} p_incident=${r.jev.pIncident} -> ${final}${failure}${files}${marker}${fallback}`);
  }
  // Fail closed: any PR without a Jev verdict makes the whole run nonzero.
  if (records.some((r) => r.final === NO_VERDICT)) process.exit(3);
}
