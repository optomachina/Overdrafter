// @vitest-environment node

/**
 * Characterizes the 1.0 CNC validation package against the offline envelopes of
 * the named 1.0 provider portfolio.
 *
 * Package, from docs/1-0-beta-runbook.md ("Exact CNC-first validation package
 * envelope"):
 * - one `.step` or `.stp` file submitted as one discrete part;
 * - CNC milling, not turning or another manufacturing process;
 * - aluminum 6061-T6;
 * - quantity `1`;
 * - as-machined finish;
 * - standard dimensional tolerance of `+/- 0.005 in` or looser;
 * - no threads, inserts, special inspection, certification, material-provision,
 *   or export-control requirement.
 * The named 1.0 portfolio is Xometry, Fictiv, Quickparts, Weerg, Geomiq, RMFG,
 * and OSH Cut.
 *
 * Assumptions made here:
 * - The package is one STEP file, process key `cnc_machining`, quantity 1, no
 *   drawing, submitted from an existing authenticated account.
 * - The material reaches the evaluators as one of three spellings: the catalog
 *   keys `aluminum_6061` and `aluminum_6061_t6`, and the free-text
 *   `6061 aluminum` that the vendor-workflow smoke harness uses by default.
 *   Each spelling is evaluated with no explicit tolerance and with an explicit
 *   0.127 mm (0.005 in) tolerance.
 * - Geometry is assumed to fit every reviewed envelope with no explicit
 *   geometry requirement. That is the most favourable geometry assumption; the
 *   runbook's geometry boundary means production cannot supply this fact today,
 *   so real dispositions can only be equal to or more conservative than these.
 * - RMFG and Xometry have no provider-specific envelope evaluator. They are
 *   evaluated from PROVIDER_CATALOG capabilityEnvelope with the shared
 *   evidence-backed evaluator under the all-unknown policy that
 *   rmfgSourceEnvelope.test.ts uses. Xometry's separate dispatch-permit preflight
 *   is not evaluated here.
 *
 * This file characterizes current behaviour as decision evidence. It is not
 * provider admission, not a live-offer or dispatch claim, and not a provider
 * count. It asserts only decision-relevant invariants; the full provider x
 * material x tolerance table is recorded with the change that introduced this
 * file rather than committed as a snapshot.
 */

import { describe, expect, it } from "vitest";
import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import type { VendorQuoteAdapterInput } from "../types.js";
import {
  createEvidenceBackedEnvelopeEvaluator,
  type EvidenceBackedEnvelopeDecision,
  type EvidenceBackedEnvelopeInput,
} from "./evidenceBackedEnvelope.js";
import { evaluateFictivEnvelope } from "./fictivEnvelope.js";
import { evaluateGeomiqEnvelope } from "./geomiqEnvelope.js";
import { assessOshcutEligibility } from "./oshcut.js";
import { evaluateQuickpartsEnvelope } from "./quickpartsEnvelope.js";
import { evaluateWeergEnvelope } from "./weergEnvelope.js";

const PACKAGE_PROCESS = "cnc_machining";
const PACKAGE_FILE_NAME = "bracket.step";
const PACKAGE_QUANTITY = 1;
const PACKAGE_ACCOUNT_MODE = "existing_authenticated_account";
const PACKAGE_TOLERANCE_MM = 0.127;
const PACKAGE_TOLERANCE_INCH = 0.005;

const MATERIAL_SPELLINGS = ["aluminum_6061", "aluminum_6061_t6", "6061 aluminum"] as const;
const TOLERANCE_CASES = ["none", "0.127 mm"] as const;
const NAMED_PORTFOLIO = [
  "xometry",
  "fictiv",
  "quickparts",
  "weerg",
  "geomiq",
  "rmfg",
  "oshcut",
] as const;
const CAPABILITY_ENVELOPE_SECTIONS = [
  "processes",
  "materials",
  "files",
  "quantity",
  "tolerance",
  "geometry",
  "drawings",
  "accountModes",
] as const;

