// @vitest-environment node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// js-yaml ships with eslint (a dev dependency); no direct dependency added.
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { buildMarkerDescription } from "./lib/jev-screen-marker.mjs";
import { APPROVAL_SCHEMA_ID, formatApprovalBlock } from "./approval-record.mjs";
import { computeDiffId } from "./emit-verdict.mjs";
import {
  APP_TRUSTED_VERIFIERS,
  CHECK_NAME,
  IDENTITY,
  MODE,
  TRUSTED_VERIFIERS,
  classifyPull,
  collectVerdicts,
  conclusionFor,
  bodyBuilders,
  deletedVerdictsFromEvent,
  evaluateVerdicts as evaluate,
  formatSummary,
  headDiffId,
  main,
  reasonCodes,
  runGate,
} from "./ovd-merge-gate.mjs";
// Exports added by the OVD-959 repair, read through the namespace so each
// regression test fails on its own (not the whole file) against older code.
import * as gate from "./ovd-merge-gate.mjs";
import { detect, loadConfig } from "./sensitive-class-detect.mjs";
import { extractVerdictBlocks, formatVerdictBlock } from "./verdict-schema.mjs";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const BASE = "e".repeat(40);
const DIFF = "c".repeat(64);
const OTHER_DIFF = "d".repeat(64);
const PATCH = "f".repeat(40);
const BOT = "overdrafter-verifier[bot]";
const NEW_HEAD = "9".repeat(40);
const BUILT_BY = "Built-by: bot=engineer model=model:codex";
const runUrl = (run) => `https://github.com/o/r/actions/runs/${run}`;

let nextId = 100;
const at = (id) => new Date(Date.UTC(2026, 9, 20, 0, 0, 0) + id * 1000).toISOString().replace(".000Z", "Z");

function verdict({ role = "verifier", result = "PASS", sha = HEAD, diffId = DIFF, login = BOT, checks = "green", notes, findings, runs = [1], supersedes, reason, family = role === "reviewer" ? "sonnet" : "claude", evidence } = {}) {
  const value = {
    schema: "overdrafter.verdict/v1",
    role,
    verdict: result,
    sha,
    patch_id: PATCH,
    diff_id: diffId,
    verifier: { id: role === "verifier" ? "astra-verifier" : family === "sonnet" ? "sonnet-reviewer" : "opus-reviewer", model_family: family, github_login: login },
    evidence: evidence ?? runs.map((run) => ({ kind: "ci-run", url: runUrl(run) })),
    notes: notes ?? (result === "PASS_NOTES" ? ["low: fine"] : []),
    readiness: { conflicts: 0, open_threads: 0, checks },
    timestamp: "2026-10-20T00:00:00Z",
  };
  if (role === "reviewer" || findings) value.findings = findings ?? [];
  if (supersedes !== undefined) Object.assign(value, { supersedes, reason });
  return value;
}

function comment(body, { id = nextId++, login = BOT, edited = false } = {}) {
  const created = at(id);
  return { id, body, created_at: created, updated_at: edited ? at(id + 5000) : created, user: { login } };
}

const posted = (value, options = {}) => comment(`**OverDrafter verdict**\n\n${formatVerdictBlock(value)}\n`, { login: value.verifier.github_login, ...options });
const approvalComment = (overrides = {}, options = {}) => comment(formatApprovalBlock({
  schema: APPROVAL_SCHEMA_ID, sha: HEAD, diff_id: DIFF, approver: "blaine", card_id: "K-959", timestamp: "2026-10-20T00:00:00Z", ...overrides,
}), { login: "optomachina", ...options });

const DOCS_FILES = [{ filename: "docs/notes.md", status: "modified" }];
const okClassification = (files = DOCS_FILES, classes = []) => ({
  status: "ok",
  sha: HEAD,
  classes,
  files: files.map((file) => ({ path: file.filename, classes: [], category: "docs", reasons: [] })),
  errors: [],
});

/** Evidence as runGate verifies it: every cited URL resolves at its verdict's SHA (tests of unverified evidence pass their own). */
function verifiedFor(comments) {
  const verified = {};
  for (const item of Array.isArray(comments) ? comments : []) {
    for (const text of extractVerdictBlocks(item?.body)) {
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        continue;
      }
      for (const evidence of Array.isArray(value?.evidence) ? value.evidence : []) (verified[value.sha] ??= []).push(evidence.url);
    }
  }
  return verified;
}

const baseInput = (overrides = {}) => {
  const input = {
    headSha: HEAD,
    liveHeadSha: HEAD,
    headDiffId: DIFF,
    comments: [posted(verdict()), posted(verdict({ role: "reviewer" }))],
    commits: [{ author: { login: "optomachina" }, committer: { login: "optomachina" } }],
    prAuthor: "optomachina",
    prBody: BUILT_BY,
    changedFiles: DOCS_FILES,
    classification: okClassification(),
    mode: "enforce",
    identity: "shared-account",
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "verifiedEvidence")) input.verifiedEvidence = verifiedFor(input.comments);
  return input;
};

const codes = (input) => reasonCodes(evaluate(input));

describe("constants", () => {
  it("enforces verifier-bot-only trust", () => {
    expect(MODE).toBe("enforce");
    expect(IDENTITY).toBe("app");
    expect([...TRUSTED_VERIFIERS]).toEqual([BOT]);
    expect([...APP_TRUSTED_VERIFIERS]).toEqual([BOT]);
    expect(CHECK_NAME).toBe("ovd-merge-gate");
    expect(Object.isFrozen(TRUSTED_VERIFIERS)).toBe(true);
  });
});

describe("evaluate (§6 item 1)", () => {
  it("passes a verifier PASS plus a reviewer PASS at the head with checks green", () => {
    const summary = evaluate(baseInput());
    expect(summary.reasons).toEqual([]);
    expect(summary.gate).toBe("pass");
    expect(summary.sha).toBe(HEAD);
    expect(summary.diff_id).toBe(DIFF);
    expect(summary.verifier_comment_id).not.toBeNull();
    expect(summary.reviewer_comment_ids).toHaveLength(1);
  });

  it("passes a verifier at an old SHA with an equal diff_id", () => {
    const summary = evaluate(baseInput({ comments: [posted(verdict({ sha: OLD })), posted(verdict({ role: "reviewer", sha: OLD }))] }));
    expect(summary.reasons).toEqual([]);
    expect(summary.gate).toBe("pass");
  });

  it.each(["pending", "red"])("fails checks_not_green when readiness.checks is %s", (checks) => {
    expect(codes(baseInput({ comments: [posted(verdict({ checks })), posted(verdict({ role: "reviewer" }))] }))).toEqual(["checks_not_green"]);
  });

  it("fails a PASS_NOTES with a high: note", () => {
    const summary = evaluate(baseInput({ comments: [posted(verdict({ result: "PASS_NOTES", notes: ["high: data loss"] })), posted(verdict({ role: "reviewer" }))] }));
    expect(summary.gate).toBe("fail");
    expect(reasonCodes(summary)).toContain("no_qa_pass_on_head");
  });

  it("fails a verifier at an old SHA with a different diff_id (diff_id_changed)", () => {
    expect(codes(baseInput({ comments: [posted(verdict({ sha: OLD, diffId: OTHER_DIFF })), posted(verdict({ role: "reviewer" }))] }))).toEqual(["diff_id_changed"]);
  });

  it.each([null, undefined, "", "zz"])("fails with error when the head diff_id is %j", (headDiffId) => {
    expect(codes(baseInput({ headDiffId, diffIdError: "fetch failed" }))).toContain("error");
  });

  it("fails a union conflict: a FAIL at another SHA with the same diff_id", () => {
    const comments = [posted(verdict({ sha: OLD, result: "FAIL" })), posted(verdict()), posted(verdict({ role: "reviewer" }))];
    expect(codes(baseInput({ comments }))).toContain("verdict_conflict");
  });

  it("fails a reviewer FAIL at another SHA with the same diff_id", () => {
    const comments = [posted(verdict()), posted(verdict({ role: "reviewer" })), posted(verdict({ role: "reviewer", result: "FAIL", sha: OLD }))];
    expect(codes(baseInput({ comments }))).toContain("verdict_conflict");
  });

  it("fails an edited trusted verdict (edited_verdict), even with an earlier PASS", () => {
    const comments = [posted(verdict()), posted(verdict({ role: "reviewer" })), posted(verdict({ result: "FAIL" }), { edited: true })];
    expect(codes(baseInput({ comments }))).toContain("edited_verdict");
  });

  it("clears an edited verdict once a fresh verdict of the same role is posted", () => {
    const comments = [posted(verdict({ result: "FAIL" }), { edited: true }), posted(verdict()), posted(verdict({ role: "reviewer" }))];
    expect(evaluate(baseInput({ comments })).gate).toBe("pass");
  });

  it("is not cleared by a later verdict for another head", () => {
    const comments = [posted(verdict()), posted(verdict({ role: "reviewer" })), posted(verdict({ result: "FAIL" }), { edited: true }), posted(verdict({ sha: OLD, diffId: OTHER_DIFF }))];
    expect(codes(baseInput({ comments }))).toContain("edited_verdict");
  });

  it("treats an edited trusted comment with unreadable JSON as possibly for the head", () => {
    const comments = [posted(verdict()), posted(verdict({ role: "reviewer" })), comment("```overdrafter-verdict\n{broken\n```", { edited: true })];
    expect(codes(baseInput({ comments }))).toContain("edited_verdict");
  });

  it("ignores an edited trusted verdict for another SHA and another diff_id", () => {
    const comments = [posted(verdict({ sha: OLD, diffId: OTHER_DIFF, result: "FAIL" }), { edited: true }), posted(verdict()), posted(verdict({ role: "reviewer" }))];
    expect(evaluate(baseInput({ comments })).gate).toBe("pass");
  });

  it("fails a reviewer high finding", () => {
    const findings = [{ severity: "high", file: "src/a.ts", summary: "breaks quotes" }];
    const summary = evaluate(baseInput({ comments: [posted(verdict()), posted(verdict({ role: "reviewer", findings }))] }));
    expect(reasonCodes(summary)).toEqual(["no_review_on_head"]);
  });

  it("fails a verifier high finding hidden behind a later clean PASS", () => {
    const findings = [{ severity: "high", file: "src/a.ts", summary: "breaks quotes" }];
    const comments = [posted(verdict({ findings })), posted(verdict()), posted(verdict({ role: "reviewer" }))];
    expect(codes(baseInput({ comments }))).toContain("no_qa_pass_on_head");
  });

  it("fails with no verdicts (no_qa_pass_on_head)", () => {
    expect(codes(baseInput({ comments: [] }))).toEqual(["no_qa_pass_on_head", "no_review_on_head"]);
  });

  it("fails with only a verifier (no_review_on_head)", () => {
    expect(codes(baseInput({ comments: [posted(verdict())] }))).toEqual(["no_review_on_head"]);
  });

  it("fails a verifier FAIL at the head", () => {
    expect(codes(baseInput({ comments: [posted(verdict({ result: "FAIL" })), posted(verdict({ role: "reviewer" }))] }))).toContain("no_qa_pass_on_head");
  });

  it("fails a FAIL then PASS at the same SHA without a valid supersede (verdict_conflict)", () => {
    const comments = [posted(verdict({ result: "FAIL" })), posted(verdict()), posted(verdict({ role: "reviewer" }))];
    expect(codes(baseInput({ comments }))).toEqual(["verdict_conflict"]);
  });

  it("lets an infra re-run with a new run id supersede a FAIL at the same SHA", () => {
    const fail = posted(verdict({ result: "FAIL", runs: [1] }));
    const comments = [fail, posted(verdict({ runs: [2], supersedes: fail.id, reason: "infra" })), posted(verdict({ role: "reviewer" }))];
    expect(evaluate(baseInput({ comments })).gate).toBe("pass");
  });

  it("refuses a supersede that cites only the FAIL's run ids", () => {
    const fail = posted(verdict({ result: "FAIL", runs: [1] }));
    const comments = [fail, posted(verdict({ runs: [1], supersedes: fail.id, reason: "infra" })), posted(verdict({ role: "reviewer" }))];
    expect(codes(baseInput({ comments }))).toContain("verdict_conflict");
  });

  it("refuses to supersede a product FAIL (it has findings)", () => {
    const fail = posted(verdict({ result: "FAIL", findings: [{ severity: "medium", file: "src/a.ts", summary: "wrong total" }] }));
    const comments = [fail, posted(verdict({ runs: [2], supersedes: fail.id, reason: "infra" })), posted(verdict({ role: "reviewer" }))];
    expect(codes(baseInput({ comments }))).toContain("verdict_conflict");
  });

  it("refuses a supersede at another SHA", () => {
    const fail = posted(verdict({ result: "FAIL", sha: OLD }));
    const comments = [fail, posted(verdict({ runs: [2], supersedes: fail.id, reason: "infra" })), posted(verdict({ role: "reviewer" }))];
    expect(codes(baseInput({ comments }))).toContain("verdict_conflict");
  });

  it("ignores an untrusted author", () => {
    const comments = [posted(verdict({ login: "mallory" })), posted(verdict({ role: "reviewer", login: "mallory" }))];
    const summary = evaluate(baseInput({ comments }));
    expect(reasonCodes(summary)).toEqual(["no_qa_pass_on_head", "no_review_on_head"]);
    expect(summary.ignored.map((item) => item.code)).toEqual(["untrusted_author", "untrusted_author"]);
  });

  it("ignores an untrusted FAIL (it cannot block either)", () => {
    const comments = [posted(verdict()), posted(verdict({ role: "reviewer" })), posted(verdict({ result: "FAIL", login: "mallory" }))];
    expect(evaluate(baseInput({ comments })).gate).toBe("pass");
  });

  it("ignores a verdict whose github_login is not the comment author", () => {
    const forged = comment(formatVerdictBlock(verdict()), { login: "mallory" });
    const summary = evaluate(baseInput({ comments: [forged, posted(verdict({ role: "reviewer" }))] }));
    expect(reasonCodes(summary)).toEqual(["no_qa_pass_on_head"]);
    expect(summary.ignored.map((item) => item.code)).toContain("author_mismatch");
  });

  it("ignores malformed blocks from untrusted authors", () => {
    const comments = [comment("```overdrafter-verdict\n{nope\n```", { login: "mallory" }), comment(formatVerdictBlock({ ...verdict({ login: "mallory" }), extra: 1 }), { login: "mallory" }), posted(verdict()), posted(verdict({ role: "reviewer" }))];
    const summary = evaluate(baseInput({ comments }));
    expect(summary.gate).toBe("pass");
    expect(summary.ignored.map((item) => item.code)).toEqual(["invalid_json", "schema_error"]);
  });

  it.each([
    ["unparseable JSON", () => comment("```overdrafter-verdict\n{nope\n```")],
    ["a schema error", () => comment(formatVerdictBlock({ ...verdict({ result: "FAIL" }), extra: 1 }))],
    ["missing comment timestamps", () => ({ ...posted(verdict({ result: "FAIL" })), updated_at: undefined })],
  ])("fails closed on a trusted block with %s that may be for the head (verdict_schema_error)", (_name, make) => {
    const comments = [posted(verdict()), posted(verdict({ role: "reviewer" })), make()];
    expect(codes(baseInput({ comments }))).toEqual(["verdict_schema_error"]);
  });

  it("clears a trusted malformed block once a fresher verdict is posted, and ignores one for another head", () => {
    const fresh = [comment(formatVerdictBlock({ ...verdict({ result: "FAIL" }), extra: 1 })), posted(verdict()), posted(verdict({ role: "reviewer" }))];
    expect(evaluate(baseInput({ comments: fresh })).gate).toBe("pass");
    const other = [posted(verdict()), posted(verdict({ role: "reviewer" })), comment(formatVerdictBlock({ ...verdict({ sha: OLD, diffId: OTHER_DIFF }), extra: 1 }))];
    expect(evaluate(baseInput({ comments: other })).gate).toBe("pass");
  });

  it("collects every block, not just the latest verifier verdict", () => {
    const body = [formatVerdictBlock(verdict({ findings: [{ severity: "high", file: "a.ts", summary: "x" }] })), formatVerdictBlock(verdict())].join("\n\n");
    const { entries } = collectVerdicts([comment(body)], HEAD);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.block)).toEqual([0, 1]);
  });
});

