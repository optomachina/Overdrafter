// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DECISION_HEADER,
  appendDecision,
  checkMergesAgainstPlan,
  logDigest,
  openStop,
  planContiguousVerified,
  readBack,
  readBackRun,
  readDecisions,
  runCli,
  verifyAppendOnly,
} from "./merge-readback.mjs";

let dir;
let repo;

function g(...args) {
  return execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commitFile(file, content, message) {
  fs.writeFileSync(path.join(repo, file), content);
  g("add", file);
  g("commit", "-q", "-m", message);
  return g("rev-parse", "HEAD");
}

// Squash-merge a branch into main the way GitHub does: one single-parent commit.
function squashMerge(branch, message) {
  g("checkout", "-q", "main");
  g("merge", "-q", "--squash", branch);
  g("commit", "-q", "-m", message);
  return g("rev-parse", "HEAD");
}

function branchWith(name, from, file, content) {
  g("checkout", "-q", "-b", name, from);
  return commitFile(file, content, `${name}: ${file}`);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-readback-"));
  repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  commitFile("README.md", "base\n", "base");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readBack", () => {
  it("passes a squash merge whose tree equals the verified head", () => {
    const verifiedHead = branchWith("pr1", "main", "a.txt", "a\n");
    const mergeSha = squashMerge("pr1", "PR 1 (#1)");
    const result = readBack({ repo, mergeSha, verifiedHead });
    expect(result).toMatchObject({ tree_match: true, mode: "exact", on_main: true });
    expect(result.merge_tree).toBe(g("rev-parse", `${verifiedHead}^{tree}`));
    expect(result.patch_id).toMatch(/^[0-9a-f]{40}$/);
    expect(result.patch_id).toBe(result.verified_patch_id);
  });

  it("passes a squash merge after main moved, by patch-id and rebased tree", () => {
    const verifiedHead = branchWith("pr1", "main", "a.txt", "a\n");
    g("checkout", "-q", "main");
    commitFile("other.txt", "unrelated\n", "unrelated main change");
    const mergeSha = squashMerge("pr1", "PR 1 (#1)");
    const result = readBack({ repo, mergeSha, verifiedHead });
    expect(result).toMatchObject({ tree_match: true, mode: "rebased" });
    expect(result.patch_id).toBe(result.verified_patch_id);
  });

  it("fails when an extra unverified commit rode along in the squash", () => {
    const verifiedHead = branchWith("pr1", "main", "a.txt", "a\n");
    commitFile("a.txt", "a\nextra unverified line\n", "pushed after verdict");
    const mergeSha = squashMerge("pr1", "PR 1 (#1)");
    const result = readBack({ repo, mergeSha, verifiedHead });
    expect(result.tree_match).toBe(false);
    expect(result.reason).toBe("tree-mismatch-patch-id-differs");
  });

  it("fails when the merge commit was tampered with after the squash", () => {
    const verifiedHead = branchWith("pr1", "main", "a.txt", "a\n");
    squashMerge("pr1", "PR 1 (#1)");
    fs.writeFileSync(path.join(repo, "a.txt"), "tampered\n");
    g("commit", "-q", "-a", "--amend", "--no-edit");
    const result = readBack({ repo, mergeSha: g("rev-parse", "HEAD"), verifiedHead });
    expect(result.tree_match).toBe(false);
  });

  it("does not treat a commit that is not on main as merged", () => {
    const verifiedHead = branchWith("pr1", "main", "a.txt", "a\n");
    const result = readBack({ repo, mergeSha: verifiedHead, verifiedHead });
    expect(result).toMatchObject({ tree_match: false, on_main: false, reason: "not-on-main" });
  });

  it("fails a merge whose tree equals the verified head but silently reverts main", () => {
    const verifiedHead = branchWith("pr1", "main", "a.txt", "a\n");
    g("checkout", "-q", "main");
    commitFile("other.txt", "someone else's work\n", "X: unrelated main change");
    // Single-parent commit on top of X carrying the head tree: drops other.txt.
    const bad = g("commit-tree", `${verifiedHead}^{tree}`, "-p", "main", "-m", "bad squash");
    g("update-ref", "refs/heads/main", bad);
    const result = readBack({ repo, mergeSha: bad, verifiedHead });
    expect(result.merge_tree).toBe(g("rev-parse", `${verifiedHead}^{tree}`));
    expect(result).toMatchObject({ tree_match: false, mode: null, reason: "tree-mismatch-patch-id-differs" });
  });

  it("honours an explicit verified base", () => {
    const base = g("rev-parse", "main");
    const verifiedHead = branchWith("pr1", "main", "a.txt", "a\n");
    g("checkout", "-q", "main");
    const moved = commitFile("other.txt", "unrelated\n", "unrelated main change");
    const mergeSha = squashMerge("pr1", "PR 1 (#1)");
    expect(readBack({ repo, mergeSha, verifiedHead, verifiedBase: base })).toMatchObject({ tree_match: true, mode: "rebased" });
    expect(readBack({ repo, mergeSha, verifiedHead, verifiedBase: moved }).tree_match).toBe(false);
  });

  it("rejects a two-parent merge commit", () => {
    const verifiedHead = branchWith("pr1", "main", "a.txt", "a\n");
    g("checkout", "-q", "main");
    commitFile("other.txt", "unrelated\n", "unrelated main change");
    g("merge", "-q", "--no-ff", "-m", "merge pr1", "pr1");
    const result = readBack({ repo, mergeSha: g("rev-parse", "HEAD"), verifiedHead });
    expect(result).toMatchObject({ tree_match: false, reason: "not-a-single-parent-squash" });
  });

  it("reports a rebase conflict when the verified head does not apply onto the parent", () => {
    commitFile("a.txt", "x\n", "seed a.txt");
    const verifiedHead = branchWith("pr1", "main", "a.txt", "y\n");
    g("checkout", "-q", "main");
    // Whitespace-only change: patch-id ignores it, a three-way merge does not.
    commitFile("a.txt", "x \n", "main reformats a.txt");
    const mergeSha = commitFile("a.txt", "y\n", "PR 1 (#1)");
    const result = readBack({ repo, mergeSha, verifiedHead });
    expect(result.patch_id).toBe(result.verified_patch_id);
    expect(result).toMatchObject({ tree_match: false, reason: "rebase-conflict" });
  });

  it("defaults to origin/main so a stale local main does not cause a false stop", () => {
    const verifiedHead = branchWith("pr1", "main", "a.txt", "a\n");
    const mergeSha = squashMerge("pr1", "PR 1 (#1)");
    g("update-ref", "refs/remotes/origin/main", mergeSha);
    g("update-ref", "refs/heads/main", `${mergeSha}~1`);
    expect(readBack({ repo, mergeSha, verifiedHead })).toMatchObject({ tree_match: true, main_ref: "origin/main" });
    expect(readBack({ repo, mergeSha, verifiedHead, mainRef: "main" })).toMatchObject({ tree_match: false, reason: "not-on-main" });
  });

  it("reports a missing merge commit instead of throwing", () => {
    const verifiedHead = branchWith("pr1", "main", "a.txt", "a\n");
    expect(readBack({ repo, mergeSha: "0".repeat(40), verifiedHead })).toMatchObject({ tree_match: false, reason: "merge-commit-missing" });
  });
});

