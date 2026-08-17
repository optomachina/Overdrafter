// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readRootFile = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("1.0 multi-provider release contract", () => {
  it("pins the release minimum and preferred provider target in canonical docs", () => {
    const prd = readRootFile("PRD.md");
    const plan = readRootFile("PLAN.md");
    const acceptance = readRootFile("ACCEPTANCE_CRITERIA.md");
    const runbook = readRootFile("docs/1-0-beta-runbook.md");

    for (const source of [prd, plan, acceptance, runbook]) {
      expect(source).toMatch(/at least (three|two\s+additional)/i);
      expect(source).toMatch(/five (functioning sources|preferred)/i);
    }

    expect(prd).not.toContain("additional automatic providers");
    expect(plan).not.toContain("additional automatic vendor integrations");
    expect(acceptance).not.toContain("additional automatic vendor lanes");
    expect(acceptance).toContain(
      "provider lanes beyond the admitted and production-certified 1.0 release set",
    );
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

  it("records the completed safety prerequisite and current certification task", () => {
    const plan = readRootFile("PLAN.md");
    const runbook = readRootFile("docs/1-0-beta-runbook.md");

    expect(plan).toContain("Completed prerequisite: `OVD-359`");
    expect(plan).toContain("current primary production-certification task");
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
