/**
 * OVD-845 / OVD-959: Blaine's approval record for a sensitive PR,
 * `overdrafter.approval/v1` (schema from the OVD-921 plan).
 *
 * Grok Bot posts one fenced block when Blaine approves the card:
 *
 *   ```overdrafter-approval
 *   { "schema": "overdrafter.approval/v1", "sha": "<40-hex head>",
 *     "diff_id": "<64-hex diff_id of base...head>", "approver": "blaine",
 *     "card_id": "<card id>", "timestamp": "2026-10-17T08:00:00Z" }
 *   ```
 *
 * `ovd-merge-gate` accepts a record only when it is valid, posted by a
 * trusted approval login (a constant in the gate, never a repo variable), in
 * a comment that was never edited, and bound to the head SHA or the head
 * `diff_id` the gate recomputes itself.
 *
 * Node builtins only, no imports at all: the gate loads this file from the
 * default-branch checkout without node_modules. See docs/verdict-format.md.
 */

export const APPROVAL_SCHEMA_ID = "overdrafter.approval/v1";
export const APPROVAL_FENCE_INFO = "overdrafter-approval";
export const APPROVERS = Object.freeze(["blaine"]);
/** Allowed clock skew for an approval timestamp ahead of the comment's created_at. */
export const APPROVAL_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

const FIELDS = new Set(["schema", "sha", "diff_id", "approver", "card_id", "timestamp"]);
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const CARD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

const show = (value) => {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

function timestampError(value) {
  const match = typeof value === "string" ? UTC_TIMESTAMP.exec(value) : null;
  if (!match) return "must be an ISO-8601 UTC timestamp like 2026-10-17T08:00:00Z";
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const real = date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
    && date.getUTCHours() === h && date.getUTCMinutes() === mi && date.getUTCSeconds() === s;
  return real ? null : "is not a real calendar time";
}

const FIELD_CHECKS = {
  schema: (value) => (value === APPROVAL_SCHEMA_ID ? null : `must be ${show(APPROVAL_SCHEMA_ID)} - unknown schema version`),
  sha: (value) => (typeof value === "string" && HEX40.test(value) ? null : "must be a 40-hex commit SHA"),
  diff_id: (value) => (typeof value === "string" && HEX64.test(value) ? null : "must be a 64-hex diff_id"),
  approver: (value) => (APPROVERS.includes(value) ? null : `must be one of ${APPROVERS.join(", ")}`),
  card_id: (value) => (typeof value === "string" && CARD_ID.test(value) ? null : "must be a card id (letters, digits, . _ : -; at most 128)"),
  timestamp: timestampError,
};

/**
 * Validate a parsed approval record. Fails closed: unknown fields (including
 * names inherited from Object.prototype), missing fields, wrong types and a
 * timestamp more than APPROVAL_MAX_FUTURE_SKEW_MS after `now` are errors.
 * Returns { ok, errors }.
 */
export function validateApproval(obj, { now = new Date() } = {}) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, errors: ["approval: must be an object"] };
  const errors = [];
  for (const key of Object.keys(obj)) {
    if (!FIELDS.has(key)) errors.push(`approval.${key}: is not an allowed field`);
  }
  for (const key of FIELDS) {
    if (!Object.hasOwn(obj, key)) {
      errors.push(`approval.${key}: is required`);
      continue;
    }
    const problem = FIELD_CHECKS[key](obj[key]);
    if (problem) errors.push(`approval.${key}: ${problem} (got ${show(obj[key])})`);
  }
  if (!errors.length && Date.parse(obj.timestamp) > new Date(now).getTime() + APPROVAL_MAX_FUTURE_SKEW_MS) {
    errors.push(`approval.timestamp: is in the future (got ${show(obj.timestamp)}, now ${new Date(now).toISOString()})`);
  }
  return { ok: errors.length === 0, errors };
}

const FENCE = /^```overdrafter-approval[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

/** The raw JSON text of every ```overdrafter-approval block in a comment body. */
export function extractApprovalBlocks(body) {
  return typeof body === "string" ? [...body.matchAll(FENCE)].map((match) => match[1]) : [];
}

/** Render an approval record as the fenced block parseApprovalComments reads. */
export function formatApprovalBlock(approval) {
  return `\`\`\`${APPROVAL_FENCE_INFO}\n${JSON.stringify(approval, null, 2)}\n\`\`\``;
}

/**
 * Read approval records from GitHub issue comments
 * ({ id, body, created_at, updated_at, user: { login } }).
 *
 * Returns { approvals, rejected }. approvals are
 * { comment_id, block, created_at, author, approval } in created_at order.
 * rejected are { comment_id, block, reason, errors } with reason one of
 * untrusted_author, missing_comment_timestamps, edited_comment, invalid_json
 * or schema_error. Only logins in `trustedLogins` (compared case-insensitively)
 * count; an empty or missing list trusts nobody.
 */
export function parseApprovalComments(comments, { trustedLogins = [] } = {}) {
  const trusted = new Set((Array.isArray(trustedLogins) ? trustedLogins : []).map((login) => String(login).toLowerCase()));
  const approvals = [];
  const rejected = [];
  for (const comment of Array.isArray(comments) ? comments : []) {
    extractApprovalBlocks(comment?.body).forEach((text, block) => {
      const reject = (reason, errors = []) => rejected.push({ comment_id: comment.id ?? null, block, reason, errors });
      const author = comment.user?.login;
      if (typeof author !== "string" || !trusted.has(author.toLowerCase())) {
        return reject("untrusted_author", [`comment author ${show(author ?? null)} is not a trusted approval login`]);
      }
      if (!comment.created_at || !comment.updated_at) return reject("missing_comment_timestamps");
      if (comment.updated_at !== comment.created_at) return reject("edited_comment", ["comment was edited; post a new record instead"]);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        return reject("invalid_json", [error.message]);
      }
      const at = Date.parse(comment.created_at);
      const { ok, errors } = validateApproval(parsed, { now: Number.isFinite(at) ? new Date(at) : new Date() });
      if (!ok) return reject("schema_error", errors);
      approvals.push({ comment_id: comment.id ?? null, block, created_at: comment.created_at, author, approval: parsed });
    });
  }
  approvals.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.block - b.block);
  return { approvals, rejected };
}

/**
 * The latest approval bound to the head: its sha is the head SHA, or its
 * diff_id equals the head diff_id the caller recomputed. A missing or
 * malformed head diff_id never matches. Returns the entry or null.
 */
export function approvalForHead(approvals, { headSha, headDiffId }) {
  const diffId = typeof headDiffId === "string" && HEX64.test(headDiffId) ? headDiffId : null;
  const bound = (Array.isArray(approvals) ? approvals : []).filter(
    (entry) => entry?.approval?.sha === headSha || (diffId !== null && entry?.approval?.diff_id === diffId),
  );
  return bound.at(-1) ?? null;
}
