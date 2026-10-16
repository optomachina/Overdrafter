// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildVerdict, computePatchId, formatComment, main, postComment, resolveSha } from "./emit-verdict.mjs";
import { extractVerdictBlocks, parseVerdictComments, validateVerdict } from "./verdict-schema.mjs";

let repo;
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (file, content, message) => {
  writeFileSync(join(repo, file), content);
  git("add", file);
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ovd851-verdict-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  git("config", "commit.gpgsign", "false");
  commit("base.txt", "base\n", "base");
  git("checkout", "-q", "-b", "feature");
  commit("feature.txt", "feature line\n", "feature");
  git("checkout", "-q", "main");
  commit("unrelated.txt", "main moved\n", "main moves");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

const NOW = new Date("2026-10-16T12:34:56.789Z");
const ARGS = [
  "--verdict", "PASS",
  "--base", "main",
  "--head", "feature",
  "--verifier-id", "astra-verifier",
  "--model-family", "opus",
  "--github-login", "verifier-bot",
  "--evidence", "verify-run=https://github.com/o/r/actions/runs/42",
  "--checks", "green",
  "--conflicts", "0",
  "--open-threads", "0",
];

describe("computePatchId", () => {
  it("is stable across a no-op rebase and changes when the diff changes", () => {
    const before = computePatchId({ base: "main", head: "feature", cwd: repo });
    const oldHead = resolveSha("feature", { cwd: repo });
    git("checkout", "-q", "feature");
    git("rebase", "-q", "main");
    const rebasedHead = git("rev-parse", "HEAD");
    expect(rebasedHead).not.toBe(oldHead);
    expect(computePatchId({ base: "main", head: "feature", cwd: repo })).toBe(before);

    commit("feature.txt", "feature line changed\n", "amend diff");
    expect(computePatchId({ base: "main", head: "feature", cwd: repo })).not.toBe(before);
    git("reset", "-q", "--hard", rebasedHead);
    git("checkout", "-q", "main");
  });

  it("changes when only indentation changes (--verbatim)", () => {
    git("checkout", "-q", "-b", "ws-a", "main");
    commit("ws.py", "if x:\n    y()\nz()\n", "dedented z");
    git("checkout", "-q", "-b", "ws-b", "main");
    commit("ws.py", "if x:\n    y()\n    z()\n", "indented z");
    git("checkout", "-q", "main");
    expect(computePatchId({ base: "main", head: "ws-a", cwd: repo })).not.toBe(computePatchId({ base: "main", head: "ws-b", cwd: repo }));
  });

  it("does not depend on local diff config", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    git("checkout", "-q", "-b", "ctx-base", "main");
    commit("ctx.txt", `${lines.join("\n")}\n`, "ctx base");
    git("checkout", "-q", "-b", "ctx-head");
    commit("ctx.txt", `${lines.map((l, i) => (i === 4 || i === 12 ? `${l} changed` : l)).join("\n")}\n`, "ctx change");
    git("checkout", "-q", "main");
    const pinned = computePatchId({ base: "ctx-base", head: "ctx-head", cwd: repo });
    const settings = [["diff.context", "1"], ["diff.interHunkContext", "10"], ["diff.algorithm", "patience"], ["diff.noprefix", "true"], ["diff.suppressBlankEmpty", "true"]];
    try {
      for (const [key, value] of settings) git("config", key, value);
      expect(computePatchId({ base: "ctx-base", head: "ctx-head", cwd: repo })).toBe(pinned);
    } finally {
      for (const [key] of settings) git("config", "--unset", key);
    }
  });

  it("never lets base or head be read as a git option", () => {
    const outDir = mkdtempSync(join(tmpdir(), "ovd851-inject-"));
    try {
      expect(() => computePatchId({ base: `--output=${join(outDir, "x")}`, head: "feature", cwd: repo })).toThrow(/rev-parse/);
      expect(() => computePatchId({ base: "main", head: `--output=${join(outDir, "y")}`, cwd: repo })).toThrow(/rev-parse/);
      expect(readdirSync(outDir)).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("refuses an empty diff", () => {
    expect(() => computePatchId({ base: "main", head: "main", cwd: repo })).toThrow(/empty diff/);
  });
});

describe("emit -> validate round trip", () => {
  it("fills sha, patch_id and a UTC timestamp and validates", () => {
    const body = main(ARGS, { cwd: repo, now: NOW });
    const [block] = extractVerdictBlocks(body);
    const verdict = JSON.parse(block);
    expect(validateVerdict(verdict)).toEqual({ ok: true, errors: [] });
    expect(verdict).toMatchObject({
      role: "verifier",
      sha: resolveSha("feature", { cwd: repo }),
      patch_id: computePatchId({ base: "main", head: "feature", cwd: repo }),
      timestamp: "2026-10-16T12:34:56Z",
    });
    const comments = [{ id: 7, user: { login: "verifier-bot" }, created_at: "2026-10-16T12:35:00Z", updated_at: "2026-10-16T12:35:00Z", body }];
    expect(parseVerdictComments(comments, { sha: verdict.sha }).verdict).toEqual(verdict);
  });

  it("binds patch_id to the given sha rather than re-resolving head", () => {
    const sha = resolveSha("ws-a", { cwd: repo });
    const verdict = buildVerdict(
      { role: "verifier", verdict: "PASS", sha, base: "main", head: "feature", verifierId: "v", modelFamily: "opus", githubLogin: "bot", evidence: [{ kind: "log", url: "https://x.test/" }], readiness: { conflicts: 0, open_threads: 0, checks: "green" } },
      { cwd: repo, now: NOW },
    );
    expect(verdict.patch_id).toBe(computePatchId({ base: "main", head: "ws-a", cwd: repo }));
  });

  it("rejects a --findings file that is not an array", () => {
    const findingsFile = join(repo, "findings-object.json");
    writeFileSync(findingsFile, JSON.stringify({ severity: "high" }));
    expect(() => main([...ARGS, "--role", "reviewer", "--findings", findingsFile], { cwd: repo, now: NOW })).toThrow(/must contain a JSON array/);
  });

  it("refuses to emit an invalid verdict with every error listed", () => {
    expect(() => main([...ARGS.slice(0, -6), "--evidence", "log=http://x.test/", "--checks", "maybe", "--conflicts", "0", "--open-threads", "0"], { cwd: repo, now: NOW }))
      .toThrow(/evidence\[1\]\.url: must use https[\s\S]*readiness\.checks: must be one of/);
    expect(() => main([...ARGS, "--conflicts=-1"], { cwd: repo })).toThrow(/--conflicts must be a non-negative integer/);
    expect(() => main(ARGS.filter((a) => !a.startsWith("verify-run") && a !== "--evidence"), { cwd: repo })).toThrow(/at least 1 item/);
  });

  it("emits reviewer verdicts with corroborated findings and marks them advisory", () => {
    const findingsFile = join(repo, "findings.json");
    writeFileSync(findingsFile, JSON.stringify([
      { severity: "high", file: "feature.txt", line: 1, model: "grok" },
      { severity: "medium", file: "feature.txt", line: 1, model: "codex" },
    ]));
    const body = main([...ARGS, "--role", "reviewer", "--findings", findingsFile], { cwd: repo, now: NOW });
    expect(body).toContain("advisory reviewer verdict, not gate input");
    const verdict = JSON.parse(extractVerdictBlocks(body)[0]);
    expect(verdict.findings.every((f) => f.corroborated)).toBe(true);
  });
});

describe("posting", () => {
  it("prints by default and never calls gh without --post", () => {
    const run = vi.fn();
    main([...ARGS, "--pr", "12"], { cwd: repo, now: NOW, run });
    expect(run).not.toHaveBeenCalled();
  });

  it("posts a new comment through an injected runner with --post", () => {
    const run = vi.fn(() => ({ status: 0 }));
    const body = main([...ARGS, "--pr", "12", "--post"], { cwd: repo, now: NOW, run });
    expect(run).toHaveBeenCalledWith("gh", ["pr", "comment", "12", "--body-file", "-"], expect.objectContaining({ input: body, cwd: repo }));
  });

  it("requires a PR number and surfaces gh failures", () => {
    const verdict = buildVerdict(
      { role: "verifier", verdict: "FAIL", sha: "a".repeat(40), patchId: "b".repeat(40), verifierId: "v", modelFamily: "opus", githubLogin: "bot", evidence: [{ kind: "log", url: "https://x.test/" }], readiness: { conflicts: 0, open_threads: 0, checks: "red" } },
      { now: NOW },
    );
    const body = formatComment(verdict);
    expect(() => postComment({ body, run: vi.fn() })).toThrow(/--pr/);
    expect(() => postComment({ pr: 3, body, run: () => ({ status: 1 }) })).toThrow(/exit 1/);
  });
});
