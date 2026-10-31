// @vitest-environment node
// Keep both the standalone node:test command and the repository Vitest suite working.
const runner = await import(process.env.VITEST ? "vitest" : "node:test");
const { describe, it } = runner;
const afterAll = runner.afterAll ?? runner.after;
import assert from "node:assert/strict";
import { format } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DELIVERY_UNAVAILABLE_REASON,
  QA_UNIT,
  buildSnapshot,
  attributePullRequest,
  normalizePullRequest,
  parseReviewVerdict,
  parseArchitectReviewHeader,
  modelFamily,
  isReviewShaValid,
  isCommentsOnlyComparison,
  qaFamilyBuilder,
  builderFromBodyLines,
  computeBots,
  computeLiveQuotes,
  computeMerges,
  computeQa,
  computeReverts,
  computeTimeToMerge,
  mergedInWindow,
  parseCliArgs,
  parseQaVerdict,
  parseResultsJsonl,
  percentile,
  resolveWindow,
  runCli,
  resolveBinary,
  SAFE_BIN_DIRS,
  serializeSnapshot,
  weekStartUtc,
} from "./trust-metrics.mjs";

const each = (values) => (name, check) => {
  for (const value of values) it(format(name, value), () => assert.doesNotThrow(() => check(...(Array.isArray(value) ? value : [value]))));
};

const FIXTURES = fileURLToPath(new URL("./fixtures/trust-metrics/", import.meta.url));
const fixture = (name) => path.join(FIXTURES, name);
const readFixture = (name) => JSON.parse(fs.readFileSync(fixture(name), "utf8"));
const WINDOW_INPUT = { start: "2026-09-28", end: "2026-10-15" };
const window = resolveWindow(WINDOW_INPUT);
const prs = readFixture("prs.json");
const comments = readFixture("comments.json");
const harnessRows = parseResultsJsonl(fs.readFileSync(fixture("results.jsonl"), "utf8"));
const merged = mergedInWindow(prs, window);
const REVIEW_SHA = "a".repeat(40);
const QA_SHA = "b".repeat(40);
const familyPr = (number, extra = {}) => ({ number, mergedAt: "2026-10-14T12:00:00Z", ...extra });
const familyComment = (prNumber, body, extra = {}) => ({ prNumber, body, createdAt: "2026-10-14T10:00:00Z", ...extra });
const architect = (model, sha = QA_SHA, verdict = "PASS") => `Architect review (${model}) @ ${sha}\nDetails\nVERDICT: ${verdict}`;

const fixtureSnapshot = (overrides = {}) => buildSnapshot({
  window: WINDOW_INPUT,
  pullRequests: prs,
  comments,
  harnessRows,
  harnessResultFiles: 1,
  ...overrides,
});

describe("window and weeks", () => {
  it("buckets by Monday 00:00 UTC", () => {
    assert.equal(weekStartUtc("2026-10-04T23:59:59Z"), "2026-09-28");
    assert.equal(weekStartUtc("2026-10-05T00:00:00Z"), "2026-10-05");
    assert.equal(weekStartUtc("2026-10-15T12:00:00Z"), "2026-10-12");
  });

  it("defaults to eight Monday-aligned weeks ending with the end week", () => {
    const { start, end } = resolveWindow({ end: "2026-10-15" });
    assert.deepEqual({ start, end }, { start: "2026-08-24", end: "2026-10-15" });
    assert.equal(resolveWindow({ end: "2026-10-15", weeks: 1 }).start, "2026-10-12");
  });

  it("rejects malformed and inverted windows", () => {
    assert.throws(() => resolveWindow({ end: "2026-13-01" }), /valid date/);
    assert.throws(() => resolveWindow({ end: "10/15/2026" }), /YYYY-MM-DD/);
    assert.throws(() => resolveWindow({ start: "2026-10-16", end: "2026-10-15" }), /after/);
  });

  it("keeps only PRs merged into the base branch inside whole UTC window days", () => {
    assert.deepEqual(merged.map((pr) => pr.number), [1, 2, 3, 4, 5, 9]);
    assert.deepEqual(mergedInWindow(prs, window, "feature/ovd-10").map((pr) => pr.number), [10]);
  });
});

describe("merges per week", () => {
  it("counts merges per Monday week, including empty weeks", () => {
    assert.deepEqual(computeMerges(merged, window), {
      total: 6,
      perWeek: [
        { weekStart: "2026-09-28", count: 2 },
        { weekStart: "2026-10-05", count: 2 },
        { weekStart: "2026-10-12", count: 2 },
      ],
    });
    const wide = resolveWindow({ start: "2026-09-21", end: "2026-10-15" });
    assert.deepEqual(computeMerges(mergedInWindow(prs, wide), wide).perWeek[0], { weekStart: "2026-09-21", count: 1 });
  });

  it("accepts gh pr list camelCase input", () => {
    const camel = [{ number: 1, title: "x", createdAt: "2026-10-01T00:00:00Z", mergedAt: "2026-10-01T01:00:00Z", headRefName: "a", labels: [] }];
    assert.equal(computeMerges(mergedInWindow(camel, window), window).total, 1);
  });
});