describe("fail closed on missing or unknown inputs (OVD-959)", () => {
  it.each([
    ["no head sha", { headSha: undefined }, "missing_input"],
    ["a malformed head sha", { headSha: "HEAD" }, "missing_input"],
    ["no live head", { liveHeadSha: undefined }, "missing_input"],
    ["a moved head", { liveHeadSha: OLD }, "stale_sha"],
    ["no comments", { comments: undefined }, "missing_input"],
    ["no PR author", { prAuthor: undefined }, "missing_input"],
    ["an unknown mode", { mode: "off" }, "missing_input"],
    ["a missing mode", { mode: undefined }, "missing_input"],
    ["an unknown identity", { identity: "none" }, "missing_input"],
    ["a missing diff_id", { headDiffId: undefined }, "error"],
  ])("fails with %s", (_name, overrides, code) => {
    const summary = evaluate(baseInput(overrides));
    expect(summary.gate).toBe("fail");
    expect(reasonCodes(summary)).toContain(code);
  });

  it("fails when called with nothing", () => {
    expect(evaluate().gate).toBe("fail");
    expect(evaluate({}).gate).toBe("fail");
    expect(evaluate(null).gate).toBe("fail");
    expect(evaluate("pass").gate).toBe("fail");
  });

  it("treats an unknown mode as enforce, so the conclusion is failure, not neutral", () => {
    expect(conclusionFor(evaluate(baseInput({ mode: "off" }))).conclusion).toBe("failure");
  });

  it.each([
    ["missing (undefined)", undefined],
    ["absent (null)", null],
    ["not an object", "ok"],
    ["status missing", { sha: HEAD, classes: [], files: [{ path: "docs/notes.md" }] }],
    ["status error", { ...okClassification(), status: "error", errors: ["GitHub API error"] }],
    ["status unknown", { ...okClassification(), status: "unknown" }],
    ["status partial", { ...okClassification(), status: "partial" }],
    ["status OK in another case", { ...okClassification(), status: "OK" }],
    ["status true", { ...okClassification(), status: true }],
    ["ok for another sha (stale)", { ...okClassification(), sha: OLD }],
    ["ok without a sha", { ...okClassification(), sha: null }],
    ["ok without classes (partial)", { ...okClassification(), classes: undefined }],
    ["ok without files (partial)", { ...okClassification(), files: undefined }],
    ["ok that misses a changed file (partial)", okClassification([])],
  ])("classifier result %s is classifier_error and not auto-merge safe", (_name, classification) => {
    const summary = evaluate(baseInput({ classification }));
    expect(summary.gate).toBe("fail");
    expect(reasonCodes(summary)).toContain("classifier_error");
    expect(summary.automerge).toBe("needs_blaine");
  });

  it("is classifier_error when the changed-file list is missing", () => {
    const summary = evaluate(baseInput({ changedFiles: undefined }));
    expect(reasonCodes(summary)).toContain("classifier_error");
    expect(summary.automerge).toBe("needs_blaine");
  });

  it("is missing_input in stage B when the commit list is missing", () => {
    const comments = [posted(verdict({ login: BOT })), posted(verdict({ role: "reviewer", login: BOT }))];
    expect(codes(baseInput({ identity: "app", comments, commits: undefined }))).toContain("missing_input");
  });
});

describe("sensitive changes need an approval record (§6 item 2)", () => {
  const config = loadConfig().config;
  const classifyFiles = (files, sha = HEAD) => detect({ files, config, sha, readHeadFile: async () => "select 1;\n" });
  const run = async (files, comments = [posted(verdict()), posted(verdict({ role: "reviewer" }))]) => {
    const classification = await classifyFiles(files);
    return evaluate(baseInput({ changedFiles: files, classification, comments }));
  };

  it("loads the detector config from this checkout", () => {
    expect(config).toBeTruthy();
  });

  it.each([
    [".github/workflows/x.yml", "infra_ci"],
    [".github/CODEOWNERS", "infra_ci"],
    ["supabase/migrations/20261020000000_x.sql", "migrations"],
    ["src/lib/stripe-checkout.ts", "payments"],
    ["src/lib/helpers.ts", "unclassified"],
  ])("%s without an approval is approval_missing:%s", async (filename, cls) => {
    const summary = await run([{ filename, status: "modified" }]);
    expect(summary.gate).toBe("fail");
    expect(reasonCodes(summary)).toContain(`approval_missing:${cls}`);
    expect(summary.automerge).toBe("needs_blaine");
  });

  it("counts a .github change as infra_ci even when it is only the previous name of a rename", async () => {
    const files = [{ filename: "docs/moved.md", status: "renamed", previous_filename: ".github/ISSUE_TEMPLATE/x.md" }];
    const summary = evaluate(baseInput({ changedFiles: files, classification: okClassification(files) }));
    expect(reasonCodes(summary)).toContain("approval_missing:infra_ci");
  });

  it("fails with an approval for another SHA and a different diff_id", async () => {
    const comments = [posted(verdict()), posted(verdict({ role: "reviewer" })), approvalComment({ sha: OLD, diff_id: OTHER_DIFF })];
    expect(reasonCodes(await run([{ filename: ".github/workflows/x.yml", status: "modified" }], comments))).toContain("approval_missing:infra_ci");
  });

  it("passes with an approval at another SHA with an equal diff_id", async () => {
    const comments = [posted(verdict()), posted(verdict({ role: "reviewer" })), approvalComment({ sha: OLD })];
    const summary = await run([{ filename: ".github/workflows/x.yml", status: "modified" }], comments);
    expect(summary.reasons).toEqual([]);
    expect(summary.approval_comment_id).toBe(comments[2].id);
    expect(summary.automerge).toBe("needs_blaine");
  });

  it("fails with an approval from an untrusted login", async () => {
    const comments = [posted(verdict()), posted(verdict({ role: "reviewer" })), approvalComment({}, { login: "mallory" })];
    expect(reasonCodes(await run([{ filename: "supabase/migrations/1_x.sql", status: "added" }], comments))).toContain("approval_missing:migrations");
  });

  it("fails with an edited approval", async () => {
    const comments = [posted(verdict()), posted(verdict({ role: "reviewer" })), approvalComment({}, { edited: true })];
    expect(reasonCodes(await run([{ filename: "supabase/migrations/1_x.sql", status: "added" }], comments))).toContain("approval_missing:migrations");
  });

  it("needs no approval for a docs-only PR, and automerge is needs_release", async () => {
    const summary = await run([{ filename: "docs/notes.md", status: "modified" }]);
    expect(summary.reasons).toEqual([]);
    expect(summary.sensitive_classes).toEqual([]);
    expect(summary.automerge).toBe("needs_release");
  });

  it("is needs_blaine for more than one class, and lists every missing class", async () => {
    const summary = await run([{ filename: "supabase/migrations/1_x.sql", status: "added" }, { filename: ".github/workflows/x.yml", status: "modified" }]);
    expect(summary.automerge).toBe("needs_blaine");
    expect(reasonCodes(summary)).toEqual(expect.arrayContaining(["approval_missing:schema", "approval_missing:migrations", "approval_missing:infra_ci"]));
  });

  it("is classifier_error when the detector cannot read a changed SQL file", async () => {
    const files = [{ filename: "supabase/migrations/1_x.sql", status: "added" }];
    const classification = await detect({ files, config, sha: HEAD, readHeadFile: async () => { throw new Error("404"); } });
    expect(classification.status).toBe("error");
    expect(reasonCodes(evaluate(baseInput({ changedFiles: files, classification })))).toContain("classifier_error");
  });

  it("is classifier_error when the classifier throws", async () => {
    const throwing = await classifyPull({ client: {}, repo: "o/r", pr: 1, headSha: HEAD, loadConfigImpl: () => { throw new Error("boom"); } });
    expect(throwing.classification.status).toBe("error");
    expect(reasonCodes(evaluate(baseInput({ classification: throwing.classification, changedFiles: throwing.files })))).toContain("classifier_error");
    const badConfig = await classifyPull({ client: {}, repo: "o/r", pr: 1, headSha: HEAD, loadConfigImpl: () => ({ config: null, errors: ["bad"] }) });
    expect(reasonCodes(evaluate(baseInput({ classification: badConfig.classification, changedFiles: DOCS_FILES })))).toContain("classifier_error");
  });

  it("is classifier_error when the detector itself throws mid-run", async () => {
    const api = fakeGithub({ files: DOCS_FILES });
    const result = await classifyPull({ client: api.client, repo: "o/r", pr: 7, headSha: HEAD, detectImpl: async () => { throw new Error("detector crashed"); } });
    expect(result.classification.status).toBe("error");
    expect(result.classification.errors.join(" ")).toContain("detector crashed");
  });
});

