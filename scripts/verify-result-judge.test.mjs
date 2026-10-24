// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CONFIG_TEST_DIRS, specsFor } from "../.agents/skills/verify-overdrafter/scripts/feature-specs.mjs";
import { collectJourneys, expectedConfigRuns, formatSummary, judge, main, parseManifest } from "./verify-result-judge.mjs";

const SHA = "a".repeat(40);
const FEATURES = ["quote"];

// Same lines verify.sh writes; scripts/verify-overdrafter-skill.test.mjs feeds a
// manifest produced by verify.sh itself through the judge.
const manifest = ({
  sha = SHA, tree = "clean", codes = "0", verdict = "PASS", mode = "local", features = "quote",
  specs = "e2e/intake.spec.ts e2e/sourcing-destination.spec.ts e2e/journeys/friends-release-golden.spec.ts", configs = "playwright.config.ts", skipped = "none",
} = {}) =>
  [
    `mode: ${mode}`, `features: ${features}`, `skipped features: ${skipped}`, `specs: ${specs}`, `configs: ${configs}`, "command: npx playwright test",
    `git head: ${sha} (${tree} tree)`, `exit codes: ${codes}`, "tests: passed=4 failed=0 skipped=0 expectedFail=0 flaky=0", `verdict: ${verdict}`,
  ].join("\n");

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
    {
      title: "journeys/friends-release-golden.spec.ts",
      file: "journeys/friends-release-golden.spec.ts",
      specs: [{ title: "upload, edit, compare and inspect without ordering", file: "journeys/friends-release-golden.spec.ts", tests: [test("passed")] }],
    },
  ],
  errors: [],
});

const run = ({ reportText = report(), ...over } = {}) => ({
  label: "local",
  manifestText: manifest(),
  reports: reportText == null ? {} : { "playwright-report-0.json": reportText },
  ...over,
});
const judgeOne = (over = {}, opts = {}) => judge({ runs: [run(over)], expectedSha: SHA, features: FEATURES, ...opts });

