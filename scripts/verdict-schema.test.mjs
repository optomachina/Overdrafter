// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  SCHEMA_ID,
  extractVerdictBlocks,
  formatVerdictBlock,
  hasHighNote,
  parseVerdictComments,
  schema,
  tagCorroborated,
  validateVerdict,
} from "./verdict-schema.mjs";

const SHA = "a".repeat(40);
const OLD_SHA = "b".repeat(40);
const PATCH = "c".repeat(40);

const valid = (overrides = {}) => ({
  schema: SCHEMA_ID,
  role: "verifier",
  verdict: "PASS",
  sha: SHA,
  patch_id: PATCH,
  verifier: { id: "astra-verifier", model_family: "opus", github_login: "verifier-bot" },
  evidence: [{ kind: "verify-run", url: "https://github.com/o/r/actions/runs/1" }],
  notes: [],
  readiness: { conflicts: 0, open_threads: 0, checks: "green" },
  timestamp: "2026-10-15T12:00:00Z",
  ...overrides,
});

const without = (key) => {
  const verdict = valid();
  delete verdict[key];
  return verdict;
};

describe("validateVerdict", () => {
  it("accepts a well-formed verifier verdict", () => {
    expect(validateVerdict(valid())).toEqual({ ok: true, errors: [] });
  });

  it("exposes a JSON Schema object that lists every required field", () => {
    expect(schema.$schema).toContain("json-schema.org");
    expect(schema.required).toEqual(expect.arrayContaining(["schema", "verdict", "sha", "patch_id", "verifier", "evidence", "readiness", "timestamp"]));
  });

  const cases = [
    ["missing sha", without("sha"), "verdict.sha: is required"],
    ["missing timestamp", without("timestamp"), "verdict.timestamp: is required"],
    ["missing verifier login", valid({ verifier: { id: "v", model_family: "opus" } }), "verdict.verifier.github_login: is required"],
    ["missing role", without("role"), "verdict.role: is required"],
    ["unknown schema version", valid({ schema: "overdrafter.verdict/v2" }), 'verdict.schema: must be "overdrafter.verdict/v1" (got "overdrafter.verdict/v2") - unknown schema version'],
    ["unknown verdict", valid({ verdict: "LGTM" }), 'verdict.verdict: must be one of PASS, PASS_NOTES, FAIL (got "LGTM")'],
    ["short sha", valid({ sha: "abc123" }), "verdict.sha: must match ^[0-9a-f]{40}$"],
    ["numeric sha", valid({ sha: 1234 }), "verdict.sha: must be string (got integer)"],
    ["string conflicts", valid({ readiness: { conflicts: "0", open_threads: 0, checks: "green" } }), "verdict.readiness.conflicts: must be integer (got string)"],
    ["negative threads", valid({ readiness: { conflicts: 0, open_threads: -1, checks: "green" } }), "verdict.readiness.open_threads: must be >= 0 (got -1)"],
    ["evidence object", valid({ evidence: {} }), "verdict.evidence: must be array (got object)"],
    ["notes not strings", valid({ notes: [1] }), "verdict.notes[0]: must be string (got integer)"],
    ["untagged note", valid({ verdict: "PASS_NOTES", notes: ["looks fine"] }), "verdict.notes[0]: must match"],
    ["extra field", valid({ approved: true }), "verdict.approved: is not an allowed field"],
    ["extra verifier field", valid({ verifier: { id: "v", model_family: "opus", github_login: "x", admin: true } }), "verdict.verifier.admin: is not an allowed field"],
    ["non-https evidence", valid({ evidence: [{ kind: "log", url: "http://example.com/log" }] }), 'verdict.evidence[0].url: must use https (got http) (got "http://example.com/log")'],
    ["relative evidence", valid({ evidence: [{ kind: "log", url: "/runs/1" }] }), "verdict.evidence[0].url: must be an absolute https URL"],
    ["credentialed evidence", valid({ evidence: [{ kind: "log", url: "https://u:p@example.com/" }] }), "verdict.evidence[0].url: must not embed credentials"],
    ["unknown evidence kind", valid({ evidence: [{ kind: "vibes", url: "https://example.com" }] }), "verdict.evidence[0].kind: must be one of verify-run, test, log, artifact"],
    ["zero evidence links", valid({ evidence: [] }), "verdict.evidence: must have at least 1 item (got 0)"],
    ["unparseable timestamp", valid({ timestamp: "yesterday" }), "verdict.timestamp: must be an ISO-8601 UTC timestamp"],
    ["non-UTC timestamp", valid({ timestamp: "2026-10-16T12:00:00+02:00" }), "verdict.timestamp: must be an ISO-8601 UTC timestamp"],
    ["impossible date", valid({ timestamp: "2026-02-30T12:00:00Z" }), "verdict.timestamp: is not a real calendar time"],
    ["verifier with findings", valid({ findings: [] }), "verdict.findings: is only allowed when role is reviewer"],
    ["reviewer without findings", valid({ role: "reviewer" }), "verdict.findings: is required when role is reviewer"],
    ["PASS_NOTES without notes", valid({ verdict: "PASS_NOTES" }), "verdict.notes: PASS_NOTES requires at least one note"],
    ["bad finding line", valid({ role: "reviewer", findings: [{ severity: "low", file: "a.ts", line: 0, model: "grok" }] }), "verdict.findings[0].line: must be >= 1 (got 0)"],
    ["not an object", [], "verdict: must be object (got array)"],
    ["far-future timestamp", valid({ timestamp: "2999-01-01T00:00:00Z" }), "verdict.timestamp: is in the future"],
    // Names inherited from Object.prototype must still be unknown fields (fail closed).
    ...["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"].flatMap((name) => {
      const top = valid();
      const nested = valid();
      // Define as own data properties: `obj.__proto__ = x` would set the prototype instead.
      Object.defineProperty(top, name, { value: "x", enumerable: true });
      Object.defineProperty(nested.verifier, name, { value: 1, enumerable: true });
      return [
        [`top-level ${name}`, top, `verdict.${name}: is not an allowed field`],
        [`verifier.${name}`, nested, `verdict.verifier.${name}: is not an allowed field`],
      ];
    }),
    ["JSON-parsed __proto__", JSON.parse(JSON.stringify(valid()).replace(/^\{/, '{"__proto__":{"x":1},')), "verdict.__proto__: is not an allowed field"],
  ];

  it.each(cases)("rejects %s with a precise message", (_name, verdict, message) => {
    const result = validateVerdict(verdict);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.startsWith(message))).toBe(true);
  });

  it("accepts a reviewer verdict with file-level and line findings", () => {
    const findings = [
      { severity: "high", file: "src/a.ts", line: 12, model: "grok", message: "null deref" },
      { severity: "info", file: "README.md", line: null, model: "codex" },
    ];
    expect(validateVerdict(valid({ role: "reviewer", findings })).ok).toBe(true);
  });

  it("rejects a timestamp beyond the skew allowance relative to now, and accepts one within it", () => {
    const now = new Date("2026-10-16T12:00:00Z");
    expect(validateVerdict(valid({ timestamp: "2026-10-16T12:04:59Z" }), { now }).ok).toBe(true);
    const result = validateVerdict(valid({ timestamp: "2026-10-16T12:05:01Z" }), { now });
    expect(result.errors).toEqual([expect.stringMatching(/^verdict\.timestamp: is in the future/)]);
  });

  it("detects high notes", () => {
    expect(hasHighNote(valid({ notes: ["low: nit", "high: data loss"] }))).toBe(true);
    expect(hasHighNote(valid({ notes: ["medium: naming"] }))).toBe(false);
  });
});

