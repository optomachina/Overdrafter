// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertReadOnlyGhArgs, buildReport, checkWorkflowShape, main, replayMergedPrs, reportingHistory } from "./required-check-readiness.mjs";

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
