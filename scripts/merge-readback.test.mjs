// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DECISION_HEADER,
  appendDecision,
  assertRef,
  assertSupportedPlatform,
  checkMergesAgainstPlan,
  gitEnv,
  isAncestor,
  logDigest,
  openStop,
  planContiguousVerified,
  planLogMismatch,
  planDigest,
  readBack,
  readBackRun,
  readDecisions,
  resolveBinary,
  runCli,
  setGitBinaryForTesting,
  verifyAppendOnly,
} from "./merge-readback.mjs";

let dir;
let repo;

// Fixture git never inherits GIT_* (e.g. GIT_DIR from a hook), so fixture
// commits cannot land in another repo.
function g(...args) {
  return execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// Logs plan-land rows for plan.land, as `plan --log` does, so a plan-bound
// read-back on logPath sees a matching plan.
function logPlan(logPath, plan) {
  for (const entry of plan.land) appendDecision(logPath, { ...entry, action: "plan-land", result: "verified-at-head" });
  appendDecision(logPath, { action: "plan-digest", result: `plan-sha256:${planDigest(plan)}` });
}

const readbackRows = (logPath) => readDecisions(logPath).filter((row) => row.action === "readback");

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
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv() });
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

  it("passes a squash merge after main moved, by rebased tree", () => {
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
    expect(result.reason).toBe("tree-mismatch-after-rebase");
  });

  it("fails when the merge commit was tampered with after the squash", () => {
    const verifiedHead = branchWith("pr1", "main", "a.txt", "a\n");
    squashMerge("pr1", "PR 1 (#1)");
    fs.writeFileSync(path.join(repo, "a.txt"), "tampered\n");
    g("commit", "-q", "-a", "--amend", "--no-edit");
    const result = readBack({ repo, mergeSha: g("rev-parse", "HEAD"), verifiedHead });
    expect(result).toMatchObject({ tree_match: false, on_main: true, reason: "tree-mismatch-after-rebase" });
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
    expect(result).toMatchObject({ tree_match: false, mode: null, reason: "tree-mismatch-after-rebase" });
  });

  it("rejects a verifiedBase override instead of using it", () => {
    const verifiedHead = branchWith("pr1", "main", "a.txt", "a\n");
    const mergeSha = squashMerge("pr1", "PR 1 (#1)");
    expect(() => readBack({ repo, mergeSha, verifiedHead, verifiedBase: `${mergeSha}` })).toThrow(/verified_base override is not accepted/);
    expect(() => readBack({ repo, mergeSha, verifiedHead, verifiedBase: undefined })).toThrow(/verified_base override is not accepted/);
  });

  it("ignores GIT_DIR, GIT_INDEX_FILE, and GIT_WORK_TREE inherited from the parent environment", () => {
    const verifiedHead = branchWith("pr1", "main", "a.txt", "a\n");
    const mergeSha = squashMerge("pr1", "PR 1 (#1)");
    const other = path.join(dir, "other.git");
    execFileSync("git", ["init", "-q", "--bare", other], { env: gitEnv() });
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    Object.assign(process.env, { GIT_DIR: other, GIT_INDEX_FILE: path.join(dir, "bogus-index"), GIT_WORK_TREE: dir });
    try {
      expect(Object.keys(gitEnv()).filter((key) => key.startsWith("GIT_"))).toEqual([]);
      expect(readBack({ repo, mergeSha, verifiedHead })).toMatchObject({ tree_match: true, mode: "exact", on_main: true });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(gitEnv({ GIT_DIR: "x", git_config_parameters: "y", HOME: "/h", PATH: "/evil" })).toEqual({ HOME: "/h", PATH: "/usr/bin:/bin:/usr/local/bin" });
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

// Opus repro (review of b70fdf2e): the PR branched from an older main, main
// moved, and the squash carries the PR head's tree on top of the main tip, so it
// silently reverts the main change. With the base set to the main tip, the
// merge's parent equals the base and the trees match, which used to read back
// "exact".
function revertOnMainTip() {
  const forkPoint = g("rev-parse", "main");
  const head = branchWith("pr1", "main", "a.txt", "a\n");
  g("checkout", "-q", "main");
  const mainTip = commitFile("other.txt", "someone else's work\n", "X: unrelated main change");
  const bad = g("commit-tree", `${head}^{tree}`, "-p", mainTip, "-m", "PR 1 (#1) reverting X");
  g("update-ref", "refs/heads/main", bad);
  return { forkPoint, head, mainTip, bad };
}

describe("verified base must be an ancestor of the verified head", () => {
  const sink = () => {
    const chunks = [];
    return { write: (chunk) => chunks.push(chunk), json: () => JSON.parse(chunks.join("")), text: () => chunks.join("") };
  };

  it("fails a reverting squash when the plan base is the merge's parent, not the fork point", () => {
    const { forkPoint, head, mainTip, bad } = revertOnMainTip();
    expect(isAncestor(repo, mainTip, head)).toBe(false);
    const land = [{ pr: 1, head_sha: head, verdict_ref: "v1" }];
    const tipLog = path.join(dir, "tip.tsv");
    logPlan(tipLog, { base: mainTip, land });
    expect(readBackRun({ repo, logPath: tipLog, plan: { base: mainTip, land, stop: null }, merges: [{ pr: 1, merge_sha: bad }] }).stop).toMatchObject({
      tree_match: false,
      mode: null,
      reason: "verified-base-not-ancestor-of-head",
    });
    const forkLog = path.join(dir, "fork.tsv");
    logPlan(forkLog, { base: forkPoint, land });
    expect(readBackRun({ repo, logPath: forkLog, plan: { base: forkPoint, land, stop: null }, merges: [{ pr: 1, merge_sha: bad }] }).stop).toMatchObject({
      tree_match: false,
      reason: "tree-mismatch-after-rebase",
    });
  });

  it("stops readBackRun with the main tip as plan base, and refuses a verified_base override without logging", () => {
    const { forkPoint, head, mainTip, bad } = revertOnMainTip();
    const land = [{ pr: 1, head_sha: head, verdict_ref: "v1" }];
    const planLog = path.join(dir, "plan-base.tsv");
    logPlan(planLog, { base: mainTip, land });
    const viaPlan = readBackRun({ repo, logPath: planLog, plan: { base: mainTip, land, stop: null }, merges: [{ pr: 1, merge_sha: bad }] });
    expect(viaPlan.landed).toEqual([]);
    expect(viaPlan.stop).toMatchObject({ pr: 1, tree_match: false, reason: "verified-base-not-ancestor-of-head" });
    expect(readbackRows(planLog)[0]).toMatchObject({ tree_match: "false", result: expect.stringMatching(/^STOP verified-base-not-ancestor-of-head/) });

    const overrideLog = path.join(dir, "override.tsv");
    logPlan(overrideLog, { base: forkPoint, land });
    const before = fs.readFileSync(overrideLog, "utf8");
    // Even an override equal to the derived base is refused: there is no override path.
    for (const verified_base of [mainTip, forkPoint, undefined]) {
      const viaOverride = readBackRun({ repo, logPath: overrideLog, plan: { base: forkPoint, land, stop: null }, merges: [{ pr: 1, merge_sha: bad, verified_base }] });
      expect(viaOverride).toMatchObject({ landed: [], stop: null, refused: "verified-base-override-not-allowed: 1" });
    }
    expect(fs.readFileSync(overrideLog, "utf8")).toBe(before);
  });

  it("rejects the CLI --verified-base option, standalone and plan-bound", () => {
    const { forkPoint, head, mainTip, bad } = revertOnMainTip();
    expect(() => runCli(["readback", "--repo", repo, "--merge-sha", bad, "--verified-head", head, "--verified-base", mainTip], sink())).toThrow(/--verified-base is not accepted/);

    const planPath = path.join(dir, "plan.json");
    const logPath = path.join(dir, "decisions.tsv");
    const plan = { base: forkPoint, land: [{ pr: 1, head_sha: head, verdict_ref: "v1" }], stop: null };
    fs.writeFileSync(planPath, JSON.stringify(plan));
    logPlan(logPath, plan);
    const before = fs.readFileSync(logPath, "utf8");
    const args = ["readback", "--repo", repo, "--merge-sha", bad, "--verified-head", head, "--verified-base", forkPoint, "--log", logPath, "--plan", planPath, "--pr", "1"];
    expect(() => runCli(args, sink())).toThrow(/--verified-base is not accepted/);
    expect(fs.readFileSync(logPath, "utf8")).toBe(before);
  });

  // Opus repro (review of 67b8a160): a two-commit PR where only the second
  // commit reached main. A base of head~1 is an ancestor of the head, so only
  // the fork-point check catches the partial landing.
  it("stops a partial landing when the bottom plan base is an ancestor but not the fork point", () => {
    const forkPoint = g("rev-parse", "main");
    branchWith("pr1", "main", "a.txt", "a\n");
    const head = commitFile("b.txt", "b\n", "pr1: b.txt");
    g("checkout", "-q", "main");
    g("cherry-pick", head);
    const partial = g("rev-parse", "HEAD");
    const land = [{ pr: 1, head_sha: head, verdict_ref: "v1" }];
    const logPath = path.join(dir, "partial.tsv");
    logPlan(logPath, { base: g("rev-parse", `${head}~1`), land });
    const run = readBackRun({ repo, logPath, plan: { base: g("rev-parse", `${head}~1`), land, stop: null }, merges: [{ pr: 1, merge_sha: partial }] });
    expect(run.landed).toEqual([]);
    expect(run.stop).toMatchObject({ tree_match: false, reason: expect.stringMatching(/^bottom-base-differs-from-merge-base: plan base [0-9a-f]{40} != merge-base\(head, main\) /) });
    expect(run.stop.reason).toContain(forkPoint);
    const forkLog = path.join(dir, "partial-fork.tsv");
    logPlan(forkLog, { base: forkPoint, land });
    expect(readBackRun({ repo, logPath: forkLog, plan: { base: forkPoint, land, stop: null }, merges: [{ pr: 1, merge_sha: partial }] }).stop).toMatchObject({
      tree_match: false,
      reason: "tree-mismatch-after-rebase",
    });
  });

  it("stops when the bottom PR's base is not merge-base(head, main), and does not apply that check above it", () => {
    const early = g("rev-parse", "main");
    commitFile("seed.txt", "seed\n", "seed");
    const head1 = branchWith("pr1", "main", "a.txt", "a\n");
    const head2 = branchWith("pr2", "pr1", "b.txt", "b\n");
    const merge1 = squashMerge("pr1", "PR 1 (#1)");
    const merge2 = squashMerge("pr2", "PR 2 (#2)");
    const land = [
      { pr: 1, head_sha: head1, verdict_ref: "v1" },
      { pr: 2, head_sha: head2, verdict_ref: "v2" },
    ];
    const merges = [{ pr: 1, merge_sha: merge1 }, { pr: 2, merge_sha: merge2 }];

    const goodLog = path.join(dir, "good.tsv");
    logPlan(goodLog, { base: g("rev-parse", `${merge1}~1`), land });
    const good = readBackRun({ repo, logPath: goodLog, plan: { base: g("rev-parse", `${merge1}~1`), land, stop: null }, merges });
    expect(good.landed.map((entry) => [entry.pr, entry.tree_match])).toEqual([[1, true], [2, true]]);

    const logPath = path.join(dir, "stop.tsv");
    const planPath = path.join(dir, "plan.json");
    const mergesPath = path.join(dir, "merges.json");
    fs.writeFileSync(planPath, JSON.stringify({ base: early, land, stop: null }));
    fs.writeFileSync(mergesPath, JSON.stringify(merges));
    logPlan(logPath, { base: early, land });
    const out = sink();
    expect(runCli(["readback-run", "--repo", repo, "--merges", mergesPath, "--plan", planPath, "--log", logPath], out)).toBe(1);
    expect(out.json()).toMatchObject({ landed: [], stop: { pr: 1, tree_match: false, reason: expect.stringMatching(/^bottom-base-differs-from-merge-base/) } });
    expect(readbackRows(logPath)).toHaveLength(1);
    expect(readbackRows(logPath)[0].result).toMatch(/^STOP bottom-base-differs-from-merge-base/);
  });
});

describe("resolveBinary", () => {
  it("returns the first fixed directory that has the binary and never consults PATH", () => {
    const seen = [];
    const exists = (candidate) => {
      seen.push(candidate);
      return candidate === "/bin/git";
    };
    expect(resolveBinary("git", { exists })).toBe("/bin/git");
    expect(seen).toEqual(["/usr/bin/git", "/bin/git"]);
    expect(() => resolveBinary("git", { dirs: ["/nonexistent"], exists: () => false })).toThrow(/git not found in \/nonexistent/);
    expect(path.isAbsolute(resolveBinary("git"))).toBe(true);
  });
});

// OVD-1072 #926: on Windows git was "not found", the error was swallowed and a
// merge commit that existed was reported as merge-commit-missing.
describe("git failures are errors, never a missing commit or a no", () => {
  afterEach(() => setGitBinaryForTesting(null));

  function landed() {
    const verifiedHead = branchWith("pr1", "main", "a.txt", "a\n");
    return { verifiedHead, mergeSha: squashMerge("pr1", "PR 1 (#1)") };
  }

  it("throws when git is missing instead of reporting merge-commit-missing", () => {
    const { verifiedHead, mergeSha } = landed();
    setGitBinaryForTesting(path.join(dir, "no-such-git"));
    expect(() => readBack({ repo, mergeSha, verifiedHead })).toThrow(/ENOENT/);
  });

  it("throws when git fails instead of reporting not-an-ancestor", () => {
    const { verifiedHead, mergeSha } = landed();
    const broken = path.join(dir, "broken-git");
    fs.writeFileSync(broken, "#!/bin/sh\necho 'fatal: simulated failure' >&2\nexit 128\n", { mode: 0o755 });
    setGitBinaryForTesting(broken);
    expect(() => readBack({ repo, mergeSha, verifiedHead })).toThrow(/simulated failure/);
    expect(() => isAncestor(repo, verifiedHead, mergeSha)).toThrow(/simulated failure/);
  });

  it("throws when git exits 1 with an error message instead of reading it as no", () => {
    const { verifiedHead, mergeSha } = landed();
    const shim = path.join(dir, "xcrun-git");
    fs.writeFileSync(shim, "#!/bin/sh\necho 'xcrun: error: invalid active developer path' >&2\nexit 1\n", { mode: 0o755 });
    setGitBinaryForTesting(shim);
    expect(() => readBack({ repo, mergeSha, verifiedHead })).toThrow(/xcrun: error/);
    expect(() => isAncestor(repo, verifiedHead, mergeSha)).toThrow(/xcrun: error/);
  });

  it("records a lower-merge-missing stop when the logged lower merge is not in this clone", () => {
    const base = g("rev-parse", "main");
    const head1 = branchWith("pr1", "main", "a.txt", "a\n");
    const head2 = branchWith("pr2", "pr1", "b.txt", "b\n");
    const merge1 = squashMerge("pr1", "PR 1 (#1)");
    const plan = { base, land: [{ pr: 1, head_sha: head1, verdict_ref: "v1" }, { pr: 2, head_sha: head2, verdict_ref: "v2" }], stop: null };
    const logPath = path.join(dir, "missing-lower.tsv");
    logPlan(logPath, plan);
    expect(readBackRun({ repo, plan, logPath, merges: [{ pr: 1, merge_sha: merge1 }] }).landed).toMatchObject([{ pr: 1 }]);
    // Rewrite main and prune, so the logged lower squash no longer exists here.
    g("reset", "-q", "--hard", base);
    fs.rmSync(path.join(repo, ".git", "ORIG_HEAD"), { force: true });
    g("reflog", "expire", "--expire=now", "--all");
    g("gc", "-q", "--prune=now");
    expect(() => g("cat-file", "-e", merge1)).toThrow();
    const merge2 = squashMerge("pr2", "PR 2 (#2)");
    const run = readBackRun({ repo, plan, logPath, merges: [{ pr: 2, merge_sha: merge2 }] });
    expect(run.stop).toMatchObject({ pr: 2, tree_match: false, reason: expect.stringMatching(/^lower-merge-missing/) });
    expect(openStop(readDecisions(logPath))).toEqual(readbackRows(logPath).find((row) => row.pr === "2"));
  });

  it("still reports a commit that really is missing, and a real non-ancestor", () => {
    const { verifiedHead, mergeSha } = landed();
    expect(readBack({ repo, mergeSha: "0".repeat(40), verifiedHead })).toMatchObject({ reason: "merge-commit-missing" });
    expect(isAncestor(repo, mergeSha, verifiedHead)).toBe(false);
  });

  it("fails fast on Windows with a clear instruction, before running git", () => {
    expect(() => assertSupportedPlatform("win32")).toThrow(/Linux or macOS only; on Windows run it inside WSL/);
    expect(() => assertSupportedPlatform("linux")).not.toThrow();
    expect(() => assertSupportedPlatform("darwin")).not.toThrow();
    expect(() => runCli(["digest", "--log", path.join(dir, "log.tsv")], { write() {} }, "win32"))
      .toThrow(/Linux or macOS only/);
  });
});

describe("assertRef", () => {
  it("rejects leading dashes, whitespace, and control bytes", () => {
    expect(assertRef("origin/main", "ref")).toBe("origin/main");
    for (const bad of ["-x", "a b", "a\u00a0b", "a\u0001b", "a\u007fb", ""]) expect(() => assertRef(bad, "ref")).toThrow(/ref must be a git ref/);
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
    expect(plan).toEqual({ base: null, land: [], stop: { pr: 101, head_sha: "a".repeat(40), verdict_ref: "old", reason: "verdict-sha-stale" } });
  });

  it("lands the whole stack when every PR is verified at its head", () => {
    const verdicts = Object.fromEntries(stack.map((entry) => [entry.pr, { sha: entry.head_sha, verdict_ref: `v${entry.pr}`, valid: true }]));
    expect(planContiguousVerified(stack, verdicts)).toMatchObject({ stop: null, land: [{ pr: 101 }, { pr: 102 }, { pr: 103 }] });
  });

  it("rejects a short, missing, or non-hex head_sha before anything is planned", () => {
    for (const bad of ["abcd1234", "A".repeat(40), "g".repeat(40), "a".repeat(41), "", undefined, null]) {
      expect(() => planContiguousVerified([{ pr: 101, head_sha: bad }], {})).toThrow(/head_sha for PR 101 must be a full 40-hex commit SHA/);
    }
    // The bad entry is rejected even when it sits above a PR that would stop the plan first.
    expect(() => planContiguousVerified([...stack, { pr: 104, head_sha: "abcd1234" }], {})).toThrow(/PR 104/);
  });

  it("fails closed on duplicate or missing PR numbers", () => {
    expect(() => planContiguousVerified([...stack, { pr: "101", head_sha: "d".repeat(40) }], {})).toThrow(/duplicate PR/);
    expect(() => planContiguousVerified([{ head_sha: "a".repeat(40) }], {})).toThrow(/missing pr/);
    expect(() => planContiguousVerified(stack, {}, { base: "--output=x" })).toThrow(/stack base must be a hex/);
  });
});

describe("checkMergesAgainstPlan", () => {
  const plan = {
    base: "0".repeat(40),
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
        { pr: 1, head_sha: "a".repeat(40), verdict_ref: "v1", merge_sha: "m1", verified_base: "0".repeat(40) },
        { pr: 2, head_sha: "b".repeat(40), verdict_ref: "v2", merge_sha: "m2", verified_base: "a".repeat(40) },
      ],
    });
    const rows = [{ action: "readback", tree_match: "true", pr: "1", head_sha: "a".repeat(40) }];
    expect(checkMergesAgainstPlan({ plan, merges: [{ pr: 2 }], rows }).merges[0].verified_base).toBe("a".repeat(40));
  });

  it("refuses any verified_base on a merge and fails closed without a plan base", () => {
    expect(checkMergesAgainstPlan({ plan, merges: [{ pr: 1, verified_base: "e".repeat(40) }] })).toEqual({ ok: false, reason: "verified-base-override-not-allowed: 1" });
    expect(checkMergesAgainstPlan({ plan, merges: [{ pr: 1, verified_base: "0".repeat(40) }] })).toEqual({ ok: false, reason: "verified-base-override-not-allowed: 1" });
    expect(checkMergesAgainstPlan({ plan: { ...plan, base: null }, merges: [{ pr: 1 }] })).toMatchObject({ ok: false, reason: expect.stringMatching(/^plan-base-missing/) });
    expect(checkMergesAgainstPlan({ plan: undefined, merges: [{ pr: 1 }] })).toMatchObject({ ok: false, reason: "plan-missing" });
  });
});