describe("QA verdicts", () => {
  it("parses the verdict from the first non-empty line only", () => {
    assert.equal(parseQaVerdict("QA: PASS on 31e99417 All ACs met"), "pass");
    assert.equal(parseQaVerdict("QA: FAIL on db45840"), "fail");
    assert.equal(parseQaVerdict("\n**QA: FAIL** on 1234567"), "fail");
    assert.equal(parseQaVerdict("Final-head QA PASS at 1c3253a"), "pass");
    assert.equal(parseQaVerdict("T5 final QA PASS at `9d67da3`"), "pass");
    assert.equal(parseQaVerdict("QA FAIL follow-up on head `ad052d6`"), null);
    assert.equal(parseQaVerdict("Hosted CI green.\nQA: PASS on abc"), null);
    assert.equal(parseQaVerdict("QA: PARTIAL on abc"), null);
    assert.equal(parseQaVerdict(undefined), null);
  });

  it("counts the latest in-window verdict per merged PR", () => {
    assert.deepEqual(computeQa(merged, comments, window), { pass: 2, fail: 2, noVerdict: 2, unit: QA_UNIT });
  });

  it("breaks same-instant ties by comment id", () => {
    const tie = [
      { id: 2, issue_url: "x/issues/9", created_at: "2026-10-14T07:00:00Z", body: "QA: PASS on a" },
      { id: 1, issue_url: "x/issues/9", created_at: "2026-10-14T07:00:00Z", body: "QA: FAIL on a" },
    ];
    const { pass, fail } = computeQa(merged, tie, window);
    assert.deepEqual({ pass, fail }, { pass: 1, fail: 0 });
  });
});