describe("identity (§6 item 3)", () => {
  it("legacy history evaluation retains shared-account diagnostics for bot verdicts and the summary says shared-account (not enforced)", () => {
    const summary = evaluate(baseInput());
    expect(summary.gate).toBe("pass");
    expect(summary.identity).toBe("shared-account");
    expect(summary.identity_note).toContain("identity: shared-account (not enforced)");
    expect(summary.identity_note).toContain("verifier ≠ author not enforced (single identity)");
  });

  it("stage B: an optomachina verdict is ignored (verifier_is_merger)", () => {
    const summary = evaluate(baseInput({ identity: "app", comments: [posted(verdict({login:"optomachina"})), posted(verdict({role:"reviewer",login:"optomachina"}))] }));
    expect(summary.gate).toBe("fail");
    expect(summary.ignored.map((item) => item.code)).toEqual(["verifier_is_merger", "verifier_is_merger"]);
    expect(reasonCodes(summary)).toEqual(["no_qa_pass_on_head", "no_review_on_head"]);
  });

  it("stage B: a verdict from a login that authored or committed a PR commit is verifier_not_independent", () => {
    const comments = [posted(verdict({ login: BOT })), posted(verdict({ role: "reviewer", login: BOT }))];
    for (const commits of [[{ author: { login: BOT }, committer: { login: "web-flow" } }], [{ author: { login: "optomachina" }, committer: { login: BOT } }]]) {
      expect(codes(baseInput({ identity: "app", comments, commits }))).toContain("verifier_not_independent");
    }
    expect(codes(baseInput({ identity: "app", comments, prAuthor: BOT }))).toContain("verifier_not_independent");
  });

  it("stage B: an overdrafter-verifier[bot] verdict on an optomachina PR counts", () => {
    const comments = [posted(verdict({ login: BOT })), posted(verdict({ role: "reviewer", login: BOT }))];
    const summary = evaluate(baseInput({ identity: "app", comments }));
    expect(summary.reasons).toEqual([]);
    expect(summary.identity_note).toBe("identity: app (enforced)");
  });

  it("the bot is trusted in every identity mode", () => {
    const comments = [posted(verdict({ login: BOT })), posted(verdict({ role: "reviewer", login: BOT }))];
    expect(codes(baseInput({ comments }))).toEqual([]);
  });

  describe("the trust list is not read from env or repo variables", () => {
    const names = ["TRUSTED_VERIFIERS", "VERDICT_TRUSTED_LOGINS", "OVD_TRUSTED_VERIFIERS", "OVD_MERGE_GATE_TRUSTED", "TRUSTED_APPROVERS", "OVD_MERGE_GATE_MODE", "MODE", "IDENTITY"];
    const saved = {};
    afterEach(() => {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    });

    it("ignores trust-list variables in process.env and in the CLI env", async () => {
      for (const name of names) {
        saved[name] = process.env[name];
        process.env[name] = name.includes("MODE") ? "enforce" : "mallory";
      }
      const comments = [posted(verdict({ login: "mallory" })), posted(verdict({ role: "reviewer", login: "mallory" })), approvalComment({}, { login: "mallory" })];
      expect(codes(baseInput({ comments }))).toEqual(["no_qa_pass_on_head", "no_review_on_head"]);
      const api = fakeGithub({ comments });
      const out = [];
      const env = { GITHUB_TOKEN: "t", ...Object.fromEntries(names.map((name) => [name, "mallory"])) };
      const code = await main(["evaluate", "--repo", "o/r", "--pr", "7", "--sha", HEAD, "--json"], { env, fetchImpl: api.fetch, stdout: { write: (text) => out.push(text) }, git: fakeGit(), diff: () => DIFF, classify: docsClassify });
      expect(code).toBe(1);
      const summary = JSON.parse(out.join(""));
      expect(summary.mode).toBe("enforce");
      expect(reasonCodes(summary)).toEqual(expect.arrayContaining(["no_qa_pass_on_head", "no_review_on_head", "sonnet_not_pass", "qa_not_pass"]));
    });

    it("reads no trust, mode or identity setting from env in the source, and only the kill switch comes from Actions variables", () => {
      const source = readFileSync(new URL("./ovd-merge-gate.mjs", import.meta.url), "utf8");
      const envReads = [...source.matchAll(/env\.([A-Z_]+)/g)].map((match) => match[1]);
      expect(new Set(envReads)).toEqual(new Set(["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_API_URL", "GITHUB_REPOSITORY", "GITHUB_EVENT_PATH", "DOOR_AUTOMERGE", "OVD_AUTOMERGE_DISABLED"]));
      expect(source).not.toMatch(/process\.env\[/);
      const workflow = readFileSync(new URL("../.github/workflows/ovd-merge-gate.yml", import.meta.url), "utf8");
      expect([...workflow.matchAll(/vars\.([A-Z_]+)/g)].map((match)=>match[1])).toEqual(["DOOR_AUTOMERGE", "OVD_AUTOMERGE_DISABLED"]);
    });
  });
});

describe("conclusion (§6 item 4)", () => {
  const passing = evaluate(baseInput());
  const failing = evaluate(baseInput({ comments: [] }));
  const odd = [null, undefined, {}, { gate: "pass" }, { gate: "pass", reasons: [{ code: "error", detail: "x" }] }, { gate: "neutral", reasons: [] }, { gate: "skipped" }];

  it("enforce mode is only ever success or failure", () => {
    expect(conclusionFor(passing, "enforce").conclusion).toBe("success");
    expect(conclusionFor(failing, "enforce").conclusion).toBe("failure");
    for (const summary of odd) {
      const { conclusion } = conclusionFor(summary, "enforce");
      expect(["success", "failure"]).toContain(conclusion);
      expect(conclusion).not.toMatch(/neutral|skipped/);
    }
    for (const summary of odd.slice(2)) expect(conclusionFor(summary, "enforce").conclusion).toBe("failure");
  });

  it("report mode writes neutral with REPORT: would block: <codes>, or success", () => {
    expect(conclusionFor(passing, "report")).toEqual({ conclusion: "success", title: "ovd-merge-gate: pass (report mode)" });
    expect(conclusionFor(failing, "report")).toEqual({ conclusion: "neutral", title: "REPORT: would block: no_qa_pass_on_head, no_review_on_head" });
  });

  it("an unknown mode is treated as enforce", () => {
    expect(conclusionFor(failing, "bogus").conclusion).toBe("failure");
    expect(conclusionFor({ ...failing, mode: undefined }).conclusion).toBe("failure");
  });
});

describe("workflow YAML (§6 item 5)", () => {
  const workflow = yaml.load(readFileSync(new URL("../.github/workflows/ovd-merge-gate.yml", import.meta.url), "utf8"));
  const jobs = Object.entries(workflow.jobs);
  const steps = jobs.flatMap(([, job]) => job.steps ?? []);

  it("triggers on pull_request_target, issue_comment, workflow_dispatch (pr) and merge_group", () => {
    expect(Object.keys(workflow.on)).toEqual(["pull_request_target", "issue_comment", "workflow_dispatch", "merge_group"]);
    expect(workflow.on.pull_request_target.types).toEqual(["opened", "synchronize", "reopened", "ready_for_review", "edited"]);
    expect(workflow.on.issue_comment.types).toEqual(["created", "edited", "deleted"]);
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(["pr"]);
    expect(workflow.on.merge_group.types).toEqual(["checks_requested"]);
    expect(workflow.on.pull_request).toBeUndefined();
  });

  it("has no paths filter on any trigger", () => {
    for (const trigger of Object.values(workflow.on)) {
      for (const key of ["paths", "paths-ignore", "branches", "branches-ignore"]) expect(trigger?.[key]).toBeUndefined();
    }
  });

  it("defaults to no permissions and scopes permissions to each job", () => {
    expect(workflow.permissions).toEqual({});
    for (const [key, job] of jobs) expect(job.permissions).toEqual(key.endsWith("queue") ? { checks: "write" } : { checks: "write", actions: "read", "pull-requests": key.endsWith("writer") ? "write" : "read", contents: key.endsWith("writer") ? "write" : "read" });
  });

  it("separates PR writer/history from the checkout-free queue job", () => {
    expect(jobs.map(([key]) => key)).toEqual(["ovd-merge-gate-writer", "ovd-merge-gate-history", "ovd-merge-gate-queue"]);
    for (const [key, job] of jobs) {
      expect(key).not.toBe(CHECK_NAME);
      expect(job.name).toBe(key);
      // F1: the writer must run even when the history job failed; no condition may skip either job.
      expect(job.if).toBe(key === "ovd-merge-gate-writer" ? "${{ always() && github.event_name != 'merge_group' }}" : key.endsWith("queue") ? "github.event_name == 'merge_group'" : "github.event_name != 'merge_group'");
    }
  });

  it("passes the history job result to the writer (F1)", () => {
    const writer = jobs.find(([key]) => key === "ovd-merge-gate-writer")[1];
    const step = writer.steps.find((item) => item.name === "Write ovd-merge-gate");
    expect(step.env.HISTORY_RESULT).toBe("${{ needs.ovd-merge-gate-history.result }}");
    expect(step.run).toContain('write --pr "$pr" --history-result "$HISTORY_RESULT"');
  });

  it("queues the writer per PR without cancelling, after the history job", () => {
    const writer = workflow.jobs["ovd-merge-gate-writer"];
    expect(writer.concurrency.group).toBe("ovd-merge-gate-${{ github.event.pull_request.number || github.event.issue.number || inputs.pr || github.sha }}");
    expect(writer.concurrency["cancel-in-progress"]).toBe(false);
    expect(writer.needs).toBe("ovd-merge-gate-history");
  });

  it("never lets a newer run replace the history job: no workflow-level or history concurrency group (finding 1)", () => {
    expect(workflow.concurrency).toBeUndefined();
    const history = workflow.jobs["ovd-merge-gate-history"];
    expect(history.concurrency).toBeUndefined();
    expect(history.needs).toBeUndefined();
    const run = history.steps.find((step) => step.run?.includes("ovd-merge-gate.mjs")).run;
    expect(run).toContain("node scripts/ovd-merge-gate.mjs record --pr \"$pr\"");
    expect(run).not.toContain("merge_group)");
    for (const event of ["pull_request_target)", "issue_comment)", "workflow_dispatch)"]) expect(run).toContain(event);
    expect(run).toContain("refs/heads/$DEFAULT_BRANCH");
  });

  it("checks out only the default branch in each job, never the head ref, and fetches no history into it", () => {
    const checkouts = steps.filter((step) => String(step.uses ?? "").startsWith("actions/checkout"));
    expect(checkouts).toHaveLength(2);
    for (const [, job] of jobs) expect(job.steps.filter((step) => String(step.uses ?? "").startsWith("actions/checkout"))).toHaveLength(job.name.endsWith("queue") ? 0 : 1);
    for (const step of checkouts) {
      expect(step.with["fetch-depth"]).toBeUndefined();
      expect(step.if).toBeUndefined();
      expect(step.with.ref).toBeUndefined();
      expect(step.with.repository).toBeUndefined();
      expect(step.with["persist-credentials"]).toBe(false);
      expect(JSON.stringify(step)).not.toMatch(/head|pull_request|refs\/pull|merge_group|github\.sha|github\.ref/);
    }
  });

  it("never checks out, installs or runs PR code in a run step, and passes event values through env", () => {
    for (const step of steps.filter((item) => item.run)) {
      expect(step.run).not.toMatch(/gh pr checkout|git checkout|git switch|npm (ci|install)|refs\/pull|\$\{\{/);
    }
    for (const step of steps) expect(step.if).toBeUndefined();
  });

  it("runs the default-branch script for PR events", () => {
    const run = steps.find((step) => step.run?.includes("ovd-merge-gate.mjs")).run;

    expect(run).toContain("node scripts/ovd-merge-gate.mjs write --pr \"$pr\"");
    for (const event of ["pull_request_target)", "issue_comment)", "workflow_dispatch)"]) expect(run).toContain(event);
    expect(run).toContain("refs/heads/$DEFAULT_BRANCH");
  });
});

// ----------------------------------------------------------------- IO

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
}

/** GitHub Actions check runs (CI) on a SHA, as the Checks API lists them. */
const ciCheckRuns = (sha, runs) => runs.map((run) => ({ id: 5000 + run, name: `ci-${run}`, head_sha: sha, app: { id: 15368 }, details_url: `${runUrl(run)}/job/${9000 + run}`, html_url: `https://github.com/o/r/runs/${7000 + run}` }));

/**
 * A fake GitHub API. Posted check runs are kept and listed again (by SHA,
 * check_name), like the real Checks API; `checkRuns` are earlier runs listed
 * on every SHA; `ciRuns` maps a SHA to the Actions run ids that reported on it.
 */
const greenChecks = (sha = HEAD) => ["ci", "provider-go-live", "secret-scan"].map((name, id) => ({name, id, head_sha:sha, app:{id:15368}, status:"completed", conclusion:"success"}));
const jevStatus = (sha = HEAD, tier = "low", jevTier = "low") => ({
  context:"jev-screen", creator:{login:"optomachina"}, state:"success", url:`https://api.github.com/repos/o/r/statuses/${sha}`,
  description:buildMarkerDescription({tier,jevTier,confidence:0.9,model:"jev-1.13.0",questionHash:"1234abcd",stateHash:"x".repeat(43)}),
});

function fakeGithub({ head = HEAD, headAfter, body, content = "plain docs content", comments = [], files = DOCS_FILES, changedFiles = files.length, labels = [], statuses, commits = [{ author: { login: "optomachina" }, committer: { login: "optomachina" } }], checkRuns = [], ciRuns = {}, stored = [], fail = [], workflowRun = {}, provenance = {} } = {}) {
  const requests = [];
  const urls = [];
  const posts = [];
  let pullReads = 0;
  const listRuns = (sha, name) => [...checkRuns, ...stored.filter((run) => run.head_sha === sha), ...ciCheckRuns(sha, ciRuns[sha] ?? [1, 2, 3]), ...greenChecks(sha)]
    .filter((run) => name === null || run.name === name);
  const fetchImpl = async (url, options = {}) => {
    const { pathname, search, searchParams } = new URL(url);
    const method = options.method ?? "GET";
    requests.push(`${method} ${pathname}`);
    urls.push(`${method} ${pathname}${search}`);
    if (fail.some((part) => pathname.includes(part))) return response(500, { message: "boom" });
    if (method === "POST" && pathname === "/graphql") return response(200, {data:{repository:{pullRequest:{headRefOid:head,reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}}}}}});
    if (method === "POST" && pathname === "/repos/o/r/check-runs") {
      const posted = JSON.parse(options.body);
      // GitHub rejects a check run whose output.text is over 65535 characters.
      if ((posted.output?.text ?? "").length > 65535) return response(422, { message: "output.text too long" });
      posts.push(posted);
      stored.push({ check_suite: { id: 42 }, id: 900 + stored.length, app: { id: 15368 }, ...posted });
      return response(201, { id: 1 });
    }
    if (pathname.startsWith("/repos/o/r/contents/")) return response(200, content);
    if (pathname === "/repos/o/r") return response(200, { default_branch: "main" });
    if (pathname === "/repos/o/r/actions/runs") return response(200, { workflow_runs: [{ check_suite_id: 42, path: ".github/workflows/ovd-merge-gate.yml", head_branch: "main", event: "issue_comment", ...provenance }] });
    if (/^\/repos\/o\/r\/actions\/runs\/\d+$/.test(pathname)) {
      const id = Number(pathname.split("/").at(-1));
      const sha = Object.keys(ciRuns).find((sha) => ciRuns[sha].includes(id)) ?? HEAD;
      return response(200, { head_sha: sha, path: ".github/workflows/ci.yml", conclusion: "success", ...workflowRun });
    }
    if (pathname === "/repos/o/r/pulls/7") {
      pullReads += 1;
      const sha = headAfter && pullReads > 1 ? headAfter : head;
      return response(200, { head: { sha }, base: { ref: "main", sha: BASE }, user: { login: "optomachina" }, body: body ?? BUILT_BY, state:"open", draft:false, mergeable:true, mergeable_state:"clean", labels, commits: commits.length, changed_files: changedFiles });
    }
    if (pathname === "/repos/o/r/issues/7/comments") return response(200, comments);
    if (pathname === "/repos/o/r/pulls/7/commits") return response(200, commits);
    if (pathname === "/repos/o/r/pulls/7/files") return response(200, files);
    if (pathname.startsWith(`/repos/o/r/commits/`) && pathname.endsWith("/check-runs")) return response(200, { check_runs: listRuns(pathname.split("/")[5], searchParams.get("check_name")) });
    if (pathname.endsWith("/status") || pathname.endsWith("/statuses")) return response(200, statuses ?? [jevStatus(head)]);
    return response(404, { message: `no route ${pathname}` });
  };
  const client = {
    json: async (p) => (await fetchImpl(`https://api.test${p}`)).json(),
    raw: async (p) => (await fetchImpl(`https://api.test${p}`)).text(),
    post: async (p, body) => (await fetchImpl(`https://api.test${p}`, {method:"POST", body:JSON.stringify(body)})).json(),
  };
  return { fetch: fetchImpl, client, requests, urls, posts, stored };
}

function fakeGit(calls = []) {
  return (args, options = {}) => {
    calls.push({ args, env: options.env ?? {} });
    if (args.includes("rev-parse")) return `${BASE}\n`;
    return "";
  };
}

const docsClassify = async ({ headSha }) => ({ classification: okClassification(DOCS_FILES, []), files: DOCS_FILES, headSha });

const passingComments = () => [posted(verdict()), posted(verdict({ role: "reviewer" }))];

async function runCli(args, api, overrides = {}) {
  const out = [];
  const err = [];
  const code = await main(args, {
    env: { GITHUB_TOKEN: "test-token", GITHUB_REPOSITORY: "o/r", ...overrides.env },
    fetchImpl: api.fetch,
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    git: overrides.git ?? fakeGit(),
    diff: overrides.diff ?? (() => DIFF),
    classify: overrides.classify ?? docsClassify,
    merge: overrides.merge,
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("IO wrapper and CLI", () => {
  it("evaluate --json prints the summary and exits 0 on pass", async () => {
    const api = fakeGithub({ comments: passingComments() });
    const { code, out } = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], api);
    expect(code).toBe(0);
    const summary = JSON.parse(out);
    expect(summary).toMatchObject({ gate: "pass", sha: HEAD, diff_id: DIFF, mode: "enforce", identity: "app", automerge: "eligible" });
    expect(api.posts).toEqual([]);
  });

  it("evaluate exits 1 and reports stale_sha when --sha is not the PR head", async () => {
    const api = fakeGithub({ comments: passingComments(), head: OLD });
    const { code, out } = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], api);
    expect(code).toBe(1);
    expect(reasonCodes(JSON.parse(out))).toContain("stale_sha");
  });

  it.each([
    [[], "command must be"],
    [["evaluate", "--pr", "7"], "needs --sha"],
    [["evaluate", "--pr", "x", "--sha", HEAD], "--pr must be"],
    [["evaluate", "--pr", "7", "--sha", "HEAD"], "--sha must be"],
    [["write"], "needs --pr"],
    [["merge-group"], "needs --sha"],
    [["evaluate", "--pr", "7", "--sha", HEAD, "--bogus"], "unknown argument"],
  ])("usage error %j exits 2", async (args, message) => {
    const { code, err } = await runCli(args, fakeGithub());
    expect(code).toBe(2);
    expect(err).toContain(message);
  });

  it("write evaluates the live head and writes an enforced failure", async () => {
    const api = fakeGithub({ comments: [] });
    const { code } = await runCli(["write", "--pr", "7"], api);
    expect(code).toBe(0);
    expect(api.posts).toHaveLength(1);
    expect(api.posts[0]).toMatchObject({ name: "ovd-merge-gate", head_sha: HEAD, status: "completed", conclusion: "failure" });
    expect(api.posts[0].output.title).toContain("ovd-merge-gate: fail:");
    expect(api.posts[0].output.summary).toContain("identity: app (enforced)");
  });

  it("write writes success when the gate passes", async () => {
    const api = fakeGithub({ comments: passingComments() });
    await runCli(["write", "--pr", "7"], api);
    expect(api.posts[0].conclusion).toBe("success");
  });

  it("write re-reads the head right before writing and writes nothing when it moved", async () => {
    const api = fakeGithub({ comments: passingComments(), headAfter: OLD });
    const { code, out } = await runCli(["write", "--pr", "7"], api);
    expect(code).toBe(0);
    expect(api.posts).toEqual([]);
    expect(out).toContain("head moved");
    const reads = api.requests.filter((request) => request === "GET /repos/o/r/pulls/7");
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(api.requests.at(-1)).toBe("GET /repos/o/r/pulls/7");
  });

  it("merge-group writes success on the merge group sha", async () => {
    const api = fakeGithub();
    const { code } = await runCli(["merge-group", "--sha", OLD], api);
    expect(code).toBe(0);
    expect(api.posts).toHaveLength(1);
    expect(api.posts[0]).toMatchObject({ name: "ovd-merge-gate", head_sha: OLD, conclusion: "success" });
  });

  it("exits 1 and writes nothing when the PR cannot be read", async () => {
    const api = fakeGithub({ fail: ["/pulls/7"] });
    const { code } = await runCli(["write", "--pr", "7"], api);
    expect(code).toBe(1);
    expect(api.posts).toEqual([]);
  });

  it("fails closed when comments cannot be read (missing_input)", async () => {
    const api = fakeGithub({ comments: passingComments(), fail: ["/issues/7/comments"] });
    const { out } = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], api);
    expect(reasonCodes(JSON.parse(out))).toContain("missing_input");
  });

  it("fails closed when earlier gate check runs cannot be read (missing_input)", async () => {
    const api = fakeGithub({ comments: passingComments(), fail: ["/check-runs"] });
    const { code, out } = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], api);
    expect(code).toBe(1);
    expect(reasonCodes(JSON.parse(out))).toContain("missing_input");
  });

  it("fails closed with error when diff_id cannot be computed", async () => {
    const api = fakeGithub({ comments: passingComments() });
    const { out } = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], api, { diff: () => { throw new Error("computeDiffId: empty diff"); } });
    const summary = JSON.parse(out);
    expect(reasonCodes(summary)).toContain("error");
    expect(summary.reasons.find((reason) => reason.code === "error").detail).toContain("empty diff");
  });

  it("reads the head Jev marker from commit statuses", async () => {
    const api = fakeGithub({ comments: passingComments() });
    const {code,out} = await runCli(["evaluate","--pr","7","--sha",HEAD,"--json"],api);
    expect(code).toBe(0);
    expect(JSON.parse(out).tier).toBe("low");
    expect(api.requests).toContain(`GET /repos/o/r/commits/${HEAD}/statuses`);
  });

  it("runs the real default-branch detector through the fake API (docs-only passes, workflow change needs approval)", async () => {
    const docs = fakeGithub({ comments: passingComments() });
    const docsResult = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], docs, { classify: classifyPull });
    expect(JSON.parse(docsResult.out)).toMatchObject({ gate: "pass", automerge: "eligible" });

    const ci = fakeGithub({ comments: passingComments(), files: [{ filename: ".github/workflows/evil.yml", status: "added" }] });
    const ciResult = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], ci, { classify: classifyPull });
    expect(reasonCodes(JSON.parse(ciResult.out))).toContain("approval_missing:infra_ci");
  });

  it("is classifier_error when the API file list is incomplete", async () => {
    const api = fakeGithub({ comments: passingComments() });
    const original = api.fetch;
    const truncated = async (url, options) => {
      const result = await original(url, options);
      if (new URL(url).pathname === "/repos/o/r/pulls/7") {
        const body = await result.json();
        return response(200, { ...body, changed_files: 2 });
      }
      return result;
    };
    const { out } = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], { ...api, fetch: truncated }, { classify: classifyPull });
    expect(reasonCodes(JSON.parse(out))).toContain("classifier_error");
  });
});