describe("plan must match the log", () => {
  const land = [{ pr: 1, head_sha: "a".repeat(40), verdict_ref: "v1" }];
  const merges = [{ pr: 1, head_sha: "a".repeat(40), verdict_ref: "v1" }];
  const planLand = { action: "plan-land", pr: "1", head_sha: "a".repeat(40), verdict_ref: "v1" };

  it("needs the latest plan row for each PR to be a matching plan-land", () => {
    const plan = { base: null, land, stop: null };
    const digest = { action: "plan-digest", result: `plan-sha256:${planDigest(plan)}` };
    expect(planLogMismatch([planLand, digest], merges, plan)).toBeNull();
    expect(planLogMismatch([planLand], merges, plan)).toBe("plan-not-in-log: no plan-digest row");
    expect(planLogMismatch([planLand, digest, planLand], merges, plan)).toBe("plan-digest-mismatch");
    expect(planLogMismatch([], merges)).toMatch(/^plan-not-in-log: no plan row for PR 1/);
    expect(planLogMismatch([{ ...planLand, verdict_ref: "other" }], merges)).toMatch(/^plan-not-in-log: PR 1 /);
    expect(planLogMismatch([{ ...planLand, head_sha: "b".repeat(40) }], merges)).toMatch(/^plan-not-in-log: PR 1 /);
    expect(planLogMismatch([planLand, { ...planLand, action: "plan-stop" }], merges)).toMatch(/latest plan row for PR 1 is plan-stop/);
    expect(planLogMismatch([{ ...planLand, action: "plan-stop" }, planLand, digest], merges, plan)).toBeNull();
  });

  it("refuses a hand-written or edited plan.json, via readback-run and readback, without logging", () => {
    const base = g("rev-parse", "main");
    const head1 = branchWith("pr1", "main", "a.txt", "a\n");
    const merge1 = squashMerge("pr1", "PR 1 (#1)");
    const sink = () => {
      const chunks = [];
      return { write: (chunk) => chunks.push(chunk), json: () => JSON.parse(chunks.join("")) };
    };
    const logPath = path.join(dir, "decisions.tsv");
    const planPath = path.join(dir, "plan.json");
    const mergesPath = path.join(dir, "merges.json");
    fs.writeFileSync(mergesPath, JSON.stringify([{ pr: 1, merge_sha: merge1 }]));
    const hand = { base, land: [{ pr: 1, head_sha: head1, verdict_ref: "v1" }], stop: null };
    fs.writeFileSync(planPath, JSON.stringify(hand));

    // Never planned on this log.
    expect(runCli(["init-log", "--log", logPath])).toBe(0);
    const before = fs.readFileSync(logPath, "utf8");
    const run = sink();
    expect(runCli(["readback-run", "--repo", repo, "--merges", mergesPath, "--plan", planPath, "--log", logPath], run)).toBe(1);
    expect(run.json()).toMatchObject({ landed: [], refused: "plan-not-in-log: no plan row for PR 1" });
    const single = sink();
    expect(runCli(["readback", "--repo", repo, "--merge-sha", merge1, "--verified-head", head1, "--log", logPath, "--plan", planPath, "--pr", "1"], single)).toBe(1);
    expect(single.json()).toMatchObject({ refused: "plan-not-in-log: no plan row for PR 1" });
    expect(readBackRun({ repo, plan: hand, merges: [{ pr: 1, merge_sha: merge1 }] }).refused).toBe("plan-not-in-log: no plan row for PR 1");
    expect(fs.readFileSync(logPath, "utf8")).toBe(before);

    // Planned with one verdict, plan.json edited to another afterwards.
    logPlan(logPath, { land: [{ pr: 1, head_sha: head1, verdict_ref: "v0" }] });
    const edited = fs.readFileSync(logPath, "utf8");
    expect(readBackRun({ repo, logPath, plan: hand, merges: [{ pr: 1, merge_sha: merge1 }] }).refused).toMatch(/^plan-not-in-log: PR 1 /);
    expect(fs.readFileSync(logPath, "utf8")).toBe(edited);

    // The matching plan-land row lets the same read-back through.
    logPlan(logPath, hand);
    expect(readBackRun({ repo, logPath, plan: hand, merges: [{ pr: 1, merge_sha: merge1 }] })).toMatchObject({ stop: null, landed: [{ pr: 1, tree_match: true }] });
  });
});