describe("QA families", () => {
  it("parses an exact Architect header with a later verdict", () => {
    assert.deepEqual(parseArchitectReviewHeader(architect("GPT-6.1", REVIEW_SHA, "FAIL")), {
      model: "GPT-6.1", sha: REVIEW_SHA, verdict: "fail",
    });
    assert.equal(parseArchitectReviewHeader(architect("Opus").replaceAll("\n", "\r\n"))?.model, "Opus");
  });

  each([
    architect("opus", "abcdef0"),
    architect("opus").replace(`@ ${QA_SHA}`, `@ ${QA_SHA}0`),
    `Architect review (opus) @ ${QA_SHA.slice(0, 8)}: PASS_NOTES`,
    `Engineer review (opus) @ ${QA_SHA}: PASS`,
    `## Architect review (Codex review mode, gpt-6-astra) at ${QA_SHA}`,
    `Architect review (opus) @ ${QA_SHA}: looks fine`,
    architect("opus").replace("Architect", "Engineer"),
    `\n${architect("opus")}`,
    `Architect review (opus) @ ${QA_SHA}`,
    `Architect review (opus) @ ${QA_SHA}\nVerdict:  \nDelta from x`,
    `Architect review (opus) @ ${QA_SHA}\nThe verdict: PASS`,
    undefined,
  ])("rejects a missing or nonstandard Architect header/verdict: %s", (body) => {
    assert.equal(parseArchitectReviewHeader(body), null);
  });

  each([
    [`Architect review (Codex) @ ${QA_SHA}: PASS_NOTES`, "Codex", "pass_notes"],
    [`Architect review (Opus) @ ${QA_SHA}: CHANGES_REQUIRED\r\nbody`, "Opus", "changes_required"],
    [`Architect review (opus) @ ${QA_SHA} (round 2): FAIL`, "opus", "fail"],
    [`Architect review (opus) @ ${QA_SHA} \u2014 PASS (comments-only delta)`, "opus", "pass"],
    [`Architect review (grok) @ ${QA_SHA} (delta re-review)\nVERDICT: PASS`, "grok", "pass"],
    [`Architect review (opus) @ ${QA_SHA}\nScope ok.\nVerdict: PASS_NOTES (same diff as the reviewed head)`, "opus", "pass_notes"],
    [`Architect review (Codex) @ ${QA_SHA}\n**Verdict: CHANGES_REQUIRED**\n- [high] x`, "Codex", "changes_required"],
    [`Architect review (opus) @ ${QA_SHA}\nModel: claude-opus\nVerdict:  \nVERDICT: PASS`, "opus", "pass"],
  ])("accepts tolerant Architect header forms: %s", (body, model, verdict) => {
    assert.deepEqual(parseArchitectReviewHeader(body), { model, sha: QA_SHA, verdict });
  });

  it("reads builders from Built-by:/Model: lines after bot attribution and before Built on", () => {
    assert.equal(qaFamilyBuilder({ labels: ["model:codex"], body: "Built-by: bot=engineer model=model:opus" }), "codex");
    assert.equal(qaFamilyBuilder({ body: "Built-by: bot=engineer model=model:claude-opus\nBuilt on cursor" }), "claude-opus");
    assert.equal(qaFamilyBuilder({ body: "Built-by: Engineer / grok-4.7 via Cursor cloud agent" }), "grok-4.7");
    assert.equal(qaFamilyBuilder({ body: "Model: model:codex (effort=high)\nBuilt on cursor" }), "codex");
    assert.equal(qaFamilyBuilder({ body: "Built-by: bot=engineer model=model:claude-opus; follow-up bot=engineer model=model:codex\nBuilt on cursor" }), "cursor");
    assert.equal(qaFamilyBuilder({ body: "Built-by: bot=engineer (hand-written, no model)\nBuilt on cursor" }), "cursor");
  });

  it("never reads a builder from the line after a blank Built-by:/Model: and ignores a literal unknown", () => {
    assert.equal(builderFromBodyLines("Built-by:\nCodex review pending"), null);
    assert.equal(builderFromBodyLines("Model:\nopus"), null);
    assert.equal(qaFamilyBuilder({ body: "Built-by:\nCodex review pending\nBuilt on cursor" }), "cursor");
    assert.equal(qaFamilyBuilder({ body: "Model:\nopus\nBuilt on cursor" }), "cursor");
    assert.equal(qaFamilyBuilder({ body: "Model: unknown\nBuilt on cursor" }), "cursor");
    assert.equal(qaFamilyBuilder({ body: "Built-by: bot=engineer model=model:unknown\nBuilt on cursor" }), "cursor");
    assert.equal(qaFamilyBuilder({ body: "Model: unknown" }), "unknown");
    assert.equal(qaFamilyBuilder({ body: "Built-by:  \t model=model:opus" }), "opus");
  });

  each([
    ["Opus", "claude"], ["SONNET", "claude"], ["codex", "openai"], ["gpt", "openai"],
    ["GPT-6.1", "openai"], ["grok", "xai"], ["claude fable 5.1", "claude"],
    ["opus delta 71b15c2d..94090be4", "claude"], ["sonnet delta 9ac028d4..57238331", "claude"],
    ["Codex gpt-6-astra xhigh, delta since 3473bcd8", "openai"], ["Opus, delta since 3473bcd8", "claude"],
    ["Claude Code, Opus", "claude"], ["claude-opus, fresh session, no build context", "claude"],
    ["git + claude-opus", "claude"], ["opus+git", "claude"], ["Claude Code + git", "claude"],
    ["Opus, merge-resolution delta since 3473bcd8", "claude"], ["grok-4.7 via Cursor", "xai"],
    ["git", null], ["git delta", null], ["git (comments-only delta)", null],
    ["codex + opus", null], ["Opus, then grok", null], ["unknown", null], ["gptish", null], ["opusish", null],
    ["", null], [undefined, null],
  ])("maps model family by known tokens: %s", (model, family) => {
    assert.equal(modelFamily(model), family);
  });

  it("keeps equal SHAs and only proven comments-only ancestors", () => {
    assert.equal(isReviewShaValid(QA_SHA, QA_SHA, { isCommentsOnlyAncestor: () => { throw new Error("unneeded comparison"); } }), true);
    assert.equal(isReviewShaValid(REVIEW_SHA, QA_SHA, { isCommentsOnlyAncestor: (base, head) => base === REVIEW_SHA && head === QA_SHA }), true);
    assert.equal(isReviewShaValid(REVIEW_SHA, QA_SHA, { isCommentsOnlyAncestor: () => false }), false);
    assert.equal(isReviewShaValid(REVIEW_SHA, QA_SHA), false);
    assert.equal(isReviewShaValid(REVIEW_SHA, null), false);
  });

  it("prefers bot attribution, then the Built on pool token, then unknown", () => {
    assert.equal(qaFamilyBuilder({ labels: ["model:codex"], body: "Built on cursor" }), "codex");
    assert.equal(qaFamilyBuilder({ body: "Model: opus\nBuilt on cursor" }), "opus");
    assert.equal(qaFamilyBuilder({ author: { login: "robot[bot]" }, body: "Built on cursor" }), "robot");
    assert.equal(qaFamilyBuilder({ body: "Other text\nbUiLt On Cursor more details" }), "cursor");
    assert.equal(qaFamilyBuilder({ labels: ["model:codex", "model:opus"], body: "Built on claude" }), "unknown");
  });

  it("keeps a conflicting bot attribution unknown instead of falling through to body lines", () => {
    assert.equal(qaFamilyBuilder({ body: "Model: codex/opus" }), "unknown");
    assert.equal(qaFamilyBuilder({ labels: ["model:codex"], body: "Model: opus\nBuilt on cursor" }), "unknown");
    assert.equal(qaFamilyBuilder({ labels: ["model:codex"], body: "Built-by: model=model:opus" }), "codex");
    assert.equal(qaFamilyBuilder({ labels: ["model:codex"], body: "Model:\nBuilt on cursor" }), "codex");
  });

  it("trims trailing punctuation from builder names without looping on punctuation-only names", () => {
    assert.equal(builderFromBodyLines("Built-by: grok-4.7.,;"), "grok-4.7");
    assert.equal(builderFromBodyLines("Model: ..."), "");
    assert.equal(builderFromBodyLines(), null);
    assert.equal(qaFamilyBuilder({ body: "It was Built on cursor" }), "unknown");
    assert.equal(qaFamilyBuilder({ body: "Built on " }), "unknown");
    assert.equal(qaFamilyBuilder({ body: "Built on\nUnrelated text" }), "unknown");
    assert.equal(qaFamilyBuilder({}), "unknown");
  });

  it("uses the latest QA head, filters reviews, counts all merged PRs and stays deterministic", () => {
    const pullRequests = [
      familyPr(1, { headRefOid: REVIEW_SHA, labels: ["model:codex"], body: "Built on cursor" }),
      familyPr(2, { headRefOid: QA_SHA, body: "Built on Cursor" }),
      familyPr(3, { head: { sha: QA_SHA } }), familyPr(4), familyPr(5),
    ];
    const comments = [
      familyComment(1, `QA: FAIL on ${REVIEW_SHA}`, { id: 1 }),
      familyComment(1, `**QA: PASS** on ${QA_SHA}`, { id: 2 }),
      familyComment(1, `QA: FAIL on ${REVIEW_SHA}`, { createdAt: "2026-10-16T00:00:00Z" }),
      familyComment(1, architect("Opus")), familyComment(1, architect("Opus")),
      familyComment(1, architect("gpt-6", REVIEW_SHA, "APPROVED")),
      familyComment(1, architect("sonnet", "c".repeat(40))),
      familyComment(1, architect("git")), familyComment(1, architect("git delta")),
      familyComment(1, architect("grok"), { createdAt: "2026-10-16T00:00:00Z" }),
      familyComment(2, "QA: PASS"), familyComment(2, architect("git delta")),
      familyComment(3, "Final-head QA FAIL"), familyComment(3, architect("grok")),
      familyComment(4, "QA: PASS"), familyComment(5, architect("sonnet")),
      familyComment(99, "QA: PASS"), familyComment(99, architect("opus")),
    ];
    const options = { pullRequests, comments, isCommentsOnlyAncestor: (base, head) => base === REVIEW_SHA && head === QA_SHA };
    const snapshot = fixtureSnapshot(options);
    assert.deepEqual(snapshot.qaFamilies, {
      perPr: [
        { prNumber: 1, qaHead: QA_SHA, reviewers: [
          { family: "claude", model: "Opus", sha: QA_SHA, verdict: "pass" },
          { family: "openai", model: "gpt-6", sha: REVIEW_SHA, verdict: "approved" },
        ], builder: "codex" },
        { prNumber: 2, qaHead: QA_SHA, reviewers: "none", builder: "cursor" },
        { prNumber: 3, qaHead: QA_SHA, reviewers: [{ family: "xai", model: "grok", sha: QA_SHA, verdict: "pass" }], builder: "unknown" },
        { prNumber: 4, qaHead: null, reviewers: "none", builder: "unknown" },
        { prNumber: 5, qaHead: null, reviewers: [], builder: "unknown" },
      ],
      summary: { qaJudged: 4, reviewersNone: 2, prs: 5, builderUnknown: 3 },
    });
    assert.deepEqual(fixtureSnapshot({ ...options, pullRequests: [...pullRequests].reverse(), comments: [...comments].reverse() }), snapshot);
    assert.deepEqual(snapshot.qa, { pass: 3, fail: 1, noVerdict: 1, unit: QA_UNIT });
    assert.equal(snapshot.botAttribution.noSignal, 4);
    assert.deepEqual(fixtureSnapshot({ pullRequests: [], comments: [] }).qaFamilies, {
      perPr: [], summary: { qaJudged: 0, reviewersNone: 0, prs: 0, builderUnknown: 0 },
    });
  });

  it("captures abbreviated QA SHAs without substituting the PR head", () => {
    const snapshot = fixtureSnapshot({ pullRequests: [familyPr(1, { headRefOid: QA_SHA })], comments: [familyComment(1, "T5 final QA PASS at `abcdef0`")] });
    assert.equal(snapshot.qaFamilies.perPr[0].qaHead, "abcdef0");
  });
});