describe("deleted verdicts: only blocking ones are carried forward (ruling b)", () => {
  const deletion = (value, id = 1, body = formatVerdictBlock(value)) => ({ action: "deleted", comment: { id, body, created_at: at(id), user: { login: value.verifier.github_login } } });
  const gateClient = (api) => ({ ...api.client, paginate: async (p, pick = (d) => d) => pick(await api.client.json(p)) });
  const priorRun = (deletedVerdicts) => ({ app: { id: 15368 }, check_suite: { id: 42 }, name: CHECK_NAME, output: { text: `\`\`\`json\n${JSON.stringify({ deleted_verdicts: deletedVerdicts })}\n\`\`\`` } });
  const run = (api, event = null) => runGate({ client: gateClient(api), repo: "o/r", pr: 7, event, git: fakeGit(), diff: () => DIFF, classify: docsClassify });

  it("reads a deleted blocking verdict from an issue_comment deleted event, with a snapshot", () => {
    const [item] = deletedVerdictsFromEvent(deletion(verdict({ result: "FAIL" })));
    expect(item).toMatchObject({ comment_id: 1, author: BOT, sha: HEAD, diff_id: DIFF, role: "verifier", verdict_block: { role: "verifier", verdict: "FAIL", sha: HEAD, diff_id: DIFF } });
    expect(deletedVerdictsFromEvent({ action: "created", comment: { body: formatVerdictBlock(verdict()) } })).toEqual([]);
    expect(deletedVerdictsFromEvent({ action: "deleted", comment: { body: "hello" } })).toEqual([]);
  });

  it("drops a deleted clean PASS or PASS_NOTES, and keeps a deleted pass with a high note or finding", () => {
    expect(deletedVerdictsFromEvent(deletion(verdict()))).toEqual([]);
    expect(deletedVerdictsFromEvent(deletion(verdict({ result: "PASS_NOTES" })))).toEqual([]);
    expect(deletedVerdictsFromEvent(deletion(verdict({ result: "PASS_NOTES", notes: ["high: broken"] })))).toHaveLength(1);
    expect(deletedVerdictsFromEvent(deletion(verdict({ role: "reviewer", findings: [{ severity: "high", file: "a", line: 1, model: "opus", message: "x" }] })))).toHaveLength(1);
  });

  it("keeps a deleted block that cannot be read, without a snapshot", () => {
    const [item] = deletedVerdictsFromEvent(deletion(verdict(), 1, "```overdrafter-verdict\n{not json\n```"));
    expect(item).toMatchObject({ comment_id: 1, sha: null, role: null });
    expect(item.verdict_block).toBeUndefined();
  });

  it("a deleted FAIL stands even after a fresh PASS (it is not cleared by deleting it)", () => {
    const [deleted] = deletedVerdictsFromEvent(deletion(verdict({ result: "FAIL" }), 1));
    const summary = evaluate(baseInput({ deletedVerdicts: [deleted] }));
    expect(summary.gate).toBe("fail");
    expect(reasonCodes(summary)).toContain("verdict_conflict");
    expect(summary.reasons.find((reason) => reason.code === "verdict_conflict").detail).toContain("1 (deleted)");
  });

  it("a deleted FAIL with no other verdict of its role blocks", () => {
    const [deleted] = deletedVerdictsFromEvent(deletion(verdict({ role: "reviewer", result: "FAIL" }), 99999));
    expect(codes(baseInput({ comments: [posted(verdict())], deletedVerdicts: [deleted] }))).toContain("no_review_on_head");
  });

  it("a deleted infra FAIL can still be superseded the normal way, and a deleted verdict is never a supersede claim", () => {
    const [deleted] = deletedVerdictsFromEvent(deletion(verdict({ result: "FAIL", runs: [1] }), 1));
    const fresh = posted(verdict({ runs: [2], supersedes: 1, reason: "infra" }));
    expect(evaluate(baseInput({ comments: [fresh, posted(verdict({ role: "reviewer" }))], deletedVerdicts: [deleted] })).gate).toBe("pass");

    const live = posted(verdict({ result: "FAIL", runs: [1] }), { id: 5 });
    const [claim] = deletedVerdictsFromEvent(deletion(verdict({ result: "FAIL", runs: [9], supersedes: 5, reason: "infra" }), 6));
    expect(codes(baseInput({ comments: [live, posted(verdict()), posted(verdict({ role: "reviewer" }))], deletedVerdicts: [claim] }))).toContain("verdict_conflict");
  });

  it("a deleted pass with a high note blocks, and is never chosen as the pass", () => {
    const [deleted] = deletedVerdictsFromEvent(deletion(verdict({ result: "PASS_NOTES", notes: ["high: broken"] }), 99999));
    const summary = evaluate(baseInput({ comments: [posted(verdict({ role: "reviewer" }))], deletedVerdicts: [deleted] }));
    expect(reasonCodes(summary)).toContain("no_qa_pass_on_head");
    expect(summary.verifier_comment_id).toBeNull();
  });

  it("a deleted verdict for another SHA and another diff_id is ignored", () => {
    const [deleted] = deletedVerdictsFromEvent(deletion(verdict({ result: "FAIL", sha: OLD, diffId: OTHER_DIFF }), 99999));
    expect(evaluate(baseInput({ deletedVerdicts: [deleted] })).gate).toBe("pass");
  });

  it("an unreadable deleted trusted block fails edited_verdict until a fresher verdict is posted", () => {
    const [late] = deletedVerdictsFromEvent(deletion(verdict(), 99999, "```overdrafter-verdict\n{not json\n```"));
    expect(codes(baseInput({ deletedVerdicts: [late] }))).toContain("edited_verdict");
    const [early] = deletedVerdictsFromEvent(deletion(verdict(), 1, "```overdrafter-verdict\n{not json\n```"));
    expect(evaluate(baseInput({ deletedVerdicts: [early] })).gate).toBe("pass");
  });

  it("a carried-forward deletion without a readable snapshot (or with an unknown verdict) fails closed", () => {
    const legacy = { comment_id: 99999, author: BOT, created_at: at(99999), sha: HEAD, diff_id: DIFF, role: "verifier" };
    expect(codes(baseInput({ deletedVerdicts: [legacy] }))).toContain("edited_verdict");
    const unknown = { ...legacy, comment_id: 1, created_at: at(1), verdict_block: { role: "verifier", verdict: "CHANGES_REQUIRED", sha: HEAD, diff_id: DIFF } };
    expect(evaluate(baseInput({ deletedVerdicts: [unknown] })).gate).toBe("fail");
  });

  it("ignores deletions by untrusted logins", () => {
    const [deleted] = deletedVerdictsFromEvent(deletion(verdict({ result: "FAIL", login: "mallory" }), 99999));
    expect(evaluate(baseInput({ deletedVerdicts: [deleted] })).gate).toBe("pass");
  });

  it("a deleted FAIL still blocks on later runs (carried forward from earlier gate check runs on the head)", async () => {
    const event = deletion(verdict({ result: "FAIL" }), 1);
    const first = await run(fakeGithub({ comments: passingComments() }), event);
    expect(reasonCodes(first)).toContain("verdict_conflict");
    expect(first.deleted_verdicts).toHaveLength(1);
    // A later run sees no deletion event, only what the earlier run recorded.
    const later = await run(fakeGithub({ comments: passingComments(), checkRuns: [priorRun(first.deleted_verdicts)] }));
    expect(later.gate).toBe("fail");
    expect(reasonCodes(later)).toContain("verdict_conflict");
    expect(later.deleted_verdicts).toEqual(first.deleted_verdicts);
  });

  it("a deleted PASS does not count as a pass on later runs, and is never recorded", async () => {
    const reviewerOnly = [posted(verdict({ role: "reviewer" }))];
    const first = await run(fakeGithub({ comments: reviewerOnly }), deletion(verdict(), 1));
    expect(first.deleted_verdicts).toEqual([]);
    expect(reasonCodes(first)).toEqual(["no_qa_pass_on_head", "qa_not_pass"]);
    // Even a forged earlier run that records a deleted PASS changes nothing: it does not pass (a) or (b)...
    const forged = { comment_id: 1, author: BOT, created_at: at(1), sha: HEAD, diff_id: DIFF, role: "verifier", verdict_block: { role: "verifier", verdict: "PASS", sha: HEAD, diff_id: DIFF } };
    const forgedReviewer = { ...forged, comment_id: 2, role: "reviewer", verdict_block: { ...forged.verdict_block, role: "reviewer", findings: [] } };
    const later = await run(fakeGithub({ comments: [], checkRuns: [priorRun([forged, forgedReviewer])] }));
    expect(reasonCodes(later)).toEqual(["no_qa_pass_on_head", "no_review_on_head", "sonnet_not_pass", "qa_not_pass"]);
    expect(later.deleted_verdicts).toEqual([]);
    // ...and it simply disappears: it does not block a head that has live passes.
    expect((await run(fakeGithub({ comments: passingComments(), checkRuns: [priorRun([forged])] }))).gate).toBe("pass");
  });
});

describe("verifier independence from the PR builder (ruling 1, stage A warning)", () => {
  const VERIFIER_ID = "astra-verifier";
  const REVIEWER_ID = "sonnet-reviewer";
  const notIndependent = (items) => items.filter((item) => item.code === "verifier_not_independent");

  it("reads builder ids from canonical and free-text Built-by lines", () => {
    expect(bodyBuilders("x\nBuilt-by: bot=engineer model=model:codex; bot=Architect model=model:claude-opus\n")).toEqual(["engineer", "architect"]);
    expect(bodyBuilders("Built-by: Engineer / Codex (gpt via codex exec)")).toEqual(["engineer"]);
    expect(bodyBuilders("Model-builder: bot=astra-verifier model=model:codex")).toEqual(["astra-verifier"]);
    expect(bodyBuilders("Built-by: nonsense")).toEqual([]);
    expect(bodyBuilders(undefined)).toEqual([]);
  });

  it("match: warns verifier_not_independent, visible in the summary, without blocking in stage A", () => {
    const summary = evaluate(baseInput({ prBody: `Summary\n\nBuilt-by: bot=${VERIFIER_ID} model=model:codex\n` }));
    expect(summary.gate).toBe("pass");
    expect(summary.reasons).toEqual([]);
    expect(notIndependent(summary.warnings)).toHaveLength(1);
    expect(notIndependent(summary.warnings)[0].detail).toContain(VERIFIER_ID);
    expect(conclusionFor(summary)).toMatchObject({ conclusion: "success" });
    expect(formatSummary(summary)).toContain("`verifier_not_independent` (warning)");
  });

  it("match on the reviewer: warns too", () => {
    const summary = evaluate(baseInput({ prBody: `Built-by: ${REVIEWER_ID} / opus` }));
    expect(summary.gate).toBe("pass");
    expect(notIndependent(summary.warnings)[0].detail).toContain(REVIEWER_ID);
  });

  it("a match is a blocking reason in stage B (from K3 on)", () => {
    const comments = [posted(verdict({ login: BOT })), posted(verdict({ role: "reviewer", login: BOT }))];
    const summary = evaluate(baseInput({ identity: "app", comments, prBody: `Built-by: bot=${VERIFIER_ID} model=model:codex` }));
    expect(summary.gate).toBe("fail");
    expect(reasonCodes(summary)).toEqual(["verifier_not_independent"]);
  });

  it("no match: no warning", () => {
    const summary = evaluate(baseInput({ prBody: "Built-by: bot=engineer model=model:codex" }));
    expect(summary.gate).toBe("pass");
    expect(notIndependent(summary.warnings)).toEqual([]);
    expect(formatSummary(summary)).not.toContain("verifier_not_independent");
  });

  it.each([
    ["no body", undefined],
    ["a null body", null],
    ["a body without a builder line", "Just a summary."],
    ["an unparseable builder line", "Built-by: ???"],
  ])("%s: no verifier_not_independent warning and no pass effect in stage A (builder_unattributed warns)", (_name, prBody) => {
    const passing = evaluate(baseInput({ prBody }));
    expect(passing.gate).toBe("pass");
    expect(notIndependent(passing.warnings)).toEqual([]);
    expect(passing.warnings.map((warning) => warning.code)).toContain("builder_unattributed");
    for (const comments of [[], [posted(verdict())], [posted(verdict({ result: "FAIL" })), posted(verdict({ role: "reviewer" }))]]) {
      expect(evaluate(baseInput({ comments, prBody })).reasons).toEqual(evaluate(baseInput({ comments })).reasons);
      expect(evaluate(baseInput({ comments, prBody })).gate).toBe("fail");
    }
  });

  it("runGate reads the builder line from the PR body as data", async () => {
    const api = fakeGithub({ comments: passingComments(), body: `Built-by: bot=${VERIFIER_ID} model=model:codex` });
    const summary = await runGate({ client: { ...api.client, paginate: async (p, pick = (d) => d) => pick(await api.client.json(p)) }, repo: "o/r", pr: 7, git: fakeGit(), diff: () => DIFF, classify: docsClassify });
    expect(summary.gate).toBe("fail");
    expect(notIndependent(summary.reasons)).toHaveLength(1);
  });
});