describe("readBackRun", () => {
  it("stops at the first tree mismatch and logs it without reading later merges", () => {
    const base = g("rev-parse", "main");
    const head1 = branchWith("pr1", "main", "a.txt", "a\n");
    const merge1 = squashMerge("pr1", "PR 1 (#1)");
    const head2 = branchWith("pr2", "main", "b.txt", "b\n");
    commitFile("b.txt", "b\nunverified\n", "extra");
    const merge2 = squashMerge("pr2", "PR 2 (#2)");
    const head3 = branchWith("pr3", "main", "c.txt", "c\n");
    const merge3 = squashMerge("pr3", "PR 3 (#3)");
    const logPath = path.join(dir, "decisions.tsv");

    const plan = {
      base,
      land: [
        { pr: 1, head_sha: head1, verdict_ref: "v1" },
        { pr: 2, head_sha: head2, verdict_ref: "v2" },
        { pr: 3, head_sha: head3, verdict_ref: "v3" },
      ],
      stop: null,
    };
    logPlan(logPath, plan);
    const run = readBackRun({
      repo,
      logPath,
      plan,
      merges: [
        { pr: 1, merge_sha: merge1 },
        { pr: 2, merge_sha: merge2 },
        { pr: 3, merge_sha: merge3 },
      ],
    });

    expect(run.landed.map((entry) => entry.pr)).toEqual([1]);
    expect(run.stop).toMatchObject({ pr: 2, tree_match: false });
    const rows = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(rows[0]).toBe(DECISION_HEADER.trim());
    expect(rows).toHaveLength(7);
    expect(rows.slice(1).map((line) => line.split("\t")[5])).toEqual(["plan-land", "plan-land", "plan-land", "plan-digest", "readback", "readback"]);
    const cells = rows[6].split("\t");
    expect(cells.slice(1, 3)).toEqual(["2", head2]);
    expect(cells.slice(5, 8)).toEqual(["readback", merge2, "false"]);
    expect(cells[8]).toMatch(/^STOP .*Grok Bot.*no auto-revert$/);
  });

  it("refuses merges that are not the plan's verified run, without logging", () => {
    const base = g("rev-parse", "main");
    const head1 = branchWith("pr1", "main", "a.txt", "a\n");
    const merge1 = squashMerge("pr1", "PR 1 (#1)");
    const logPath = path.join(dir, "decisions.tsv");
    const plan = { base, land: [{ pr: 1, head_sha: head1, verdict_ref: "v1" }], stop: null };
    logPlan(logPath, plan);
    const before = fs.readFileSync(logPath, "utf8");
    expect(readBackRun({ repo, logPath, merges: [{ pr: 1, merge_sha: merge1 }] })).toMatchObject({ landed: [], refused: "plan-missing" });
    const unplanned = readBackRun({ repo, logPath, plan, merges: [{ pr: 9, head_sha: head1, merge_sha: merge1 }] });
    expect(unplanned).toMatchObject({ landed: [], refused: "pr-not-in-plan-land: 9" });
    expect(fs.readFileSync(logPath, "utf8")).toBe(before);
    const run = readBackRun({ repo, logPath, plan, merges: [{ pr: 1, merge_sha: merge1 }] });
    expect(run).toMatchObject({ stop: null, landed: [{ pr: 1, tree_match: true }] });
    expect(readbackRows(logPath)).toMatchObject([{ pr: "1", verdict_ref: "v1", action: "readback", tree_match: "true" }]);
  });

  it("reads back a real stacked base -> pr1 -> pr2 squash-merged bottom-up onto main", () => {
    const base = g("rev-parse", "main");
    const head1 = branchWith("pr1", "main", "a.txt", "a\n");
    const head2 = branchWith("pr2", "pr1", "b.txt", "b\n");
    g("checkout", "-q", "main");
    commitFile("other.txt", "unrelated\n", "unrelated main change");
    const merge1 = squashMerge("pr1", "PR 1 (#1)");
    const merge2 = squashMerge("pr2", "PR 2 (#2)");
    const verdicts = { 1: { sha: head1, verdict_ref: "v1", valid: true }, 2: { sha: head2, verdict_ref: "v2", valid: true } };
    const plan = planContiguousVerified([{ pr: 1, head_sha: head1 }, { pr: 2, head_sha: head2 }], verdicts, { base });
    expect(plan).toMatchObject({ base, stop: null });

    // Standalone read-back is a diagnostic, not proof: replaying pr1's identical
    // addition succeeds. The plan-bound run below binds the verified base.
    expect(readBack({ repo, mergeSha: merge2, verifiedHead: head2 }).tree_match).toBe(true);

    logPlan(path.join(dir, "together.tsv"), plan);
    const together = readBackRun({ repo, plan, logPath: path.join(dir, "together.tsv"), merges: [{ pr: 1, merge_sha: merge1 }, { pr: 2, merge_sha: merge2 }] });
    expect(together.stop).toBeNull();
    expect(together.landed).toMatchObject([
      { pr: 1, tree_match: true },
      { pr: 2, tree_match: true },
    ]);

    // One PR per run, as merges land: pr2 derives its base from pr1's verified head.
    const logPath = path.join(dir, "stack.tsv");
    logPlan(logPath, plan);
    expect(readBackRun({ repo, plan, logPath, merges: [{ pr: 1, merge_sha: merge1 }] }).landed).toMatchObject([{ pr: 1, tree_match: true }]);
    expect(readBackRun({ repo, plan, logPath, merges: [{ pr: 2, merge_sha: merge2 }] }).landed).toMatchObject([{ pr: 2, tree_match: true }]);
    expect(readbackRows(logPath).map((row) => [row.pr, row.tree_match])).toEqual([
      ["1", "true"],
      ["2", "true"],
    ]);
  });

  it("skips a repeat of a passed read-back and refuses one at another merge commit", () => {
    const base = g("rev-parse", "main");
    const head1 = branchWith("pr1", "main", "a.txt", "a\n");
    const merge1 = squashMerge("pr1", "PR 1 (#1)");
    const logPath = path.join(dir, "decisions.tsv");
    const plan = { base, land: [{ pr: 1, head_sha: head1, verdict_ref: "v1" }], stop: null };
    logPlan(logPath, plan);
    expect(readBackRun({ repo, logPath, plan, merges: [{ pr: 1, merge_sha: merge1 }] }).landed).toHaveLength(1);
    const before = fs.readFileSync(logPath, "utf8");
    expect(readBackRun({ repo, logPath, plan, merges: [{ pr: 1, merge_sha: merge1.slice(0, 12) }] })).toMatchObject({
      landed: [],
      skipped: [{ pr: 1 }],
      stop: null,
    });
    const other = commitFile("z.txt", "z\n", "later main change");
    expect(readBackRun({ repo, logPath, plan, merges: [{ pr: 1, merge_sha: other }] }).refused).toMatch(/^already-read-back: PR 1/);
    expect(fs.readFileSync(logPath, "utf8")).toBe(before);
  });

  it("throws on a merge SHA git could read as an option", () => {
    const base = g("rev-parse", "main");
    const head1 = branchWith("pr1", "main", "a.txt", "a\n");
    const plan = { base, land: [{ pr: 1, head_sha: head1, verdict_ref: "v1" }], stop: null };
    expect(() => readBackRun({ repo, plan, merges: [{ pr: 1, merge_sha: "--all" }] })).toThrow(/merge_sha for PR 1 must be a hex/);
    expect(() => readBackRun({ repo, plan, mainRef: "-main", merges: [{ pr: 1, merge_sha: head1 }] })).toThrow(/main ref/);
  });
});

