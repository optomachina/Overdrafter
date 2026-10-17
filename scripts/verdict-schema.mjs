/**
 * OVD-851 review verdict format: the single source of truth for the
 * `overdrafter.verdict/v1` envelope.
 *
 * Node builtins only, no imports at all: OVD-845 loads this file from the
 * base checkout, so it must run without node_modules.
 *
 * - `schema` is a JSON Schema (2020-12) object. `validateVerdict` interprets
 *   it directly, then adds the semantic checks JSON Schema cannot express
 *   (https URLs, real UTC timestamps, role-dependent findings).
 * - Only `role: "verifier"` verdicts are gate input. `role: "reviewer"`
 *   verdicts are advisory and carry `findings`.
 * - A verdict binds to `sha`. `patch_id` is lossy; reuse across a rebase must
 *   also require an equal `diff_id` (exact changed paths, modes and blobs).
 * - `parseVerdictComments` reads GitHub issue comments and returns the latest
 *   valid verifier verdict for a SHA, conflicting verdicts, and every
 *   rejected block. Edited comments are rejected; post a new comment instead.
 *
 * See docs/verdict-format.md.
 */

export const SCHEMA_ID = "overdrafter.verdict/v1";
export const FENCE_INFO = "overdrafter-verdict";

const SEVERITIES = ["high", "medium", "low", "info"];
const HEX40 = "^[0-9a-f]{40}$";
/** diff_id: lowercase hex SHA-256 of `git diff --raw -z` (see scripts/emit-verdict.mjs computeDiffId). */
const HEX64 = "^[0-9a-f]{64}$";
const MODEL_FAMILY = "^[a-z][a-z0-9-]{0,31}$";

export const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://overdrafter.dev/schemas/verdict-v1.json",
  title: "OverDrafter review verdict v1",
  type: "object",
  additionalProperties: false,
  required: ["schema", "role", "verdict", "sha", "patch_id", "diff_id", "verifier", "evidence", "notes", "readiness", "timestamp"],
  properties: {
    schema: { const: SCHEMA_ID },
    role: { enum: ["verifier", "reviewer"] },
    verdict: { enum: ["PASS", "PASS_NOTES", "FAIL"] },
    sha: { type: "string", pattern: HEX40 },
    patch_id: { type: "string", pattern: HEX40 },
    diff_id: { type: "string", pattern: HEX64 },
    verifier: {
      type: "object",
      additionalProperties: false,
      required: ["id", "model_family", "github_login"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 128 },
        model_family: { type: "string", pattern: MODEL_FAMILY },
        github_login: { type: "string", pattern: String.raw`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$` },
      },
    },
    evidence: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "url"],
        properties: {
          kind: { enum: ["verify-run", "test", "log", "artifact"] },
          url: { type: "string", format: "https-url" },
        },
      },
    },
    notes: {
      type: "array",
      items: { type: "string", pattern: String.raw`^(${SEVERITIES.join("|")}): \S` },
    },
    readiness: {
      type: "object",
      additionalProperties: false,
      required: ["conflicts", "open_threads", "checks"],
      properties: {
        conflicts: { type: "integer", minimum: 0 },
        open_threads: { type: "integer", minimum: 0 },
        checks: { enum: ["green", "pending", "red"] },
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "file", "line", "model"],
        properties: {
          severity: { enum: SEVERITIES },
          file: { type: "string", minLength: 1 },
          line: { type: ["integer", "null"], minimum: 1 },
          model: { type: "string", pattern: MODEL_FAMILY },
          message: { type: "string" },
          corroborated: { type: "boolean" },
        },
      },
    },
    timestamp: { type: "string", format: "utc-timestamp" },
  },
};

