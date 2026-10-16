// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { collectJourneys, judge, main, parseManifest } from "./verify-result-judge.mjs";

const SHA = "a".repeat(40);

const manifest = ({ sha = SHA, code = 0, specs = "e2e/intake.spec.ts e2e/journeys/jarvis.spec.ts" } = {}) =>
  ["mode: local", "features: quote", `specs: ${specs}`, "command: npx playwright test", `git head: ${sha}`, `exit code: ${code}`, "verdict: PASS"].join("\n");

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
      title: "journeys/jarvis.spec.ts",
      file: "journeys/jarvis.spec.ts",
      specs: [{ title: "front door", file: "journeys/jarvis.spec.ts", tests: [test("passed")] }],
    },
  ],
  errors: [],
});

const run = (over = {}) => ({ label: "local", manifestText: manifest(), reportText: report(), ...over });

describe("verify-result-judge", () => {
  it("passes a clean run at the expected SHA", () => {
    const result = judge({ runs: [run()], expectedSha: SHA });
    expect(result.reasons).toEqual([]);
    expect(result.verdict).toBe("PASS");
    expect(result.headShas).toEqual([SHA]);
    expect(result.journeys).toHaveLength(3);
    expect(result.journeys[1].name).toBe("intake.spec.ts › intake flow › client requests a quote");
  });

  it("fails a broken journey and names it", () => {
    const result = judge({ runs: [run({ reportText: report("failed") })], expectedSha: SHA });
    expect(result.verdict).toBe("FAIL");
    expect(result.failingJourneys).toEqual(["local: intake.spec.ts › intake flow › client requests a quote (failed)"]);
  });

  it.each([
    ["skipped", "skipped"],
    ["timedOut", "timedOut"],
    ["interrupted", "cancelled"],
  ])("fails a %s journey", (status, label) => {
    const result = judge({ runs: [run({ reportText: report(status) })], expectedSha: SHA });
    expect(result.verdict).toBe("FAIL");
    expect(result.reasons).toContain(`local: ${label}: intake.spec.ts › intake flow › client requests a quote`);
  });

  it("fails test.fail() and flaky journeys instead of counting them as verified", () => {
    const expectedFailure = judge({ runs: [run({ reportText: report("failed", { expectedStatus: "failed", status: "expected" }) })], expectedSha: SHA });
    expect(expectedFailure.verdict).toBe("FAIL");
    expect(expectedFailure.failingJourneys[0]).toMatch(/expected-failure/);
    const flaky = judge({ runs: [run({ reportText: report("passed", { status: "flaky" }) })], expectedSha: SHA });
    expect(flaky.failingJourneys[0]).toMatch(/\(flaky\)$/);
  });

  it("fails on a missing report, a missing manifest or invalid JSON", () => {
    expect(judge({ runs: [run({ reportText: null })], expectedSha: SHA }).reasons).toContain("local: playwright-report.json missing");
    expect(judge({ runs: [run({ manifestText: null })], expectedSha: SHA }).reasons).toContain("local: manifest.txt missing");
    expect(judge({ runs: [run({ reportText: "{" })], expectedSha: SHA }).verdict).toBe("FAIL");
    expect(judge({ runs: [], expectedSha: SHA }).verdict).toBe("FAIL");
  });

  it("fails on a SHA mismatch or no expected SHA", () => {
    const mismatch = judge({ runs: [run({ manifestText: manifest({ sha: "b".repeat(40) }) })], expectedSha: SHA });
    expect(mismatch.verdict).toBe("FAIL");
    expect(mismatch.reasons[0]).toMatch(/SHA mismatch/);
    expect(judge({ runs: [run()], expectedSha: null }).verdict).toBe("FAIL");
  });

  it("fails when a mapped spec ran no journeys, playwright exited non-zero, or reported errors", () => {
    const missingSpec = judge({ runs: [run({ manifestText: manifest({ specs: "e2e/intake.spec.ts e2e/gone.spec.ts" }) })], expectedSha: SHA });
    expect(missingSpec.reasons).toEqual(["local: no journeys ran for e2e/gone.spec.ts"]);
    expect(judge({ runs: [run({ manifestText: manifest({ code: 1 }) })], expectedSha: SHA }).reasons).toEqual(["local: playwright exit code 1"]);
    const errored = JSON.stringify({ ...JSON.parse(report()), errors: [{ message: "webServer exited\nstack" }] });
    expect(judge({ runs: [run({ reportText: errored })], expectedSha: SHA }).reasons).toEqual(["local: playwright error: webServer exited"]);
  });

  it("parses verify.sh manifests and flattens nested suites", () => {
    expect(parseManifest(manifest())).toMatchObject({ mode: "local", gitHead: SHA, exitCode: 0, specs: ["e2e/intake.spec.ts", "e2e/journeys/jarvis.spec.ts"] });
    expect(collectJourneys(JSON.parse(report())).map((j) => j.file)).toEqual(["intake.spec.ts", "intake.spec.ts", "journeys/jarvis.spec.ts"]);
  });

  it("CLI writes verify-result.json and exits non-zero on FAIL", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "verify-judge-"));
    const evidence = path.join(dir, "local");
    mkdirSync(evidence);
    writeFileSync(path.join(evidence, "manifest.txt"), manifest());
    writeFileSync(path.join(evidence, "playwright-report.json"), report());
    const out = path.join(dir, "verify-result.json");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(main(["--expected-sha", SHA, "--out", out, evidence])).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).verdict).toBe("PASS");
    expect(main(["--expected-sha", SHA, "--out", out, evidence, path.join(dir, "fixture")])).toBe(1);
    expect(JSON.parse(readFileSync(out, "utf8")).reasons).toContain("fixture: manifest.txt missing");
    expect(write).toHaveBeenCalledWith(expect.stringContaining("verify-overdrafter: FAIL"));
  });
});