describe("open stop", () => {
  const sink = () => ({ write: () => {} });

  it("blocks the next plan and read-back on the same log until a stop-ack", () => {
    const head1 = branchWith("pr1", "main", "a.txt", "a\n");
    commitFile("a.txt", "a\nunverified\n", "extra");
    const merge1 = squashMerge("pr1", "PR 1 (#1)");
    const logPath = path.join(dir, "decisions.tsv");
    const plan = { base: g("rev-parse", `${merge1}~1`), land: [{ pr: 1, head_sha: head1, verdict_ref: "v1" }], stop: null };
    logPlan(logPath, plan);
    expect(readBackRun({ repo, logPath, plan, merges: [{ pr: 1, merge_sha: merge1 }] }).stop).toMatchObject({ pr: 1, tree_match: false });
    expect(openStop(readDecisions(logPath))).toMatchObject({ pr: "1", tree_match: "false" });

    const stackPath = path.join(dir, "stack.json");
    const verdictsPath = path.join(dir, "verdicts.json");
    const planPath = path.join(dir, "plan.json");
    const mergesPath = path.join(dir, "merges.json");
    fs.writeFileSync(stackPath, JSON.stringify({ base: plan.base, prs: [{ pr: 1, head_sha: head1 }] }));
    fs.writeFileSync(verdictsPath, JSON.stringify({ 1: { sha: head1, verdict_ref: "v1", valid: true } }));
    fs.writeFileSync(planPath, JSON.stringify(plan));
    fs.writeFileSync(mergesPath, JSON.stringify([{ pr: 1, merge_sha: merge1 }]));
    const before = fs.readFileSync(logPath, "utf8");
    expect(runCli(["plan", "--stack", stackPath, "--verdicts", verdictsPath, "--log", logPath], sink())).toBe(1);
    expect(runCli(["readback-run", "--repo", repo, "--merges", mergesPath, "--plan", planPath, "--log", logPath], sink())).toBe(1);
    expect(runCli(["readback", "--repo", repo, "--merge-sha", merge1, "--verified-head", head1, "--log", logPath, "--plan", planPath, "--pr", "1"], sink())).toBe(1);
    expect(fs.readFileSync(logPath, "utf8")).toBe(before);

    expect(() => runCli(["stop-ack", "--log", logPath, "--pr", "2", "--by", "Blaine", "--note", "x"])).toThrow(/open stop is PR 1/);
    expect(runCli(["stop-ack", "--log", logPath, "--pr", "1", "--by", "Blaine", "--note", "reverted by hand in #9"], sink())).toBe(0);
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
    const base = g("rev-parse", "main");
    const head1 = branchWith("pr1", "main", "a.txt", "a\n");
    const merge1 = squashMerge("pr1", "PR 1 (#1)");
    const logPath = path.join(dir, "audit", "plan.tsv");
    const stackPath = path.join(dir, "stack.json");
    const verdictsPath = path.join(dir, "verdicts.json");
    fs.writeFileSync(stackPath, JSON.stringify([{ pr: 1, head_sha: head1 }]));
    fs.writeFileSync(verdictsPath, JSON.stringify({ 1: { sha: head1, verdict_ref: "v1", valid: true } }));
    expect(() => runCli(["plan", "--stack", stackPath, "--verdicts", verdictsPath], sink())).toThrow(/must be \{"base"/);
    fs.writeFileSync(stackPath, JSON.stringify({ prs: [{ pr: 1, head_sha: head1 }] }));
    expect(() => runCli(["plan", "--stack", stackPath, "--verdicts", verdictsPath], sink())).toThrow(/stack base must be a hex/);
    fs.writeFileSync(stackPath, JSON.stringify({ base, prs: [{ pr: 1, head_sha: head1 }, { pr: 2, head_sha: "b".repeat(40) }] }));

    expect(runCli(["init-log", "--log", logPath])).toBe(0);
    const plan = sink();
    expect(runCli(["plan", "--stack", stackPath, "--verdicts", verdictsPath, "--log", logPath], plan)).toBe(0);
    expect(plan.json()).toMatchObject({ base, stop: { pr: 2, reason: "no-verdict" } });
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
    const again = sink();
    expect(runCli(["readback", "--repo", repo, "--merge-sha", merge1, "--verified-head", head1, "--log", logPath, "--plan", planPath, "--pr", "1"], again)).toBe(0);
    expect(again.json()).toMatchObject({ reason: "already-read-back" });
    expect(runCli(["readback", "--repo", repo, "--merge-sha", head1, "--verified-head", head1], sink())).toBe(1);

    expect(runCli(["verify-log", "--log", logPath, "--prior", priorPath], sink())).toBe(0);
    const actions = fs.readFileSync(logPath, "utf8").trim().split("\n").slice(1).map((line) => line.split("\t")[5]);
    expect(actions).toEqual(["plan-land", "plan-stop", "plan-digest", "readback"]);

    expect(() => runCli(["readback", "--repo", repo])).toThrow(/missing --merge-sha/);
    expect(() => runCli(["readback", "--repo", repo, "--merge-sha", "-all", "--verified-head", head1])).toThrow(/--merge-sha must be a hex/);
    expect(() => runCli(["readback", "--repo", repo, "--merge-sha", "HEAD~1", "--verified-head", head1])).toThrow(/--merge-sha must be a hex/);
    expect(() => runCli(["readback", "--repo", repo, "--merge-sha", merge1, "--verified-head", head1, "--verified-base", "main"])).toThrow(/--verified-base is not accepted/);
    expect(() => runCli(["readback", "--repo", repo, "--merge-sha", merge1, "--verified-head", head1, "--main", "-x"])).toThrow(/--main must be a git ref/);
    expect(() => runCli(["readback", "--repo", "-C", "--merge-sha", merge1, "--verified-head", head1])).toThrow(/--repo must not start/);
    expect(() => runCli(["merge"])).toThrow(/unknown command/);
  });
});


// Capture CLI JSON without spawning a process.
const sink = () => {
  const chunks = [];
  return { write: (chunk) => chunks.push(chunk), json: () => JSON.parse(chunks.join("")) };
};

function nearbyLineFixture(tamper = false) {
  commitFile("f.txt", "1\n2\n3\n4\n5\n", "five lines");
  const base = g("rev-parse", "main");
  const head = branchWith("pr1", "main", "f.txt", "1\n2\n3\nfour\n5\n");
  g("checkout", "-q", "main");
  commitFile("f.txt", "one\n2\n3\n4\n5\n", "nearby main change");
  let merge = squashMerge("pr1", "PR 1 (#1)");
  if (tamper) {
    fs.writeFileSync(path.join(repo, "f.txt"), "one\n2\nthree\nfour\n5\n");
    g("commit", "-q", "-a", "--amend", "--no-edit");
    merge = g("rev-parse", "HEAD");
    g("update-ref", "refs/heads/main", merge);
  }
  return { plan: { base, land: [{ pr: 1, head_sha: head, verdict_ref: "v1" }], stop: null }, merges: [{ pr: 1, merge_sha: merge }] };
}

function cliPlan(plan, logPath, digestPath) {
  const stackPath = path.join(dir, "stack.json");
  const verdictsPath = path.join(dir, "verdicts.json");
  fs.writeFileSync(stackPath, JSON.stringify({ base: plan.base, prs: plan.land }));
  fs.writeFileSync(verdictsPath, JSON.stringify(Object.fromEntries(plan.land.map((entry) => [entry.pr, { sha: entry.head_sha, verdict_ref: entry.verdict_ref, valid: true }]))));
  const out = sink();
  expect(runCli(["plan", "--stack", stackPath, "--verdicts", verdictsPath, "--log", logPath, ...(digestPath ? ["--digest-out", digestPath] : [])], out)).toBe(0);
  return out.json();
}

describe("F2: rebased-tree comparison is the only pass/stop check", () => {
  it("passes a correct squash rebased onto a main that changed a nearby line (5-line repro)", () => {
    const { plan, merges } = nearbyLineFixture();
    const logPath = path.join(dir, "nearby.tsv");
    logPlan(logPath, plan);
    expect(readBackRun({ repo, plan, merges, logPath })).toMatchObject({
      landed: [{ pr: 1, tree_match: true, mode: "rebased", reason: "rebased-tree-matches" }], stop: null,
    });
    expect(readbackRows(logPath)).toMatchObject([{ tree_match: "true", patch_id: expect.stringMatching(/^[0-9a-f]{40}$/) }]);
    expect(openStop(readDecisions(logPath))).toBeNull();
  });

  it("still stops a rebased squash that carries a real content difference", () => {
    const { plan, merges } = nearbyLineFixture(true);
    const logPath = path.join(dir, "tampered.tsv");
    logPlan(logPath, plan);
    expect(readBackRun({ repo, plan, merges, logPath }).stop).toMatchObject({ tree_match: false, reason: "tree-mismatch-after-rebase" });
    expect(openStop(readDecisions(logPath))).not.toBeNull();
  });
});

describe("F3: landing order is checked against git ancestry", () => {
  it("stops a reversed landing where the upper PR merged first", () => {
    const base = g("rev-parse", "main");
    const head1 = branchWith("pr1", "main", "a.txt", "a\n");
    const head2 = branchWith("pr2", "pr1", "b.txt", "b\n");
    g("checkout", "-q", "main");
    const merge2 = commitFile("b.txt", "b\n", "upper first");
    const merge1 = commitFile("a.txt", "a\n", "lower second");
    const plan = { base, land: [{ pr: 1, head_sha: head1, verdict_ref: "v1" }, { pr: 2, head_sha: head2, verdict_ref: "v2" }], stop: null };
    const merges = [{ pr: 1, merge_sha: merge1 }, { pr: 2, merge_sha: merge2 }];
    for (const incremental of [false, true]) {
      const logPath = path.join(dir, `${incremental}.tsv`);
      logPlan(logPath, plan);
      if (incremental) expect(readBackRun({ repo, plan, logPath, merges: merges.slice(0, 1) }).landed).toMatchObject([{ pr: 1 }]);
      const run = readBackRun({ repo, plan, logPath, merges: incremental ? merges.slice(1) : merges });
      expect(run.landed.map((entry) => entry.pr)).toEqual(incremental ? [] : [1]);
      expect(run.stop).toMatchObject({ pr: 2, tree_match: false, reason: expect.stringMatching(/^lower-merge-not-ancestor-of-parent/) });
      expect(openStop(readDecisions(logPath))).toEqual(readbackRows(logPath).find((row) => row.pr === "2"));
    }
  });
});

describe("F4: the whole ordered plan is bound to the log", () => {
  function fixture() {
    const base = g("rev-parse", "main");
    const head1 = branchWith("pr1", "main", "a.txt", "a\n");
    const head2 = branchWith("pr2", "pr1", "b.txt", "b\n");
    const merge1 = squashMerge("pr1", "PR 1 (#1)");
    const merge2 = squashMerge("pr2", "PR 2 (#2)");
    const logPath = path.join(dir, "bound.tsv");
    const plan = cliPlan({ base, land: [{ pr: 1, head_sha: head1, verdict_ref: "v1" }, { pr: 2, head_sha: head2, verdict_ref: "v2" }] }, logPath);
    return { plan, logPath, head1, head2, merge1, merge2 };
  }

  function refuses(f, plan) {
    const planPath = path.join(dir, "plan.json");
    const mergesPath = path.join(dir, "merges.json");
    fs.writeFileSync(planPath, JSON.stringify(plan));
    fs.writeFileSync(mergesPath, JSON.stringify([{ pr: 2, merge_sha: f.merge2 }]));
    const before = fs.readFileSync(f.logPath);
    for (const args of [
      ["readback-run", "--merges", mergesPath],
      ["readback", "--pr", "2", "--merge-sha", f.merge2, "--verified-head", f.head2],
    ]) {
      const out = sink();
      expect(runCli([...args, "--repo", repo, "--plan", planPath, "--log", f.logPath], out)).toBe(1);
      expect(out.json()).toMatchObject({ refused: "plan-digest-mismatch" });
      expect(fs.readFileSync(f.logPath)).toEqual(before);
    }
  }

  it("refuses a plan.json with a lower PR deleted from land", () => {
    const f = fixture();
    refuses(f, { ...f.plan, base: f.head1, land: f.plan.land.slice(1) });
  });

  it("refuses a plan.json with a changed base", () => {
    const f = fixture();
    // Supply the lower passing row so order checks cannot mask the digest check.
    expect(readBackRun({ repo, plan: f.plan, logPath: f.logPath, merges: [{ pr: 1, merge_sha: f.merge1 }] }).stop).toBeNull();
    refuses(f, { ...f.plan, base: f.head1 });
  });
});

describe("F5: the log digest is refreshed after every append", () => {
  it("detects a failed read-back flipped to true after the post-read-back digest", () => {
    const { plan, merges } = nearbyLineFixture(true);
    const logPath = path.join(dir, "digest.tsv");
    const d0 = path.join(dir, "d0.json");
    const d1 = path.join(dir, "d1.json");
    const planPath = path.join(dir, "plan.json");
    const mergesPath = path.join(dir, "merges.json");
    fs.writeFileSync(planPath, JSON.stringify(cliPlan(plan, logPath, d0)));
    fs.writeFileSync(mergesPath, JSON.stringify(merges));
    const args = ["readback-run", "--repo", repo, "--plan", planPath, "--merges", mergesPath, "--log", logPath];
    const out = sink();
    expect(runCli([...args, "--prior", d0, "--digest-out", d1], out)).toBe(1);
    expect(out.json().stop).toMatchObject({ tree_match: false });
    expect(out.json().log_digest).toEqual(JSON.parse(fs.readFileSync(d1, "utf8")));

    const copy = path.join(dir, "ack.tsv");
    const ackDigest = path.join(dir, "ack.json");
    fs.copyFileSync(logPath, copy);
    const ack = sink();
    expect(runCli(["stop-ack", "--log", copy, "--pr", "1", "--by", "fixture", "--note", "reviewed", "--prior", d1, "--digest-out", ackDigest], ack)).toBe(0);
    expect(ack.json().log_digest).toEqual(JSON.parse(fs.readFileSync(ackDigest, "utf8")));
    expect(runCli(["verify-log", "--log", copy, "--prior", ackDigest], sink())).toBe(0);

    const original = fs.readFileSync(logPath, "utf8");
    const flip = (pad) => original.split("\n").map((line) => line.split("\t")[5] === "readback" ? `${line.replace("\tfalse\t", "\ttrue\t")}${pad}` : line).join("\n");
    // The gate repro: flipping false to true shortens the log by one byte.
    fs.writeFileSync(logPath, flip(""));
    const shorter = sink();
    expect(runCli(["verify-log", "--log", logPath, "--prior", d1], shorter)).toBe(1);
    expect(shorter.json()).toMatchObject({ ok: false, reason: "log-truncated" });
    // A same-length flip (one byte padded onto the row) is caught by the hash.
    const flipped = flip(" ");
    expect(Buffer.byteLength(flipped)).toBe(Buffer.byteLength(original));
    fs.writeFileSync(logPath, flipped);
    const verify = sink();
    expect(runCli(["verify-log", "--log", logPath, "--prior", d1], verify)).toBe(1);
    expect(verify.json()).toMatchObject({ ok: false, reason: "prior-rows-rewritten" });
    const refused = sink();
    expect(runCli([...args, "--prior", d1], refused)).toBe(1);
    expect(refused.json()).toEqual({ refused: "prior-rows-rewritten" });
    expect(fs.readFileSync(logPath, "utf8")).toBe(flipped);
  });

  it("refuses the next PR's read-back after a stop's recorded digest and a flipped row", () => {
    const base = g("rev-parse", "main");
    const h1 = branchWith("pr1", base, "a.txt", "a\n");
    const h2 = branchWith("pr2", h1, "b.txt", "b\n");
    squashMerge("pr1", "PR 1 (#1)");
    fs.writeFileSync(path.join(repo, "rider.txt"), "rider\n");
    g("add", "rider.txt");
    g("commit", "-q", "--amend", "--no-edit");
    const m1 = g("rev-parse", "HEAD");
    g("update-ref", "refs/heads/main", m1);
    const m2 = squashMerge("pr2", "PR 2 (#2)");
    const plan = { base, land: [{ pr: 1, head_sha: h1, verdict_ref: "v1" }, { pr: 2, head_sha: h2, verdict_ref: "v2" }], stop: null };
    const logPath = path.join(dir, "per-pr-digest.tsv");
    const planPath = path.join(dir, "plan.json");
    const d0 = path.join(dir, "d0.json");
    const d1 = path.join(dir, "d1.json");
    const d2 = path.join(dir, "d2.json");
    fs.writeFileSync(planPath, JSON.stringify(cliPlan(plan, logPath, d0)));
    const args = ["readback", "--repo", repo, "--main", "main", "--log", logPath, "--plan", planPath];
    const out = sink();
    expect(runCli([...args, "--merge-sha", m1, "--verified-head", h1, "--pr", "1", "--prior", d0, "--digest-out", d1], out)).toBe(1);
    expect(out.json().tree_match).toBe(false);
    expect(fs.existsSync(d1)).toBe(true);
    expect(JSON.parse(fs.readFileSync(d1, "utf8"))).toEqual(out.json().log_digest);

    const flipped = fs.readFileSync(logPath, "utf8").split("\n").map((line) => line.split("\t")[5] === "readback" ? line.replace("\tfalse\t", "\ttrue\t") : line).join("\n");
    fs.writeFileSync(logPath, flipped);
    const refused = sink();
    expect(runCli([...args, "--merge-sha", m2, "--verified-head", h2, "--pr", "2", "--prior", d1, "--digest-out", d2], refused)).toBe(1);
    expect(refused.json()).toEqual({ refused: expect.stringMatching(/^(log-truncated|prior-rows-rewritten)$/) });
    expect(fs.readFileSync(logPath, "utf8")).toBe(flipped);
    expect(fs.existsSync(d2)).toBe(false);
  });
});

describe("F7: large diffs", () => {
  it("reads back a ~2 MB diff without ENOBUFS", () => {
    const head = branchWith("pr1", "main", "big.txt", `${"x".repeat(40)}\n`.repeat(60000));
    const merge = squashMerge("pr1", "PR 1 (#1)");
    expect(readBack({ repo, mergeSha: merge, verifiedHead: head })).toMatchObject({ tree_match: true, patch_id: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });
});