describe("headDiffId", () => {
  it("fetches the PR head and base as data into a separate bare store, with the token only in the git child env", () => {
    const calls = [];
    const store = mkdtempSync(path.join(tmpdir(), "ovd959-store-"));
    let diffCwd;
    const result = headDiffId({ pr: 7, repo: "o/r", headSha: HEAD, baseRef: "main", cwd: "/x", token: "secret-token", git: fakeGit(calls), makeStore: () => store, diff: ({ base, head, cwd }) => { diffCwd = cwd; return base === BASE && head === HEAD ? DIFF : "wrong"; } });
    expect(result).toEqual({ diffId: DIFF, error: null });
    expect(calls[0].args).toEqual(["init", "--bare", "--quiet", store]);
    expect(calls[1].args).toEqual(["--git-dir", store, "fetch", "--no-tags", "--no-recurse-submodules", "--quiet", "https://github.com/o/r.git", "+refs/pull/7/head:refs/ovd-merge-gate/head", "+refs/heads/main:refs/ovd-merge-gate/base"]);
    expect(calls[2].args.slice(0, 2)).toEqual(["--git-dir", store]);
    // Nothing runs in the trusted checkout (/x): every git call and the diff use the store.
    expect(diffCwd).toBe(store);
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain("/x");
    expect(calls.some((call) => call.args.includes("checkout") || call.args.includes("worktree"))).toBe(false);
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain("secret-token");
    expect(calls[1].env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${Buffer.from("x-access-token:secret-token").toString("base64")}`);
    expect(calls[2].env).toEqual({});
    // The store is removed afterwards.
    expect(() => readFileSync(path.join(store, "HEAD"))).toThrow();
  });

  it.each([
    ["an option-like base ref", { baseRef: "--upload-pack=x" }],
    ["a base ref with ..", { baseRef: "main..x" }],
    ["no base ref", { baseRef: undefined }],
    ["a bad head", { headSha: "HEAD" }],
    ["a bad PR", { pr: "7; rm" }],
    ["a bad repository", { repo: "o/r --upload-pack=x" }],
  ])("returns an error and no diff_id for %s", (_name, overrides) => {
    const calls = [];
    const result = headDiffId({ pr: 7, repo: "o/r", headSha: HEAD, baseRef: "main", git: fakeGit(calls), diff: () => DIFF, ...overrides });
    expect(result.diffId).toBeNull();
    expect(result.error).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("returns an error when the fetch fails", () => {
    const result = headDiffId({ pr: 7, repo: "o/r", headSha: HEAD, baseRef: "main", git: () => { throw new Error("fatal: could not read"); }, diff: () => DIFF });
    expect(result).toEqual({ diffId: null, error: "fatal: could not read" });
  });

  describe("with a real repository", () => {
    let dir;
    afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

    it("recomputes the same diff_id as computeDiffId over origin/<base>...head without fetching", () => {
      dir = mkdtempSync(path.join(tmpdir(), "ovd959-"));
      const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } }).trim();
      git("init", "-q", "-b", "main");
      writeFileSync(path.join(dir, "a.txt"), "a\n");
      git("add", ".");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD");
      git("update-ref", "refs/remotes/origin/main", base);
      writeFileSync(path.join(dir, "b.txt"), "b\n");
      git("add", ".");
      git("commit", "-qm", "head");
      const head = git("rev-parse", "HEAD");
      const result = headDiffId({ pr: 1, headSha: head, baseRef: "main", cwd: dir, fetch: false });
      expect(result.error).toBeNull();
      expect(result.diffId).toBe(computeDiffId({ base, head, cwd: dir }));
    });
  });
});

// ------------------------------------------------- OVD-959 repair round 1
// One describe per finding in the Codex review of dd68f8a5. Every test here
// fails against dd68f8a5 and passes now.

const ANCHOR = "a1cd387a57f7441a0c498ac6365148b04c39f724";
const gateClientFor = (api) => ({ ...api.client, paginate: async (p, pick = (d) => d) => pick(await api.client.json(p)), post: async (p, b) => (await api.fetch(`https://api.test${p}`, { method: "POST", body: JSON.stringify(b) })).json() });
const deletedEvent = (value, id, body = formatVerdictBlock(value)) => ({ action: "deleted", issue: { number: 7 }, comment: { id, body, created_at: at(id), updated_at: at(id), user: { login: value.verifier.github_login } } });
const createdEvent = (item) => ({ action: "created", issue: { number: 7 }, comment: item });

/** Run the CLI with an event payload, as the workflow does (GITHUB_EVENT_PATH). */
async function runWithEvent(args, api, event, overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ovd959-event-"));
  try {
    const file = path.join(dir, "event.json");
    writeFileSync(file, JSON.stringify(event));
    return await runCli(args, api, { ...overrides, env: { GITHUB_EVENT_PATH: file, ...overrides.env } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const historyRun = (entries, { pr = 7, name = `ovd-merge-gate-history/pr-${pr}`, text } = {}) => ({
  id: 4242,
  name,
  head_sha: ANCHOR,
  app: { id: 15368 },
  output: { text: text ?? `\`\`\`json\n${JSON.stringify({ schema: "overdrafter.gate-history/v1", pr, event: "deleted", entries })}\n\`\`\`` },
});

describe("finding 1: verdict history survives a replaced gate run (durable, append-only)", () => {
  it("anchors the history on the repository root commit, one check name per PR", () => {
    expect(gate.HISTORY_ANCHOR_SHA).toBe(ANCHOR);
    expect(gate.historyCheckName(7)).toBe("ovd-merge-gate-history/pr-7");
    expect(gate.HISTORY_SCHEMA_ID).toBe("overdrafter.gate-history/v1");
  });

  it("a deletion whose own gate run never ran (replaced in the queue) still blocks the next writer", async () => {
    const fail = verdict({ result: "FAIL" });
    const api = fakeGithub({ comments: passingComments() });
    // The deletion run: its history job records; its writer is replaced by a newer pending run.
    const recorded = await runWithEvent(["record", "--pr", "7"], api, deletedEvent(fail, 1));
    expect(recorded.code).toBe(0);
    expect(api.posts).toHaveLength(1);
    expect(api.posts[0]).toMatchObject({ name: "ovd-merge-gate-history/pr-7", head_sha: ANCHOR, status: "completed" });
    // The newer run (an unrelated comment) has no deletion event; only the history knows.
    const unrelated = comment("thanks!");
    const written = await runWithEvent(["write", "--pr", "7"], api, createdEvent(unrelated));
    expect(written.code).toBe(0);
    const check = api.posts.find((item) => item.name === CHECK_NAME);
    expect(check.conclusion).toBe("failure");
    expect(check.output.title).toContain("verdict_conflict");
    expect(JSON.parse(check.output.text.slice(8, -4)).deleted_verdicts).toHaveLength(1);
  });

  it("records a FAIL when it is created, so it is carried even if every deletion run fails", async () => {
    const failComment = posted(verdict({ result: "FAIL" }));
    const api = fakeGithub({ comments: [...passingComments(), failComment] });
    expect((await runWithEvent(["record", "--pr", "7"], api, createdEvent(failComment))).code).toBe(0);
    // The FAIL is deleted; no deleted event is ever processed.
    const later = fakeGithub({ comments: passingComments(), stored: api.stored });
    const { code, out } = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], later);
    expect(code).toBe(1);
    expect(reasonCodes(JSON.parse(out))).toContain("verdict_conflict");
  });

  it("records only trusted blocking verdicts, never a clean pass, and never the same one twice", async () => {
    const api = fakeGithub({ comments: [...passingComments(), posted(verdict({ result: "FAIL", login: "mallory" }))] });
    const client = gateClientFor(api);
    expect(await gate.recordHistory({ client, repo: "o/r", pr: 7, event: deletedEvent(verdict(), 1) })).toEqual({ written: 0 });
    const fail = deletedEvent(verdict({ role: "reviewer", result: "FAIL" }), 2);
    expect(await gate.recordHistory({ client, repo: "o/r", pr: 7, event: fail })).toEqual({ written: 1 });
    expect(await gate.recordHistory({ client, repo: "o/r", pr: 7, event: fail })).toEqual({ written: 0 });
    const [entry] = await gate.readHistory(client, "o/r", 7);
    expect(entry).toMatchObject({ comment_id: 2, author: BOT, role: "reviewer", verdict_block: { verdict: "FAIL", sha: HEAD, diff_id: DIFF } });
  });

  it("leaves a recorded verdict that is still posted to the live comments, and carries one that was removed or edited away", () => {
    const failComment = posted(verdict({ result: "FAIL" }));
    const [entry] = deletedVerdictsFromEvent({ action: "deleted", comment: failComment });
    expect(gate.removedHistory([entry], [failComment])).toEqual([]);
    expect(gate.removedHistory([entry], [])).toEqual([entry]);
    const editedAway = { ...failComment, body: formatVerdictBlock(verdict()), updated_at: at(failComment.id + 9) };
    expect(gate.removedHistory([entry], [editedAway])).toEqual([entry]);
    // A FAIL edited into a PASS, then a fresh PASS: the original FAIL still stands.
    const summary = evaluate(baseInput({ comments: [editedAway, posted(verdict()), posted(verdict({ role: "reviewer" }))], history: [entry] }));
    expect(reasonCodes(summary)).toContain("verdict_conflict");
  });

  it.each([
    ["the history list cannot be read", { fail: [ANCHOR] }],
    ["a history record is not JSON", { stored: [historyRun([], { text: "```json\n{nope\n```" })] }],
    ["a history record has another schema", { stored: [historyRun([], { text: "```json\n{\"schema\":\"x\",\"pr\":7,\"entries\":[]}\n```" })] }],
    ["a history record is for another PR", { stored: [historyRun([], { pr: 8, name: "ovd-merge-gate-history/pr-7" })] }],
    ["a history entry is not an object", { stored: [historyRun(["FAIL"])] }],
  ])("fails closed (missing_input) when %s", async (_name, options) => {
    const api = fakeGithub({ comments: passingComments(), ...options });
    const { code, out } = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], api);
    expect(code).toBe(1);
    const summary = JSON.parse(out);
    expect(summary.gate).toBe("fail");
    expect(summary.reasons.some((reason) => reason.code === "missing_input" && reason.detail.includes("verdict history"))).toBe(true);
  });
});

describe("finding 2: removed blocking verdicts are keyed on the PR and diff_id, not the head SHA", () => {
  it("a new head with the same diff_id cannot pass on surviving PASS comments after a FAIL was deleted", async () => {
    const survivors = [posted(verdict({ sha: OLD })), posted(verdict({ role: "reviewer", sha: OLD }))];
    // At head OLD: the FAIL is deleted; the workflow records, then writes.
    const before = fakeGithub({ head: OLD, comments: survivors });
    await runWithEvent(["record", "--pr", "7"], before, deletedEvent(verdict({ result: "FAIL", sha: OLD }), 1));
    await runWithEvent(["write", "--pr", "7"], before, deletedEvent(verdict({ result: "FAIL", sha: OLD }), 1));
    expect(before.posts.find((item) => item.name === CHECK_NAME).conclusion).toBe("failure");
    // A rebase to NEW_HEAD keeps diff_id; the gate's own runs on OLD are not read for NEW_HEAD.
    const after = fakeGithub({ head: NEW_HEAD, comments: survivors, stored: before.stored });
    const { code, out } = await runCli(["evaluate", "--pr", "7", "--sha", NEW_HEAD, "--json"], after);
    expect(code).toBe(1);
    const summary = JSON.parse(out);
    expect(summary.diff_id).toBe(DIFF);
    expect(reasonCodes(summary)).toContain("verdict_conflict");
  });

  it("a removed FAIL for another diff_id does not block the new head", () => {
    const [entry] = deletedVerdictsFromEvent(deletedEvent(verdict({ result: "FAIL", sha: OLD, diffId: OTHER_DIFF }), 1));
    expect(evaluate(baseInput({ history: [entry] })).gate).toBe("pass");
  });
});

describe("finding 3: earlier gate runs are read with filter=all and fail closed when malformed", () => {
  const gateRun = (text) => ({ id: 31, name: CHECK_NAME, app: { id: 15368 }, output: { text } });

  it.each([
    ["JSON that does not parse", "```json\n{\"deleted_verdicts\": [\n```"],
    ["no JSON block", "nothing here"],
    ["no deleted_verdicts list", "```json\n{\"gate\":\"pass\"}\n```"],
    ["a deleted_verdicts item that is not an object", "```json\n{\"deleted_verdicts\":[\"FAIL\"]}\n```"],
  ])("an earlier gate run with %s is missing_input, never empty history", async (_name, text) => {
    const api = fakeGithub({ comments: passingComments(), checkRuns: [gateRun(text)] });
    const { code, out } = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], api);
    expect(code).toBe(1);
    const summary = JSON.parse(out);
    expect(summary.gate).toBe("fail");
    expect(summary.reasons.some((reason) => reason.code === "missing_input" && reason.detail.includes("earlier gate check runs"))).toBe(true);
  });

  it("queries earlier gate runs and the history with filter=all", async () => {
    const api = fakeGithub({ comments: passingComments() });
    await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], api);
    expect(api.urls).toContain(`GET /repos/o/r/commits/${HEAD}/check-runs?check_name=ovd-merge-gate&filter=all&per_page=100&page=1`);
    expect(api.urls).toContain(`GET /repos/o/r/commits/${ANCHOR}/check-runs?check_name=ovd-merge-gate-history%2Fpr-7&filter=all&per_page=100&page=1`);
  });
});

describe("finding 4: a missing or unparseable Built-by line warns in stage A and blocks in stage B", () => {
  const botComments = () => [posted(verdict({ login: BOT })), posted(verdict({ role: "reviewer", login: BOT }))];
  const attribution = (body) => gate.builderAttribution(body);

  it.each([
    ["no body", undefined],
    ["no Built-by line", "Just a summary."],
    ["an unparseable line", "Built-by: ???"],
    ["a second builder in free text", "Built-by: Engineer / Codex and Opus"],
    ["a legacy Model line only", "Model: model:codex"],
    ["one unparseable entry next to a good one", "Built-by: bot=engineer model=model:codex; ???"],
  ])("%s: builder_unattributed blocks in stage B", (_name, prBody) => {
    const summary = evaluate(baseInput({ identity: "app", comments: botComments(), prBody }));
    expect(summary.gate).toBe("fail");
    expect(reasonCodes(summary)).toEqual(["builder_unattributed"]);
  });

  it("is a warning, not a reason, in stage A", () => {
    const summary = evaluate(baseInput({ prBody: "Built-by: Engineer / Codex and Opus" }));
    expect(summary.gate).toBe("pass");
    expect(summary.warnings.map((warning) => warning.code)).toContain("builder_unattributed");
    expect(formatSummary(summary)).toContain("`builder_unattributed` (warning)");
  });

  it("parses the documented forms with the maintained parser (docs/agent-pr-tags.md)", () => {
    expect(attribution("Built-by: bot=engineer model=model:codex; bot=architect model=model:claude-opus")).toEqual({ ids: ["engineer", "architect"], problem: null });
    expect(attribution("Built-by: Engineer / Codex (gpt via codex exec, ChatGPT plan)")).toEqual({ ids: ["engineer"], problem: null });
    expect(attribution("Built-by: Mac Mini Claude Jobs / claude-opus")).toEqual({ ids: ["mac-mini-claude-jobs"], problem: null });
    expect(attribution("Built-by: Engineer / Codex and Opus").problem).toMatch(/cannot be parsed/);
    expect(attribution("Model: model:codex").problem).toMatch(/no Built-by line/);
  });

  it("a parseable line with no match passes stage B", () => {
    expect(evaluate(baseInput({ identity: "app", comments: botComments(), prBody: BUILT_BY })).reasons).toEqual([]);
  });
});

describe("finding 5: PASS evidence must resolve to an Actions run on the verdict's SHA", () => {
  const evaluateCli = async (api) => {
    const { code, out } = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], api);
    return { code, summary: JSON.parse(out) };
  };

  it("https://example.invalid/not-a-run does not carry a PASS", async () => {
    const fake = verdict({ evidence: [{ kind: "ci-run", url: "https://example.invalid/not-a-run" }] });
    const { code, summary } = await evaluateCli(fakeGithub({ comments: [posted(fake), posted(verdict({ role: "reviewer" }))] }));
    expect(code).toBe(1);
    expect(reasonCodes(summary)).toEqual(["evidence_unverified", "no_qa_pass_on_head", "qa_not_pass"]);
    expect(summary.verifier_comment_id).toBeNull();
  });

  it.each([
    ["an Actions run that never reported on the verdict's SHA", { runs: [77] }, {}],
    ["a run in another repository", { evidence: [{ kind: "ci-run", url: "https://github.com/evil/r/actions/runs/1" }] }, {}],
    ["a lookalike host", { evidence: [{ kind: "verify-run", url: "https://github.com.evil.test/o/r/actions/runs/1" }] }, {}],
    ["a run whose check runs cannot be read", {}, { fail: [`/commits/${HEAD}/check-runs`] }],
  ])("%s does not carry a PASS", async (_name, overrides, apiOptions) => {
    const { summary } = await evaluateCli(fakeGithub({ comments: [posted(verdict(overrides)), posted(verdict({ role: "reviewer" }))], ...apiOptions }));
    expect(summary.gate).toBe("fail");
    expect(reasonCodes(summary)).toContain("evidence_unverified");
  });

  it("a reviewer PASS needs resolving evidence too", async () => {
    const { summary } = await evaluateCli(fakeGithub({ comments: [posted(verdict()), posted(verdict({ role: "reviewer", runs: [77] }))] }));
    expect(reasonCodes(summary)).toEqual(["evidence_unverified", "no_review_on_head", "sonnet_not_pass"]);
  });

  it("Actions evidence must resolve and old-SHA passes cannot approve the current head", async () => {
    expect((await evaluateCli(fakeGithub({ comments: passingComments() }))).summary.gate).toBe("pass");
    const old = [posted(verdict({ sha: OLD, runs: [8] })), posted(verdict({ role: "reviewer", sha: OLD, runs: [8] }))];
    expect((await evaluateCli(fakeGithub({ comments: old, ciRuns: { [OLD]: [8], [HEAD]: [] } }))).summary.gate).toBe("fail");
    expect(reasonCodes((await evaluateCli(fakeGithub({ comments: old, ciRuns: { [OLD]: [], [HEAD]: [8] } }))).summary)).toContain("evidence_unverified");
  });

  it("evaluate counts no pass without verified evidence", () => {
    expect(reasonCodes(evaluate(baseInput({ verifiedEvidence: undefined })))).toContain("evidence_unverified");
    expect(evaluate(baseInput({ verifiedEvidence: { [OLD]: [runUrl(1)] } })).gate).toBe("fail");
  });

  it("an infra supersede needs its new run verified at the FAIL's SHA", () => {
    const fail = posted(verdict({ result: "FAIL", runs: [1] }));
    const comments = [fail, posted(verdict({ runs: [2], supersedes: fail.id, reason: "infra" })), posted(verdict({ role: "reviewer" }))];
    expect(evaluate(baseInput({ comments })).gate).toBe("pass");
    // Run 2 is not an Actions run on HEAD: the FAIL stands.
    expect(codes(baseInput({ comments, verifiedEvidence: { [HEAD]: [runUrl(1)] } }))).toContain("verdict_conflict");
    expect(codes(baseInput({ comments, verifiedEvidence: { [OLD]: [runUrl(2)], [HEAD]: [runUrl(1)] } }))).toContain("verdict_conflict");
  });

  it("reads only Actions run URLs of this repository", () => {
    expect(gate.actionsRunId("https://github.com/o/r/actions/runs/12", "o/r")).toBe("12");
    expect(gate.actionsRunId("https://github.com/O/R/actions/runs/12/job/34?pr=7", "o/r")).toBe("12");
    expect(gate.actionsRunId("https://github.com/o/r/actions/runs/12/attempts/2", "o/r")).toBe("12");
    for (const url of ["https://example.invalid/not-a-run", "http://github.com/o/r/actions/runs/12", "https://github.com/o/x/actions/runs/12", "https://github.com:444/o/r/actions/runs/12", "https://u:p@github.com/o/r/actions/runs/12", "https://github.com/o/r/actions/runs/x", "not a url"]) {
      expect(gate.actionsRunId(url, "o/r")).toBeNull();
    }
  });
});