type MaterialSpelling = (typeof MATERIAL_SPELLINGS)[number];
type ToleranceCase = (typeof TOLERANCE_CASES)[number];
type PortfolioProvider = (typeof NAMED_PORTFOLIO)[number];
type EnvelopeEvaluatedProvider = Exclude<PortfolioProvider, "oshcut">;

type PackageDisposition = {
  provider: PortfolioProvider;
  material: MaterialSpelling;
  tolerance: ToleranceCase;
  eligible: boolean;
  state: string;
  reasonCodes: readonly string[];
};

function createCatalogEnvelopeEvaluator(providerKey: "rmfg" | "xometry") {
  const envelope = PROVIDER_CATALOG[providerKey].capabilityEnvelope;
  return createEvidenceBackedEnvelopeEvaluator({
    providerKey,
    envelopeRevision: `${providerKey}-catalog-envelope.v${envelope.version}`,
    envelope,
    quantityMaximum: "unknown",
    drawingDisposition: "unknown",
    toleranceDisposition: "unknown",
    geometryDisposition: "unknown",
  });
}

const ENVELOPE_EVALUATORS: Record<
  EnvelopeEvaluatedProvider,
  (input: EvidenceBackedEnvelopeInput) => EvidenceBackedEnvelopeDecision
> = {
  xometry: createCatalogEnvelopeEvaluator("xometry"),
  fictiv: evaluateFictivEnvelope,
  quickparts: evaluateQuickpartsEnvelope,
  weerg: evaluateWeergEnvelope,
  geomiq: evaluateGeomiqEnvelope,
  rmfg: createCatalogEnvelopeEvaluator("rmfg"),
};

function makePackageEnvelopeInput(
  material: MaterialSpelling,
  tolerance: ToleranceCase,
): EvidenceBackedEnvelopeInput {
  const explicitTolerance = tolerance !== "none";
  return {
    process: PACKAGE_PROCESS,
    material,
    fileName: PACKAGE_FILE_NAME,
    quantity: PACKAGE_QUANTITY,
    accountMode: PACKAGE_ACCOUNT_MODE,
    drawingIncluded: false,
    explicitToleranceRequirement: explicitTolerance,
    requestedToleranceMm: explicitTolerance ? PACKAGE_TOLERANCE_MM : null,
    explicitGeometryRequirements: false,
    geometryWithinReviewedEnvelope: true,
  };
}

function makePackageAdapterInput(
  material: MaterialSpelling,
  tolerance: ToleranceCase,
): VendorQuoteAdapterInput {
  return {
    organizationId: "org-named-portfolio",
    quoteRunId: "run-named-portfolio",
    requestedQuantity: PACKAGE_QUANTITY,
    part: {
      id: "part-named-portfolio",
      job_id: "job-named-portfolio",
      organization_id: "org-named-portfolio",
      name: "CNC validation bracket",
      normalized_key: "cnc-validation-bracket",
      cad_file_id: "cad-named-portfolio",
      drawing_file_id: null,
      quantity: PACKAGE_QUANTITY,
    },
    cadFile: {
      id: "cad-named-portfolio",
      job_id: "job-named-portfolio",
      storage_bucket: "job-files",
      storage_path: `cad/${PACKAGE_FILE_NAME}`,
      original_name: PACKAGE_FILE_NAME,
      file_kind: "cad",
    },
    drawingFile: null,
    stagedCadFile: {
      originalName: PACKAGE_FILE_NAME,
      localPath: `/private/staged/${PACKAGE_FILE_NAME}`,
      storageBucket: "job-files",
      storagePath: `cad/${PACKAGE_FILE_NAME}`,
    },
    stagedDrawingFile: null,
    requirement: {
      id: "requirement-named-portfolio",
      part_id: "part-named-portfolio",
      description: "CNC validation bracket",
      part_number: null,
      revision: null,
      material,
      finish: "As machined",
      tightest_tolerance_inch: tolerance === "none" ? null : PACKAGE_TOLERANCE_INCH,
      quantity: PACKAGE_QUANTITY,
      quote_quantities: [PACKAGE_QUANTITY],
      requested_by_date: null,
      applicable_vendors: ["oshcut"],
      spec_snapshot: { process: PACKAGE_PROCESS },
    },
  };
}

