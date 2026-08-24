// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readRootFile = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("1.0 multi-provider release contract", () => {
  it("pins all 12 named providers as the hard release gate", () => {
    const readme = readRootFile("README.md");
    const prd = readRootFile("PRD.md");
    const plan = readRootFile("PLAN.md");
    const roadmap = readRootFile("ROADMAP.md");
    const architecture = readRootFile("ARCHITECTURE.md");
    const tests = readRootFile("TEST_STRATEGY.md");
    const acceptance = readRootFile("ACCEPTANCE_CRITERIA.md");
    const runbook = readRootFile("docs/1-0-beta-runbook.md");
    const betaProgram = readRootFile("docs/founding-beta-program.md");
    const operations = readRootFile("RUNBOOK.md");
    const workerReadme = readRootFile("worker/README.md");
    const normalizedWorkerReadme = workerReadme.replace(/\s+/g, " ");
    const normalizedRunbook = runbook.replace(/\s+/g, " ");

    for (const source of [
      readme,
      prd,
      plan,
      roadmap,
      architecture,
      tests,
      acceptance,
      runbook,
      betaProgram,
    ]) {
      expect(source).toMatch(/Xometry/i);
      expect(source).toMatch(/production-certified/i);
      expect(source).toMatch(/all 12|12-provider/i);
      expect(source).toMatch(/evaluation-only/i);
      expect(source).toMatch(/disabled/i);
      expect(source).toMatch(/link-only/i);
      expect(source).toMatch(/manual-only/i);
    }

    const namedProviderContracts = [prd, plan, architecture, tests, acceptance, runbook];
    const providers = [
      "Quickparts",
      "Weerg",
      "Geomiq",
      "RapidDirect",
      "Protolabs Network",
      "Fabworks",
      "OSH Cut",
      "Ponoko",
      "SendCutSend",
      "Protolabs",
      "eMachineShop",
      "Xometry",
    ];
    const normalizedPrd = prd.replace(/\s+/g, " ");
    const launchProviderList = normalizedPrd.match(
      /customer-enabled: (.*?)\. Xometry is the security and certification baseline/,
    );
    expect(launchProviderList?.[1]).toBeDefined();
    const parsedLaunchProviders = launchProviderList?.[1]
      .replace(/, and /g, ", ")
      .split(", ");
    expect(parsedLaunchProviders).toEqual(providers);

    for (const source of namedProviderContracts) {
      const normalizedSource = source.replace(/\s+/g, " ");
      for (const provider of providers) {
        if (provider === "Protolabs") {
          expect(normalizedSource).toMatch(/\bProtolabs\b(?! Network)/);
          continue;
        }

        expect(normalizedSource).toContain(provider);
      }
    }

    const combinedContract = [prd, plan, roadmap, acceptance, runbook, betaProgram].join(
      "\n",
    );
    expect(combinedContract).not.toMatch(/at least three production-certified/i);
    expect(combinedContract).not.toMatch(/five functioning sources/i);
    expect(combinedContract).not.toMatch(/Xometry and at least two additional/i);
    expect(acceptance).toContain(
      "provider lanes beyond the admitted and production-certified 1.0 release set",
    );
    expect(prd).toContain("certifies platform readiness, not universal eligibility");
    expect(normalizedRunbook).toContain(
      "does not claim that every provider can quote the same part",
    );
    expect(normalizedRunbook).toContain(
      "do not widen this Founding Beta's CNC-milled aluminum 6061-T6",
    );
    expect(operations).toContain("Xometry-only worker is not a releasable 1.0 configuration");
    expect(normalizedWorkerReadme).toContain("not a releasable 1.0 worker");
    expect(betaProgram).toContain("Hard cap: 120 automatic-provider runs");
    expect(betaProgram).toContain("without thinning a request's");
    expect(plan).not.toMatch(/twenty automatic-provider runs/i);
  });

  it("keeps Xometry as the baseline without treating it as the full release", () => {
    const architecture = readRootFile("ARCHITECTURE.md");
    const tests = readRootFile("TEST_STRATEGY.md");
    const runbook = readRootFile("docs/1-0-beta-runbook.md");

    expect(architecture).toContain("As-built Xometry Phase 1 vendor boundary");
    expect(architecture).toContain("Provider-neutral 1.0 target");
    expect(tests).toContain("provider-neutral regression baseline");
    expect(runbook).toContain("Multi-provider release gate");
  });

  it("records completed prerequisites and the active authentication gate", () => {
    const plan = readRootFile("PLAN.md");
    const runbook = readRootFile("docs/1-0-beta-runbook.md");

    expect(plan).toContain("Completed prerequisite: `OVD-359`");
    expect(plan).toContain("Completed prerequisite: `OVD-408`");
    expect(plan).toContain("In-progress prerequisite: `OVD-410`");
    expect(plan).toContain(
      "This becomes the primary production-certification task only after",
    );
    expect(plan).not.toContain("This is the current primary production-certification task");
    expect(plan).not.toContain("keep blocked behind `OVD-359`");
    expect(runbook).toContain("`OVD-359` and both children are closed");
  });

  it("requires admission, action-time confirmation, and no-purchase safety", () => {
    const contract = [
      readRootFile("PRD.md"),
      readRootFile("ARCHITECTURE.md"),
      readRootFile("docs/1-0-beta-runbook.md"),
    ].join("\n");

    expect(contract).toMatch(/admission/i);
    expect(contract).toMatch(/confirmation/i);
    expect(contract).toMatch(/immediate(?:ly)? .*pre-adapter|immediate worker/i);
    expect(contract).toMatch(
      /no-order|no authority to place|without manufacturing-order authority/i,
    );
  });

  it("drives live offers and buyer handoff from admitted provider policy", () => {
    const architecture = readRootFile("ARCHITECTURE.md");
    const tests = readRootFile("TEST_STRATEGY.md");

    expect(architecture).toContain(
      "currently admitted and production-certified",
    );
    expect(architecture).toContain("reviewed destination-domain allowlist");
    expect(tests).toContain("current admitted and production-certified");
    expect(tests).toContain("reviewed domain allowlist");
    expect(architecture).not.toContain(
      "only successful Xometry or Fictiv live-adapter offers",
    );
  });

  it("links the operational provider readiness evidence register", () => {
    const runbook = readRootFile("docs/1-0-beta-runbook.md");

    expect(runbook).toContain(
      "https://linear.app/overdrafter/document/founding-beta-provider-readiness-and-admission-matrix-75a9239a3092",
    );
    expect(runbook).toContain("operational evidence register");
  });
});
