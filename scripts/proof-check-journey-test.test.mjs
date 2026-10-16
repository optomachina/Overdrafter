// @vitest-environment node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { JOURNEY_TEST_RULE_ID, checkJourneyTest } from "./proof-check.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtures = path.join(repoRoot, "scripts", "fixtures", "proof-check");
const scriptPath = path.join(repoRoot, "scripts", "proof-check.mjs");
const uiFiles = ["src/components/QuoteTable.tsx", "src/index.css"];
const runUrl = "https://github.com/optomachina/Overdrafter/actions/runs/1234567890";

function body(proof) {
  const section = proof === undefined ? "" : `## Proof\n\n${proof}\n\n`;
  return `## Summary\n\nChanges a thing.\n\n${section}## Tests\n\nNone.\n`;
}

describe("checkJourneyTest", () => {
  it("uses its own rule id", () => {
    expect(JOURNEY_TEST_RULE_ID).toBe("journey-test");
    expect(checkJourneyTest(body(), uiFiles).rule).toBe("journey-test");
  });

  it("fails a UI change without a journey test reference", () => {
    const result = checkJourneyTest(body("- Screenshot: https://example.com/table.png"), uiFiles);
    expect(result.status).toBe("fail");
    expect(result.reasons[0]).toMatch(/no journey test reference/);
    expect(result.reasons).toContain("user-facing files: src/components/QuoteTable.tsx, src/index.css");
  });

  it("fails a UI change with no Proof section", () => {
    const result = checkJourneyTest(body(), uiFiles);
    expect(result.status).toBe("fail");
    expect(result.reasons[0]).toBe('user-facing change has no "## Proof" section to reference a journey test');
  });

  it("does not count a reference that sits only in an HTML comment", () => {
    expect(checkJourneyTest(body("<!-- - Test: e2e/journeys/quote.spec.ts -->"), uiFiles).status).toBe("fail");
  });

  it("does not count other e2e specs or lookalike paths", () => {
    for (const proof of [
      "- Test: e2e/quote-flow.spec.ts",
      "- Test: tools/e2e/journeys/quote.spec.ts",
      "- Test: e2e/journeys/quote.spec.tsx",
      "- Test: e2e/journeys/../quote.spec.ts",
    ]) {
      expect(checkJourneyTest(body(proof), uiFiles).status, proof).toBe("fail");
    }
  });

  it("passes a UI change that references an e2e/journeys spec path", () => {
    expect(checkJourneyTest(body("- Test: `e2e/journeys/quote-request.spec.ts`"), uiFiles)).toEqual({
      rule: "journey-test",
      status: "pass",
      reasons: ["journey spec: e2e/journeys/quote-request.spec.ts"],
    });
  });

  it("requires the spec to be in the diff or the repository when existsInRepo is given", () => {
    const proof = "- Test: e2e/journeys/quote-request.spec.ts";
    const missing = checkJourneyTest(body(proof), uiFiles, { existsInRepo: () => false });
    expect(missing.status).toBe("fail");
    expect(missing.reasons).toContain('journey spec "e2e/journeys/quote-request.spec.ts" is not in the diff or the repository');

    const inDiff = checkJourneyTest(body(proof), [...uiFiles, "e2e/journeys/quote-request.spec.ts"], { existsInRepo: () => false });
    expect(inDiff.status).toBe("pass");
  });

  it("passes a UI change that links a GitHub Actions run", () => {
    expect(checkJourneyTest(body(`- Live: ${runUrl} (journey e2e run)`), uiFiles)).toEqual({
      rule: "journey-test",
      status: "pass",
      reasons: [`journey run: ${runUrl}`],
    });
    expect(checkJourneyTest(body("- Live: https://github.com/someone/else/actions/runs/1"), uiFiles).status).toBe("fail");
  });

  it("does not apply to a change without user-facing files", () => {
    expect(checkJourneyTest(body(), ["scripts/proof-check.mjs", "src/lib/format.ts"])).toEqual({
      rule: "journey-test",
      status: "not-applicable",
      reasons: ["no user-facing files (src/**/*.tsx or src/**/*.css) changed"],
    });
  });

  it("exempts a docs-only change", () => {
    expect(checkJourneyTest(body(), ["docs/DESIGN.md", "README.md"])).toEqual({
      rule: "journey-test",
      status: "exempt",
      reasons: ["every changed file is under docs/ or is a .md file"],
    });
  });
});

describe("proof-check CLI reports the journey-test rule", () => {
  function run(env) {
    return spawnSync(process.execPath, [scriptPath, "--changed-files", path.join(fixtures, "changed-files-ui.txt")], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...env },
    });
  }

  const passingProof = "- Screenshot: https://example.com/table.png";

  it("reports both rules and fails enforce mode when only the journey rule fails", () => {
    const enforce = run({ PROOF_CHECK_MODE: "enforce", PR_BODY: body(passingProof) });
    expect(enforce.status).toBe(1);
    expect(enforce.stdout).toContain("### Proof check: PASS");
    expect(enforce.stdout).toContain("### Journey test check (journey-test): FAIL");

    const report = run({ PROOF_CHECK_MODE: "report", PR_BODY: body(passingProof) });
    expect(report.status).toBe(0);
    expect(report.stdout).toContain("### Journey test check (journey-test): FAIL");
    expect(report.stdout).toContain("Report mode: this result does not fail the job.");
  });

  it("passes enforce mode when both rules pass", () => {
    const result = run({ PROOF_CHECK_MODE: "enforce", PR_BODY: body(`${passingProof}\n- Live: ${runUrl}`) });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("### Journey test check (journey-test): PASS");
  });
});