describe("medium: a commits fetch error is never a stage A success", () => {
  it.each([
    ["the commits API returns 500", { fail: ["/pulls/7/commits"] }],
    ["the commit list is incomplete", { commits: [] }],
  ])("%s: missing_input, neutral in report mode", async (_name, options) => {
    const api = fakeGithub({ comments: passingComments(), ...options });
    if (options.commits) {
      const original = api.fetch;
      api.fetch = async (url, init) => {
        const result = await original(url, init);
        if (new URL(url).pathname === "/repos/o/r/pulls/7") return response(200, { ...(await result.json()), commits: 1 });
        return result;
      };
    }
    const { code } = await runCli(["write", "--pr", "7"], api);
    expect(code).toBe(0);
    const check = api.posts.find((item) => item.name === CHECK_NAME);
    expect(check.conclusion).toBe("failure");
    expect(check.output.title).toContain("missing_input");
  });

  it("evaluate in stage A fails without a commit list", () => {
    expect(codes(baseInput({ commits: undefined }))).toEqual(["missing_input"]);
    expect(codes(baseInput({ commits: [null] }))).toEqual(["missing_input"]);
  });
});

describe("medium: an unterminated verdict fence does not disappear", () => {
  const unterminated = (value) => comment(`Verdict:\n\n\`\`\`overdrafter-verdict\n${JSON.stringify(value, null, 2)}\n`);

  it("an unterminated trusted FAIL is verdict_schema_error (blocking)", () => {
    const summary = evaluate(baseInput({ comments: [...passingComments(), unterminated(verdict({ result: "FAIL" }))] }));
    expect(summary.gate).toBe("fail");
    expect(reasonCodes(summary)).toEqual(["verdict_schema_error"]);
    expect(summary.ignored.map((item) => item.code)).toContain("unterminated_block");
  });

  it("an unterminated block after a closed one still counts", () => {
    const body = `${formatVerdictBlock(verdict({ role: "reviewer" }))}\n\n\`\`\`overdrafter-verdict\n${JSON.stringify(verdict({ result: "FAIL" }))}\n`;
    expect(codes(baseInput({ comments: [posted(verdict()), comment(body)] }))).toContain("verdict_schema_error");
  });

  it("an unterminated block from an untrusted author is ignored", () => {
    const item = { ...unterminated(verdict({ result: "FAIL", login: "mallory" })), user: { login: "mallory" } };
    expect(evaluate(baseInput({ comments: [...passingComments(), item] })).gate).toBe("pass");
  });

  it("a deleted comment with an unterminated block is kept as unreadable", () => {
    const event = { action: "deleted", comment: { ...unterminated(verdict({ result: "FAIL" })), id: 99999, created_at: at(99999) } };
    const [item] = deletedVerdictsFromEvent(event);
    expect(item).toMatchObject({ comment_id: 99999, role: null, sha: null });
    expect(codes(baseInput({ deletedVerdicts: [item] }))).toContain("edited_verdict");
  });
});

describe("medium: ruling-4 model families and repo-relative finding paths", () => {
  it.each(["", "Opus", "gpt-6", "claude-opus", "mallory"])("a trusted verdict with model_family %s is verdict_schema_error", (family) => {
    const comments = [...passingComments(), posted(verdict({ result: "FAIL", family }))];
    const summary = evaluate(baseInput({ comments }));
    expect(reasonCodes(summary)).toEqual(["verdict_schema_error"]);
    expect(summary.ignored.find((item) => item.code === "schema_error").detail).toContain("model_family");
  });

  it("an unknown family never carries a pass", () => {
    expect(codes(baseInput({ comments: [posted(verdict({ family: "gpt-6" })), posted(verdict({ role: "reviewer" }))] }))).toContain("no_qa_pass_on_head");
  });

  it.each(["opus", "sonnet", "claude", "codex", "grok", "jev", "human"])("accepts model_family %s", (family) => {
    expect(evaluate(baseInput({ comments: [posted(verdict({ family })), posted(verdict({ role: "reviewer", family }))] })).gate).toBe("pass");
  });

  it("a trusted reviewer PASS with a legacy finding at ../outside is verdict_schema_error", () => {
    const findings = [{ severity: "low", file: "../outside", line: 1, model: "grok" }];
    const comments = [posted(verdict()), posted(verdict({ role: "reviewer" })), posted(verdict({ role: "reviewer", findings }))];
    expect(codes(baseInput({ comments }))).toEqual(["verdict_schema_error"]);
  });
});

describe("Sonar repair: no behaviour change", () => {
  it("the CLI still parses every flag and refuses unknown ones", async () => {
    const api = fakeGithub({ comments: passingComments() });
    expect((await runCli(["evaluate", "--json", "--no-fetch", "--pr", "7", "--sha", HEAD, "--repo", "o/r"], api, { git: fakeGit() })).code).toBe(0);
    expect((await runCli(["record"], api)).err).toContain("record needs --pr");
    expect((await runCli(["write", "--pr"], api)).err).toContain("--pr needs a value");
    expect((await runCli(["write", "--pr", "7", "--json", "--bogus"], api)).err).toContain("unknown argument");
  });
});

describe("F1: an oversized history record fails closed, never leaves a stale result", () => {
  const bigNotes = (n, size = 30000) => Array.from({ length: n }, (_, i) => `${i === 0 ? "high" : "low"}: ${String(i).padStart(4, "0")}${"x".repeat(size)}`);

  it("a FAIL with over 65535 characters of notes is recorded and still blocks after it is deleted", async () => {
    const failComment = posted(verdict({ result: "FAIL", notes: bigNotes(3) }));
    expect(failComment.body.length).toBeGreaterThan(65535);
    const api = fakeGithub({ comments: [...passingComments(), failComment] });
    const { code } = await runWithEvent(["record", "--pr", "7"], api, createdEvent(failComment));
    expect(code).toBe(0);
    for (const item of api.posts) expect(item.output.text.length).toBeLessThanOrEqual(65535);
    const later = fakeGithub({ comments: passingComments(), stored: api.stored });
    const { code: evalCode, out } = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], later);
    expect(evalCode).toBe(1);
    expect(reasonCodes(JSON.parse(out))).toContain("verdict_conflict");
  });

  it("note text is replaced by a digest that keeps high notes blocking and distinct notes distinct", () => {
    const high = deletedVerdictsFromEvent({ action: "deleted", comment: posted(verdict({ result: "PASS_NOTES", notes: ["high: broken", "low: x"] })) });
    expect(high).toHaveLength(1);
    expect(high[0].verdict_block.notes).toEqual([expect.stringMatching(/^high: 2 note\(s\) omitted, sha256 [0-9a-f]{64}$/)]);
    const a = deletedVerdictsFromEvent({ action: "deleted", comment: posted(verdict({ result: "FAIL", notes: ["low: a"] })) });
    const b = deletedVerdictsFromEvent({ action: "deleted", comment: posted(verdict({ result: "FAIL", notes: ["low: b"] })) });
    expect(a[0].verdict_block.notes).not.toEqual(b[0].verdict_block.notes);
    // A recorded snapshot re-read by carriedDeletions is unchanged (idempotent) and still blocking.
    expect(gate.carriedDeletions(high, [BOT]).blocking).toEqual(high);
  });

  it("many fresh entries are split across records that each fit", async () => {
    const comments = Array.from({ length: 400 }, (_, i) => posted(verdict({ result: "FAIL", findings: undefined, runs: [i + 1] })));
    const api = fakeGithub({ comments });
    const client = gateClientFor(api);
    const result = await gate.recordHistory({ client, repo: "o/r", pr: 7, event: null });
    expect(result.written).toBeGreaterThan(0);
    for (const item of api.posts) expect(item.output.text.length).toBeLessThanOrEqual(65535);
    expect((await gate.readHistory(client, "o/r", 7)).length).toBe(result.written);
  });

  it("historyBatches throws for an entry that cannot fit alone (the history job fails visibly)", () => {
    const render = (entries) => JSON.stringify(entries);
    expect(() => gate.historyBatches([{ comment_id: 1, author: "x", pad: "y".repeat(200) }], render, 100)).toThrow(/does not fit/);
    expect(gate.historyBatches([{ a: 1 }, { a: 2 }, { a: 3 }], render, 17).map((b) => b.entries.length)).toEqual([2, 1]);
  });

  it.each(["failure", "cancelled", "skipped", ""])("the writer fails the gate when the history job result is %j", async (result) => {
    const api = fakeGithub({ comments: passingComments() });
    const { code } = await runCli(["write", "--pr", "7", "--history-result", result], api);
    expect(code).toBe(0);
    const check = api.posts.find((item) => item.name === CHECK_NAME);
    expect(check.conclusion).not.toBe("success");
    const summary = JSON.parse(check.output.text.slice(check.output.text.indexOf("{"), check.output.text.lastIndexOf("}") + 1));
    expect(summary.gate).toBe("fail");
    expect(summary.reasons.some((reason) => reason.code === "missing_input" && reason.detail.includes("history job"))).toBe(true);
  });

  it("--history-result success adds no reason, and is rejected outside write", async () => {
    const api = fakeGithub({ comments: passingComments() });
    await runCli(["write", "--pr", "7", "--history-result", "success"], api);
    const check = api.posts.find((item) => item.name === CHECK_NAME);
    expect(check.output.text).not.toContain("history job");
    const { code } = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--history-result", "success"], fakeGithub({ comments: passingComments() }));
    expect(code).toBe(2);
  });

  it("summaryText fits a summary with huge deleted_verdicts and never makes it pass", () => {
    const deleted = Array.from({ length: 2000 }, (_, i) => ({ comment_id: i, author: BOT, created_at: null, sha: HEAD, diff_id: DIFF, role: "verifier", verdict_block: { role: "verifier", verdict: "FAIL", sha: HEAD, notes: ["x".repeat(100)] } }));
    const summary = { gate: "fail", sha: HEAD, mode: "report", reasons: [{ code: "verdict_conflict", detail: "d" }], warnings: [], ignored: [], deleted_verdicts: deleted };
    for (const max of [65535, 20000, 2000]) {
      const text = gate.summaryText(summary, max);
      expect(text.length).toBeLessThanOrEqual(max);
      const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      expect(parsed.gate).toBe("fail");
      expect(parsed.deleted_verdicts.length).toBeGreaterThan(0);
      expect(parsed.deleted_verdicts.every((item) => typeof item.author === "string")).toBe(true);
    }
  });
});

describe("R2 evidence workflow and revision binding", () => {
  it.each([
    ["failed", { conclusion: "failure" }],
    ["cancelled", { conclusion: "cancelled" }],
    ["in progress", { conclusion: null, status: "in_progress" }],
    ["other workflow", { path: ".github/workflows/proof-check.yml" }],
    ["wrong SHA", { head_sha: OLD }],
  ])("rejects %s evidence", async (_label, workflowRun) => {
    const api = fakeGithub({ comments: passingComments(), workflowRun });
    const { out } = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], api);
    const summary = JSON.parse(out);
    expect(summary.gate).toBe("fail");
    expect(reasonCodes(summary)).toContain("evidence_unverified");
  });
  it("accepts successful Verify runs", async () => {
    const api = fakeGithub({ comments: passingComments(), workflowRun: { path: ".github/workflows/verify.yml" } });
    const { out } = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], api);
    expect(JSON.parse(out).gate).toBe("pass");
  });
});

describe("R2 history provenance", () => {
  const history = (overrides = {}) => ({ name: gate.historyCheckName(7), head_sha: ANCHOR, app: { id: 15368 }, check_suite: { id: 42 }, output: { text: `\`\`\`json\n${JSON.stringify({ schema: gate.HISTORY_SCHEMA_ID, pr: 7, entries: [] })}\n\`\`\`` }, ...overrides });
  it.each([
    ["foreign app", { app: { id: 1 } }, {}],
    ["missing suite", { check_suite: null }, {}],
    ["other workflow", {}, { path: ".github/workflows/ci.yml" }],
    ["fork branch", {}, { head_branch: "fork" }],
    ["wrong event", {}, { event: "pull_request" }],
    ["merge_group event", {}, { event: "merge_group" }],
    ["wrong suite", {}, { check_suite_id: 43 }],
  ])("blocks %s records", async (_label, overrides, provenance) => {
    const api = fakeGithub({ comments: passingComments(), stored: [history(overrides)], provenance });
    const { out } = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], api);
    expect(reasonCodes(JSON.parse(out))).toContain("missing_input");
  });
  it("applies the same provenance rules to prior gate reads", async () => {
    const api = fakeGithub({ comments: passingComments(), checkRuns: [{ ...history(), name: CHECK_NAME, app: { id: 1 }, output: { text: '\u0060\u0060\u0060json\n{"deleted_verdicts":[]}\n\u0060\u0060\u0060' } }] });
    const { out } = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], api);
    expect(reasonCodes(JSON.parse(out))).toContain("missing_input");
  });
  it("trusts a pull_request_target record whatever its head branch", async () => {
    const api = fakeGithub({ comments: passingComments(), stored: [history()], provenance: { event: "pull_request_target", head_branch: "feature" } });
    expect(await gate.readHistory(gateClientFor(api), "o/r", 7)).toEqual([]);
  });
  it("trusts an unchanged default-branch gate record", async () => {
    const api = fakeGithub({ comments: passingComments(), stored: [history()] });
    expect(await gate.readHistory(gateClientFor(api), "o/r", 7)).toEqual([]);
  });
});

describe("R2 model family comparisons", () => {
  it("normalizes only exact explicit aliases", () => {
    expect(gate.normalizeModelFamily("opus")).toBe("claude");
    expect(gate.normalizeModelFamily("sonnet")).toBe("claude");
    for (const value of ["", "Opus", "claude-opus", "gpt-6", "toString", null]) expect(gate.normalizeModelFamily(value)).toBeNull();
  });
});