describe("planContiguousVerified", () => {
  const stack = [
    { pr: 101, head_sha: "a".repeat(40) },
    { pr: 102, head_sha: "b".repeat(40) },
    { pr: 103, head_sha: "c".repeat(40) },
  ];

  it("lands only the bottom PR when the middle of a stack of 3 is unverified", () => {
    const verdicts = {
      101: { sha: "a".repeat(40), verdict_ref: "verdict#101", valid: true },
      102: { sha: "b".repeat(40), verdict_ref: "verdict#102", valid: false },
      103: { sha: "c".repeat(40), verdict_ref: "verdict#103", valid: true },
    };
    const plan = planContiguousVerified(stack, verdicts);
    expect(plan.land.map((entry) => entry.pr)).toEqual([101]);
    expect(plan.stop).toMatchObject({ pr: 102, reason: "verdict-not-valid" });
  });

  it("voids a verdict for an older head SHA and accepts an injected lookup function", () => {
    const plan = planContiguousVerified(stack, (pr) => (pr === 101 ? { sha: "f".repeat(40), verdict_ref: "old", valid: true } : undefined));
    expect(plan).toEqual({ land: [], stop: { pr: 101, head_sha: "a".repeat(40), verdict_ref: "old", reason: "verdict-sha-stale" } });
  });

  it("lands the whole stack when every PR is verified at its head", () => {
    const verdicts = Object.fromEntries(stack.map((entry) => [entry.pr, { sha: entry.head_sha, verdict_ref: `v${entry.pr}`, valid: true }]));
    expect(planContiguousVerified(stack, verdicts)).toMatchObject({ stop: null, land: [{ pr: 101 }, { pr: 102 }, { pr: 103 }] });
  });

  it("fails closed on duplicate or missing PR numbers", () => {
    expect(() => planContiguousVerified([...stack, { pr: "101", head_sha: "d".repeat(40) }], {})).toThrow(/duplicate PR/);
    expect(() => planContiguousVerified([{ head_sha: "a".repeat(40) }], {})).toThrow(/missing pr/);
  });
});