const typeOf = (value) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
};
const typeMatches = (actual, expected) => actual === expected || (expected === "number" && actual === "integer");
const show = (value) => {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

/** Allowed clock skew for a verdict timestamp ahead of `now`. */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const FORMATS = {
  "https-url": (value) => {
    let url;
    try {
      url = new URL(value);
    } catch {
      return "must be an absolute https URL";
    }
    if (url.protocol !== "https:") return `must use https (got ${url.protocol.replace(/:$/, "")})`;
    if (url.username || url.password) return "must not embed credentials";
    return null;
  },
  "utc-timestamp": (value) => {
    const match = UTC_TIMESTAMP.exec(value);
    if (!match) return "must be an ISO-8601 UTC timestamp like 2026-10-16T12:00:00Z";
    const [, y, mo, d, h, mi, s] = match.map(Number);
    const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
    const roundTrips = date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
      && date.getUTCHours() === h && date.getUTCMinutes() === mi && date.getUTCSeconds() === s;
    return roundTrips ? null : "is not a real calendar time";
  },
};

/**
 * Keywords that reject the value outright (const, enum, type). Returns false when
 * the value is rejected, so no narrower keyword reports a second error for it.
 */
function checkShape(node, value, actual, path, errors) {
  if ("const" in node && value !== node.const) {
    const hint = path === "verdict.schema" ? " - unknown schema version" : "";
    errors.push(`${path}: must be ${show(node.const)} (got ${show(value)})${hint}`);
    return false;
  }
  if (node.enum && !node.enum.includes(value)) {
    errors.push(`${path}: must be one of ${node.enum.join(", ")} (got ${show(value)})`);
    return false;
  }
  if (!node.type) return true;
  const allowed = [node.type].flat();
  if (allowed.some((t) => typeMatches(actual, t))) return true;
  errors.push(`${path}: must be ${allowed.join(" or ")} (got ${actual})`);
  return false;
}

function checkString(node, value, path, errors) {
  if (node.minLength !== undefined && value.length < node.minLength) errors.push(`${path}: must not be empty`);
  if (node.maxLength !== undefined && value.length > node.maxLength) errors.push(`${path}: must be at most ${node.maxLength} characters`);
  if (node.pattern && !new RegExp(node.pattern).test(value)) errors.push(`${path}: must match ${node.pattern} (got ${show(value)})`);
  const formatError = node.format && FORMATS[node.format](value);
  if (formatError) errors.push(`${path}: ${formatError} (got ${show(value)})`);
}

function checkArray(node, value, path, errors) {
  if (node.minItems !== undefined && value.length < node.minItems) {
    const plural = node.minItems === 1 ? "" : "s";
    errors.push(`${path}: must have at least ${node.minItems} item${plural} (got ${value.length})`);
  }
  if (node.items) value.forEach((item, i) => check(node.items, item, `${path}[${i}]`, errors));
}

function checkObject(node, value, path, errors) {
  for (const key of node.required ?? []) {
    if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: is required`);
  }
  for (const [key, child] of Object.entries(value)) {
    // Own properties only: `constructor`, `__proto__`, `valueOf`, ... must not resolve to Object.prototype.
    const sub = node.properties && Object.hasOwn(node.properties, key) ? node.properties[key] : undefined;
    if (sub) check(sub, child, `${path}.${key}`, errors);
    else if (node.additionalProperties === false) errors.push(`${path}.${key}: is not an allowed field`);
  }
}

/** Minimal JSON Schema interpreter covering exactly the keywords `schema` uses. */
function check(node, value, path, errors) {
  const actual = typeOf(value);
  if (!checkShape(node, value, actual, path, errors)) return;
  if (actual === "string") checkString(node, value, path, errors);
  else if (actual === "integer" && node.minimum !== undefined && value < node.minimum) {
    errors.push(`${path}: must be >= ${node.minimum} (got ${value})`);
  } else if (actual === "array") checkArray(node, value, path, errors);
  else if (actual === "object") checkObject(node, value, path, errors);
}

/** Checks JSON Schema cannot express: future timestamps and role/verdict-dependent fields. */
function semanticErrors(obj, now) {
  const errors = [];
  const at = typeof obj.timestamp === "string" && !FORMATS["utc-timestamp"](obj.timestamp) ? Date.parse(obj.timestamp) : Number.NaN;
  if (Number.isFinite(at) && at > new Date(now).getTime() + MAX_FUTURE_SKEW_MS) {
    errors.push(`verdict.timestamp: is in the future (got ${show(obj.timestamp)}, now ${new Date(now).toISOString()})`);
  }
  const hasFindings = Object.hasOwn(obj, "findings");
  if (obj.role === "reviewer" && !hasFindings) errors.push("verdict.findings: is required when role is reviewer (use [] for none)");
  if (obj.role === "verifier" && hasFindings) errors.push("verdict.findings: is only allowed when role is reviewer");
  if (obj.verdict === "PASS_NOTES" && Array.isArray(obj.notes) && obj.notes.length === 0) {
    errors.push("verdict.notes: PASS_NOTES requires at least one note");
  }
  return errors;
}

/**
 * Validate a parsed verdict object. Returns { ok, errors } with one precise message per problem.
 * A timestamp more than MAX_FUTURE_SKEW_MS after `now` is rejected.
 */
export function validateVerdict(obj, { now = new Date() } = {}) {
  const errors = [];
  check(schema, obj, "verdict", errors);
  if (typeOf(obj) === "object") errors.push(...semanticErrors(obj, now));
  return { ok: errors.length === 0, errors };
}

/** True when any note is a `high` item. A PASS_NOTES verdict with a high note is not merge eligible. */
export function hasHighNote(verdict) {
  return Array.isArray(verdict?.notes) && verdict.notes.some((note) => typeof note === "string" && note.startsWith("high:"));
}

/**
 * Tag each finding `corroborated` when a finding from a different model family
 * names the same file and a line within `lineTolerance` (file-level findings,
 * line null, match other file-level findings). Returns new finding objects.
 */
export function tagCorroborated(findings, { lineTolerance = 0 } = {}) {
  const near = (a, b) => (a.line === null || b.line === null ? a.line === b.line : Math.abs(a.line - b.line) <= lineTolerance);
  return findings.map((finding) => ({
    ...finding,
    corroborated: findings.some((other) => other.model !== finding.model && other.file === finding.file && near(other, finding)),
  }));
}

const FENCE = /^```overdrafter-verdict[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

/** Extract the raw JSON text of every ```overdrafter-verdict block in a comment body. */
export function extractVerdictBlocks(body) {
  return typeof body === "string" ? [...body.matchAll(FENCE)].map((match) => match[1]) : [];
}

/** Render a verdict as the fenced block that parseVerdictComments reads. */
export function formatVerdictBlock(verdict) {
  return `\`\`\`${FENCE_INFO}\n${JSON.stringify(verdict, null, 2)}\n\`\`\``;
}

/** Order comments by created_at as instants (not strings), falling back to string order when unparseable. */
const byCreatedAt = (a, b) => {
  const [x, y] = [Date.parse(a?.created_at), Date.parse(b?.created_at)];
  if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return String(a?.created_at).localeCompare(String(b?.created_at));
};

/**
 * Parse GitHub issue comments ({ id, body, created_at, updated_at, user: { login } }).
 *
 * Returns, for `sha`:
 * - verdict: latest valid verifier verdict (by comment created_at, then block order), or null.
 *   Always null when `conflict` is true, so a consumer that ignores conflicts cannot pass;
 * - conflict: true when any valid verifier verdict for the SHA disagrees with the latest one;
 * - conflicts: those disagreeing entries (`verdict`, `patch_id` or `diff_id` differs;
 *   the latest itself is `latest`);
 * - latest: the latest verifier entry, kept for diagnostics even when conflicting;
 * - reviews: valid advisory reviewer verdicts for the SHA;
 * - other_sha: valid verdicts for other SHAs (stale for this head);
 * - rejected: [{ comment_id, block, reason, errors }] for edited comments, unparseable
 *   JSON, schema errors (including a timestamp after the comment's created_at), or a
 *   github_login that is not the comment author.
 * A gate must fail closed (verdict_schema_error) on any conflict.
 */
export function parseVerdictComments(comments, { sha } = {}) {
  if (typeof sha !== "string" || !new RegExp(HEX40).test(sha)) throw new TypeError("parseVerdictComments: sha must be a 40-hex commit SHA");
  const accepted = [];
  const rejected = [];
  const ordered = [...(comments ?? [])].sort(byCreatedAt);
  for (const comment of ordered) {
    const blocks = extractVerdictBlocks(comment?.body);
    blocks.forEach((text, block) => {
      const reject = (reason, errors = []) => rejected.push({ comment_id: comment.id ?? null, block, reason, errors });
      if (!comment.created_at || !comment.updated_at) return reject("missing_comment_timestamps");
      if (comment.updated_at !== comment.created_at) return reject("edited_comment", ["comment was edited; post a new comment instead"]);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        return reject("invalid_json", [error.message]);
      }
      const { ok, errors } = validateVerdict(parsed, { now: Number.isFinite(Date.parse(comment.created_at)) ? new Date(comment.created_at) : new Date() });
      if (!ok) return reject("schema_error", errors);
      const author = comment.user?.login;
      if (!author || author.toLowerCase() !== parsed.verifier.github_login.toLowerCase()) {
        return reject("author_mismatch", [`verifier.github_login ${show(parsed.verifier.github_login)} is not the comment author ${show(author ?? null)}`]);
      }
      accepted.push({ comment_id: comment.id ?? null, block, created_at: comment.created_at, verdict: parsed });
    });
  }
  const forSha = accepted.filter((entry) => entry.verdict.sha === sha);
  const verifierEntries = forSha.filter((entry) => entry.verdict.role === "verifier");
  const latest = verifierEntries.at(-1) ?? null;
  const conflicts = latest
    ? verifierEntries.filter(
      (entry) => entry.verdict.verdict !== latest.verdict.verdict
        || entry.verdict.patch_id !== latest.verdict.patch_id
        || entry.verdict.diff_id !== latest.verdict.diff_id,
    )
    : [];
  const conflict = conflicts.length > 0;
  return {
    verdict: conflict ? null : (latest?.verdict ?? null),
    comment_id: conflict ? null : (latest?.comment_id ?? null),
    conflict,
    conflicts,
    latest,
    reviews: forSha.filter((entry) => entry.verdict.role === "reviewer"),
    other_sha: accepted.filter((entry) => entry.verdict.sha !== sha),
    rejected,
  };
}
