/**
 * Jev PR screen dedupe via GitHub commit status markers.
 *
 * Marker key: (full 40-hex SHA, screener_id, question_set_hash, model).
 * A marker is a commit status with context "jev-screen" and state "success";
 * the screen result lives in the description field. There is no pending claim:
 * two overlapping screens both call Jev, and both results are valid.
 *
 * Reading is fail-safe: re-screen on anything missing, malformed, mismatched or
 * from an untrusted author. Writing fails open: a write failure never fails the
 * screen.
 *
 * gh is resolved once to an absolute path from a fixed list of trusted
 * directories (never from PATH) and runs with a fixed minimal PATH.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";

export const MARKER_CONTEXT = "jev-screen";
export const MARKER_VERSION = "v1";
export const SCREENER_ID = "mjs";
export const ALLOWED_AUTHORS = Object.freeze(["optomachina"]);
export const DEFAULT_OWNER = "optomachina";
export const DEFAULT_REPO = "Overdrafter";
export const MARKER_TIERS = Object.freeze(["low", "normal", "risky"]);
/** Directories gh may be loaded from; PATH is never searched. */
export const TRUSTED_BIN_DIRS = Object.freeze(["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]);
/** The PATH gh runs with. */
export const FIXED_PATH = TRUSTED_BIN_DIRS.join(":");
/** GitHub's limit on a commit status description. */
export const MAX_DESCRIPTION_LENGTH = 140;

/** Statuses per page when listing a commit's statuses (GitHub's maximum). */
export const STATUS_PAGE_SIZE = 100;
/** Pages read before giving up; more than this is a miss, never a partial read. */
export const MAX_STATUS_PAGES = 50;

const GH_TIMEOUT_MS = 10_000;
const TOKEN = /^[A-Za-z0-9._-]+$/;
/** A question-set hash: 8 lowercase hex chars, as hashQuestions returns. */
const QUESTION_HASH = /^[0-9a-f]{8}$/;
/** A probability as the writer prints it: 0 to 1 with at most 3 decimals. */
const PROBABILITY_TEXT = /^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/;
/** One key=value field of a marker description. */
const FIELD = /^([a-z]+)=([A-Za-z0-9._-]+)$/;
/** The fields every marker carries, each exactly once and nothing else. */
const MARKER_KEYS = Object.freeze(["tier", "jev", "c", "p", "model", "q", "screener"]);

const isProbability = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const errorText = (error) => String(error?.message ?? error);
const miss = (reason, extra = {}) => ({ found: false, reason, ...extra });

/** Code-unit order, the same on every host and locale (the hash must match across hosts). */
export function compareCodeUnits(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * JSON with object keys sorted at every level, so equal values always give the
 * same text. undefined members are dropped, as JSON.stringify does.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const members = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort(compareCodeUnits)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Hash the whole question set (every nested field) to detect schema changes. */
export function hashQuestions(questions) {
  return createHash("sha256").update(canonicalJson(questions)).digest("hex").slice(0, 8);
}

/** Validate a commit SHA (must be 40 hex chars). */
export function isValidSha(sha) {
  return typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha);
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The absolute path of name in the first trusted directory that has it, or null. */
export function resolveTrustedExecutable(name, { dirs = TRUSTED_BIN_DIRS, canExecute = isExecutable } = {}) {
  if (!TOKEN.test(name)) return null;
  return dirs.map((dir) => join(dir, name)).find((path) => canExecute(path)) ?? null;
}

let ghPath;
function trustedGh() {
  if (ghPath === undefined) ghPath = resolveTrustedExecutable("gh");
  if (!ghPath) throw new Error(`gh not found in ${FIXED_PATH}`);
  return ghPath;
}

/** Run gh by its resolved absolute path with a fixed PATH. Throws on failure. */
export function runGh(args) {
  return execFileSync(trustedGh(), args, {
    encoding: "utf8",
    timeout: GH_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PATH: FIXED_PATH },
  });
}

/** Round down (confidence) or up (incident probability) to 3 places, so a replay is never more lenient. */
const floor3 = (value) => Math.floor(value * 1000) / 1000;
const ceil3 = (value) => Math.ceil(value * 1000) / 1000;

/**
 * Marker description:
 * "v1 tier=<final> jev=<jev tier> c=<confidence> p=<incident|na> model=<model> q=<hash> screener=<id>"
 */
export function buildMarkerDescription({ tier, jevTier, confidence, pIncident = null, model, questionHash }) {
  const p = isProbability(pIncident) ? ceil3(pIncident) : "na";
  return `${MARKER_VERSION} tier=${tier} jev=${jevTier} c=${floor3(confidence)} p=${p} model=${model} q=${questionHash} screener=${SCREENER_ID}`;
}

/**
 * The key=value fields of a description, or null when the version is wrong or
 * any token is malformed, unknown, repeated or missing. Strict on purpose: a
 * marker with an appended or repeated field is rejected whole, never merged.
 */
function descriptionFields(description) {
  if (description.length > MAX_DESCRIPTION_LENGTH) return null;
  const [version, ...parts] = description.trim().split(/\s+/);
  if (version !== MARKER_VERSION) return null;
  const fields = new Map();
  for (const part of parts) {
    const match = FIELD.exec(part);
    if (!match || !MARKER_KEYS.includes(match[1]) || fields.has(match[1])) return null;
    fields.set(match[1], match[2]);
  }
  return fields.size === MARKER_KEYS.length ? Object.fromEntries(fields) : null;
}

const probabilityText = (text) => (PROBABILITY_TEXT.test(text) ? Number(text) : null);

/**
 * Parse a marker description. Returns null unless the version matches, every
 * field appears exactly once with nothing extra, and the tiers, confidence,
 * incident probability, model, question hash and screener are all well formed.
 */
export function parseMarkerDescription(description) {
  if (!description || typeof description !== "string") return null;
  const fields = descriptionFields(description);
  if (!fields) return null;
  const confidence = probabilityText(fields.c);
  const pIncident = fields.p === "na" ? null : probabilityText(fields.p);
  const wellFormed =
    MARKER_TIERS.includes(fields.tier) &&
    MARKER_TIERS.includes(fields.jev) &&
    confidence !== null &&
    (fields.p === "na" || pIncident !== null) &&
    TOKEN.test(fields.model) &&
    QUESTION_HASH.test(fields.q) &&
    TOKEN.test(fields.screener);
  if (!wellFormed) return null;
  return { version: MARKER_VERSION, tier: fields.tier, jevTier: fields.jev, confidence, pIncident, model: fields.model, questionHash: fields.q, screener: fields.screener };
}

/**
 * Every status on sha (newest first), read page by page until a short page, as
 * parsed JSON. Throws on any gh or shape error, or past MAX_STATUS_PAGES, so a
 * truncated list is a miss and never a hit on a weaker marker.
 */
function fetchStatuses(sha, { owner = DEFAULT_OWNER, repo = DEFAULT_REPO, run = runGh } = {}) {
  const statuses = [];
  for (let page = 1; page <= MAX_STATUS_PAGES; page += 1) {
    const batch = JSON.parse(run(["api", `repos/${owner}/${repo}/commits/${sha}/statuses?per_page=${STATUS_PAGE_SIZE}&page=${page}`]));
    if (!Array.isArray(batch)) throw new Error("statuses response is not an array");
    if (batch.length > STATUS_PAGE_SIZE) throw new Error("statuses page is larger than requested");
    statuses.push(...batch);
    if (batch.length < STATUS_PAGE_SIZE) return statuses;
  }
  throw new Error(`more than ${MAX_STATUS_PAGES} pages of statuses`);
}

/** False when status names a commit other than sha (its url ends in /statuses/<sha>). */
function statusForSha(status, sha) {
  if (status.url === undefined) return true;
  return typeof status.url === "string" && status.url.toLowerCase().endsWith(`/statuses/${sha.toLowerCase()}`);
}

/** The parsed marker when status is a trusted success marker for this key, else null. */
function validMarker(status, { sha, model, questionHash, allowedAuthors }) {
  if (status?.context !== MARKER_CONTEXT || status.state !== "success") return null;
  if (!allowedAuthors.includes(status.creator?.login)) return null;
  if (!statusForSha(status, sha)) return null;
  const parsed = parseMarkerDescription(status.description);
  if (!parsed) return null;
  const matches = parsed.model === model && parsed.questionHash === questionHash && parsed.screener === SCREENER_ID;
  return matches ? parsed : null;
}

/**
 * The strongest marker: the highest final tier (raise-only when several agree
 * on the key), then the newest. markers is newest first, as GitHub lists them,
 * so on a tie the earlier one wins.
 */
function strongestMarker(markers) {
  const rank = (marker) => MARKER_TIERS.indexOf(marker.tier);
  return markers.slice(1).reduce((best, current) => (rank(current) > rank(best) ? current : best), markers[0]);
}

/**
 * Read the marker for sha. Returns { found: true, tier, jevTier, confidence,
 * pIncident, model, questionHash, screener } on a valid hit, or
 * { found: false, reason } on a miss. Fail-safe: any error is a miss.
 * options: { owner, repo, allowedAuthors, run } (run is the gh seam for tests).
 */
export async function readMarker(sha, model, questionHash, options = {}) {
  const { allowedAuthors = ALLOWED_AUTHORS, ...ghOptions } = options;
  if (!isValidSha(sha)) return miss("invalid_sha");
  let statuses;
  try {
    statuses = fetchStatuses(sha, ghOptions);
  } catch (error) {
    return miss("api_error", { error: errorText(error) });
  }
  if (!statuses.some((status) => status?.context === MARKER_CONTEXT)) return miss("no_marker");
  const valid = statuses.map((status) => validMarker(status, { sha, model, questionHash, allowedAuthors })).filter(Boolean);
  if (valid.length === 0) return miss("no_valid_marker");
  return { found: true, ...strongestMarker(valid) };
}

function invalidWrite(sha, marker) {
  if (!isValidSha(sha)) return "invalid_sha";
  const { tier, jevTier, confidence, pIncident = null, model, questionHash } = marker ?? {};
  if (!MARKER_TIERS.includes(tier) || !MARKER_TIERS.includes(jevTier)) return "invalid_tier";
  if (!isProbability(confidence) || !(pIncident === null || isProbability(pIncident))) return "invalid_probability";
  if (!TOKEN.test(model ?? "") || !QUESTION_HASH.test(questionHash ?? "")) return "invalid_key";
  return null;
}

/**
 * Write the marker for sha: marker is { tier, jevTier, confidence, pIncident,
 * model, questionHash }. Returns { success: true } or { success: false, reason }.
 * Fail-open: never throws. options: { owner, repo, run }.
 */
export async function writeMarker(sha, marker, options = {}) {
  const { owner = DEFAULT_OWNER, repo = DEFAULT_REPO, run = runGh } = options;
  const invalid = invalidWrite(sha, marker);
  if (invalid) return { success: false, reason: invalid };
  const description = buildMarkerDescription(marker);
  if (description.length > MAX_DESCRIPTION_LENGTH) return { success: false, reason: "description_too_long" };
  try {
    run(["api", `repos/${owner}/${repo}/statuses/${sha}`, "-X", "POST", "-f", "state=success", "-f", `description=${description}`, "-f", `context=${MARKER_CONTEXT}`]);
    return { success: true };
  } catch (error) {
    return { success: false, reason: "api_error", error: errorText(error) };
  }
}

/**
 * The PR's current head SHA (lowercase), or null on any error, so the caller
 * can check that the SHA it screens is the one GitHub has. options: { owner, repo, run }.
 */
export async function readPrHeadSha(pr, options = {}) {
  const { owner = DEFAULT_OWNER, repo = DEFAULT_REPO, run = runGh } = options;
  if (!Number.isInteger(pr) || pr <= 0) return null;
  try {
    const sha = String(run(["api", `repos/${owner}/${repo}/pulls/${pr}`, "--jq", ".head.sha"])).trim().toLowerCase();
    return isValidSha(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** The real marker I/O; screen() takes a replacement so tests never call GitHub. */
export const GITHUB_MARKER_IO = Object.freeze({ read: readMarker, write: writeMarker, headSha: readPrHeadSha });