describe("checkMergesAgainstPlan", () => {
  const plan = {
    land: [
      { pr: 1, head_sha: "a".repeat(40), verdict_ref: "v1" },
      { pr: 2, head_sha: "b".repeat(40), verdict_ref: "v2" },
    ],
    stop: { pr: 3, head_sha: "c".repeat(40), verdict_ref: "", reason: "no-verdict" },
  };

  it("refuses PRs outside the plan, at another SHA, or out of bottom-up order", () => {
    expect(checkMergesAgainstPlan({ plan, merges: [{ pr: 3, merge_sha: "m" }] })).toMatchObject({ ok: false, reason: "pr-not-in-plan-land: 3" });
    expect(checkMergesAgainstPlan({ plan, merges: [{ pr: 1, head_sha: "f".repeat(40) }] })).toMatchObject({ ok: false, reason: "head-sha-not-the-verified-head: 1" });
    expect(checkMergesAgainstPlan({ plan, merges: [{ pr: 1, verdict_ref: "forged" }] })).toMatchObject({ ok: false, reason: "verdict-ref-differs-from-plan: 1" });
    expect(checkMergesAgainstPlan({ plan, merges: [{ pr: 2 }] }).reason).toMatch(/^out-of-order: 1 /);
    expect(checkMergesAgainstPlan({ plan, merges: [{ pr: 2 }, { pr: 1 }] }).reason).toMatch(/^out-of-order/);
  });

  it("takes the verified head and verdict from the plan and resumes above passed read-backs", () => {
    expect(checkMergesAgainstPlan({ plan, merges: [{ pr: "1", merge_sha: "m1" }, { pr: 2, merge_sha: "m2" }] })).toEqual({
      ok: true,
      merges: [
        { pr: 1, head_sha: "a".repeat(40), verdict_ref: "v1", merge_sha: "m1" },
        { pr: 2, head_sha: "b".repeat(40), verdict_ref: "v2", merge_sha: "m2" },
      ],
    });
    const rows = [{ action: "readback", tree_match: "true", pr: "1", head_sha: "a".repeat(40) }];
    expect(checkMergesAgainstPlan({ plan, merges: [{ pr: 2 }], rows }).ok).toBe(true);
  });
});

