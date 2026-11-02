// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readRootFile = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("1.0 multi-provider release contract", () => {
  it("pins the four-provider 1.0 launch set and process-specific release proof", () => {
    const prd = readRootFile("PRD.md");
    const plan = readRootFile("PLAN.md");
    const roadmap = readRootFile("ROADMAP.md");
    const acceptance = readRootFile("ACCEPTANCE_CRITERIA.md");
    const readme = readRootFile("README.md");
    const runbook = readRootFile("docs/1-0-beta-runbook.md");
    const foundingBeta = readRootFile("docs/founding-beta-program.md");

    const currentContracts = [
      prd,
      plan,
      roadmap,
      acceptance,
      readme,
      runbook,
      foundingBeta,
    ];
    // Blaine's October 20, 2026 decision: 1.0 ships with Xometry, Fictiv and Quickparts (CNC) and
    // RMFG (sheet metal); Weerg, Geomiq and OSH Cut are 1.1. Every contract still names all seven
    // so the 1.1 deferral stays explicit, and states the four-provider minimum in its own words.
    const fourProviderSet =
      /\bfour\b[\s\S]{0,80}?independently\s+admitted\s+and\s+production-\s*certified|all\s+four\s+(?:providers\s+are\s+independently\s+admitted|qualify)|Four\s+automatic\s+quote\s+sources\s+must\s+be\s+independently\s+admitted/i;
    // PLAN keeps the superseded September 4 and September 28 decisions as dated history under the
    // decision-log heading; only the wording above that heading is the current contract.
    const decisionLogIndex = plan.indexOf("## Decision log");
    expect(decisionLogIndex).toBeGreaterThan(0);
    const planCurrent = plan.slice(0, decisionLogIndex);
    const currentWording = [
      prd,
      planCurrent,
      roadmap,
      acceptance,
      readme,
      runbook,
      foundingBeta,
    ];

    for (const source of currentContracts) {
      for (const provider of [
        "Xometry",
        "Fictiv",
        "Quickparts",
        "Weerg",
        "Geomiq",
        "RMFG",
        "OSH Cut",
      ]) {
        expect(source).toContain(provider);
      }
      expect(source).toMatch(fourProviderSet);
      expect(source).toMatch(/Weerg,\s+Geomiq\s+and\s+OSH\s+Cut\s+are\s+1\.1/);
      expect(source).toMatch(/CNC/i);
      expect(source).toMatch(/process-specific|applicable process/i);
      expect(source).toMatch(/production-\s*certified/i);
      expect(source).not.toMatch(/complete five-provider launch set/i);
      expect(source).not.toMatch(/five\s+preferred/i);
      expect(source).not.toMatch(
        /at\s+least\s+(?:two|three)(?:\s+(?:additional|independently))?(?:\s+production-\s*certified)?\s+(?:automatic\s+)?quote\s+(?:sources|providers)/i,
      );
    }

    for (const source of currentWording) {
      expect(source).not.toMatch(
        /at\s+least\s+five\s+(?:eligible|independently|CNC-qualified|qualifying|production-\s*certified|automatic)/i,
      );
      expect(source).not.toMatch(/at\s+least\s+four\s+additional/i);
      expect(source).not.toMatch(
        /seven-provider\s+(?:1\.0|beta)|seven\s+named\s+1\.0|all\s+seven\s+named|beyond\s+the\s+(?:seven|named\s+seven)/i,
      );
      expect(source).not.toMatch(/Quickparts,\s+Weerg,\s+Geomiq,\s+RMFG,?\s+and\s+OSH\s+Cut/i);
    }

    for (const source of [prd, plan, acceptance, readme, runbook, foundingBeta]) {
      expect(source).toMatch(/Xometry/i);
    }

    expect(prd).toMatch(
      /Completion:\*\*\s+all\s+four\s+named\s+providers[\s\S]*?proves\s+Xometry,\s+Fictiv\s+and\s+Quickparts[\s\S]*?proves\s+RMFG/,
    );
    expect(plan).toMatch(
      /from\s+the\s+four\s+independently\s+admitted\s+and\s+production-certified,\s+package-eligible\s+sources/,
    );
    expect(acceptance).toMatch(/Xometry,\s+Fictiv\s+and\s+Quickparts\s+are\s+independently\s+admitted\s+and\s+production-certified\s+for\s+the\s+same\s+CNC\s+validation\s+envelope,\s+and\s+RMFG\s+for\s+the\s+sheet-metal\s+validation\s+envelope/);
    expect(runbook).toContain("1.0 ships only when all four providers are independently admitted");
    expect(roadmap).toMatch(
      /CNC-first comparison requires\s+Xometry,\s+Fictiv\s+and\s+Quickparts\s+to\s+return\s+current\s+live\s+offers/,
    );
    expect(foundingBeta).toContain(
      "Four automatic quote sources must be independently admitted and",
    );
    for (const source of [plan, acceptance, runbook, foundingBeta]) {
      expect(source).toMatch(
        /at\s+least\s+one\s+unaided\s+eligible\s+CNC\s+participant\s+attempt[\s\S]{0,140}current,\s+independently\s+traceable\s+live\s+offer[\s\S]{0,160}each\s+of\s+Xometry,\s+Fictiv\s+and\s+Quickparts[\s\S]{0,120}same\s+disclosed\s+package\s+and\s+scope/i,
      );
    }
    expect(acceptance).toMatch(/provider lanes beyond the four named 1\.0 providers/i);
    expect(plan).toMatch(/RapidDirect is outside the named 1\.0\s+portfolio and is not a release gate/i);
    expect(plan).toContain("### October 20, 2026 — Four-provider 1.0 launch set");
    expect(plan).toContain("### September 28, 2026 — Seven-provider 1.0 portfolio (superseded)");
    expect(plan).toContain("September 4, 2026 — Five-provider launch contract (superseded)");
    expect(plan.indexOf("### October 20, 2026")).toBeLessThan(plan.indexOf("### September 28, 2026"));
    expect(acceptance).toMatch(/Account existence,[\s\S]*?source integration,[\s\S]*?live quote verification,[\s\S]*?production certification/);

    // The reviewed provider data carries the same decision: the permissions matrix `in_1_0` flags
    // and the registry `oneDotZero` list (compared by scripts/provider-permissions-check.mjs) name
    // exactly the four launch providers, and the 1.1 providers stay in the matrix as not in 1.0.
    const launchKeys = ["fictiv", "quickparts", "rmfg", "xometry"];
    const matrix = JSON.parse(readRootFile("docs/providers/permissions-matrix.v1.json")) as {
      providers: { key: string; in_1_0: boolean; enabled_for_paid_automation: boolean }[];
    };
    const registry = JSON.parse(readRootFile("provider-integrations/provider-registry.v1.json")) as {
      oneDotZero: string[];
    };
    expect(matrix.providers.filter((row) => row.in_1_0).map((row) => row.key).sort()).toEqual(launchKeys);
    expect(registry.oneDotZero).toEqual(launchKeys);
    for (const key of ["geomiq", "oshcut", "sendcutsend", "weerg"]) {
      expect(matrix.providers.find((row) => row.key === key)).toMatchObject({
        in_1_0: false,
        enabled_for_paid_automation: false,
      });
    }
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