describe("tagCorroborated", () => {
  it("tags findings raised by two model families on the same location", () => {
    const tagged = tagCorroborated([
      { severity: "high", file: "a.ts", line: 3, model: "opus" },
      { severity: "medium", file: "a.ts", line: 3, model: "grok" },
      { severity: "low", file: "a.ts", line: 3, model: "opus" },
      { severity: "low", file: "b.ts", line: 3, model: "codex" },
    ]);
    expect(tagged.map((f) => f.corroborated)).toEqual([true, true, true, false]);
  });

  it("does not corroborate one family with itself and honours lineTolerance", () => {
    const findings = [
      { severity: "high", file: "a.ts", line: 3, model: "opus" },
      { severity: "high", file: "a.ts", line: 3, model: "opus" },
      { severity: "high", file: "a.ts", line: 5, model: "codex" },
    ];
    expect(tagCorroborated(findings).map((f) => f.corroborated)).toEqual([false, false, false]);
    expect(tagCorroborated(findings, { lineTolerance: 2 }).map((f) => f.corroborated)).toEqual([true, true, true]);
  });
});

const comment = (id, verdict, { login = "verifier-bot", created = `2026-10-16T12:0${id}:00Z`, updated = created, prefix = "Summary" } = {}) => ({
  id,
  user: { login },
  created_at: created,
  updated_at: updated,
  body: `${prefix}\n\n${typeof verdict === "string" ? verdict : formatVerdictBlock(verdict)}\n`,
});