describe("readBackRun", () => {
  it("stops at the first tree mismatch and logs it without reading later merges", () => {
    const head1 = branchWith("pr1", "main", "a.txt", "a\n");
    const merge1 = squashMerge("pr1", "PR 1 (#1)");
    const head2 = branchWith("pr2", "main", "b.txt", "b\n");
    commitFile("b.txt", "b\nunverified\n", "extra");
    const merge2 = squashMerge("pr2", "PR 2 (#2)");
    const head3 = branchWith("pr3", "main", "c.txt", "c\n");
    const merge3 = squashMerge("pr3", "PR 3 (#3)");
    const logPath = path.join(dir, "decisions.tsv");

    const run = readBackRun({
      repo,
      logPath,
      merges: [
        { pr: 1, head_sha: head1, verdict_ref: "v1", merge_sha: merge1 },
        { pr: 2, head_sha: head2, verdict_ref: "v2", merge_sha: merge2 },
        { pr: 3, head_sha: head3, verdict_ref: "v3", merge_sha: merge3 },
      ],
    });

    expect(run.landed.map((entry) => entry.pr)).toEqual([1]);
    expect(run.stop).toMatchObject({ pr: 2, tree_match: false });
    const rows = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(rows[0]).toBe(DECISION_HEADER.trim());
    expect(rows).toHaveLength(3);
    const cells = rows[2].split("\t");
    expect(cells.slice(1, 3)).toEqual(["2", head2]);
    expect(cells.slice(5, 8)).toEqual(["readback", merge2, "false"]);
    expect(cells[8]).toMatch(/^STOP .*Grok Bot.*no auto-revert$/);
  });

  it("refuses merges that are not the plan's verified run, without logging", () => {
    const head1 = branchWith("pr1", "main", "a.txt", "a\n");
    const merge1 = squashMerge("pr1", "PR 1 (#1)");
    const logPath = path.join(dir, "decisions.tsv");
    const plan = { land: [{ pr: 1, head_sha: head1, verdict_ref: "v1" }], stop: null };
    const unplanned = readBackRun({ repo, logPath, plan, merges: [{ pr: 9, head_sha: head1, merge_sha: merge1 }] });
    expect(unplanned).toMatchObject({ landed: [], refused: "pr-not-in-plan-land: 9" });
    expect(fs.existsSync(logPath)).toBe(false);
    const run = readBackRun({ repo, logPath, plan, merges: [{ pr: 1, merge_sha: merge1 }] });
    expect(run).toMatchObject({ stop: null, landed: [{ pr: 1, tree_match: true }] });
    expect(readDecisions(logPath)).toMatchObject([{ pr: "1", verdict_ref: "v1", action: "readback", tree_match: "true" }]);
  });
});

