// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readRootFile = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("1.0 multi-provider release contract", () => {
  it("pins the hard five-provider release minimum in canonical docs", () => {
    const prd = readRootFile("PRD.md");
    const plan = readRootFile("PLAN.md");
    const roadmap = readRootFile("ROADMAP.md");
    const acceptance = readRootFile("ACCEPTANCE_CRITERIA.md");
    const readme = readRootFile("README.md");
    const runbook = readRootFile("docs/1-0-beta-runbook.md");
    const foundingBeta = readRootFile("docs/founding-beta-program.md");

    for (const source of [
      prd,
      plan,
      roadmap,
      acceptance,
      readme,
      runbook,
      foundingBeta,
    ]) {
      expect(source).toMatch(/production-\s*certified/i);
      expect(source).toMatch(/at least (five|four\s+additional)/i);
      expect(source).not.toMatch(/five preferred/i);
      expect(source).not.toMatch(/at least three automatic quote/i);
    }

    for (const source of [prd, plan, acceptance, readme, runbook, foundingBeta]) {
      expect(source).toMatch(/Xometry/i);
    }

    expect(prd).toContain(
      "Launch sources:** at least five independently admitted and production-",
    );
    expect(plan).toContain(
      "trustworthy, comparable quote decisions from at least five independently",
    );
    expect(acceptance).toContain(
      "Xometry and at least four additional automatic quote providers",
    );
    expect(runbook).toContain("Xometry plus at least four");
    expect(roadmap).toContain(
      "Release requires at least five independently admitted and production-",
    );
    expect(foundingBeta).toContain(
      "At least five automatic quote sources—Xometry plus at least four additional",
    );
    for (const source of [plan, acceptance, runbook, foundingBeta]) {
      expect(source).toMatch(
        /at\s+least\s+one\s+unaided\s+eligible\s+participant\s+attempt/i,
      );
      expect(source).toMatch(
        /every (?:member|provider)[\s\S]{0,80}five-provider\s+launch\s+set/i,
      );
    }
    expect(acceptance).toContain(
      "provider lanes beyond the required, named, at-least-five admitted and",
    );
  });

  it("routes provider expansion to 1.1 and monetization to 1.2 consistently", () => {
    const prd = readRootFile("PRD.md");
    const plan = readRootFile("PLAN.md");
    const roadmap = readRootFile("ROADMAP.md");
    const acceptance = readRootFile("ACCEPTANCE_CRITERIA.md");
    const readme = readRootFile("README.md");
    const runbook = readRootFile("docs/1-0-beta-runbook.md");
    const soloWorkflow = readRootFile("docs/workflows/solo-linear-workflow.md");

    expect(roadmap).toContain("### 1.1 — Provider Expansion and Quote Reliability");
    expect(roadmap).toContain("### 1.2 — Monetization and First Paid Pilot");
    expect(prd).toContain("Planned 1.1 provider-expansion decisions");
    expect(prd).toContain("Planned 1.2 commercial decisions");
    expect(prd).not.toContain("activation are a 1.1 decision");
    expect(prd).not.toContain("requires a 1.1 pricing");
    expect(plan).not.toContain("1.1 billing decision");
    expect(acceptance).not.toContain("collecting revenue is a 1.1 milestone");
    expect(acceptance).not.toContain("paid customer remains a 1.1 decision");
    expect(readme).not.toContain("belong to 1.1 after 1.0 proves value");
    expect(readme).not.toContain("unapproved 1.1 hypotheses");
    expect(runbook).not.toContain("unapproved 1.1 hypotheses");
    expect(soloWorkflow).not.toContain("belongs in the 1.1 release description");
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

  it("records completed prerequisites and the active release gate", () => {
    const plan = readRootFile("PLAN.md");
    const runbook = readRootFile("docs/1-0-beta-runbook.md");
    const handoff = readRootFile(
      "docs/release/ovd-419-contained-live-handoff.json",
    );

    expect(plan).toContain("Completed prerequisite: `OVD-359`");
    expect(plan).toContain("Completed prerequisite: `OVD-408`");
    expect(plan).toContain("Completed prerequisite: `OVD-410`");
    expect(plan).toContain("Next: `OVD-419`");
    expect(plan).toContain("offline bounded-evidence improvement");
    expect(plan).toContain("This plan does not authorize another controller");
    expect(plan).toContain("`OVD-199`: keep `Blocked`");
    expect(plan).toContain(
      "This becomes the primary production-certification task only after",
    );
    expect(plan).not.toContain("This is the current primary production-certification task");
    expect(plan).not.toContain("keep blocked behind `OVD-359`");
    expect(runbook).toContain("`OVD-359` and both children are closed");
    expect(handoff).toContain('"probeExecutionIdIndependentlyObserved": false');
    expect(handoff).toContain('"cloudRunProbeExecutionAcceptance": "unknown"');
    expect(handoff).toContain('"notReachedByController": [\n      "ordinal-2 probe"\n    ]');
    expect(handoff).not.toContain("probeExecutionAcceptedByFailedController");
    expect(handoff).not.toContain('"cloudRunAcceptedProbeExecution": false');
    expect(handoff).not.toContain('"post-probe containment"');
    expect(readRootFile("docs/workflows/ovd419-final-digest-release.md")).toContain(
      "still invoked its mandatory final inventory and containment evaluation",
    );
  });

  it("keeps a twenty-run default cap and requires a separately approved higher-cap experiment", () => {
    const plan = readRootFile("PLAN.md");
    const acceptance = readRootFile("ACCEPTANCE_CRITERIA.md");
    const foundingBeta = readRootFile("docs/founding-beta-program.md");

    for (const source of [plan, acceptance, foundingBeta]) {
      expect(source).toMatch(/twenty\s+automatic-provider runs/i);
      expect(source).toMatch(/separately\s+approved\s+experiment/i);
      expect(source).toMatch(/before\s+participant\s+activation/i);
    }

    expect(foundingBeta).toMatch(/default cap: twenty/i);
    expect(foundingBeta).not.toMatch(/hard cap: twenty/i);
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