describe("comments-only comparisons", () => {
  const comparison = (patch, extra = {}) => ({ status: "ahead", files: [{ filename: "src/a.js", status: "modified", additions: 1, deletions: 1, patch, ...extra }] });

  each(["// comment", "/* comment */", "<!-- comment -->", "   "])("accepts changed comment or blank lines: %s", (line) => {
    assert.equal(isCommentsOnlyComparison(comparison(`@@ -1 +1 @@\n-// old\n+${line}`)), true);
  });

  each([
    ["scripts/a.py", "#"], ["bin/run.sh", "#"], ["ci.yml", "#"], [".github/x.yaml", "#"], ["pyproject.toml", "#"], ["Gemfile.rb", "#"],
    ["db/q.sql", "--"], ["init.lua", "--"],
  ])("accepts # and -- line comments only where the file type uses them: %s", (filename, prefix) => {
    assert.equal(isCommentsOnlyComparison(comparison(`@@ -1 +1 @@\n-${prefix} old\n+${prefix} new`, { filename })), true);
  });

  each([
    ["README.md", "@@ -1,2 +1,3 @@\n-# Old heading\n+# New heading\n+---", 2, 1],
    ["styles/a.css", "@@ -1 +1 @@\n---bg: #fff\n+--bg: #000", 1, 1],
    ["src/a.js", "@@ -1 +1 @@\n-# old\n+# new", 1, 1],
    ["db/q.sql", "@@ -1 +1 @@\n-# old\n+# new", 1, 1],
    ["scripts/a.py", "@@ -1 +1 @@\n--- old\n+-- new", 1, 1],
    [undefined, "@@ -1 +1 @@\n-# old\n+# new", 1, 1],
  ])("rejects # and -- changes in files where they are content: %s", (filename, patch, additions, deletions) => {
    assert.equal(isCommentsOnlyComparison(comparison(patch, { filename, additions, deletions })), false);
  });

  it("treats // lines inside a template literal as content", () => {
    assert.equal(isCommentsOnlyComparison(comparison("@@ -1,3 +1,3 @@\n const url = `\n-//old-path\n+//new-path\n `;")), false);
    assert.equal(isCommentsOnlyComparison(comparison("@@ -1,2 +1,2 @@\n const a = `x`;\n-// old `quoted`\n+// new")), true);
    assert.equal(isCommentsOnlyComparison(comparison("@@ -1,3 +1,3 @@\n const s = \"\\`\";\n-// old\n+// new")), true);
  });

  it("recognizes block comment context on each side of the patch", () => {
    assert.equal(isCommentsOnlyComparison(comparison("@@ -1,3 +1,3 @@\n /*\n- old\n+ new\n */")), true);
  });

  it("accepts added or removed files containing only comments", () => {
    assert.equal(isCommentsOnlyComparison(comparison("@@ -0,0 +1 @@\n+// new", { status: "added", deletions: 0 })), true);
    assert.equal(isCommentsOnlyComparison(comparison("@@ -1 +0,0 @@\n-// old", { status: "removed", additions: 0 })), true);
  });

  it("rejects code, missing/truncated patches, renames and non-ancestor statuses", () => {
    assert.equal(isCommentsOnlyComparison(comparison("@@ -1 +1 @@\n-const x = 1;\n+const x = 2;")), false);
    assert.equal(isCommentsOnlyComparison(comparison("@@ -1 +1 @@\n-// old\n+/* comment */ run();")), false);
    assert.equal(isCommentsOnlyComparison(comparison(undefined)), false);
    assert.equal(isCommentsOnlyComparison(comparison("@@ -1 +1 @@\n-// old\n+// new", { additions: 2 })), false);
    assert.equal(isCommentsOnlyComparison(comparison("@@ -1 +1 @@\n-// old\n+// new", { status: "renamed" })), false);
    for (const status of ["behind", "diverged", undefined]) assert.equal(isCommentsOnlyComparison({ status, files: [] }), false);
    assert.equal(isCommentsOnlyComparison({ status: "ahead" }), false);
    assert.equal(isCommentsOnlyComparison({ status: "identical", files: [] }), true);
    assert.equal(isCommentsOnlyComparison({ status: "ahead", files: Array(300).fill({}) }), false);
  });
});

describe("reverts and rollbacks", () => {
  it("detects reverts by title, revert branch or label, and rollbacks by leading title word or label", () => {
    assert.deepEqual(computeReverts(merged), { reverts: 1, rollbacks: 2 });
  });

  it("counts a PR once, revert first", () => {
    const both = mergedInWindow([{ number: 1, title: "Revert \"Rollback x\"", created_at: "2026-10-01T00:00:00Z",
      merged_at: "2026-10-01T01:00:00Z", head: { ref: "a" }, labels: [{ name: "rollback" }] }], window);
    assert.deepEqual(computeReverts(both), { reverts: 1, rollbacks: 0 });
  });
});

