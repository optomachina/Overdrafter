// @vitest-environment node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// js-yaml ships with eslint (a dev dependency); no direct dependency added.
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
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
  deletedVerdictFromEvent,
  evaluate,
  headDiffId,
  main,
  reasonCodes,
  runGate,
} from "./ovd-merge-gate.mjs";
import { detect, loadConfig } from "./sensitive-class-detect.mjs";
import { formatVerdictBlock } from "./verdict-schema.mjs";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const BASE = "e".repeat(40);
const DIFF = "c".repeat(64);
const OTHER_DIFF = "d".repeat(64);
const PATCH = "f".repeat(40);
const BOT = "overdrafter-verifier[bot]";

let nextId = 100;
const at = (id) => new Date(Date.UTC(2026, 9, 20, 0, 0, 0) + id * 1000).toISOString().replace(".000Z", "Z");

function verdict({ role = "verifier", result = "PASS", sha = HEAD, diffId = DIFF, login = "optomachina", checks = "green", notes, findings, runs = [1], supersedes, reason } = {}) {
  const value = {
    schema: "overdrafter.verdict/v1",
    role,
    verdict: result,
    sha,
    patch_id: PATCH,
    diff_id: diffId,
    verifier: { id: role === "verifier" ? "astra-verifier" : "opus-reviewer", model_family: "opus", github_login: login },
    evidence: runs.map((run) => ({ kind: "ci-run", url: `https://github.com/optomachina/Overdrafter/actions/runs/${run}` })),
    notes: notes ?? (result === "PASS_NOTES" ? ["low: fine"] : []),
    readiness: { conflicts: 0, open_threads: 0, checks },
    timestamp: "2026-10-20T00:00:00Z",
  };
  if (role === "reviewer" || findings) value.findings = findings ?? [];
  if (supersedes !== undefined) Object.assign(value, { supersedes, reason });
  return value;
}

function comment(body, { id = nextId++, login = "optomachina", edited = false } = {}) {
  const created = at(id);
  return { id, body, created_at: created, updated_at: edited ? at(id + 5000) : created, user: { login } };
}

const posted = (value, options = {}) => comment(`**OverDrafter verdict**\n\n${formatVerdictBlock(value)}\n`, { login: value.verifier.github_login, ...options });
const approvalComment = (overrides = {}, options = {}) => comment(formatApprovalBlock({
  schema: APPROVAL_SCHEMA_ID, sha: HEAD, diff_id: DIFF, approver: "blaine", card_id: "K-959", timestamp: "2026-10-20T00:00:00Z", ...overrides,
}), options);

const DOCS_FILES = [{ filename: "docs/notes.md", status: "modified" }];
const okClassification = (files = DOCS_FILES, classes = []) => ({
  status: "ok",
  sha: HEAD,
  classes,
  files: files.map((file) => ({ path: file.filename, classes: [], category: "docs", reasons: [] })),
  errors: [],
});

const baseInput = (overrides = {}) => ({
  headSha: HEAD,
  liveHeadSha: HEAD,
  headDiffId: DIFF,
  comments: [posted(verdict()), posted(verdict({ role: "reviewer" }))],
  commits: [{ author: { login: "optomachina" }, committer: { login: "optomachina" } }],
  prAuthor: "optomachina",
  changedFiles: DOCS_FILES,
  classification: okClassification(),
  mode: "enforce",
  identity: "shared-account",
  ...overrides,
});

const codes = (input) => reasonCodes(evaluate(input));