describe("verify-result-judge", () => {
  it("passes a clean run at the expected SHA", () => {
    const result = judgeOne();
    expect(result.reasons).toEqual([]);
    expect(result.verdict).toBe("PASS");
    expect(result.headShas).toEqual([SHA]);
    expect(result.journeys).toHaveLength(4);
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
    expect(judgeOne({ reportText: null }).reasons).toContain("local: playwright-report-0.json missing (playwright.config.ts)");
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
    expect(dropped.reasons).toEqual(["local: manifest specs differ from the base feature map (e2e/intake.spec.ts e2e/sourcing-destination.spec.ts e2e/journeys/friends-release-golden.spec.ts)"]);
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
    expect(judgeOne({ reportText: noJourneys }).reasons).toEqual([
      "local: no journeys ran for e2e/sourcing-destination.spec.ts",
      "local: no journeys ran for e2e/journeys/friends-release-golden.spec.ts",
    ]);
    expect(judgeOne({ manifestText: manifest({ codes: "1", verdict: "FAIL" }) }).reasons).toEqual([
      "local: playwright exit codes 1",
      "local: verify.sh verdict FAIL",
    ]);
    const errored = JSON.stringify({ ...JSON.parse(report()), errors: [{ message: "webServer exited\nstack" }] });
    expect(judgeOne({ reportText: errored }).reasons).toEqual(["local: playwright error (playwright.config.ts): webServer exited"]);
  });

  it("fails an INCOMPLETE verify.sh verdict, missing exit codes and drifting configs", () => {
    expect(judgeOne({ manifestText: manifest({ verdict: "INCOMPLETE" }) }).reasons).toEqual(["local: verify.sh verdict INCOMPLETE"]);
    expect(judgeOne({ manifestText: manifest({ codes: "" }) }).reasons).toEqual(["local: playwright exit codes missing"]);
    expect(judgeOne({ manifestText: manifest({ configs: "e2e/admin-operations.config.ts" }) }).reasons).toEqual([
      "local: manifest configs differ from the base feature map (playwright.config.ts)",
    ]);
  });

  it("requires one report per config in the feature map and rejects extra reports", () => {
    expect(expectedConfigRuns(["provider"], "fixture")).toEqual([
      { config: "e2e/admin-operations.config.ts", specs: ["e2e/admin-operations.spec.ts"], report: "playwright-report-0.json" },
      { config: "playwright.config.ts", specs: ["e2e/engineering-admin-route.spec.ts"], report: "playwright-report-1.json" },
    ]);
    const suite = (file) => ({ title: file, file, specs: [{ title: "journey", file, tests: [test("passed")] }] });
    const provider = (reports, codes = "0 0") => judge({
      runs: [{
        label: "fixture",
        manifestText: manifest({
          mode: "fixture", features: "provider", codes,
          specs: "e2e/admin-operations.spec.ts e2e/engineering-admin-route.spec.ts",
          configs: "e2e/admin-operations.config.ts playwright.config.ts",
        }),
        reports,
      }],
      expectedSha: SHA,
      features: ["provider"],
    });
    const admin = JSON.stringify({ suites: [suite("admin-operations.spec.ts")], errors: [] });
    const rest = JSON.stringify({ suites: [suite("engineering-admin-route.spec.ts")], errors: [] });
    const ok = provider({ "playwright-report-0.json": admin, "playwright-report-1.json": rest });
    expect(ok.reasons).toEqual([]);
    expect(ok.journeys.map((j) => j.config)).toEqual(["e2e/admin-operations.config.ts", "playwright.config.ts"]);
    expect(provider({ "playwright-report-0.json": admin }).reasons).toEqual(["fixture: playwright-report-1.json missing (playwright.config.ts)"]);
    // A spec that only ran under the wrong config does not count.
    expect(provider({ "playwright-report-0.json": rest, "playwright-report-1.json": admin }).reasons).toEqual([
      "fixture: no journeys ran for e2e/admin-operations.spec.ts",
      "fixture: no journeys ran for e2e/engineering-admin-route.spec.ts",
    ]);
    expect(provider({ "playwright-report-0.json": admin, "playwright-report-1.json": rest, "playwright-report-2.json": rest }).reasons).toEqual([
      "fixture: unexpected report playwright-report-2.json",
    ]);
    expect(provider({ "playwright-report-0.json": admin, "playwright-report-1.json": rest }, "0").reasons).toEqual(["fixture: playwright exit codes 0"]);
  });

  // What verify.sh writes for a clean run of `features` in `mode` per the feature map.
  const cleanRun = (features, mode, skipped = "none") => {
    const runs = expectedConfigRuns(features, mode);
    const suite = (spec, config) => {
      const file = path.posix.relative(CONFIG_TEST_DIRS[config], spec);
      return { title: file, file, specs: [{ title: "journey", file, tests: [test("passed")] }] };
    };
    return {
      label: mode,
      manifestText: manifest({
        mode, features: features.join(","), skipped, codes: runs.map(() => "0").join(" "),
        specs: specsFor(features, mode).map((x) => x.spec).join(" "), configs: runs.map((r) => r.config).join(" "),
      }),
      reports: Object.fromEntries(runs.map((r) => [r.report, JSON.stringify({ suites: r.specs.map((sp) => suite(sp, r.config)), errors: [] })])),
    };
  };
  const DEFAULT = ["auth", "quote", "provider"];

  it("judges the workflow default (auth,quote,provider in fixture and local) without a structural FAIL", () => {
    const result = judge({
      runs: [cleanRun(DEFAULT, "fixture"), cleanRun(DEFAULT, "local", "provider (SKIPPED: no local specs)")],
      expectedSha: SHA,
      features: DEFAULT,
    });
    expect(result.reasons).toEqual([]);
    expect(result.verdict).toBe("PASS");
    expect(result.skippedFeatures).toEqual(["local: provider (SKIPPED: no local specs)"]);
    expect(result.runs.map((r) => r.skipped)).toEqual([[], ["provider"]]);
    // The skipped feature contributes no journeys and is not counted as passing.
    expect(result.journeys.filter((j) => j.mode === "local").map((j) => j.file)).toEqual([
      "smoke.spec.ts", "access-scope.spec.ts", "intake.spec.ts", "sourcing-destination.spec.ts",
      "journeys/friends-release-golden.spec.ts",
    ]);
  });

  it("fails when the manifest's skipped features differ from the base feature map", () => {
    const local = cleanRun(DEFAULT, "local", "none");
    expect(judge({ runs: [local], expectedSha: SHA, features: DEFAULT }).reasons).toEqual([
      "local: manifest skipped features none, expected provider",
    ]);
    const noLine = { ...local, manifestText: local.manifestText.replace(/^skipped features: .*\n/m, "") };
    expect(judge({ runs: [noLine], expectedSha: SHA, features: DEFAULT }).reasons).toEqual([
      "local: manifest skipped features missing, expected provider",
    ]);
  });

  it("fails provider-only in local mode and any selection with zero specs", () => {
    const providerLocal = judge({ runs: [{ label: "local", manifestText: null, reports: {} }], expectedSha: SHA, features: ["provider"] });
    expect(providerLocal.verdict).toBe("FAIL");
    expect(providerLocal.reasons).toContain("local: feature provider has no local specs");
    expect(providerLocal.reasons).toContain("no specs selected across the run");
    expect(judge({ runs: [], expectedSha: SHA, features: DEFAULT }).reasons).toContain("no specs selected across the run");
    expect(judge({ runs: [cleanRun(["quote"], "local")], expectedSha: SHA, features: [] }).verdict).toBe("FAIL");
  });

  it("matches report files against the config's testDir, not by suffix", () => {
    const fixture = cleanRun(["provider"], "fixture");
    // journeys/engineering-admin-route.spec.ts relative to e2e/ is e2e/journeys/..., not the mapped e2e/ spec.
    const moved = fixture.reports["playwright-report-1.json"].replaceAll("engineering-admin-route.spec.ts", "journeys/engineering-admin-route.spec.ts");
    const result = judge({ runs: [{ ...fixture, reports: { ...fixture.reports, "playwright-report-1.json": moved } }], expectedSha: SHA, features: ["provider"] });
    expect(result.reasons).toEqual(["fixture: no journeys ran for e2e/engineering-admin-route.spec.ts"]);
  });

  it("lists pending specs (OVD-805) without running them or counting them as passing", () => {
    const result = judge({ runs: [cleanRun(["provider"], "fixture")], expectedSha: SHA, features: ["provider"] });
    expect(result.verdict).toBe("PASS");
    expect(result.pendingSpecs).toEqual([
      "fixture: provider e2e/journeys/jarvis-front-door.spec.ts (OVD-805: journey is test.fail() until OVD-805 adds the public Jarvis link)",
    ]);
    expect(result.journeys.map((j) => j.file)).toEqual(["admin-operations.spec.ts", "engineering-admin-route.spec.ts"]);
    expect(formatSummary(result)).toContain("### Pending (not run, not counted as passing)\n- fixture: provider e2e/journeys/jarvis-front-door.spec.ts (OVD-805");
    // Only for requested features and judged modes.
    expect(judgeOne().pendingSpecs).toEqual([]);
    expect(judge({ runs: [cleanRun(DEFAULT, "local", "provider (SKIPPED: no local specs)")], expectedSha: SHA, features: DEFAULT }).pendingSpecs).toEqual([]);
  });

  it("still fails a test.fail() journey from a pending spec if it runs anyway", () => {
    const fixture = cleanRun(["provider"], "fixture");
    const rest = JSON.parse(fixture.reports["playwright-report-1.json"]);
    const file = "journeys/jarvis-front-door.spec.ts";
    rest.suites.push({ title: file, file, specs: [{ title: "front door", file, tests: [test("failed", { expectedStatus: "failed", status: "expected" })] }] });
    const result = judge({ runs: [{ ...fixture, reports: { ...fixture.reports, "playwright-report-1.json": JSON.stringify(rest) } }], expectedSha: SHA, features: ["provider"] });
    expect(result.verdict).toBe("FAIL");
    expect(result.reasons).toEqual(["fixture: expected-failure: journeys/jarvis-front-door.spec.ts › front door"]);
  });

  it("parses verify.sh manifests and flattens nested suites", () => {
    expect(parseManifest(manifest({ codes: "0 1" }))).toMatchObject({
      mode: "local", gitHead: SHA, tree: "clean", exitCodes: [0, 1], verdict: "PASS", skipped: [],
      specs: ["e2e/intake.spec.ts", "e2e/sourcing-destination.spec.ts", "e2e/journeys/friends-release-golden.spec.ts"], configs: ["playwright.config.ts"],
    });
    expect(parseManifest(manifest({ tree: "dirty" })).tree).toBe("dirty");
    expect(parseManifest(manifest({ skipped: "provider (SKIPPED: no local specs)" })).skipped).toEqual(["provider"]);
    expect(parseManifest("mode: local").skipped).toBeNull();
    expect(parseManifest("git head: not-a-sha (clean tree)").gitHead).toBeNull();
    expect(collectJourneys(JSON.parse(report())).map((j) => j.file)).toEqual(["intake.spec.ts", "intake.spec.ts", "sourcing-destination.spec.ts", "journeys/friends-release-golden.spec.ts"]);
  });

  it("CLI writes verify-result.json and exits non-zero on FAIL", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "verify-judge-"));
    const evidence = path.join(dir, "local");
    mkdirSync(evidence);
    writeFileSync(path.join(evidence, "manifest.txt"), manifest());
    writeFileSync(path.join(evidence, "playwright-report-0.json"), report());
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