describe("time to merge", () => {
  it("uses linear-interpolation percentiles", () => {
    assert.equal(percentile([], 0.5), null);
    assert.equal(percentile([5], 0.9), 5);
    assert.equal(percentile([288, 2, 24, 4, 10, 6], 0.5), 8);
    assert.equal(percentile([288, 2, 24, 4, 10, 6], 0.9), 156);
  });

  it("reports window and weekly median and p90 hours, omitting weeks without merges", () => {
    assert.deepEqual(computeTimeToMerge(merged), {
      medianHours: 8,
      p90Hours: 156,
      perWeek: [
        { weekStart: "2026-09-28", medianHours: 17, p90Hours: 22.6 },
        { weekStart: "2026-10-05", medianHours: 3, p90Hours: 3.8 },
        { weekStart: "2026-10-12", medianHours: 147, p90Hours: 259.8 },
      ],
    });
    assert.deepEqual(computeTimeToMerge([]), { medianHours: null, p90Hours: null, perWeek: [] });
  });
});

describe("live quotes", () => {
  it("skips blank and malformed results.jsonl lines", () => {
    const skipped = [];
    parseResultsJsonl(fs.readFileSync(fixture("results.jsonl"), "utf8"), (line) => skipped.push(line));
    assert.deepEqual(skipped, [7]);
  });

  it("keeps in-window v1 rows, dedupes, sorts and passes lead time through", () => {
    assert.deepEqual(computeLiveQuotes(harnessRows, window), [
      {
        runId: "20261012T080000Z-9c0d1e2f",
        provider: "protolabs",
        requestedQuantity: 10,
        totalPriceUsd: null,
        leadTimeBusinessDays: null,
        estimatedDeliveryDate: null,
        deliveryUnavailableReason: DELIVERY_UNAVAILABLE_REASON,
        status: null,
        timestamp: "2026-10-12T08:00:00.000Z",
        errorCode: "price_unavailable",
      },
      {
        runId: "20261014T090000Z-1a2b3c4d",
        provider: "xometry",
        requestedQuantity: 10,
        totalPriceUsd: 414.15,
        leadTimeBusinessDays: null,
        estimatedDeliveryDate: null,
        deliveryUnavailableReason: DELIVERY_UNAVAILABLE_REASON,
        status: "instant_quote_received",
        timestamp: "2026-10-14T09:00:00.000Z",
        errorCode: null,
      },
      {
        runId: "20261014T090000Z-1a2b3c4d",
        provider: "fictiv",
        requestedQuantity: 1,
        totalPriceUsd: 188,
        leadTimeBusinessDays: 7,
        estimatedDeliveryDate: null,
        deliveryUnavailableReason: DELIVERY_UNAVAILABLE_REASON,
        status: "instant_quote_received",
        timestamp: "2026-10-14T09:01:02.000Z",
        errorCode: null,
      },
    ]);
  });

  it("never carries quote URLs or provider quote ids into the snapshot", () => {
    const json = serializeSnapshot(fixtureSnapshot());
    assert.doesNotMatch(json, /quoteUrl|providerQuoteId|Q00-0000-0000|example\.com|artifacts/);
  });

  it("never derives a delivery date from lead time or timestamp", () => {
    for (const quote of computeLiveQuotes(harnessRows, window)) {
      assert.equal(quote.estimatedDeliveryDate, null);
    }
  });
});

describe("snapshot", () => {
  it("has the v1 shape in a stable key order", () => {
    const snapshot = fixtureSnapshot();
    assert.deepEqual(Object.keys(snapshot), [
      "schemaVersion", "generatedAt", "window", "sources", "merges", "qa", "reverts", "timeToMerge", "liveQuotes", "bots", "botAttribution", "qaFamilies",
    ]);
    const { schemaVersion, generatedAt, window, sources, bots, botAttribution } = snapshot;
    assert.deepEqual({ schemaVersion, generatedAt, window, sources, bots, botAttribution }, {
      schemaVersion: "trust-snapshot.v1",
      generatedAt: "2026-10-15T23:59:59Z",
      window: { start: "2026-09-28", end: "2026-10-15" },
      sources: { repository: "optomachina/Overdrafter", baseBranch: "main", harnessResultFiles: 1 },
      bots: [{ bot: "unknown", prs: 6, qa: { pass: 2, fail: 2, noVerdict: 2, passRate: 0.5 }, reverts: { reverts: 1, rollbacks: 2 }, reviews: { approved: 0, changesRequired: 0 } }],
      botAttribution: { attributed: 0, noSignal: 6, conflicting: 0, bySource: { label: 0, body: 0, author: 0 } },
    });
  });

  it("takes generatedAt from input, normalized to whole-second UTC", () => {
    assert.equal(fixtureSnapshot({ generatedAt: "2026-10-15T07:00:00.123-07:00" }).generatedAt, "2026-10-15T14:00:00Z");
    assert.throws(() => fixtureSnapshot({ generatedAt: "yesterday" }), /ISO 8601/);
  });

  it("is deterministic: same inputs in any order give identical JSON", () => {
    const first = serializeSnapshot(fixtureSnapshot());
    const second = serializeSnapshot(fixtureSnapshot({
      pullRequests: [...prs].reverse(),
      comments: [...comments].reverse(),
      harnessRows: [...harnessRows].reverse(),
    }));
    assert.equal(second, first);
  });
});