describe("constants", () => {
  it("is report mode, shared-account identity, optomachina-only trust in stage A", () => {
    expect(MODE).toBe("report");
    expect(IDENTITY).toBe("shared-account");
    expect([...TRUSTED_VERIFIERS]).toEqual(["optomachina"]);
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
  it("stage A: an optomachina verdict counts and the summary says shared-account (not enforced)", () => {
    const summary = evaluate(baseInput());
    expect(summary.gate).toBe("pass");
    expect(summary.identity).toBe("shared-account");
    expect(summary.identity_note).toContain("identity: shared-account (not enforced)");
    expect(summary.identity_note).toContain("verifier ≠ author not enforced (single identity)");
  });

  it("stage B: an optomachina verdict is ignored (verifier_is_merger)", () => {
    const summary = evaluate(baseInput({ identity: "app" }));
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

  it("stage A: the bot is not trusted yet", () => {
    const comments = [posted(verdict({ login: BOT })), posted(verdict({ role: "reviewer", login: BOT }))];
    expect(codes(baseInput({ comments }))).toEqual(["no_qa_pass_on_head", "no_review_on_head"]);
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
      expect(summary.mode).toBe("report");
      expect(reasonCodes(summary)).toEqual(["no_qa_pass_on_head", "no_review_on_head"]);
    });

    it("reads no trust, mode or identity setting from env in the source, and the workflow uses no repo variables", () => {
      const source = readFileSync(new URL("./ovd-merge-gate.mjs", import.meta.url), "utf8");
      const envReads = [...source.matchAll(/env\.([A-Z_]+)/g)].map((match) => match[1]);
      expect(new Set(envReads)).toEqual(new Set(["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_API_URL", "GITHUB_REPOSITORY", "GITHUB_EVENT_PATH"]));
      expect(source).not.toMatch(/process\.env\[/);
      const workflow = readFileSync(new URL("../.github/workflows/ovd-merge-gate.yml", import.meta.url), "utf8");
      expect(workflow).not.toMatch(/\bvars\./);
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

  it("has exactly checks: write, pull-requests: read, contents: read, with no job-level overrides", () => {
    expect(workflow.permissions).toEqual({ checks: "write", "pull-requests": "read", contents: "read" });
    for (const [, job] of jobs) expect(job.permissions).toBeUndefined();
  });

  it("has one job named ovd-merge-gate-writer (never the check name) and no job-level if", () => {
    expect(jobs.map(([key]) => key)).toEqual(["ovd-merge-gate-writer"]);
    for (const [key, job] of jobs) {
      expect(key).not.toBe(CHECK_NAME);
      expect(job.name).toBe("ovd-merge-gate-writer");
      expect(job.if).toBeUndefined();
    }
  });

  it("queues per PR without cancelling", () => {
    expect(workflow.concurrency.group).toBe("ovd-merge-gate-${{ github.event.pull_request.number || github.event.issue.number || inputs.pr || github.sha }}");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("checks out only the default branch on every trigger, never the head ref", () => {
    const checkouts = steps.filter((step) => String(step.uses ?? "").startsWith("actions/checkout"));
    expect(checkouts).toHaveLength(1);
    for (const step of checkouts) {
      expect(step.if).toBeUndefined();
      expect(step.with.ref).toBe("${{ github.event.repository.default_branch }}");
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

  it("runs the default-branch script for every event, including merge_group, and writes through it", () => {
    const run = steps.find((step) => step.run?.includes("ovd-merge-gate.mjs")).run;
    expect(run).toContain("merge_group)");
    expect(run).toContain("node scripts/ovd-merge-gate.mjs merge-group --sha \"$GITHUB_SHA\"");
    expect(run).toContain("node scripts/ovd-merge-gate.mjs write --pr \"$pr\"");
    for (const event of ["pull_request_target)", "issue_comment)", "workflow_dispatch)"]) expect(run).toContain(event);
    expect(run).toContain("refs/heads/$DEFAULT_BRANCH");
  });
});

// ----------------------------------------------------------------- IO

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
}

function fakeGithub({ head = HEAD, headAfter, comments = [], files = DOCS_FILES, commits = [{ author: { login: "optomachina" }, committer: { login: "optomachina" } }], checkRuns = [], fail = [] } = {}) {
  const requests = [];
  const posts = [];
  let pullReads = 0;
  const fetchImpl = async (url, options = {}) => {
    const { pathname } = new URL(url);
    const method = options.method ?? "GET";
    requests.push(`${method} ${pathname}`);
    if (fail.some((part) => pathname.includes(part))) return response(500, { message: "boom" });
    if (method === "POST" && pathname === "/repos/o/r/check-runs") {
      posts.push(JSON.parse(options.body));
      return response(201, { id: 1 });
    }
    if (pathname === "/repos/o/r/pulls/7") {
      pullReads += 1;
      const sha = headAfter && pullReads > 1 ? headAfter : head;
      return response(200, { head: { sha }, base: { ref: "main", sha: BASE }, user: { login: "optomachina" }, commits: commits.length, changed_files: files.length });
    }
    if (pathname === "/repos/o/r/issues/7/comments") return response(200, comments);
    if (pathname === "/repos/o/r/pulls/7/commits") return response(200, commits);
    if (pathname === "/repos/o/r/pulls/7/files") return response(200, files);
    if (pathname.startsWith(`/repos/o/r/commits/`) && pathname.endsWith("/check-runs")) return response(200, { check_runs: checkRuns });
    if (pathname.endsWith("/status") || pathname.endsWith("/statuses")) return response(200, { statuses: [{ context: "jev-screen", state: "failure" }] });
    return response(404, { message: `no route ${pathname}` });
  };
  const client = {
    json: async (p) => (await fetchImpl(`https://api.test${p}`)).json(),
    raw: async (p) => (await fetchImpl(`https://api.test${p}`)).text(),
  };
  return { fetch: fetchImpl, client, requests, posts };
}

function fakeGit(calls = []) {
  return (args, options = {}) => {
    calls.push({ args, env: options.env ?? {} });
    if (args[0] === "rev-parse") return `${BASE}\n`;
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
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("IO wrapper and CLI", () => {
  it("evaluate --json prints the summary and exits 0 on pass", async () => {
    const api = fakeGithub({ comments: passingComments() });
    const { code, out } = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], api);
    expect(code).toBe(0);
    const summary = JSON.parse(out);
    expect(summary).toMatchObject({ gate: "pass", sha: HEAD, diff_id: DIFF, mode: "report", identity: "shared-account", automerge: "needs_release" });
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

  it("write evaluates the live head and writes a neutral REPORT check in report mode", async () => {
    const api = fakeGithub({ comments: [] });
    const { code } = await runCli(["write", "--pr", "7"], api);
    expect(code).toBe(0);
    expect(api.posts).toHaveLength(1);
    expect(api.posts[0]).toMatchObject({ name: "ovd-merge-gate", head_sha: HEAD, status: "completed", conclusion: "neutral" });
    expect(api.posts[0].output.title).toBe("REPORT: would block: no_qa_pass_on_head, no_review_on_head");
    expect(api.posts[0].output.summary).toContain("identity: shared-account (not enforced)");
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

  it("never reads the advisory jev-screen status: a failing or missing jev-screen changes nothing", async () => {
    const api = fakeGithub({ comments: passingComments() });
    const { code, out } = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], api);
    expect(code).toBe(0);
    expect(JSON.parse(out).gate).toBe("pass");
    expect(api.requests.some((request) => /\/status(es)?$/.test(request))).toBe(false);
    expect(out).not.toMatch(/jev/i);
    const source = readFileSync(new URL("./ovd-merge-gate.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/\/statuses?\b|jev-screen["']/);
  });

  it("runs the real default-branch detector through the fake API (docs-only passes, workflow change needs approval)", async () => {
    const docs = fakeGithub({ comments: passingComments() });
    const docsResult = await runCli(["evaluate", "--pr", "7", "--sha", HEAD, "--json"], docs, { classify: classifyPull });
    expect(JSON.parse(docsResult.out)).toMatchObject({ gate: "pass", automerge: "needs_release" });

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

describe("deleted verdicts fail closed until a fresh verdict", () => {
  const deletion = (value, id = 1) => ({ action: "deleted", comment: { id, body: formatVerdictBlock(value), created_at: at(id), user: { login: value.verifier.github_login } } });

  it("reads a deleted verdict from an issue_comment deleted event", () => {
    expect(deletedVerdictFromEvent(deletion(verdict({ result: "FAIL" })))).toMatchObject({ comment_id: 1, author: "optomachina", sha: HEAD, diff_id: DIFF, role: "verifier" });
    expect(deletedVerdictFromEvent({ action: "created", comment: { body: formatVerdictBlock(verdict()) } })).toBeNull();
    expect(deletedVerdictFromEvent({ action: "deleted", comment: { body: "hello" } })).toBeNull();
  });

  it("fails edited_verdict for a deleted trusted verdict with no fresher verdict", () => {
    const deleted = deletedVerdictFromEvent(deletion(verdict({ result: "FAIL" }), 99999));
    expect(codes(baseInput({ deletedVerdicts: [deleted] }))).toContain("edited_verdict");
  });

  it("clears once a fresh verdict of that role is posted after the deleted one", () => {
    const deleted = deletedVerdictFromEvent(deletion(verdict({ result: "FAIL" }), 1));
    expect(evaluate(baseInput({ deletedVerdicts: [deleted] })).gate).toBe("pass");
  });

  it("ignores deletions by untrusted logins", () => {
    const deleted = deletedVerdictFromEvent(deletion(verdict({ result: "FAIL", login: "mallory" }), 99999));
    expect(evaluate(baseInput({ deletedVerdicts: [deleted] })).gate).toBe("pass");
  });

  it("carries a deletion forward from earlier gate check runs on the head", async () => {
    const deleted = deletedVerdictFromEvent(deletion(verdict({ result: "FAIL" }), 99999));
    const checkRuns = [{ name: CHECK_NAME, output: { text: `\`\`\`json\n${JSON.stringify({ deleted_verdicts: [deleted] })}\n\`\`\`` } }];
    const api = fakeGithub({ comments: passingComments(), checkRuns });
    const summary = await runGate({ client: { ...api.client, paginate: async (p, pick = (d) => d) => pick(await api.client.json(p)) }, repo: "o/r", pr: 7, git: fakeGit(), diff: () => DIFF, classify: docsClassify });
    expect(reasonCodes(summary)).toContain("edited_verdict");
    expect(summary.deleted_verdicts).toEqual([deleted]);
  });
});

describe("headDiffId", () => {
  it("fetches the PR head and base as data, with the token only in the git child env", () => {
    const calls = [];
    const result = headDiffId({ pr: 7, headSha: HEAD, baseRef: "main", cwd: "/x", token: "secret-token", git: fakeGit(calls), diff: ({ base, head }) => (base === BASE && head === HEAD ? DIFF : "wrong") });
    expect(result).toEqual({ diffId: DIFF, error: null });
    expect(calls[0].args).toEqual(["fetch", "--no-tags", "--no-recurse-submodules", "--quiet", "origin", "+refs/pull/7/head:refs/ovd-merge-gate/head", "+refs/heads/main:refs/ovd-merge-gate/base"]);
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain("secret-token");
    expect(calls[0].env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${Buffer.from("x-access-token:secret-token").toString("base64")}`);
    expect(calls[1].env).toEqual({});
  });

  it.each([
    ["an option-like base ref", { baseRef: "--upload-pack=x" }],
    ["a base ref with ..", { baseRef: "main..x" }],
    ["no base ref", { baseRef: undefined }],
    ["a bad head", { headSha: "HEAD" }],
    ["a bad PR", { pr: "7; rm" }],
  ])("returns an error and no diff_id for %s", (_name, overrides) => {
    const calls = [];
    const result = headDiffId({ pr: 7, headSha: HEAD, baseRef: "main", git: fakeGit(calls), diff: () => DIFF, ...overrides });
    expect(result.diffId).toBeNull();
    expect(result.error).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("returns an error when the fetch fails", () => {
    const result = headDiffId({ pr: 7, headSha: HEAD, baseRef: "main", git: () => { throw new Error("fatal: could not read"); }, diff: () => DIFF });
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
