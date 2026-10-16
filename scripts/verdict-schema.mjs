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
const MODEL_FAMILY = "^[a-z][a-z0-9-]{0,31}$";

export const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://overdrafter.dev/schemas/verdict-v1.json",
  title: "OverDrafter review verdict v1",
  type: "object",
  additionalProperties: false,
  required: ["schema", "role", "verdict", "sha", "patch_id", "verifier", "evidence", "notes", "readiness", "timestamp"],
  properties: {
    schema: { const: SCHEMA_ID },
    role: { enum: ["verifier", "reviewer"] },
    verdict: { enum: ["PASS", "PASS_NOTES", "FAIL"] },
    sha: { type: "string", pattern: HEX40 },
    patch_id: { type: "string", pattern: HEX40 },
    verifier: {
      type: "object",
      additionalProperties: false,
      required: ["id", "model_family", "github_login"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 128 },
        model_family: { type: "string", pattern: MODEL_FAMILY },
        github_login: { type: "string", pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\\[bot\\])?$" },
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
      items: { type: "string", pattern: `^(${SEVERITIES.join("|")}): \\S` },
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
  return text === undefined ? String(value) : text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

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

/** Minimal JSON Schema interpreter covering exactly the keywords `schema` uses. */
function check(node, value, path, errors) {
  if ("const" in node && value !== node.const) {
    errors.push(`${path}: must be ${show(node.const)} (got ${show(value)})${path === "verdict.schema" ? " - unknown schema version" : ""}`);
    return;
  }
  if (node.enum && !node.enum.includes(value)) {
    errors.push(`${path}: must be one of ${node.enum.join(", ")} (got ${show(value)})`);
    return;
  }
  const actual = typeOf(value);
  if (node.type) {
    const allowed = [].concat(node.type);
    if (!allowed.some((t) => typeMatches(actual, t))) {
      errors.push(`${path}: must be ${allowed.join(" or ")} (got ${actual})`);
      return;
    }
  }
  if (actual === "string") {
    if (node.minLength !== undefined && value.length < node.minLength) errors.push(`${path}: must not be empty`);
    if (node.maxLength !== undefined && value.length > node.maxLength) errors.push(`${path}: must be at most ${node.maxLength} characters`);
    if (node.pattern && !new RegExp(node.pattern).test(value)) errors.push(`${path}: must match ${node.pattern} (got ${show(value)})`);
    const formatError = node.format && FORMATS[node.format](value);
    if (formatError) errors.push(`${path}: ${formatError} (got ${show(value)})`);
  }
  if (actual === "integer" && node.minimum !== undefined && value < node.minimum) {
    errors.push(`${path}: must be >= ${node.minimum} (got ${value})`);
  }
  if (actual === "array") {
    if (node.minItems !== undefined && value.length < node.minItems) {
      errors.push(`${path}: must have at least ${node.minItems} item${node.minItems === 1 ? "" : "s"} (got ${value.length})`);
    }
    if (node.items) value.forEach((item, i) => check(node.items, item, `${path}[${i}]`, errors));
  }
  if (actual === "object") {
    for (const key of node.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      const sub = node.properties?.[key];
      if (sub) check(sub, child, `${path}.${key}`, errors);
      else if (node.additionalProperties === false) errors.push(`${path}.${key}: is not an allowed field`);
    }
  }
}

/** Validate a parsed verdict object. Returns { ok, errors } with one precise message per problem. */
export function validateVerdict(obj) {
  const errors = [];
  check(schema, obj, "verdict", errors);
  if (typeOf(obj) === "object") {
    if (obj.role === "reviewer" && !Object.hasOwn(obj, "findings")) {
      errors.push("verdict.findings: is required when role is reviewer (use [] for none)");
    }
    if (obj.role === "verifier" && Object.hasOwn(obj, "findings")) {
      errors.push("verdict.findings: is only allowed when role is reviewer");
    }
    if (obj.verdict === "PASS_NOTES" && Array.isArray(obj.notes) && obj.notes.length === 0) {
      errors.push("verdict.notes: PASS_NOTES requires at least one note");
    }
  }
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

/**
 * Parse GitHub issue comments ({ id, body, created_at, updated_at, user: { login } }).
 *
 * Returns, for `sha`:
 * - verdict: latest valid verifier verdict (by comment created_at, then block order), or null;
 * - conflicts: valid verifier verdicts for the SHA that disagree with it on verdict or patch_id;
 * - reviews: valid advisory reviewer verdicts for the SHA;
 * - other_sha: valid verdicts for other SHAs (stale for this head);
 * - rejected: [{ comment_id, block, reason, errors }] for edited comments, unparseable
 *   JSON, schema errors, or a github_login that is not the comment author.
 * A gate must fail closed (verdict_schema_error) on any conflict.
 */
export function parseVerdictComments(comments, { sha } = {}) {
  if (typeof sha !== "string" || !new RegExp(HEX40).test(sha)) throw new TypeError("parseVerdictComments: sha must be a 40-hex commit SHA");
  const accepted = [];
  const rejected = [];
  const ordered = [...(comments ?? [])].sort((a, b) => String(a?.created_at).localeCompare(String(b?.created_at)));
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
      const { ok, errors } = validateVerdict(parsed);
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
    ? verifierEntries.filter((entry) => entry.verdict.verdict !== latest.verdict.verdict || entry.verdict.patch_id !== latest.verdict.patch_id)
    : [];
  return {
    verdict: latest?.verdict ?? null,
    comment_id: latest?.comment_id ?? null,
    conflicts,
    reviews: forSha.filter((entry) => entry.verdict.role === "reviewer"),
    other_sha: accepted.filter((entry) => entry.verdict.sha !== sha),
    rejected,
  };
}