describe("cli", () => {
  const tempDirs = [];
  const tempDir = (prefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  });
  const offlineArgs = (out) => [
    "--window-start", "2026-09-28", "--window-end", "2026-10-15",
    "--prs-json", fixture("prs.json"), "--comments-json", fixture("comments.json"),
    "--results-jsonl", fixture("results.jsonl"), "--out", out,
  ];
  const noNetwork = () => {
    throw new Error("network fetch attempted");
  };

  it("writes byte-identical files on repeated offline runs without touching the network", () => {
    const dir = tempDir("trust-metrics-");
    const outputs = ["a.json", "b.json"].map((name) => {
      const out = path.join(dir, name);
      assert.equal(runCli(offlineArgs(out), { fetchInputs: noNetwork, log: () => undefined }), 0);
      return fs.readFileSync(out, "utf8");
    });
    assert.equal(outputs[1], outputs[0]);
    assert.equal(JSON.parse(outputs[0]).merges.total, 6);
  });

  it("reads every run's results.jsonl under an artifact root", () => {
    const root = tempDir("trust-metrics-root-");
    fs.mkdirSync(path.join(root, "20261014T090000Z-1a2b3c4d"));
    fs.copyFileSync(fixture("results.jsonl"), path.join(root, "20261014T090000Z-1a2b3c4d", "results.jsonl"));
    const out = path.join(root, "out.json");
    const args = offlineArgs(out).filter((arg) => arg !== "--results-jsonl" && arg !== fixture("results.jsonl"));
    runCli([...args, "--artifact-root", root], { fetchInputs: noNetwork, log: () => undefined });
    const snapshot = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(snapshot.sources.harnessResultFiles, 1);
    assert.equal((snapshot.liveQuotes).length, 3);
  });

  it("uses offline commit evidence and never fetches absent comparisons", () => {
    const dir = tempDir("trust-metrics-families-");
    const prFile = path.join(dir, "prs.json");
    const commentFile = path.join(dir, "comments.json");
    const commitFile = path.join(dir, "commits.json");
    const out = path.join(dir, "snapshot.json");
    fs.writeFileSync(prFile, JSON.stringify([familyPr(1)]));
    fs.writeFileSync(commentFile, JSON.stringify([
      familyComment(1, `QA: PASS on ${QA_SHA}`), familyComment(1, architect("opus", REVIEW_SHA)),
    ]));
    const args = ["--window-end", "2026-10-15", "--prs-json", prFile, "--comments-json", commentFile, "--out", out];
    const dependencies = { fetchInputs: noNetwork, compareCommits: noNetwork, log: () => undefined };
    for (const evidence of [null, {}, { [`${REVIEW_SHA}...${QA_SHA}`]: false }, { [`${REVIEW_SHA}...${QA_SHA}`]: true }]) {
      fs.writeFileSync(commitFile, JSON.stringify(evidence));
      runCli(evidence === null ? args : [...args, "--commits-json", commitFile], dependencies);
      const { qaFamilies } = JSON.parse(fs.readFileSync(out, "utf8"));
      assert.equal(qaFamilies.summary.reviewersNone, evidence?.[`${REVIEW_SHA}...${QA_SHA}`] === true ? 0 : 1);
    }
  });

  it("supplies the repository and SHAs to the online comparison adapter", () => {
    const dir = tempDir("trust-metrics-comparison-");
    const out = path.join(dir, "snapshot.json");
    const calls = [];
    runCli(["--window-end", "2026-10-15", "--repo", "example/project", "--out", out], {
      fetchInputs: () => ({ pullRequests: [familyPr(1)], comments: [
        familyComment(1, `QA: PASS on ${QA_SHA}`), familyComment(1, architect("opus", REVIEW_SHA)),
        familyComment(1, architect("sonnet", REVIEW_SHA)),
      ] }),
      compareCommits: (...args) => { calls.push(args); return true; },
      log: () => undefined,
    });
    assert.deepEqual(calls, [["example/project", REVIEW_SHA, QA_SHA]]);
    assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).qaFamilies.perPr[0].reviewers.length, 2);
  });

  it("treats a failed online comparison as not comments-only, logs the pair without the error, and finishes", () => {
    const dir = tempDir("trust-metrics-comparison-failure-");
    const out = path.join(dir, "snapshot.json");
    const logs = [];
    const calls = [];
    const code = runCli(["--window-end", "2026-10-15", "--out", out], {
      fetchInputs: () => ({ pullRequests: [familyPr(1), familyPr(2)], comments: [
        familyComment(1, `QA: PASS on ${QA_SHA}`), familyComment(1, architect("opus", REVIEW_SHA)), familyComment(1, architect("sonnet", REVIEW_SHA)),
        familyComment(2, `QA: PASS on ${QA_SHA}`), familyComment(2, architect("codex", REVIEW_SHA)),
      ] }),
      compareCommits: (repository, base, head) => {
        calls.push([base, head]);
        if (calls.length === 1) throw new Error("gh: Not Found (HTTP 404) token=SECRET");
        return true;
      },
      log: (line) => logs.push(line),
    });
    assert.equal(code, 0);
    assert.deepEqual(calls, [[REVIEW_SHA, QA_SHA]]);
    const { qaFamilies } = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(qaFamilies.perPr[0].reviewers, "none");
    assert.equal(qaFamilies.perPr[1].reviewers, "none");
    assert.equal(qaFamilies.summary.reviewersNone, 2);
    assert.deepEqual(logs.filter((line) => line.includes(REVIEW_SHA)), [`Comparison ${REVIEW_SHA}...${QA_SHA} unavailable; treated as not comments-only.`]);
    assert.ok(logs.every((line) => !line.includes("SECRET") && !line.includes("404")));
  });

  it("validates arguments", () => {
    assert.throws(() => parseCliArgs(["--prs-json", "a.json"]), /together/);
    assert.throws(() => parseCliArgs(["--bogus"]), /Unknown/);
    assert.throws(() => parseCliArgs(["--window-end"]), /needs a value/);
    assert.equal(runCli([], { fetchInputs: noNetwork, log: () => undefined }), 2);
  });
});