describe("door branch: report only", () => {
  const files = [{filename:"worker/src/dispatchLogic.ts",status:"modified"}];
  const green = (overrides = {}) => baseInput({
    mode: "report",
    classification: {...okClassification(files,["provider_dispatch"]), door:"revertable"},
    changedFiles: files,
    requiredChecks: ["ci","provider-go-live","secret-scan"].map((name,id) => ({name,id,head_sha:HEAD,status:"completed",conclusion:"success"})),
    reviewThreads: {sha:HEAD,complete:true,threads:[]},
    revertPlan: {sha:HEAD,ok:true,required:true,errors:[]},
    ...overrides,
  });
  const doorCodes = (input) => gate.revertableOk(input).reasons.map((reason) => reason.code);
  it("has the exact code kill switch and cross-family policy", () => {
    expect(gate.DOOR_AUTOMERGE).toBeUndefined();
    expect(gate.CROSS_FAMILY).toEqual({claude:["codex","grok"],codex:["claude"],grok:["claude"]});
    expect(Object.isFrozen(gate.CROSS_FAMILY)).toBe(true);
  });
  it("a fully green revertable PR never waives the approval record", () => {
    const input = green();
    const summary = evaluate(input);
    expect(summary.door_report.ok).toBe(true);
    expect(summary.gate).toBe("fail");
    expect(summary.automerge).toBe("needs_blaine");
    expect(reasonCodes(summary)).toEqual(["approval_missing:provider_dispatch"]);
    expect(conclusionFor(summary).conclusion).toBe("neutral");
    expect(formatSummary(summary)).toContain("Legacy door report (not merge authority)");
    expect(evaluate({...input, comments:[...input.comments, approvalComment()]}).gate).toBe("pass");
  });
  it.each([undefined,null,"typo","one-way"])("door %s fails closed and ignores labels", (door) => {
    const input = green();
    input.classification.door = door;
    input.labels = ["tier:revertable"];
    expect(gate.revertableOk(input).door).toBe("one-way");
    expect(doorCodes(input)).toContain("door_one_way");
    if (door === undefined || door === null) expect(doorCodes(input)).toContain("door_missing");
  });
  it("same-family reviewer is reviewer_same_family, and Jev is never cross-family", () => {
    for (const family of ["codex","jev","human"]) {
      expect(doorCodes(green({comments:[posted(verdict()),posted(verdict({role:"reviewer",family}))]}))).toContain("reviewer_same_family");
    }
  });
  it("mixed Claude + Codex build permits Grok outside both builders, and refuses Codex", () => {
    const prBody = "Built-by: bot=engineer model=model:codex; bot=architect model=model:claude-opus";
    for (const [family,ok] of [["grok",true],["codex",false],["claude",false]]) {
      const report = gate.revertableOk(green({prBody,comments:[posted(verdict()),posted(verdict({role:"reviewer",family}))]}));
      expect(report.ok).toBe(ok);
      if (!ok) expect(report.reasons.map((reason) => reason.code)).toContain("reviewer_same_family");
    }
  });
  it("Grok builds require Claude review; Codex cannot review them", () => {
    for (const [family,ok] of [["claude",true],["codex",false]]) {
      expect(gate.revertableOk(green({prBody:"Built-by: bot=cursor-cloud model=model:grok-overflow",comments:[posted(verdict()),posted(verdict({role:"reviewer",family}))]})).ok).toBe(ok);
    }
  });
  it("a mixed build with a Grok builder still needs Claude, so Codex cannot review it", () => {
    const prBody = "Built-by: bot=architect model=model:claude-opus; bot=cursor-cloud model=model:grok-overflow";
    expect(doorCodes(green({prBody,comments:[posted(verdict()),posted(verdict({role:"reviewer",family:"codex"}))]}))).toContain("reviewer_same_family");
  });
  it("requires exact-head reviewer and QA even when old diff ids are equal", () => {
    for (const role of ["reviewer","verifier"]) {
      const comments = [posted(verdict({sha:role === "verifier" ? OLD : HEAD})),posted(verdict({role:"reviewer",sha:role === "reviewer" ? OLD : HEAD}))];
      expect(doorCodes(green({comments}))).toContain(role === "reviewer" ? "no_review_on_head" : "no_qa_pass_on_head");
    }
  });
  it("rejects absent QA, high QA notes, unknown builders, unresolved threads and invalid plans", () => {
    for (const [overrides,code] of [
      [{comments:[posted(verdict({role:"reviewer"}))]},"no_qa_pass_on_head"],
      [{comments:[posted(verdict({notes:["high: unresolved"]})),posted(verdict({role:"reviewer"}))]},"no_qa_pass_on_head"],
      [{prBody:""},"builder_unattributed"],
      [{reviewThreads:undefined},"threads_unresolved"],
      [{reviewThreads:{sha:HEAD,complete:true,threads:[{isResolved:false}]}},"threads_unresolved"],
      [{reviewThreads:{sha:OLD,complete:true,threads:[]}},"threads_unresolved"],
      [{revertPlan:undefined},"revert_plan_missing"],
      [{revertPlan:{sha:OLD,ok:true,required:true,errors:[]}},"revert_plan_invalid"],
      [{revertPlan:{sha:HEAD,ok:false,required:true,errors:["missing Owner"]}},"revert_plan_invalid"],
    ]) expect(doorCodes(green(overrides))).toContain(code);
  });
  it.each(["ci","provider-go-live","secret-scan"])("requires %s green at this head", (name) => {
    const input = green();
    input.requiredChecks.find((check) => check.name === name).status = "in_progress";
    expect(doorCodes(input)).toContain("required_check_not_green");
    input.requiredChecks.find((check) => check.name === name).head_sha = OLD;
    expect(doorCodes(input)).toContain("required_check_not_green");
  });
  it("head movement still writes nothing, with door reporting enabled", async () => {
    const input = green();
    const api = fakeGithub({comments:input.comments,headAfter:OLD});
    const result = await runCli(["write","--pr","7"],api,{classify:async () => ({classification:input.classification,files})});
    expect(result.code).toBe(0);
    expect(result.out).toContain("not writing");
    expect(api.posts).toEqual([]);
  });
  it("door reports do not change any existing conclusion, reason or approval requirement", () => {
    for (const input of [green(),green({comments:[]}),green({classification:{status:"error"}}),green({liveHeadSha:OLD})]) {
      const before = evaluate(input);
      const after = evaluate({...input,classification:{...input.classification,door:"one-way"},requiredChecks:undefined,reviewThreads:undefined,revertPlan:undefined});
      const legacy = ({door_report:_door,...rest}) => rest;
      expect(legacy(after)).toEqual(legacy(before));
      expect(conclusionFor(after)).toEqual(conclusionFor(before));
    }
  });
});


it("optional door reporting never crowds out existing history or changes a check conclusion", () => {
  const original = evaluate(baseInput());
  delete original.door_report;
  const expanded = {...original, door_report:{door:"one-way",ok:false,reasons:[{code:"classifier_error",detail:"x".repeat(100000)}]}};
  expect(gate.summaryText(expanded, 4000)).toBe(gate.summaryText(original, 4000));
  expect(formatSummary(expanded).length).toBeLessThanOrEqual(formatSummary(original).length + 4000);
  expect(conclusionFor(expanded)).toEqual(conclusionFor(original));
});

// The history evaluator above tests legacy conflict/removal semantics in
// isolation. These tests exercise the full enforced decision used by runGate.
describe("enforced automerge gates", () => {
  const green = (overrides = {}) => baseInput({
    identity:"app", comments:passingComments(),
    requiredChecks:greenChecks(),
    commitStatuses:{sha:HEAD,statuses:[jevStatus()]},
    reviewThreads:{sha:HEAD,complete:true,threads:[]},
    ...overrides,
  });
  const decision = (overrides) => gate.evaluate(green(overrides));
  const errors = (overrides) => reasonCodes(decision(overrides));
  const sensitiveFiles = [{filename:"src/lib/auth-options.ts",status:"modified"}];
  const sensitive = (overrides = {}) => green({
    changedFiles:sensitiveFiles,
    classification:okClassification(sensitiveFiles,["auth"]),
    commitStatuses:{sha:HEAD,statuses:[jevStatus(HEAD,"risky","low")]},
    comments:[...passingComments(),posted(verdict({role:"reviewer",family:"opus"}))],
    ...overrides,
  });
  const pull = {head:{sha:HEAD},state:"open",draft:false,mergeable:true,mergeable_state:"clean",labels:[]};

  it("enforces mode and bot identity even when input requests report/shared-account", () => {
    expect(decision({mode:"report",identity:"shared-account"})).toMatchObject({gate:"pass",mode:"enforce",identity:"app",automerge:"eligible"});
    expect(conclusionFor(decision({comments:[]})).conclusion).toBe("failure");
  });

  it("allows a non-held sensitive PR only after distinct Opus, Sonnet, Jev, CI and QA pass", () => {
    const result = gate.evaluate(sensitive());
    expect(result).toMatchObject({gate:"pass",opus_required:true,held_categories:[],automerge:"eligible"});
    expect(result.reasons).toEqual([]);
    expect(gate.mergeEligibility(result,"true",pull)).toBe(true);
  });

  it.each(["opus","sonnet"])("missing %s cannot be replaced by the other review", (model) => {
    const comments = sensitive().comments.filter((entry) => !entry.body.includes(`"model_family": "${model}"`));
    expect(reasonCodes(gate.evaluate(sensitive({comments})))).toContain(`${model}_not_pass`);
  });

  it("generic Claude review cannot satisfy either named review gate", () => {
    const comments = [posted(verdict()),posted(verdict({role:"reviewer",family:"claude"}))];
    comments[1].body = comments[1].body.replaceAll("opus-reviewer","generic-reviewer");
    expect(reasonCodes(gate.evaluate(sensitive({comments})))).toEqual(expect.arrayContaining(["opus_not_pass","sonnet_not_pass"]));
  });

  it("accepts normalized emitter families only with distinct explicit reviewer ids", () => {
    const comments = [posted(verdict()), ...["opus","sonnet"].map((model) => {
      const value=verdict({role:"reviewer",family:"claude"});
      value.verifier.id=`${model}-reviewer`;
      return posted(value);
    })];
    expect(gate.evaluate(sensitive({comments})).gate).toBe("pass");
  });

  it.each(["low","normal","risky"])("retains the QA floor at tier %s", (tier) => {
    const input = tier === "risky" ? sensitive() : green();
    input.commitStatuses.statuses=[jevStatus(HEAD,tier,"low")];
    input.comments=input.comments.filter((entry)=>!entry.body.includes('"role": "verifier"'));
    expect(reasonCodes(gate.evaluate(input))).toContain("qa_not_pass");
  });

  it.each(["ci","provider-go-live","secret-scan"])("%s must succeed at the head from GitHub Actions", (name) => {
    for (const bad of [{conclusion:"failure"},{status:"in_progress"},{conclusion:"skipped"},{conclusion:"neutral"},{head_sha:OLD},{app:{id:1}}]) {
      expect(errors({requiredChecks:greenChecks().map((run)=>run.name===name?{...run,...bad}:run)})).toContain("ci_not_pass");
    }
    expect(errors({requiredChecks:greenChecks().filter((run)=>run.name!==name)})).toContain("ci_not_pass");
  });

  it("a newer failing CI attempt cannot be hidden by an older success", () => {
    expect(errors({requiredChecks:[...greenChecks(),{...greenChecks()[0],id:999,conclusion:"failure"}]})).toContain("ci_not_pass");
  });

  it.each([undefined,null,[],[{...jevStatus(),state:"failure"}],[{...jevStatus(),description:"no_verdict"}],[jevStatus(HEAD,"risky","risky")],[jevStatus(OLD)],[{...jevStatus(),creator:{login:"mallory"}}]])("missing/rejected Jev marker blocks: %j", (statuses) => {
    expect(errors({commitStatuses:{sha:HEAD,statuses}})).toContain("jev_not_pass");
  });

  it("a risky Jev marker cannot be hidden by a passing marker", () => {
    expect(errors({commitStatuses:{sha:HEAD,statuses:[jevStatus(),jevStatus(HEAD,"risky","risky")]}})).toContain("jev_not_pass");
  });

  it.each(["model=other-model", "screener=other-writer"])("rejects a marker with %s", (replacement) => {
    const status=jevStatus();
    const key=replacement.split("=")[0];
    status.description=status.description.replace(new RegExp(`${key}=[^ ]+`),replacement);
    expect(errors({commitStatuses:{sha:HEAD,statuses:[status]}})).toContain("jev_not_pass");
  });

  it.each(["qa","sonnet","opus","ci","jev","classifier","threads","live"])("%s evidence at another SHA blocks even with equal diff_id", (source) => {
    const input=sensitive();
    if (["qa","sonnet","opus"].includes(source)) input.comments=input.comments.map((entry)=> {
      const matches=source==="qa"?entry.body.includes('"role": "verifier"'):entry.body.includes(`"model_family": "${source}"`);
      return matches?{...entry,body:entry.body.replaceAll(HEAD,OLD)}:entry;
    });
    if(source==="ci") input.requiredChecks=greenChecks(OLD);
    if(source==="jev") input.commitStatuses={sha:OLD,statuses:[jevStatus(OLD)]};
    if(source==="classifier") input.classification={...input.classification,sha:OLD};
    if(source==="threads") input.reviewThreads={...input.reviewThreads,sha:OLD};
    if(source==="live") input.liveHeadSha=OLD;
    input.verifiedEvidence=verifiedFor(input.comments);
    const result=gate.evaluate(input);
    expect(result.gate).toBe("fail");
    expect(gate.mergeEligibility(result,"true",pull)).toBe(false);
  });

  it.each([
    ["prod_db_migration",{filename:"supabase/migrations/20261030120000_demo.sql",status:"added"},[]],
    ["deletion",{filename:"docs/old.md",status:"removed"},[]],
    ["vendor_spend",{filename:"src/vendors/quote.ts",status:"modified"},[]],
    ["vendor_spend",{filename:"src/billing/price.ts",status:"modified"},["payments"]],
    ["branch_protection",{filename:"config/branch-protection.json",status:"modified"},[]],
    ["sonar_safe_mark",{filename:"scripts/sonar-safe-marks.mjs",status:"modified"},[]],
    ["gate_machinery",{filename:"AGENTS.md",status:"modified"},["gate_machinery"]],
    ["unclassified",{filename:"unknown.bin",status:"added"},["unclassified"]],
  ])("holds %s even with an approval and passing reviews", (category,file,classes) => {
    const result=decision({changedFiles:[file],classification:okClassification([file],classes),comments:[...sensitive().comments,approvalComment()]});
    expect(reasonCodes(result)).toContain(`held:${category}`);
    expect(gate.mergeEligibility(result,"true",pull)).toBe(false);
  });

  it("holds gate loosenings even with an approval", () => {
    expect(errors({classification:{...okClassification(),gate_loosening:{detected:true}},comments:[...passingComments(),approvalComment()]})).toContain("held:gate_loosening");
  });

  it("classifies previous rename paths and compatibility spellings conservatively", () => {
    expect(gate.heldCategories([{filename:"docs/new.md",status:"renamed",previous_filename:"scripts/sonar-safe-marks.mjs"}],{})).toContain("sonar_safe_mark");
    expect(gate.heldCategories([{filename:"supabase/ｍigrations/demo.sql",status:"added"}],{})).toContain("prod_db_migration");
  });

  it.each(["optomachina","mallory","github-actions[bot]"])("ignores verdicts from %s, including claimed bot payloads", (login) => {
    const comments=passingComments().map((entry)=>({...entry,user:{login}}));
    const result=decision({comments});
    expect(result.gate).toBe("fail");
    expect(reasonCodes(result)).toContain("sonnet_not_pass");
    expect(result.ignored.length).toBeGreaterThan(0);
  });

  it.each([undefined,"","false","TRUE","True"," true","true ",true,"1"])("kill switch %j never merges", (value) => {
    expect(gate.mergeEligibility(decision(),value,pull)).toBe(false);
  });

  it.each([{head:{sha:OLD}},{draft:true},{state:"closed"},{mergeable:false},{mergeable:null},{mergeable_state:"blocked"}])("refuses PR state %j", (bad) => {
    expect(gate.mergeEligibility(decision(),"true",{...pull,...bad})).toBe(false);
  });

  it("keeps outstanding trusted FAILs and removed FAIL history blocking", () => {
    const fail=posted(verdict({role:"reviewer",result:"FAIL",family:"sonnet"}));
    expect(errors({comments:[...passingComments(),fail]})).toContain("verdict_conflict");
    const history=gate.historyEntriesFromComment(fail);
    expect(errors({history})).toContain("verdict_conflict");
  });

  it("unresolved or incomplete thread snapshots block", () => {
    for(const reviewThreads of [undefined,{sha:HEAD,complete:false,threads:[]},{sha:HEAD,complete:true,threads:[{isResolved:false}]}]) expect(errors({reviewThreads})).toContain("threads_unresolved");
  });

  it("runs only squash with GitHub's atomic head guard and never defers via --auto", async () => {
    const calls=[];
    const comments=passingComments();
    const summary={...decision(),comments_fingerprint:gate.commentsFingerprint(comments)};
    const merged=await gate.mergePull({client:{json:async()=>pull,paginate:async()=>comments},repo:"o/r",pr:7,summary,switchValue:"true",merge:async(args)=>calls.push(args)});
    expect(merged).toEqual({merged:true,reason:null});
    expect(calls).toEqual([["pr","merge","7","--repo","o/r","--squash","--match-head-commit",HEAD]]);
  });

  it("a comment created, edited or deleted after evaluation makes zero merge calls", async () => {
    const comments=passingComments().map((comment,index)=>({...comment,id:comment.id??index+1,updated_at:comment.updated_at??"2026-10-31T00:00:00Z"}));
    const summary={...decision(),comments_fingerprint:gate.commentsFingerprint(comments)};
    const later=[
      [...comments,{id:999,updated_at:"2026-10-31T00:00:01Z",user:{login:"x"},body:"new"}],
      comments.map((comment,index)=>index===0?{...comment,updated_at:"2026-10-31T00:00:02Z"}:comment),
      comments.slice(1),
      undefined,
    ];
    for(const live of later){
      const calls=[];
      const paginate=async()=>{ if(live===undefined) throw new Error("unreadable"); return live; };
      expect(await gate.mergePull({client:{json:async()=>pull,paginate},repo:"o/r",pr:7,summary,switchValue:"true",merge:async(args)=>calls.push(args)})).toEqual({merged:false,reason:"PR comments changed after evaluation (or could not be re-read)"});
      expect(calls).toEqual([]);
    }
    const calls=[];
    expect(await gate.mergePull({client:{json:async()=>pull,paginate:async()=>comments},repo:"o/r",pr:7,summary:decision(),switchValue:"true",merge:async(args)=>calls.push(args)})).toMatchObject({merged:false});
    expect(calls).toEqual([]);
  });

  it("a push after evaluation makes zero merge calls", async () => {
    const calls=[];
    expect(await gate.mergePull({client:{json:async()=>({...pull,head:{sha:OLD}})},repo:"o/r",pr:7,summary:decision(),switchValue:"true",merge:async(args)=>calls.push(args)})).toMatchObject({merged:false});
    expect(calls).toEqual([]);
  });

  it("switch off makes zero API and merge calls", async () => {
    const unexpected=()=>{throw new Error("must not run");};
    expect(await gate.mergePull({client:{json:unexpected},repo:"o/r",pr:7,summary:decision(),merge:unexpected})).toEqual({merged:false,reason:"DOOR_AUTOMERGE is not exactly true"});
  });

  it("writer receives the kill switch only from Actions variables", () => {
    const workflow=yaml.load(readFileSync(new URL("../.github/workflows/ovd-merge-gate.yml",import.meta.url),"utf8"));
    const step=workflow.jobs["ovd-merge-gate-writer"].steps.find((item)=>item.name==="Write ovd-merge-gate");
    expect(step.env.DOOR_AUTOMERGE).toBe("${{ vars.DOOR_AUTOMERGE }}");
    expect(step.run).not.toMatch(/source |\.env|--admin|--auto\b/);
    expect(workflow.jobs["ovd-merge-gate-history"].permissions.contents).toBe("read");
  });
});

