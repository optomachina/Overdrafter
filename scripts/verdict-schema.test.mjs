// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
const DIFF = "e".repeat(64);

const valid = (overrides = {}) => ({
  schema: SCHEMA_ID,
  role: "verifier",
  verdict: "PASS",
  sha: SHA,
  patch_id: PATCH,
  diff_id: DIFF,
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
    expect(schema.required).toEqual(expect.arrayContaining(["schema", "verdict", "sha", "patch_id", "diff_id", "verifier", "evidence", "readiness", "timestamp"]));
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
    ["missing diff_id", without("diff_id"), "verdict.diff_id: is required"],
    ["40-hex diff_id", valid({ diff_id: "e".repeat(40) }), "verdict.diff_id: must match ^[0-9a-f]{64}$"],
    ["65-hex diff_id", valid({ diff_id: "e".repeat(65) }), "verdict.diff_id: must match ^[0-9a-f]{64}$"],
    ["uppercase diff_id", valid({ diff_id: "E".repeat(64) }), "verdict.diff_id: must match ^[0-9a-f]{64}$"],
    ["non-hex diff_id", valid({ diff_id: `${"e".repeat(63)}g` }), "verdict.diff_id: must match ^[0-9a-f]{64}$"],
    ["numeric diff_id", valid({ diff_id: 7 }), "verdict.diff_id: must be string (got integer)"],
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
    ["unknown evidence kind", valid({ evidence: [{ kind: "vibes", url: "https://example.com" }] }), "verdict.evidence[0].kind: must be one of verify-run, test, log, artifact, ci-run, probe, screenshot, review"],
    ["zero evidence links", valid({ evidence: [] }), "verdict.evidence: must have at least 1 item (got 0)"],
    ["unparseable timestamp", valid({ timestamp: "yesterday" }), "verdict.timestamp: must be an ISO-8601 UTC timestamp"],
    ["non-UTC timestamp", valid({ timestamp: "2026-10-16T12:00:00+02:00" }), "verdict.timestamp: must be an ISO-8601 UTC timestamp"],
    ["impossible date", valid({ timestamp: "2026-02-30T12:00:00Z" }), "verdict.timestamp: is not a real calendar time"],
    ["verifier with legacy findings", valid({ findings: [{ severity: "low", file: "a.ts", line: 1, model: "grok" }] }), "verdict.findings: is only allowed when role is reviewer"],
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
  it("does not count opus and claude as independent families", async () => {
    const { normalizeModelFamily } = await import("./ovd-merge-gate.mjs");
    const findings = ["opus", "claude", "sonnet"].map((model) => ({ severity: "high", file: "a.ts", line: 3, model }));
    expect(tagCorroborated(findings, { normalizeFamily: normalizeModelFamily }).map((finding) => finding.corroborated)).toEqual([false, false, false]);
  });
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

  it("flags verdicts for the same SHA that differ only in diff_id", () => {
    const result = parseVerdictComments([comment(1, valid()), comment(2, valid({ diff_id: "f".repeat(64) }))], { sha: SHA });
    expect(result).toMatchObject({ verdict: null, conflict: true });
    expect(result.conflicts.map((e) => e.comment_id)).toEqual([1]);
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

const gateFinding = (overrides = {}) => ({
  severity: "medium",
  file: "src/a.ts",
  line: 4,
  summary: "bounds check is off by one",
  ...overrides,
});

describe("OVD-845 optional verdict fields", () => {
  const baseSha = "f".repeat(40);

  it("keeps every new field optional and still rejects unknown top-level fields", () => {
    expect(schema.additionalProperties).toBe(false);
    for (const field of ["findings", "base_sha", "supersedes", "reason"]) {
      expect(schema.required).not.toContain(field);
    }
    expect(schema.properties.findings.items.oneOf.every((entry) => entry.additionalProperties === false)).toBe(true);
    expect(validateVerdict(valid({ approved: true })).errors).toContain("verdict.approved: is not an allowed field");
    expect(validateVerdict(valid({ base_sha: baseSha, approved: true })).errors).toContain("verdict.approved: is not an allowed field");
  });

  it("accepts gate findings for both roles, with line optional", () => {
    expect(validateVerdict(valid({ findings: [] }))).toEqual({ ok: true, errors: [] });
    expect(validateVerdict(valid({ findings: [gateFinding()] })).ok).toBe(true);
    const withoutLine = gateFinding();
    delete withoutLine.line;
    expect(validateVerdict(valid({ findings: [withoutLine] }))).toEqual({ ok: true, errors: [] });
    expect(validateVerdict(valid({
      role: "reviewer",
      findings: [gateFinding({ severity: "high", line: 12, summary: "x".repeat(300) })],
    }))).toEqual({ ok: true, errors: [] });
    expect(validateVerdict(valid({
      role: "reviewer",
      findings: [
        { severity: "info", file: "README.md", line: null, model: "codex", message: "context" },
        { severity: "low", file: "src/a.ts", line: 3, model: "grok", corroborated: true },
      ],
    })).ok).toBe(true);
  });

  const findingCases = [
    ["bad severity", gateFinding({ severity: "critical" }), "verdict.findings[0].severity: must be one of high, medium, low"],
    ["legacy severity on a gate finding", gateFinding({ severity: "info" }), "verdict.findings[0].severity: must be one of high, medium, low"],
    [".. path", gateFinding({ file: "../src/a.ts" }), "verdict.findings[0].file: must be a repo-relative path with no .. segment"],
    ["nested .. path", gateFinding({ file: "src/../../etc/passwd" }), "verdict.findings[0].file: must be a repo-relative path with no .. segment"],
    ["absolute path", gateFinding({ file: "/etc/passwd" }), "verdict.findings[0].file: must be a repo-relative path with no leading /"],
    ["windows absolute path", gateFinding({ file: "C:/secret.ts" }), "verdict.findings[0].file: must be a repo-relative path with no leading /"],
    ["line 0", gateFinding({ line: 0 }), "verdict.findings[0].line: must be >= 1 (got 0)"],
    ["negative line", gateFinding({ line: -3 }), "verdict.findings[0].line: must be >= 1 (got -3)"],
    ["summary of 301 chars", gateFinding({ summary: "x".repeat(301) }), "verdict.findings[0].summary: must be at most 300 characters"],
    ["empty summary", gateFinding({ summary: "" }), "verdict.findings[0].summary: must not be empty"],
    ["extra finding field", gateFinding({ note: "nope" }), "verdict.findings[0].note: is not an allowed field"],
  ];

  it.each(findingCases)("rejects a gate finding with %s", (_name, finding, message) => {
    const result = validateVerdict(valid({ findings: [finding] }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.startsWith(message))).toBe(true);
  });

  // Architect CHANGES_REQUIRED 6236206625, finding 1: drive-relative and
  // Windows-form paths must not escape the repo root.
  const ABSOLUTE = "verdict.findings[0].file: must be a repo-relative path with no leading / or drive letter";
  const DOTDOT = "verdict.findings[0].file: must be a repo-relative path with no .. segment";
  const escapingPaths = [
    ["drive-relative parent", "C:../outside.ts", ABSOLUTE],
    ["drive-relative backslash parent", "C:..\\outside.ts", ABSOLUTE],
    ["drive-relative file", "C:x", ABSOLUTE],
    ["lowercase drive-relative file", "d:src/a.ts", ABSOLUTE],
    ["bare drive", "C:", ABSOLUTE],
    ["drive with backslash", "C:\\x", ABSOLUTE],
    ["drive with slash", "C:/x", ABSOLUTE],
    ["posix absolute", "/x", ABSOLUTE],
    ["backslash rooted", "\\x", ABSOLUTE],
    ["UNC share", "\\\\server\\share\\a.ts", ABSOLUTE],
    ["forward-slash UNC share", "//server/share/a.ts", ABSOLUTE],
    ["device path", "\\\\?\\C:\\x", ABSOLUTE],
    ["backslash traversal", "..\\x", DOTDOT],
    ["nested backslash traversal", "src\\..\\..\\x", DOTDOT],
    ["mixed-separator traversal", "src/..\\..\\x", DOTDOT],
    ["mixed-separator traversal, other order", "src\\../../x", DOTDOT],
    ["trailing .. segment", "src/..", DOTDOT],
    ["Windows-trimmed dots", "...\\x", DOTDOT],
    ["Windows-trimmed dot and space", "src/.. /x", DOTDOT],
  ];

  it.each(escapingPaths)("rejects a gate finding file with %s (%s)", (_name, file, message) => {
    const result = validateVerdict(valid({ findings: [gateFinding({ file })] }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.startsWith(message))).toBe(true);
  });

  const repoRelativePaths = [
    "src/a.ts",
    "src\\a.ts",
    "src/nested\\mixed/a.ts",
    "README.md",
    ".github/workflows/ci.yml",
    "src/..hidden/a.ts",
    "src/a..b.ts",
    "src/notes:v2.md",
  ];

  it.each(repoRelativePaths)("accepts the repo-relative gate finding file %s", (file) => {
    expect(validateVerdict(valid({ findings: [gateFinding({ file })] }))).toEqual({ ok: true, errors: [] });
  });

  // OVD-959 Codex review of dd68f8a5: a legacy reviewer finding accepted
  // `../outside`; its file is now repo-relative like a gate finding (stricter only).
  const legacyFinding = (file) => ({ severity: "low", file, line: 1, model: "grok" });
  it.each([
    ["..", "../outside", DOTDOT],
    ["nested ..", "src/../../outside", DOTDOT],
    ["backslash ..", "src\\..\\..\\outside", DOTDOT],
    ["absolute", "/etc/passwd", ABSOLUTE],
    ["drive letter", "C:/secret.ts", ABSOLUTE],
  ])("rejects a legacy reviewer finding with a %s file path", (_name, file, message) => {
    const result = validateVerdict(valid({ role: "reviewer", findings: [legacyFinding(file)] }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.startsWith(message))).toBe(true);
  });

  it.each(["src/a.ts", "README.md", "src/..hidden/a.ts"])("still accepts the repo-relative legacy finding file %s", (file) => {
    expect(validateVerdict(valid({ role: "reviewer", findings: [legacyFinding(file)] }))).toEqual({ ok: true, errors: [] });
  });

  it("accepts base_sha and a supersedes/reason pair, and rejects either one alone", () => {
    expect(validateVerdict(valid({ base_sha: baseSha }))).toEqual({ ok: true, errors: [] });
    expect(validateVerdict(valid({ supersedes: 123456, reason: "infra" }))).toEqual({ ok: true, errors: [] });
    const missingReason = validateVerdict(valid({ supersedes: 9 }));
    expect(missingReason.ok).toBe(false);
    expect(missingReason.errors).toContain("verdict.reason: is required when supersedes is present");
    const missingSupersedes = validateVerdict(valid({ reason: "infra" }));
    expect(missingSupersedes.ok).toBe(false);
    expect(missingSupersedes.errors).toContain("verdict.supersedes: is required when reason is present");
  });

  const pairCases = [
    ["reason other than infra", { supersedes: 9, reason: "product" }, 'verdict.reason: must be "infra"'],
    ["reason flake", { supersedes: 9, reason: "flake" }, 'verdict.reason: must be "infra"'],
    ["supersedes 0", { supersedes: 0, reason: "infra" }, "verdict.supersedes: must be >= 1 (got 0)"],
    ["negative supersedes", { supersedes: -1, reason: "infra" }, "verdict.supersedes: must be >= 1 (got -1)"],
    ["string supersedes", { supersedes: "123", reason: "infra" }, "verdict.supersedes: must be integer (got string)"],
    ["short base_sha", { base_sha: "abc" }, "verdict.base_sha: must match ^[0-9a-f]{40}$"],
    ["uppercase base_sha", { base_sha: "F".repeat(40) }, "verdict.base_sha: must match ^[0-9a-f]{40}$"],
  ];

  it.each(pairCases)("rejects %s", (_name, overrides, message) => {
    const result = validateVerdict(valid(overrides));
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.startsWith(message))).toBe(true);
  });

  it("allows box-only evidence on FAIL and refuses it as the carrier of a pass", () => {
    const box = { kind: "probe", url: "box:/workspace/verify.log" };
    expect(validateVerdict(valid({ verdict: "FAIL", evidence: [box] }))).toEqual({ ok: true, errors: [] });
    expect(validateVerdict(valid({ verdict: "FAIL", evidence: [{ kind: "log", url: "box:/workspace/artifacts/run.log" }] })).ok).toBe(true);
    const passBox = validateVerdict(valid({ evidence: [{ kind: "verify-run", url: "box:/workspace/verify.log" }] }));
    expect(passBox.ok).toBe(false);
    expect(passBox.errors).toContain("verdict.evidence: PASS and PASS_NOTES require at least one https ci-run or verify-run item");
    const supplemented = valid({
      evidence: [
        { kind: "verify-run", url: "https://github.com/o/r/actions/runs/1" },
        box,
      ],
    });
    expect(validateVerdict(supplemented)).toEqual({ ok: true, errors: [] });
    expect(validateVerdict(valid({
      evidence: [{ kind: "ci-run", url: "https://github.com/o/r/actions/runs/99" }],
    }))).toEqual({ ok: true, errors: [] });
  });

  const evidenceCases = [
    ["PASS_NOTES with only a probe", { verdict: "PASS_NOTES", notes: ["low: probed the login path"], evidence: [{ kind: "probe", url: "https://example.com/probe" }] }],
    ["PASS with only a screenshot", { evidence: [{ kind: "screenshot", url: "https://example.com/screen.png" }] }],
    ["PASS with only a review link", { evidence: [{ kind: "review", url: "https://github.com/o/r/pull/1#discussion_r1" }] }],
    ["PASS with only https log", { evidence: [{ kind: "log", url: "https://example.com/log" }] }],
    ["PASS with only https test", { evidence: [{ kind: "test", url: "https://example.com/test" }] }],
    ["PASS with only https artifact", { evidence: [{ kind: "artifact", url: "https://example.com/artifact" }] }],
    ["PASS_NOTES with only a box probe", { verdict: "PASS_NOTES", notes: ["low: box log"], evidence: [{ kind: "probe", url: "box:/workspace/probe.log" }] }],
  ];

  it.each(evidenceCases)("rejects %s", (_name, overrides) => {
    const result = validateVerdict(valid(overrides));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("verdict.evidence: PASS and PASS_NOTES require at least one https ci-run or verify-run item");
  });

  it("still rejects a non-https URL and a malformed box path on every verdict", () => {
    const httpFail = validateVerdict(valid({ verdict: "FAIL", evidence: [{ kind: "log", url: "http://example.com/log" }] }));
    expect(httpFail.errors.some((error) => error.startsWith("verdict.evidence[0].url: must use https (got http)"))).toBe(true);
    for (const url of ["box:workspace/log", "box://workspace/log", "box:/workspace/../secret", "box:/workspace/./log"]) {
      const result = validateVerdict(valid({ verdict: "FAIL", evidence: [{ kind: "log", url }] }));
      expect(result.ok, url).toBe(false);
      expect(result.errors.some((error) => error.startsWith("verdict.evidence[0].url: must be a box path"))).toBe(true);
    }
  });
});

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const COMPLETE_SHA = /^[0-9a-f]{40}$/;
const COMPLETE_DIFF = /^[0-9a-f]{64}$/;

function verdictSources() {
  const tracked = execFileSync("git", ["grep", "-l", "-I", "overdrafter.verdict/v1"], { cwd: repoRoot, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  const fixtureDir = join(repoRoot, "scripts/fixtures/verdict");
  const fixtures = readdirSync(fixtureDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join("scripts/fixtures/verdict", name));
  return [...new Set([...tracked, ...fixtures])].sort();
}

function documentsIn(relativePath) {
  const text = readFileSync(join(repoRoot, relativePath), "utf8");
  const docs = [];
  const push = (raw) => {
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value) && value.schema === SCHEMA_ID) docs.push({ source: relativePath, value });
    } catch {
      // Illustrative fences that are not JSON are not verdict documents.
    }
  };
  if (relativePath.endsWith(".json")) push(text);
  for (const block of extractVerdictBlocks(text)) push(block);
  for (const match of text.matchAll(/```json[ \t]*\r?\n([\s\S]*?)\r?\n```/g)) push(match[1]);
  return docs;
}

describe("existing verdict fixtures", () => {
  it("parses every verdict fixture and example in the repo and validates each complete one unchanged", () => {
    const documents = verdictSources().flatMap(documentsIn);
    const complete = documents.filter((doc) => COMPLETE_SHA.test(doc.value.sha) && COMPLETE_SHA.test(doc.value.patch_id) && COMPLETE_DIFF.test(doc.value.diff_id));
    const illustrations = documents.filter((doc) => !complete.includes(doc));
    expect(complete.map((doc) => doc.source).sort()).toEqual([
      "scripts/fixtures/verdict/fail-https.json",
      "scripts/fixtures/verdict/pass-notes.json",
      "scripts/fixtures/verdict/reviewer-legacy-findings.json",
      "scripts/fixtures/verdict/verifier-pass.json",
    ]);
    for (const doc of complete) {
      expect(validateVerdict(doc.value), doc.source).toEqual({ ok: true, errors: [] });
    }
    expect(illustrations.map((doc) => doc.source)).toContain("docs/verdict-format.md");
    const example = illustrations.find((doc) => doc.source === "docs/verdict-format.md");
    expect(validateVerdict(example.value).errors).toEqual([
      expect.stringMatching(/^verdict\.sha: must match \^\[0-9a-f\]\{40\}\$/),
      expect.stringMatching(/^verdict\.patch_id: must match \^\[0-9a-f\]\{40\}\$/),
      expect.stringMatching(/^verdict\.diff_id: must match \^\[0-9a-f\]\{64\}\$/),
    ]);
  });
});