describe("resolveBinary", () => {
  it("returns the first fixed directory that has the binary and never reads PATH", () => {
    const exists = (candidate) => candidate === "/usr/local/bin/gh" || candidate === "/opt/homebrew/bin/gh";
    assert.equal(resolveBinary("gh", { exists }), "/usr/local/bin/gh");
    assert.equal(SAFE_BIN_DIRS.every((dir) => path.isAbsolute(dir)), true);
  });

  it("fails closed when no fixed directory has the binary", () => {
    assert.throws(() => resolveBinary("gh", { dirs: ["/nowhere"], exists: () => false }), /gh not found in \/nowhere/);
  });
});


describe("bot attribution", () => {
  const botPrs = readFixture("bots-prs.json");
  const botComments = readFixture("bots-comments.json");
  const snapshot = (overrides = {}) => fixtureSnapshot({ pullRequests: botPrs, comments: botComments, ...overrides });
  const row = (bot, prs, pass, fail, noVerdict, passRate, reverts = 0, rollbacks = 0, approved = 0, changesRequired = 0) => ({
    bot, prs, qa: { pass, fail, noVerdict, passRate }, reverts: { reverts, rollbacks }, reviews: { approved, changesRequired },
  });

  it("counts builders and reviewers separately with exact aggregates", () => {
    const result = snapshot();
    assert.deepEqual(result.bots, [
      row("codex", 3, 2, 1, 0, 0.6667, 1, 0, 1),
      row("opus", 2, 1, 1, 0, 0.5, 0, 1, 0, 1),
      row("sonnet", 0, 0, 0, 0, null, 0, 0, 1),
      row("unknown", 6, 0, 0, 6, null),
    ]);
    assert.deepEqual(result.botAttribution, { attributed: 5, noSignal: 4, conflicting: 2, bySource: { label: 4, body: 1, author: 1 } });
    assert.equal(result.bots.reduce((sum, bot) => sum + bot.prs, 0), result.merges.total);
    for (const key of ["pass", "fail", "noVerdict"]) {
      assert.equal(result.bots.reduce((sum, bot) => sum + bot.qa[key], 0), result.qa[key]);
    }
    for (const key of ["reverts", "rollbacks"]) {
      assert.equal(result.bots.reduce((sum, bot) => sum + bot.reverts[key], 0), result.reverts[key]);
    }
    const { attributed, noSignal, conflicting } = result.botAttribution;
    assert.equal(attributed + noSignal + conflicting, result.merges.total);
    assert.equal(result.bots.at(-1).bot, "unknown");
    assert.deepEqual(Object.keys(result.bots[0]), ["bot", "prs", "qa", "reverts", "reviews"]);
  });

  it("is deterministic and keeps bodies and human identities private", () => {
    const json = serializeSnapshot(snapshot({ repository: "example/project" }));
    assert.equal(serializeSnapshot(snapshot({ repository: "example/project", pullRequests: [...botPrs].reverse(), comments: [...botComments].reverse() })), json);
    assert.doesNotMatch(json, /optomachina|Private fixture PR body text|Model: opus per Release|Codex review @/);
  });

  it("handles empty and entirely unattributable inputs", () => {
    const empty = snapshot({ pullRequests: [], comments: [] });
    assert.deepEqual(empty.bots, []);
    assert.deepEqual(empty.botAttribution, { attributed: 0, noSignal: 0, conflicting: 0, bySource: { label: 0, body: 0, author: 0 } });
    assert.deepEqual(computeBots(mergedInWindow([botPrs[2]], window), [], window), [row("unknown", 1, 0, 0, 1, null)]);
  });

  each([
    "Model: opus per Release",
    "_Model: opus_",
    "__model: opus__",
    "__Model: opus__",
    "__model:opus__ · x",
    "Model: opus.",
    "Model: opus, per Release",
    "Model: opus; per Release",
    "Model: opus: per Release",
    "Model: opus) per Release",
    "Model: opus· per Release",
    "**model:opus** · **Needs Blaine's card**",
    "Build model: **opus** (source: handoff)",
    "> - Builder model: opus",
    "+ Model: opus",
  ])("reads explicit body evidence: %s", (body) => {
    assert.deepEqual(attributePullRequest(normalizePullRequest({ body })), { bot: "opus", status: "attributed", sources: ["body"] });
  });

  each([
    "Model: model:codex",
    "- Model: model:codex",
    "Model: MODEL:Codex",
    "Model: model:codex.",
    "Model: model:codex (built by hand)",
    "Builder model: model:codex, per Release",
  ])("reads a body line that restates the label syntax: %s", (body) => {
    assert.deepEqual(attributePullRequest({ body }), { bot: "codex", status: "attributed", sources: ["body"] });
    assert.deepEqual(attributePullRequest({ body, labels: ["model:codex"] }), { bot: "codex", status: "attributed", sources: ["body", "label"] });
    assert.deepEqual(attributePullRequest({ body, labels: ["model:opus"] }), { bot: "unknown", status: "conflicting", sources: ["body", "label"] });
  });

  it("removes only one leading model: from the explicit token", () => {
    for (const body of ["Model: model:model:codex", "Model: model:", "Model: model: codex"]) {
      assert.deepEqual(attributePullRequest({ body }), { bot: "unknown", status: "conflicting", sources: ["body"] });
    }
  });

  it("preserves complete bot keys in body evidence", () => {
    assert.deepEqual(attributePullRequest({ body: "Model: z_bot", labels: ["model:z_bot"] }), { bot: "z_bot", status: "attributed", sources: ["body", "label"] });
    assert.deepEqual(attributePullRequest({ body: "Model: bot-" }), { bot: "bot-", status: "attributed", sources: ["body"] });
  });

  it("keeps bare trailing underscores in builder keys", () => {
    assert.deepEqual(attributePullRequest({ body: "Model: codex_" }), { bot: "codex_", status: "attributed", sources: ["body"] });
    assert.deepEqual(attributePullRequest({ body: "Model: codex_", labels: ["model:codex"] }), { bot: "unknown", status: "conflicting", sources: ["body", "label"] });
    assert.deepEqual(attributePullRequest({ body: "Model: z_bot_", labels: ["model:z_bot_"] }), { bot: "z_bot_", status: "attributed", sources: ["body", "label"] });
    assert.deepEqual(attributePullRequest({ body: "_Model: codex__" }), { bot: "unknown", status: "no_signal", sources: [] });
  });

  it("keeps an unpaired leading underscore, leaving the model prefix unmatched", () => {
    assert.deepEqual(attributePullRequest({ body: "_Model: opus" }), { bot: "unknown", status: "no_signal", sources: [] });
  });

  each(["codex/opus", "codex,opus", "opus|codex", ""])("treats invalid explicit model tokens as conflicting: %s", (token) => {
    const body = `Model: ${token}`;
    assert.deepEqual(attributePullRequest({ body }), { bot: "unknown", status: "conflicting", sources: ["body"] });
    assert.deepEqual(attributePullRequest({ body, labels: ["model:codex"] }), { bot: "unknown", status: "conflicting", sources: ["body", "label"] });
  });

  it("accepts explicit handoff lines and preserves keys without aliases", () => {
    assert.equal(attributePullRequest({ body: "Model: sonnet per Grok Bot triage handoff (no model label exists)" }).bot, "sonnet");
    assert.equal(attributePullRequest({ labels: ["model:Claude"] }).bot, "claude");
    assert.equal(attributePullRequest({ labels: ["model:z-bot.2_v1"] }).bot, "z-bot.2_v1");
  });

  each(["Codex and other reviewers: pending", "Opus review: CHANGES REQUIRED", "Generated with Claude Code", "Co-Authored-By: Claude ...", "```\nModel: opus\n```", "Model: unknown"])("ignores prose, fences and reserved keys: %s", (body) => {
    assert.deepEqual(attributePullRequest({ body }), { bot: "unknown", status: "no_signal", sources: [] });
  });

  it("reports every agreeing or conflicting source without choosing a winner", () => {
    assert.deepEqual(attributePullRequest(normalizePullRequest({ labels: ["model:codex", "model:codex"], body: "Model: codex", user: { login: "codex[bot]", type: "Bot" } })), { bot: "codex", status: "attributed", sources: ["author", "body", "label"] });
    assert.deepEqual(attributePullRequest({ labels: ["model:codex"], body: "Model: opus" }), { bot: "unknown", status: "conflicting", sources: ["body", "label"] });
    assert.deepEqual(attributePullRequest({ labels: ["model:codex", "model:opus"] }), { bot: "unknown", status: "conflicting", sources: ["label"] });
    assert.deepEqual(attributePullRequest({ labels: ["model:unknown", "model:invalid/key"] }), { bot: "unknown", status: "no_signal", sources: [] });
  });

  it("keeps only bot author keys during normalization", () => {
    for (const author of [{ login: "robot[bot]" }, { login: "robot", is_bot: true }]) {
      assert.equal(normalizePullRequest({ author }).authorBot, "robot");
    }
    const human = normalizePullRequest({ user: { login: "optomachina", type: "User" } });
    assert.equal(human.authorBot, null);
    assert.equal(human.body, "");
    assert.equal((JSON.stringify(human)).includes("optomachina"), false);
    assert.equal(attributePullRequest(human).status, "no_signal");
  });

  it("sorts bot keys in code-unit order with unknown last", () => {
    const input = ["z", "a_", "a-", "unknown"].map((bot, number) => normalizePullRequest({ number, labels: [`model:${bot}`] }));
    assert.deepEqual(computeBots(input, [], window).map((bot) => bot.bot), ["a-", "a_", "z", "unknown"]);
  });

  it("counts id-zero reviews individually and allows comments before window start", () => {
    const comment = { prNumber: 1, body: "Codex review @ deadbeef: APPROVED", created_at: "2026-09-01T00:00:00Z" };
    const bots = computeBots(mergedInWindow(botPrs, window), [comment, comment], window);
    assert.equal(bots[0].reviews.approved, 2);
  });
});