function evaluatePackage(
  provider: PortfolioProvider,
  material: MaterialSpelling,
  tolerance: ToleranceCase,
): PackageDisposition {
  if (provider === "oshcut") {
    const assessment = assessOshcutEligibility(makePackageAdapterInput(material, tolerance));
    return {
      provider,
      material,
      tolerance,
      eligible: assessment.state === "eligible",
      state: assessment.state,
      reasonCodes: [assessment.reasonCode],
    };
  }

  const decision = ENVELOPE_EVALUATORS[provider](makePackageEnvelopeInput(material, tolerance));
  return {
    provider,
    material,
    tolerance,
    eligible: decision.state === "eligible_for_evaluation",
    state: decision.state,
    reasonCodes: decision.reasonCodes,
  };
}

function computePackageMatrix(): PackageDisposition[] {
  return NAMED_PORTFOLIO.flatMap((provider) =>
    MATERIAL_SPELLINGS.flatMap((material) =>
      TOLERANCE_CASES.map((tolerance) => evaluatePackage(provider, material, tolerance))));
}

function describeDisposition(row: PackageDisposition): string {
  return `${row.provider} x ${row.material} x ${row.tolerance} -> ${row.state} [${row.reasonCodes.join(", ")}]`;
}

describe("named-portfolio 1.0 CNC package characterization", () => {
  const matrix = computePackageMatrix();
  const rowsFor = (provider: PortfolioProvider) =>
    matrix.filter((row) => row.provider === provider);

  it("evaluates every named provider for every material spelling and tolerance case", () => {
    const cells = new Set(matrix.map((row) => `${row.provider}|${row.material}|${row.tolerance}`));

    expect(matrix).toHaveLength(
      NAMED_PORTFOLIO.length * MATERIAL_SPELLINGS.length * TOLERANCE_CASES.length,
    );
    expect(cells.size).toBe(matrix.length);
  });

  it.each(["weerg", "geomiq"] as const)(
    "keeps %s material_unknown for every 6061 spelling",
    (provider) => {
      const rows = rowsFor(provider);

      expect(rows).toHaveLength(MATERIAL_SPELLINGS.length * TOLERANCE_CASES.length);
      expect(
        rows
          .filter((row) => !row.reasonCodes.includes("material_unknown"))
          .map(describeDisposition),
      ).toEqual([]);
    },
  );

  it("keeps OSH Cut and RMFG ineligible for cnc_machining", () => {
    expect(
      rowsFor("oshcut")
        .filter((row) => row.eligible || row.reasonCodes[0] !== "cnc_milling_not_supported")
        .map(describeDisposition),
    ).toEqual([]);
    expect(
      rowsFor("rmfg")
        .filter((row) => row.eligible || !row.reasonCodes.includes("process_unknown"))
        .map(describeDisposition),
    ).toEqual([]);
  });

  it("leaves all eight Xometry capability-envelope sections unknown", () => {
    const envelope = PROVIDER_CATALOG.xometry.capabilityEnvelope;
    const sectionNames = Object.keys(envelope).filter((name) => name !== "version");

    expect([...sectionNames].sort()).toEqual([...CAPABILITY_ENVELOPE_SECTIONS].sort());
    expect(
      CAPABILITY_ENVELOPE_SECTIONS
        .filter((section) => envelope[section].status !== "unknown")
        .map((section) => `${section}: ${envelope[section].status}`),
    ).toEqual([]);
  });

  it("finds no named provider eligible for the free-text '6061 aluminum' spelling", () => {
    const rows = matrix.filter((row) => row.material === "6061 aluminum");

    expect(rows).toHaveLength(NAMED_PORTFOLIO.length * TOLERANCE_CASES.length);
    expect(rows.filter((row) => row.eligible).map(describeDisposition)).toEqual([]);
  });
});
