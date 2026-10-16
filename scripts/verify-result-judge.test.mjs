// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { collectJourneys, judge, main, parseManifest } from "./verify-result-judge.mjs";

const SHA = "a".repeat(40);
const FEATURES = ["quote"];

// Same lines verify.sh writes; scripts/verify-overdrafter-skill.test.mjs feeds a
// manifest produced by verify.sh itself through the judge.
const manifest = ({ sha = SHA, tree = "clean", code = 0, mode = "local", features = "quote", specs = "e2e/intake.spec.ts e2e/sourcing-destination.spec.ts" } = {}) =>
  [`mode: ${mode}`, `features: ${features}`, `specs: ${specs}`, "command: npx playwright test", `git head: ${sha} (${tree} tree)`, "tests: passed=3", `exit code: ${code}`, "verdict: PASS"].join("\n");

const test = (status = "passed", extra = {}) => ({
  projectName: "",
  expectedStatus: "passed",
  status: status === "passed" ? "expected" : status === "skipped" ? "skipped" : "unexpected",
  results: status === "skipped" ? [{ status: "skipped" }] : [{ status }],
  ...extra,
});

const report = (intakeStatus = "passed", extra = {}) => JSON.stringify({
  suites: [
    {
      title: "intake.spec.ts",
      file: "intake.spec.ts",
      specs: [{ title: "client uploads a part", file: "intake.spec.ts", tests: [test("passed")] }],
      suites: [{
        title: "intake flow",
        file: "intake.spec.ts",
        specs: [{ title: "client requests a quote", file: "intake.spec.ts", tests: [test(intakeStatus, extra)] }],
      }],
    },
    {
      title: "sourcing-destination.spec.ts",
      file: "sourcing-destination.spec.ts",
      specs: [{ title: "client picks a destination", file: "sourcing-destination.spec.ts", tests: [test("passed")] }],
    },
  ],
  errors: [],
});

const run = (over = {}) => ({ label: "local", manifestText: manifest(), reportText: report(), ...over });
const judgeOne = (over = {}, opts = {}) => judge({ runs: [run(over)], expectedSha: SHA, features: FEATURES, ...opts });