describe("review verdicts", () => {
  it("parses the standard first-line format", () => {
    assert.deepEqual(parseReviewVerdict("Codex review @ 1a2b3c4d: APPROVED"), { bot: "codex", round: "review", sha: "1a2b3c4d", verdict: "approved" });
    assert.deepEqual(parseReviewVerdict("\n**Opus re-review @ DEADBEEF: CHANGES REQUIRED** details"), { bot: "opus", round: "re-review", sha: "deadbeef", verdict: "changes_required" });
  });
  each(["z_bot", "bot-"])("preserves the complete reviewer key: %s", (bot) => {
    assert.deepEqual(parseReviewVerdict(`${bot} review @ deadbeef: APPROVED`), { bot, round: "review", sha: "deadbeef", verdict: "approved" });
  });
  each(["z_bot_", "codex_"])("keeps bare trailing underscores in reviewer keys: %s", (bot) => {
    assert.deepEqual(parseReviewVerdict(`${bot} review @ deadbeef: APPROVED`), { bot, round: "review", sha: "deadbeef", verdict: "approved" });
    assert.equal(parseReviewVerdict(`**${bot} review @ deadbeef: APPROVED**`)?.bot, bot);
  });
  each(["codex/opus", "codex,opus", "opus|codex"])("rejects ambiguous reviewer keys: %s", (bot) => {
    assert.equal(parseReviewVerdict(`${bot} review @ deadbeef: APPROVED`), null);
  });
  each([undefined, "Opus review: CHANGES REQUIRED @ 7717135c", "Intro\nCodex review @ deadbeef: APPROVED", "unknown review @ deadbeef: APPROVED", "Codex review @ abc: APPROVED", `Codex review @ ${"a".repeat(41)}: APPROVED`, "2bot review @ deadbeef: APPROVED"])("rejects nonstandard verdict %s", (body) => {
    assert.equal(parseReviewVerdict(body), null);
  });
});