describe("parseVerdictComments", () => {
  it("ignores non-fenced text and other fence languages", () => {
    const body = [
      "verdict: PASS",
      "```json",
      JSON.stringify(valid()),
      "```",
      "inline ```overdrafter-verdict {} ``` text",
    ].join("\n");
    expect(extractVerdictBlocks(body)).toEqual([]);
    const result = parseVerdictComments([{ id: 1, user: { login: "verifier-bot" }, created_at: "t", updated_at: "t", body }], { sha: SHA });
    expect(result).toMatchObject({ verdict: null, conflicts: [], rejected: [] });
  });

  it("round-trips a formatted block", () => {
    expect(extractVerdictBlocks(formatVerdictBlock(valid())).map((t) => JSON.parse(t))).toEqual([valid()]);
  });

  it("picks the latest valid verifier verdict for the SHA", () => {
    const result = parseVerdictComments(
      [
        comment(3, valid({ timestamp: "2026-10-16T12:03:00Z" })),
        comment(1, valid({ verdict: "PASS", sha: OLD_SHA })),
        comment(2, valid({ timestamp: "2026-10-16T12:02:00Z" })),
      ],
      { sha: SHA },
    );
    expect(result.comment_id).toBe(3);
    expect(result.verdict.timestamp).toBe("2026-10-16T12:03:00Z");
    expect(result.conflicts).toEqual([]);
    expect(result.other_sha.map((e) => e.comment_id)).toEqual([1]);
  });

  it("returns no verdict when only an old SHA was verified", () => {
    const result = parseVerdictComments([comment(1, valid({ sha: OLD_SHA }))], { sha: SHA });
    expect(result.verdict).toBeNull();
    expect(result.other_sha).toHaveLength(1);
  });

  it("flags conflicting verdicts for the same SHA", () => {
    const result = parseVerdictComments(
      [comment(1, valid({ verdict: "FAIL" })), comment(2, valid()), comment(3, valid({ patch_id: "d".repeat(40) }), { login: "verifier-bot" })],
      { sha: SHA },
    );
    expect(result).toMatchObject({ verdict: null, comment_id: null, conflict: true });
    expect(result.latest.comment_id).toBe(3);
    expect(result.conflicts.map((e) => e.comment_id)).toEqual([1, 2]);
  });

  it("orders by created_at instant, not by string", () => {
    const result = parseVerdictComments(
      [comment(1, valid({ verdict: "FAIL" }), { created: "2026-10-16T12:00:01.500Z" }), comment(2, valid(), { created: "2026-10-16T12:00:01Z" })],
      { sha: SHA },
    );
    // As strings ".500Z" sorts before "Z"; as instants comment 1 is later.
    expect(result.latest.comment_id).toBe(1);
  });

  it("rejects a verdict timestamped after its comment was created", () => {
    const result = parseVerdictComments([comment(1, valid({ timestamp: "2026-10-16T13:00:00Z" }))], { sha: SHA });
    expect(result.verdict).toBeNull();
    expect(result.rejected[0]).toMatchObject({ reason: "schema_error", errors: [expect.stringMatching(/is in the future/)] });
  });

  it("rejects edited comments", () => {
    const result = parseVerdictComments([comment(1, valid(), { updated: "2026-10-16T13:00:00Z" })], { sha: SHA });
    expect(result.verdict).toBeNull();
    expect(result.rejected).toEqual([{ comment_id: 1, block: 0, reason: "edited_comment", errors: [expect.stringContaining("edited")] }]);
  });

  it("rejects comments without timestamps, bad JSON, schema errors, and author mismatches", () => {
    const result = parseVerdictComments(
      [
        { id: 1, user: { login: "verifier-bot" }, body: formatVerdictBlock(valid()) },
        comment(2, "```overdrafter-verdict\n{not json\n```"),
        comment(3, valid({ evidence: [] })),
        comment(4, valid(), { login: "pr-author" }),
      ],
      { sha: SHA },
    );
    expect(result.verdict).toBeNull();
    const byReason = Object.fromEntries(result.rejected.map((r) => [r.reason, r]));
    expect(Object.keys(byReason).sort()).toEqual(["author_mismatch", "invalid_json", "missing_comment_timestamps", "schema_error"]);
    expect(byReason.schema_error.errors).toContain("verdict.evidence: must have at least 1 item (got 0)");
  });

  it("keeps reviewer verdicts advisory and out of the gate verdict", () => {
    const review = valid({ role: "reviewer", verdict: "FAIL", verifier: { id: "grok-review", model_family: "grok", github_login: "grok-bot" }, findings: [] });
    const result = parseVerdictComments([comment(1, valid()), comment(2, review, { login: "grok-bot" })], { sha: SHA });
    expect(result.verdict.role).toBe("verifier");
    expect(result.conflicts).toEqual([]);
    expect(result.reviews.map((e) => e.verdict.verifier.id)).toEqual(["grok-review"]);
  });

  it("reads every block in a comment and requires a valid sha argument", () => {
    const body = `${formatVerdictBlock(valid({ verdict: "FAIL" }))}\n\n${formatVerdictBlock(valid())}`;
    const result = parseVerdictComments([comment(1, body)], { sha: SHA });
    expect(result.verdict).toBeNull();
    expect(result.latest.verdict.verdict).toBe("PASS");
    expect(result.conflicts).toHaveLength(1);
    expect(() => parseVerdictComments([], { sha: "HEAD" })).toThrow(/40-hex/);
  });
});