describe("enforced runtime boundaries", () => {
  it.each([null,undefined,[],{},"bad input"])("invalid input %j fails closed", (input) => {
    expect(gate.evaluate(input).gate).toBe("fail");
    expect(gate.jevGate(undefined,undefined)).toEqual({ok:false,tier:null});
  });

  it("the workflow write path merges only after a complete pass and explicit switch", async () => {
    const api=fakeGithub({comments:passingComments()});
    const calls=[];
    const result=await runCli(["write","--pr","7","--history-result","success"],api,{env:{DOOR_AUTOMERGE:"true"},merge:async(args)=>calls.push(args)});
    expect(result.code).toBe(0);
    expect(api.posts[0].conclusion).toBe("success");
    expect(calls).toEqual([["pr","merge","7","--repo","o/r","--squash","--match-head-commit",HEAD]]);
  });

  it.each([undefined,"false","", "TRUE"])("write path with switch %j writes its real result but never merges", async (DOOR_AUTOMERGE) => {
    const api=fakeGithub({comments:passingComments()});
    const calls=[];
    await runCli(["write","--pr","7"],api,{env:{DOOR_AUTOMERGE},merge:async(args)=>calls.push(args)});
    expect(api.posts[0].conclusion).toBe("success");
    expect(calls).toEqual([]);
  });

  it("history failure and a gate failure cannot merge even with switch on", async () => {
    for(const options of [{comments:[]},{comments:passingComments()}]) {
      const api=fakeGithub(options);
      const calls=[];
      await runCli(["write","--pr","7","--history-result","failure"],api,{env:{DOOR_AUTOMERGE:"true"},merge:async(args)=>calls.push(args)});
      expect(api.posts[0].conclusion).toBe("failure");
      expect(calls).toEqual([]);
    }
  });

  it("full head text holds a Sonar safe mark without relying on a patch", async () => {
    const api=fakeGithub({comments:passingComments(),content:"// NOSONAR"});
    const result=await runCli(["evaluate","--pr","7","--sha",HEAD,"--json"],api,{classify:classifyPull});
    expect(reasonCodes(JSON.parse(result.out))).toContain("held:sonar_safe_mark");
  });

  it("full head text holds production apply outside migration paths", async () => {
    const api=fakeGithub({comments:passingComments(),files:[{filename:"scripts/example.mjs",status:"added"}],content:"supabase db push"});
    const result=await runCli(["evaluate","--pr","7","--sha",HEAD,"--json"],api,{classify:classifyPull});
    expect(reasonCodes(JSON.parse(result.out))).toContain("held:prod_db_migration");
  });

  it("oversized or unreadable held-content scans cannot qualify", async () => {
    for(const content of ["x".repeat(256*1024+1)]) {
      const api=fakeGithub({comments:passingComments(),content});
      const result=await runCli(["evaluate","--pr","7","--sha",HEAD,"--json"],api,{classify:classifyPull});
      expect(reasonCodes(JSON.parse(result.out))).toContain("classifier_error");
    }
    const api=fakeGithub({comments:passingComments(),fail:["/contents/"]});
    const result=await runCli(["evaluate","--pr","7","--sha",HEAD,"--json"],api,{classify:classifyPull});
    expect(reasonCodes(JSON.parse(result.out))).toContain("classifier_error");
  });

  it("reads all thread pages and binds each to the live head", async () => {
    let page=0;
    const client={post:async()=>({data:{repository:{pullRequest:{headRefOid:HEAD,reviewThreads:{nodes:[{isResolved:++page===1}],pageInfo:{hasNextPage:page===1,endCursor:"next"}}}}}})};
    expect(await gate.readReviewThreads(client,"o/r",7,HEAD)).toEqual({sha:HEAD,complete:true,threads:[{isResolved:true},{isResolved:false}]});
  });

  it.each([
    {errors:[{message:"partial"}]},
    {data:{repository:{pullRequest:{headRefOid:OLD,reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}}}}}},
    {data:{repository:{pullRequest:{headRefOid:HEAD,reviewThreads:{nodes:[]}}}}},
  ])("rejects partial or stale thread data", async (response) => {
    await expect(gate.readReviewThreads({post:async()=>response},"o/r",7,HEAD)).rejects.toThrow();
  });
});

// Checklist item 17: every refusal runs the real write path (or the real
// decision) with the switch on where it matters, and asserts that no merge
// call is made, not that a mocked decision was consulted.
describe("automerge refusals (hardening checklist item 17)", () => {
  const writeWith = async (apiOptions, { env = { DOOR_AUTOMERGE: "true" }, classify } = {}) => {
    const api = fakeGithub(apiOptions);
    const calls = [];
    const result = await runCli(["write", "--pr", "7", "--history-result", "success"], api, { env, classify, merge: async (args) => calls.push(args) });
    const gatePost = api.posts.find((post) => post.name === CHECK_NAME);
    return { ...result, calls, gatePost, codes: gatePost ? reasonCodes(JSON.parse(gatePost.output.text.slice(8, -4))) : [] };
  };
  const classifyAt = async ({ headSha }) => ({ classification: { ...okClassification(), sha: headSha }, files: DOCS_FILES });

  it("control: a fully passing PR with the switch on merges exactly once", async () => {
    const { calls, out } = await writeWith({ comments: passingComments() });
    expect(calls).toEqual([["pr", "merge", "7", "--repo", "o/r", "--squash", "--match-head-commit", HEAD]]);
    expect(out).toContain("squash merge submitted");
  });

  it.each([undefined, "", "false", "TRUE", "yes"])("switch off (%j): the gate runs and passes but never merges", async (DOOR_AUTOMERGE) => {
    const { calls, gatePost, out } = await writeWith({ comments: passingComments() }, { env: { DOOR_AUTOMERGE } });
    expect(gatePost.conclusion).toBe("success");
    expect(calls).toEqual([]);
    expect(out).toContain("ovd-merge-gate: no merge: DOOR_AUTOMERGE is not exactly true");
  });

  it.each([["automerge:hold"], [" Automerge:Hold "], ["ready", "automerge:hold"]])("hold label %j stops a passing PR with the switch on", async (...names) => {
    const { calls, gatePost, out } = await writeWith({ comments: passingComments(), labels: names.map((name) => ({ name })) });
    expect(gatePost.conclusion).toBe("success");
    expect(calls).toEqual([]);
    expect(out).toContain("automerge:hold");
  });

  it.each(["1", "true", "false", "anything"])("OVD_AUTOMERGE_DISABLED=%j stops a passing PR with the switch on", async (value) => {
    const { calls, out } = await writeWith({ comments: passingComments() }, { env: { DOOR_AUTOMERGE: "true", OVD_AUTOMERGE_DISABLED: value } });
    expect(calls).toEqual([]);
    expect(out).toContain("ovd-merge-gate: no merge: OVD_AUTOMERGE_DISABLED is set");
  });

  it.each([undefined, null, "x", [{}], [{ name: 7 }]])("an unreadable label list (%j) stops the merge", async (labels) => {
    const calls = [];
    const summary = gate.evaluate({ ...baseInput({ identity: "app", requiredChecks: greenChecks(), commitStatuses: { sha: HEAD, statuses: [jevStatus()] }, reviewThreads: { sha: HEAD, complete: true, threads: [] } }) });
    expect(summary.gate).toBe("pass");
    const pull = { head: { sha: HEAD }, state: "open", draft: false, mergeable: true, mergeable_state: "clean", labels };
    expect(await gate.mergePull({ client: { json: async () => pull }, repo: "o/r", pr: 7, summary, switchValue: "true", merge: async (args) => calls.push(args) })).toMatchObject({ merged: false });
    expect(calls).toEqual([]);
  });

  it("stale head: reviews for an earlier head with an equal diff_id cannot merge the new head", async () => {
    const { calls, gatePost, codes: found } = await writeWith({ head: NEW_HEAD, comments: passingComments() }, { classify: classifyAt });
    expect(gatePost.conclusion).toBe("failure");
    expect(found).toEqual(expect.arrayContaining(["sonnet_not_pass", "qa_not_pass"]));
    expect(calls).toEqual([]);
  });

  it("push after reviews: a head that moves before the write gets no result and no merge", async () => {
    const { calls, gatePost, out } = await writeWith({ headAfter: NEW_HEAD, comments: passingComments() });
    expect(gatePost).toBeUndefined();
    expect(out).toContain(`head moved from ${HEAD} to ${NEW_HEAD}`);
    expect(calls).toEqual([]);
  });

  it.each(["optomachina", "mallory"])("spoofed author: a verdict body naming the verifier bot but posted by %s does not count", async (login) => {
    const comments = passingComments().map((item) => ({ ...item, user: { login } }));
    const { calls, gatePost, codes: found } = await writeWith({ comments });
    expect(gatePost.conclusion).toBe("failure");
    expect(found).toEqual(expect.arrayContaining(["sonnet_not_pass", "qa_not_pass"]));
    expect(calls).toEqual([]);
  });

  it.each([[[]], [[{ ...jevStatus(), state: "pending" }]], [[jevStatus(OLD)]]])("missing Jev marker (%j) blocks the merge", async (statuses) => {
    const { calls, gatePost, codes: found } = await writeWith({ comments: passingComments(), statuses });
    expect(gatePost.conclusion).toBe("failure");
    expect(found).toContain("jev_not_pass");
    expect(calls).toEqual([]);
  });

  it("CHANGES_REQUIRED (a reviewer FAIL with findings) at the head blocks even with a Sonnet PASS", async () => {
    const passes = passingComments();
    const changes = posted(verdict({ role: "reviewer", result: "FAIL", findings: [{ severity: "medium", file: "docs/notes.md", summary: "fix this" }] }));
    const { calls, gatePost, codes: found } = await writeWith({ comments: [...passes, changes] });
    expect(gatePost.conclusion).toBe("failure");
    expect(found).toEqual(expect.arrayContaining(["verdict_conflict", "actionable_findings"]));
    expect(calls).toEqual([]);
  });

  it("a literal CHANGES_REQUIRED verdict value from the bot is unreadable and blocks", async () => {
    const passes = passingComments();
    const changes = posted(verdict({ role: "reviewer" }));
    changes.body = changes.body.replace('"verdict": "PASS"', '"verdict": "CHANGES_REQUIRED"');
    const { calls, gatePost, codes: found } = await writeWith({ comments: [...passes, changes] });
    expect(gatePost.conclusion).toBe("failure");
    expect(found).toContain("verdict_schema_error");
    expect(calls).toEqual([]);
  });

  it("an Opus CHANGES_REQUIRED is not cleared by a later Sonnet PASS", async () => {
    const changes = posted(verdict({ role: "reviewer", family: "opus" }));
    changes.body = changes.body.replace('"verdict": "PASS"', '"verdict": "CHANGES_REQUIRED"');
    const { calls, gatePost, codes: found } = await writeWith({ comments: [changes, ...passingComments()] });
    expect(gatePost.conclusion).toBe("failure");
    expect(found).toContain("verdict_schema_error");
    expect(calls).toEqual([]);
  });

  it.each(["bot=architect model=model:claude-opus", "bot=engineer model=model:codex; bot=architect model=model:claude-sonnet"])("builder family self-review (%s): a Claude reviewer PASS on a Claude build never merges", async (builders) => {
    const { calls, gatePost, codes: found } = await writeWith({ comments: passingComments(), body: `Built-by: ${builders}` });
    expect(gatePost.conclusion).toBe("failure");
    expect(found).toContain("reviewer_same_family");
    expect(calls).toEqual([]);
  });

  it.each([
    ["prod_db_migration", { filename: "supabase/migrations/20261030120000_demo.sql", status: "added" }],
    ["deletion", { filename: "docs/old.md", status: "removed" }],
    ["gate_machinery", { filename: ".github/workflows/ovd-merge-gate.yml", status: "renamed", previous_filename: ".github/workflows/old-gate.yml" }],
  ])("held path (%s) through the real detector never merges, even with an approval", async (category, file) => {
    const { calls, gatePost, codes: found } = await writeWith({ comments: [...passingComments(), approvalComment()], files: [file] }, { classify: classifyPull });
    expect(gatePost.conclusion).toBe("failure");
    expect(found).toContain(`held:${category}`);
    expect(calls).toEqual([]);
  });

  it.each([
    ["a list shorter than changed_files (pagination)", { files: DOCS_FILES, changedFiles: 150 }],
    ["more files than the API can list", { files: DOCS_FILES, changedFiles: 3001 }],
    ["an empty list", { files: [], changedFiles: 0 }],
  ])("%s is held and never merges", async (_name, options) => {
    const { calls, gatePost, codes: found } = await writeWith({ comments: passingComments(), ...options }, { classify: classifyPull });
    expect(gatePost.conclusion).toBe("failure");
    expect(found).toContain("held:file_list_incomplete");
    expect(calls).toEqual([]);
  });

  it("heldCategories holds a missing, empty or unclassified file list", () => {
    for (const files of [null, undefined, []]) expect(gate.heldCategories(files, okClassification())).toContain("file_list_incomplete");
    expect(gate.heldCategories(DOCS_FILES, { ...okClassification(), status: "error" })).toContain("file_list_incomplete");
    expect(gate.heldCategories(DOCS_FILES, okClassification())).toEqual([]);
  });
});
