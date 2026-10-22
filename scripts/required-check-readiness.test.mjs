// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertReadOnlyGhArgs, buildReport, checkWorkflowShape, main, replayMergedPrs, reportingHistory, resolveBinary } from "./required-check-readiness.mjs";

const workflow = readFileSync(new URL("../.github/workflows/proof-check.yml", import.meta.url), "utf8");
const shape = () => checkWorkflowShape(workflow, "proof-check");
const heads = [{ number: 1, sha: "abc" }];
const history = (runs = []) => reportingHistory({ heads, checkRunsBySha: { abc: runs }, checkName: "proof-check" });
const run = { name: "proof-check", app: { id: 15368 }, status: "completed", conclusion: "success" };

describe("required check readiness", () => {
  it("accepts the local proof-check workflow shape", () => expect(shape()).toEqual({ ok: true, findings: [] }));
  it.each([
    [workflow.replace("  pull_request:", "  pull_request:\n    paths: [src/**]"), "paths_filter"],
    [workflow.replace("  pull_request:", "  pull_request:\n    paths-ignore: [docs/**]"), "paths_filter"],
    [workflow.replace("    name: proof-check", "    if: false\n    name: proof-check"), "job_level_if"],
    [workflow.replace("  merge_group:", "  push:"), "no_merge_group"],
    [workflow.replace("    name: proof-check", "    name: other"), "job_name_mismatch"],
    [workflow.replace("    name: proof-check", ""), "job_name_mismatch"],
    [workflow.replace("  proof-check:", "  other:"), "job_missing"],
    [workflow.replace("  pull_request:", "  pull_request_target:").replace("pull_request.base.sha", "pull_request.head.sha"), "untrusted_checkout"],
    [workflow.replace("  pull_request:", "  workflow_run:").replace("pull_request.base.sha", "workflow_run.head_sha"), "untrusted_checkout"],
  ])("reports shape finding %s", (text, code) => {
    expect(checkWorkflowShape(text, "proof-check").findings.map((finding) => finding.code)).toContain(code);
  });
  it("resolves binaries only from fixed directories in order", () => {
    const checked = [];
    expect(resolveBinary("gh", { exists: (path) => { checked.push(path); return path === "/usr/local/bin/gh"; } })).toBe("/usr/local/bin/gh");
    expect(checked).toEqual(["/usr/bin/gh", "/bin/gh", "/usr/local/bin/gh"]);
    expect(() => resolveBinary("gh", { exists: () => false })).toThrow("not found");
  });
  it.each(["on", '"on"', "'on'"])("accepts quoted and inline triggers: %s", (key) => {
    const job = "jobs:\n  check:\n    name: check";
    expect(checkWorkflowShape(`${key}: [pull_request, merge_group]\n\n${job}`, "check").ok).toBe(true);
    expect(checkWorkflowShape(`${key}:\n\tmerge_group:\n\n${job}`, "check").ok).toBe(true);
  });
  it("stops trigger scanning at the next top-level key on long input", () => {
    const text = `on:\n  push:\n${" ".repeat(100000)}\njobs:\n  check:\n    name: check\n    merge_group:`;
    expect(checkWorkflowShape(text, "check").findings.map(({ code }) => code)).toEqual(["no_merge_group"]);
  });
  it("keeps checkout refs within their own step", () => {
    const text = "on: [pull_request_target, merge_group]\njobs:\n  check:\n    name: check\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo fixture\n        ref: head.sha";
    expect(checkWorkflowShape(text, "check").ok).toBe(true);
    expect(checkWorkflowShape(text.replace("      - run: echo fixture\n", ""), "check").findings.map(({ code }) => code)).toContain("untrusted_checkout");
  });
  it("compares the job name to the check name when --job differs from --check", () => {
    const text = (name) => `on: [pull_request, merge_group]\njobs:\n  gate-job:\n    name: ${name}`;
    const codes = (name) => checkWorkflowShape(text(name), "gate-job", "my-check").findings.map(({ code }) => code);
    expect(codes("my-check")).toEqual([]);
    expect(codes("gate-job")).toEqual(["job_name_mismatch"]);
    expect(checkWorkflowShape(text("gate-job"), "gate-job", "my-check").findings[0].detail).toBe("job name must be exactly my-check");
    expect(checkWorkflowShape(text("gate-job"), "gate-job").ok).toBe(true);
  });
  it("passes the check name to the shape rule from the CLI", async () => {
    const jobs = (name) => `on: [pull_request, merge_group]\njobs:\n  verify-judge:\n    name: ${name}`;
    const run = async (name) => {
      const output = [];
      await main({ argv: ["--check", "verify", "--job", "verify-judge", "--workflow", ".github/workflows/verify.yml"],
        readFile: () => jobs(name), out: (line) => output.push(JSON.parse(line)), runGh: (args) => (args[1].includes("check-runs") ? { check_runs: [] } : []) });
      return output[0].shape;
    };
    expect(await run("verify")).toEqual({ ok: true, findings: [] });
    expect((await run("verify-judge")).findings.map(({ code }) => code)).toEqual(["job_name_mismatch"]);
  });
  describe("privileged triggers", () => {
    const steps = (...blocks) => `on: [pull_request_target, merge_group]\njobs:\n  check:\n    name: check\n    steps:\n${blocks.join("\n")}\n`;
    const checkout = (key, value) => `      - uses: actions/checkout@v4\n        with:\n          ${key}: ${value}`;
    const codes = (text) => checkWorkflowShape(text, "check").findings.map(({ code }) => code);
    it.each([
      ["github.head_ref", checkout("ref", "${{ github.head_ref }}")],
      ["the PR merge ref", checkout("ref", "refs/pull/${{ github.event.pull_request.number }}/merge")],
      ["the PR merge ref without refs/", checkout("ref", "pull/${{ github.event.number }}/head")],
      ["workflow_run head_branch", checkout("ref", "${{ github.event.workflow_run.head_branch }}")],
      ["workflow_run head_sha", checkout("ref", "${{ github.event.workflow_run.head_sha }}")],
      ["workflow_run head_commit", checkout("ref", "${{ github.event.workflow_run.head_commit.id }}")],
      ["pull_request merge_commit_sha", checkout("ref", "${{ github.event.pull_request.merge_commit_sha }}")],
      ["a nested .head. property", checkout("ref", "${{ github.event.workflow_run.pull_requests[0].head.ref }}")],
      ["a trailing .head property", checkout("ref", "${{ toJSON(github.event.pull_request.head) }}")],
      ["a different-case head reference", checkout("ref", "${{ GitHub.Head_Ref }}")],
      ["the fork repository", checkout("repository", "${{ github.event.pull_request.head.repo.full_name }}")],
      ["a flow mapping", "      - uses: actions/checkout@v4\n        with: { ref: '${{ github.head_ref }}' }"],
      ["gh pr checkout", "      - run: gh pr checkout ${{ github.event.pull_request.number }}"],
      ["git checkout", "      - run: git checkout ${{ github.head_ref }}"],
      ["git switch", "      - run: git switch --detach $HEAD_SHA"],
      ["a multi-line git checkout", "      - name: Get code\n        run: |\n          set -e\n          git fetch origin\n          git checkout \"$REF\"\n        env:\n          REF: ${{ github.head_ref }}"],
    ])("flags %s under pull_request_target", (_label, block) => {
      expect(codes(steps(block))).toContain("untrusted_checkout");
    });
    it.each(["pull_request_target", "workflow_run"])("flags a head_ref checkout under %s with merge_group present", (trigger) => {
      const text = steps(checkout("ref", "${{ github.head_ref }}")).replace("pull_request_target", trigger);
      expect(codes(text)).toContain("untrusted_checkout");
    });
    it.each([
      ["a base sha checkout", checkout("ref", "${{ github.event.pull_request.base.sha }}")],
      ["the workflow sha", checkout("ref", "${{ github.sha }}")],
      ["the default branch", checkout("ref", "${{ github.event.repository.default_branch }}")],
      ["this repository", checkout("repository", "${{ github.repository }}")],
      ["a checkout with no ref", "      - uses: actions/checkout@v4"],
      ["commands that do not check out", "      - run: git status\n      - run: git fetch origin main\n      - run: gh pr view 1"],
      ["a git checkout mentioned only in a step name", "      - name: Explain git checkout\n        run: echo done"],
      ["a git checkout in a different step's env value", "      - run: echo done\n        env:\n          NOTE: git checkout"],
    ])("does not flag %s", (_label, block) => {
      expect(codes(steps(block))).not.toContain("untrusted_checkout");
    });
    it("does not flag head references or git checkout when no privileged trigger is present", () => {
      const text = steps(checkout("ref", "${{ github.head_ref }}"), "      - run: git checkout main").replace("pull_request_target", "pull_request");
      expect(codes(text)).not.toContain("untrusted_checkout");
    });
  });
  it("pages samples over 100 and reads every head", async () => {
    const pages = [];
    const checks = [];
    const output = [];
    const code = await main({ argv: ["--check", "proof-check", "--workflow", ".github/workflows/proof-check.yml", "--heads", "101"],
      readFile: () => workflow, out: (line) => output.push(JSON.parse(line)), runGh: (args) => {
        if (args[1].includes("check-runs")) { checks.push(args[1]); return { check_runs: [run] }; }
        const page = Number(new URL(`https://fixture.invalid/${args[1]}`).searchParams.get("page"));
        pages.push(page);
        return Array.from({ length: page === 1 ? 100 : 1 }, (_, i) => ({ number: (page - 1) * 100 + i, head: { sha: `sha${page}-${i}` } }));
      } });
    expect(code).toBe(0);
    expect(pages).toEqual([1, 2]);
    expect(checks).toHaveLength(101);
    expect(output[0].history.covered).toBe(101);
  });
  it("keeps paging merged PRs until enough merged rows are found, then trims to the count", async () => {
    const closedPages = [];
    const output = [];
    const merged = (number, mergedAt) => ({ number, merged_at: mergedAt, head: { sha: `sha${number}` } });
    const closed = { 1: [merged(1, null), merged(2, "t"), merged(3, null)], 2: [merged(4, "t"), merged(5, "t"), merged(6, "t")] };
    const code = await main({ argv: ["--check", "proof-check", "--workflow", ".github/workflows/proof-check.yml", "--heads", "1", "--dry-run-merged", "3"],
      readFile: () => workflow, out: (line) => output.push(JSON.parse(line)), runGh: (args) => {
        if (args[1].includes("check-runs")) return { check_runs: [run] };
        const url = new URL(`https://fixture.invalid/${args[1]}`);
        if (url.searchParams.get("state") === "all") return [merged(9, null)];
        closedPages.push(Number(url.searchParams.get("page")));
        return closed[url.searchParams.get("page")] ?? [];
      } });
    expect(code).toBe(0);
    expect(closedPages).toEqual([1, 2]);
    expect(output[0].replay.total).toBe(3);
  });
  it("stops paging when a short page shows there is nothing more to read", async () => {
    const closedPages = [];
    const output = [];
    const code = await main({ argv: ["--check", "proof-check", "--workflow", ".github/workflows/proof-check.yml", "--heads", "1", "--dry-run-merged", "5"],
      readFile: () => workflow, out: (line) => output.push(JSON.parse(line)), runGh: (args) => {
        if (args[1].includes("check-runs")) return { check_runs: [run] };
        const url = new URL(`https://fixture.invalid/${args[1]}`);
        if (url.searchParams.get("state") === "all") return [{ number: 9, head: { sha: "sha9" } }];
        closedPages.push(Number(url.searchParams.get("page")));
        return [{ number: 1, merged_at: "t", head: { sha: "sha1" } }];
      } });
    expect(code).toBe(0);
    expect(closedPages).toEqual([1]);
    expect(output[0].replay.total).toBe(1);
  });
  it("requires exact name and app coverage, not a passing conclusion", () => {
    expect(history().ok).toBe(false);
    expect(history().missing).toEqual(heads);
    expect(history([{ ...run, app: { id: 1 } }]).covered).toBe(0);
    expect(history([{ ...run, name: "other" }]).covered).toBe(0);
    expect(history([{ ...run, status: "in_progress", conclusion: null }]).ok).toBe(true);
    expect(reportingHistory({ heads: [], checkRunsBySha: {}, checkName: "x" }).ok).toBe(false);
  });
  it("reports pre-v1 and absent evaluators as not applicable", () => {
    const prs = [{ number: 1 }];
    const replay = replayMergedPrs({ prs, evaluate: () => ({ applicable: false, reason: "not applicable (pre-v1)" }) });
    expect(replay).toEqual({ total: 1, applicable: 0, notApplicable: [{ number: 1, reason: "not applicable (pre-v1)" }], falseBlocks: [] });
    expect(replayMergedPrs({ prs }).notApplicable[0].reason).toBe("no evaluator on main");
    expect(buildReport({ check: "x", shape: shape(), history: history([run]), replay }).ready).toBe(false);
  });
  it("requires no false blocks and some applicable replay evidence", () => {
    const base = { check: "x", shape: shape(), history: history([run]) };
    expect(buildReport(base).ready).toBe(true);
    for (const block of [true, false]) {
      const replay = replayMergedPrs({ prs: [{ number: 2 }], evaluate: () => ({ applicable: true, block, reason: "fixture" }) });
      expect(buildReport({ ...base, replay }).ready).toBe(!block);
    }
    expect(buildReport({ ...base, history: history() }).ready).toBe(false);
    expect(buildReport({ ...base, shape: checkWorkflowShape("", "x") }).ready).toBe(false);
  });
  it.each([["--method", "PATCH"], ["-X", "POST"], ["-f", "x=y"], ["-F", "x=y"], ["--input", "file"], ["--method=POST"], ["-XPOST"]])("rejects write args %s", (...suffix) => {
    expect(() => assertReadOnlyGhArgs(["api", "repos/o/r/pulls", ...suffix])).toThrow();
  });
  it("accepts plain and explicit GET reads only", () => {
    expect(() => assertReadOnlyGhArgs(["api", "repos/o/r/pulls"])).not.toThrow();
    expect(() => assertReadOnlyGhArgs(["api", "repos/o/r/pulls", "--method", "GET"])).not.toThrow();
    expect(() => assertReadOnlyGhArgs(["pr", "merge"])).toThrow();
  });
  it.each([false, true])("CLI reports not-ready with opt-in failure %s", async (fail) => {
    const output = [];
    const calls = [];
    const code = await main({ argv: ["--check", "proof-check", "--workflow", ".github/workflows/proof-check.yml", ...(fail ? ["--exit-nonzero-when-not-ready"] : [])],
      readFile: () => workflow, runGh: (args) => { calls.push(args); return args[1].includes("check-runs") ? { check_runs: [] } : [{ number: 1, head: { sha: "abc" } }]; }, out: (line) => output.push(JSON.parse(line)) });
    expect(code).toBe(fail ? 1 : 0);
    expect(output[0].ready).toBe(false);
    expect(output[0].mode).toBe("report");
    calls.forEach((args) => expect(() => assertReadOnlyGhArgs(args)).not.toThrow());
  });
  it("reports missing workflows and read errors without failing by default", async () => {
    const output = [];
    const options = { argv: ["--check", "x", "--workflow", ".github/workflows/missing.yml"], out: (text) => output.push(JSON.parse(text)), readFile: () => { throw Object.assign(new Error(), { code: "ENOENT" }); } };
    expect(await main({ ...options, runGh: () => [] })).toBe(0);
    expect(output[0].shape.findings[0].code).toBe("workflow_missing");
    expect(await main({ ...options, runGh: () => { throw new Error(); } })).toBe(0);
    expect(output[1].reasons).toContain("readiness_report_error");
  });
  it("uses exit 2 only for usage errors", async () => {
    expect(await main({ argv: [], err: () => {} })).toBe(2);
  });
});