describe("verify-result-judge", () => {
  it("passes a clean run at the expected SHA", () => {
    const result = judgeOne();
    expect(result.reasons).toEqual([]);
    expect(result.verdict).toBe("PASS");
    expect(result.headShas).toEqual([SHA]);
    expect(result.journeys).toHaveLength(3);
    expect(result.journeys[1].name).toBe("intake.spec.ts › intake flow › client requests a quote");
  });

  it("fails a broken journey and names it", () => {
    const result = judgeOne({ reportText: report("failed") });
    expect(result.verdict).toBe("FAIL");
    expect(result.failingJourneys).toEqual(["local: intake.spec.ts › intake flow › client requests a quote (failed)"]);
  });

  it.each([
    ["skipped", "skipped"],
    ["timedOut", "timedOut"],
    ["interrupted", "cancelled"],
  ])("fails a %s journey", (status, label) => {
    const result = judgeOne({ reportText: report(status) });
    expect(result.verdict).toBe("FAIL");
    expect(result.reasons).toContain(`local: ${label}: intake.spec.ts › intake flow › client requests a quote`);
  });

  it("fails test.fail() and flaky journeys instead of counting them as verified", () => {
    const expectedFailure = judgeOne({ reportText: report("failed", { expectedStatus: "failed", status: "expected" }) });
    expect(expectedFailure.verdict).toBe("FAIL");
    expect(expectedFailure.failingJourneys[0]).toMatch(/expected-failure/);
    const flaky = judgeOne({ reportText: report("passed", { status: "flaky" }) });
    expect(flaky.failingJourneys[0]).toMatch(/\(flaky\)$/);
  });

  it("fails on a missing report, a missing manifest or invalid JSON", () => {
    expect(judgeOne({ reportText: null }).reasons).toContain("local: playwright-report.json missing");
    expect(judgeOne({ manifestText: null }).reasons).toContain("local: manifest.txt missing");
    expect(judgeOne({ reportText: "{" }).verdict).toBe("FAIL");
    expect(judge({ runs: [], expectedSha: SHA, features: FEATURES }).verdict).toBe("FAIL");
  });

  it("fails on a SHA mismatch or no expected SHA", () => {
    const mismatch = judgeOne({ manifestText: manifest({ sha: "b".repeat(40) }) });
    expect(mismatch.verdict).toBe("FAIL");
    expect(mismatch.reasons[0]).toMatch(/SHA mismatch/);
    expect(judgeOne({}, { expectedSha: null }).verdict).toBe("FAIL");
  });

  it("fails a dirty tree and a manifest that drifts from the base feature map", () => {
    expect(judgeOne({ manifestText: manifest({ tree: "dirty" }) }).reasons).toEqual(["local: tested tree was dirty, not clean at the head SHA"]);
    const dropped = judgeOne({ manifestText: manifest({ specs: "e2e/intake.spec.ts" }) });
    expect(dropped.reasons).toEqual(["local: manifest specs differ from the base feature map (e2e/intake.spec.ts e2e/sourcing-destination.spec.ts)"]);
    expect(judgeOne({ manifestText: manifest({ features: "auth" }) }).verdict).toBe("FAIL");
    expect(judgeOne({ manifestText: manifest({ mode: "fixture" }) }).reasons).toContain("local: manifest mode is fixture");
  });

  it("fails when the recorded harness hash is missing or differs from the base harness", () => {
    expect(judgeOne({}, { harness: { expected: "h1", recorded: "h1" } }).verdict).toBe("PASS");
    expect(judgeOne({}, { harness: { expected: "h1", recorded: "h2" } }).reasons[0]).toMatch(/harness changed/);
    expect(judgeOne({}, { harness: { expected: "h1", recorded: null } }).verdict).toBe("FAIL");
  });

  it("fails when a mapped spec ran no journeys, playwright exited non-zero, or reported errors", () => {
    const noJourneys = JSON.stringify({ ...JSON.parse(report()), suites: JSON.parse(report()).suites.slice(0, 1) });
    expect(judgeOne({ reportText: noJourneys }).reasons).toEqual(["local: no journeys ran for e2e/sourcing-destination.spec.ts"]);
    expect(judgeOne({ manifestText: manifest({ code: 1 }) }).reasons).toEqual(["local: playwright exit code 1"]);
    const errored = JSON.stringify({ ...JSON.parse(report()), errors: [{ message: "webServer exited\nstack" }] });
    expect(judgeOne({ reportText: errored }).reasons).toEqual(["local: playwright error: webServer exited"]);
  });

  it("parses verify.sh manifests and flattens nested suites", () => {
    expect(parseManifest(manifest())).toMatchObject({ mode: "local", gitHead: SHA, tree: "clean", exitCode: 0, specs: ["e2e/intake.spec.ts", "e2e/sourcing-destination.spec.ts"] });
    expect(parseManifest(manifest({ tree: "dirty" })).tree).toBe("dirty");
    expect(parseManifest("git head: not-a-sha (clean tree)").gitHead).toBeNull();
    expect(collectJourneys(JSON.parse(report())).map((j) => j.file)).toEqual(["intake.spec.ts", "intake.spec.ts", "sourcing-destination.spec.ts"]);
  });

  it("CLI writes verify-result.json and exits non-zero on FAIL", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "verify-judge-"));
    const evidence = path.join(dir, "local");
    mkdirSync(evidence);
    writeFileSync(path.join(evidence, "manifest.txt"), manifest());
    writeFileSync(path.join(evidence, "playwright-report.json"), report());
    const out = path.join(dir, "verify-result.json");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(main(["--expected-sha", SHA, "--features", "quote", "--out", out, evidence])).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).verdict).toBe("PASS");
    expect(main(["--expected-sha", SHA, "--features", "quote", "--out", out, evidence, path.join(dir, "fixture")])).toBe(1);
    expect(JSON.parse(readFileSync(out, "utf8")).reasons).toContain("fixture: manifest.txt missing");
    expect(write).toHaveBeenCalledWith(expect.stringContaining("verify-overdrafter: FAIL"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(["--expected-sha", SHA, "--features", "bogus", "--out", out, evidence])).toBe(2);
  });
});