describe("open stop", () => {
  const sink = () => ({ write: () => {} });

  it("blocks the next plan and read-back on the same log until a stop-ack", () => {
    const head1 = branchWith("pr1", "main", "a.txt", "a\n");
    commitFile("a.txt", "a\nunverified\n", "extra");
    const merge1 = squashMerge("pr1", "PR 1 (#1)");
    const logPath = path.join(dir, "decisions.tsv");
    const plan = { land: [{ pr: 1, head_sha: head1, verdict_ref: "v1" }], stop: null };
    expect(readBackRun({ repo, logPath, plan, merges: [{ pr: 1, merge_sha: merge1 }] }).stop).toMatchObject({ pr: 1, tree_match: false });
    expect(openStop(readDecisions(logPath))).toMatchObject({ pr: "1", tree_match: "false" });

    const stackPath = path.join(dir, "stack.json");
    const verdictsPath = path.join(dir, "verdicts.json");
    const planPath = path.join(dir, "plan.json");
    const mergesPath = path.join(dir, "merges.json");
    fs.writeFileSync(stackPath, JSON.stringify([{ pr: 1, head_sha: head1 }]));
    fs.writeFileSync(verdictsPath, JSON.stringify({ 1: { sha: head1, verdict_ref: "v1", valid: true } }));
    fs.writeFileSync(planPath, JSON.stringify(plan));
    fs.writeFileSync(mergesPath, JSON.stringify([{ pr: 1, merge_sha: merge1 }]));
    const before = fs.readFileSync(logPath, "utf8");
    expect(runCli(["plan", "--stack", stackPath, "--verdicts", verdictsPath, "--log", logPath], sink())).toBe(1);
    expect(runCli(["readback-run", "--repo", repo, "--merges", mergesPath, "--plan", planPath, "--log", logPath], sink())).toBe(1);
    expect(runCli(["readback", "--repo", repo, "--merge-sha", merge1, "--verified-head", head1, "--log", logPath, "--plan", planPath, "--pr", "1"], sink())).toBe(1);
    expect(fs.readFileSync(logPath, "utf8")).toBe(before);

    expect(() => runCli(["stop-ack", "--log", logPath, "--pr", "2", "--by", "Blaine", "--note", "x"])).toThrow(/open stop is PR 1/);
    expect(runCli(["stop-ack", "--log", logPath, "--pr", "1", "--by", "Blaine", "--note", "reverted by hand in #9"])).toBe(0);
    expect(openStop(readDecisions(logPath))).toBeNull();
    expect(readDecisions(logPath).at(-1)).toMatchObject({ action: "stop-ack", pr: "1", result: "ack by Blaine: reverted by hand in #9" });
    expect(runCli(["plan", "--stack", stackPath, "--verdicts", verdictsPath, "--log", logPath], sink())).toBe(0);
    expect(() => runCli(["stop-ack", "--log", logPath, "--pr", "1", "--by", "Blaine", "--note", "again"])).toThrow(/no open stop/);
  });
});

describe("decision log", () => {
  const row = { pr: 7, head_sha: "a".repeat(40), patch_id: "p", verdict_ref: "v7", action: "readback", merge_sha: "m", tree_match: "true", result: "landed (exact)" };

  it("writes the exact header once and appends single-line rows", () => {
    const logPath = path.join(dir, "log.tsv");
    appendDecision(logPath, { ...row, ts: "2026-10-16T00:00:00.000Z" });
    appendDecision(logPath, { ...row, result: "line one\nline\ttwo", verdict_ref: "=HYPERLINK()" });
    const lines = fs.readFileSync(logPath, "utf8").split("\n");
    expect(lines[0]).toBe("ts\tpr\thead_sha\tpatch_id\tverdict_ref\taction\tmerge_sha\ttree_match\tresult");
    expect(lines[1].split("\t")).toEqual(["2026-10-16T00:00:00.000Z", "7", "a".repeat(40), "p", "v7", "readback", "m", "true", "landed (exact)"]);
    expect(lines[2].split("\t")).toHaveLength(9);
    expect(lines[2]).toContain("'=HYPERLINK()");
    expect(lines[2]).toContain("line one line two");
  });

  it("refuses to append after a partial last row instead of fusing rows", () => {
    const logPath = path.join(dir, "log.tsv");
    appendDecision(logPath, row);
    fs.appendFileSync(logPath, "2026-10-16T00:00:00.000Z\t8\tcrashed mid-wr");
    const before = fs.readFileSync(logPath, "utf8");
    expect(() => appendDecision(logPath, { ...row, pr: 9 })).toThrow(/partial row/);
    expect(fs.readFileSync(logPath, "utf8")).toBe(before);
  });

  it("writes the header into an existing empty log", () => {
    const logPath = path.join(dir, "log.tsv");
    fs.writeFileSync(logPath, "");
    appendDecision(logPath, row);
    expect(readDecisions(logPath)).toHaveLength(1);
  });

  it("rejects unknown columns and actions", () => {
    const logPath = path.join(dir, "log.tsv");
    expect(() => appendDecision(logPath, { ...row, note: "x" })).toThrow(/unknown decision column/);
    expect(() => appendDecision(logPath, { ...row, action: "merge" })).toThrow(/action must be one of/);
  });

  it("accepts appends but detects a rewritten or truncated log", () => {
    const logPath = path.join(dir, "log.tsv");
    appendDecision(logPath, row);
    const digest = logDigest(logPath);
    const snapshot = fs.readFileSync(logPath, "utf8");
    expect(verifyAppendOnly(logPath, digest)).toMatchObject({ ok: true, reason: "unchanged" });

    appendDecision(logPath, { ...row, pr: 8 });
    expect(verifyAppendOnly(logPath, digest)).toMatchObject({ ok: true, reason: "appended" });
    expect(verifyAppendOnly(logPath, snapshot)).toMatchObject({ ok: true });

    fs.writeFileSync(logPath, fs.readFileSync(logPath, "utf8").replace("\ttrue\t", "\tfalse\t"));
    expect(verifyAppendOnly(logPath, digest)).toMatchObject({ ok: false, reason: "prior-rows-rewritten" });

    fs.writeFileSync(logPath, DECISION_HEADER);
    expect(verifyAppendOnly(logPath, digest)).toMatchObject({ ok: false, reason: "log-truncated" });
  });
});

describe("CLI", () => {
  const sink = () => {
    const chunks = [];
    return { write: (chunk) => chunks.push(chunk), json: () => JSON.parse(chunks.join("")) };
  };

  it("logs a plan stop and a read-back, then verifies the log append-only", () => {
    const head1 = branchWith("pr1", "main", "a.txt", "a\n");
    const merge1 = squashMerge("pr1", "PR 1 (#1)");
    const logPath = path.join(dir, "audit", "plan.tsv");
    const stackPath = path.join(dir, "stack.json");
    const verdictsPath = path.join(dir, "verdicts.json");
    fs.writeFileSync(stackPath, JSON.stringify([{ pr: 1, head_sha: head1 }, { pr: 2, head_sha: "b".repeat(40) }]));
    fs.writeFileSync(verdictsPath, JSON.stringify({ 1: { sha: head1, verdict_ref: "v1", valid: true } }));

    expect(runCli(["init-log", "--log", logPath])).toBe(0);
    const plan = sink();
    expect(runCli(["plan", "--stack", stackPath, "--verdicts", verdictsPath, "--log", logPath], plan)).toBe(0);
    expect(plan.json().stop).toMatchObject({ pr: 2, reason: "no-verdict" });
    const planPath = path.join(dir, "plan.json");
    fs.writeFileSync(planPath, JSON.stringify(plan.json()));

    const digestOut = sink();
    runCli(["digest", "--log", logPath], digestOut);
    const priorPath = path.join(dir, "prior.json");
    fs.writeFileSync(priorPath, JSON.stringify(digestOut.json()));

    expect(() => runCli(["readback", "--repo", repo, "--merge-sha", merge1, "--verified-head", head1, "--log", logPath, "--pr", "1"])).toThrow(/missing --plan/);
    const readback = sink();
    expect(runCli(["readback", "--repo", repo, "--merge-sha", merge1, "--verified-head", head1, "--log", logPath, "--plan", planPath, "--pr", "1"], readback)).toBe(0);
    expect(readback.json().tree_match).toBe(true);
    expect(runCli(["readback", "--repo", repo, "--merge-sha", head1, "--verified-head", head1], sink())).toBe(1);

    expect(runCli(["verify-log", "--log", logPath, "--prior", priorPath], sink())).toBe(0);
    const actions = fs.readFileSync(logPath, "utf8").trim().split("\n").slice(1).map((line) => line.split("\t")[5]);
    expect(actions).toEqual(["plan-land", "plan-stop", "readback"]);

    expect(() => runCli(["readback", "--repo", repo])).toThrow(/missing --merge-sha/);
    expect(() => runCli(["merge"])).toThrow(/unknown command/);
  });
});
