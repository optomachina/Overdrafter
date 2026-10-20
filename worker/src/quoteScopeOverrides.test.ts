// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { ApprovedRequirementRecord } from "./types.js";
import { buildQuoteLaneScopeSnapshot, type WorkerSourcingIntent } from "./quoteScope";

// Traces a client correction (api_update_client_part_request ->
// approved_part_requirements) into the worker scope snapshot. See
// docs/quote-scope-trace.md. Each case changes exactly one approved field and
// requires the snapshot to change with it, so a builder that ignores the
// corrected value fails here.

const baseRequirement: ApprovedRequirementRecord = {
  id: "requirement-1",
  part_id: "part-1",
  description: "Machined bracket",
  part_number: "BR-1",
  revision: "A",
  material: "6061-T6 Aluminum",
  finish: "Black anodize",
  tightest_tolerance_inch: 0.005,
  quantity: 10,
  quote_quantities: [10],
  requested_by_date: "2026-09-01",
  applicable_vendors: ["xometry"],
  updated_at: "2026-08-12T06:00:00Z",
  spec_snapshot: {
    process: "CNC machining",
    threads: "M6x1.0",
    requestedByDate: "2026-09-01",
    shipping: { requestedByDateOverride: "2026-09-02", packagingNotes: "Foam" },
  },
};

const baseIntent: WorkerSourcingIntent = {
  destination: {
    confirmationRevision: "1",
    street: "123 Test Ave",
    city: "Tucson",
    region: "AZ",
    postalCode: "85701",
    country: "US",
    state: "confirmed",
  },
  activeDeadline: "2026-09-10",
};

type Scope = ReturnType<typeof buildQuoteLaneScopeSnapshot>;

function build(
  requirement: ApprovedRequirementRecord = baseRequirement,
  sourcingIntent: WorkerSourcingIntent = baseIntent,
  requestedQuantity = 10,
): Scope {
  return buildQuoteLaneScopeSnapshot({
    part: {
      id: "part-1",
      job_id: "job-1",
      organization_id: "org-1",
      name: "Bracket",
      normalized_key: "bracket",
      cad_file_id: "cad-1",
      drawing_file_id: null,
      quantity: 10,
    },
    cadFile: {
      id: "cad-1",
      job_id: "job-1",
      storage_bucket: "job-files",
      storage_path: "org-1/bracket.step",
      original_name: "bracket.step",
      file_kind: "cad",
    },
    drawingFile: null,
    stagedCadFile: {
      originalName: "bracket.step",
      localPath: "/tmp/bracket.step",
      storageBucket: "job-files",
      storagePath: "org-1/bracket.step",
      trustedContentSha256: "a".repeat(64),
    },
    stagedDrawingFile: null,
    requirement,
    sourcingIntent,
    vendor: "xometry",
    requestedQuantity,
  });
}

function spec(scope: Scope): Record<string, unknown> {
  return scope.requirements.specification;
}

describe("buildQuoteLaneScopeSnapshot client overrides", () => {
  const baseline = build();
  const baseSpec = baseRequirement.spec_snapshot as Record<string, unknown>;

  const requirementCases: Array<[string, Partial<ApprovedRequirementRecord>, (scope: Scope) => unknown, unknown]> = [
    ["material", { material: "304 Stainless Steel" }, (s) => s.requirements.material, "304 Stainless Steel"],
    ["finish", { finish: "Clear anodize" }, (s) => s.requirements.finish, "Clear anodize"],
    ["tightest tolerance", { tightest_tolerance_inch: 0.001 }, (s) => s.requirements.tightestToleranceInch, 0.001],
    ["description", { description: "Corrected bracket" }, (s) => s.requirements.description, "Corrected bracket"],
    ["part number", { part_number: "BR-2" }, (s) => s.requirements.partNumber, "BR-2"],
    ["revision", { revision: "B" }, (s) => s.requirements.revision, "B"],
    ["process (spec_snapshot)", { spec_snapshot: { ...baseSpec, process: "Sheet metal" } }, (s) => spec(s).process, "Sheet metal"],
    ["threads (spec_snapshot)", { spec_snapshot: { ...baseSpec, threads: "M8x1.25" } }, (s) => spec(s).threads, "M8x1.25"],
  ];

  it.each(requirementCases)("carries a corrected %s into the scope", (_name, patch, pick, expected) => {
    const scope = build({ ...baseRequirement, ...patch });
    expect(pick(scope)).toEqual(expected);
    expect(pick(scope)).not.toEqual(pick(baseline));
    expect(scope).not.toEqual(baseline);
  });

  it("carries the lane requested quantity, not the requirement quantity", () => {
    const scope = build(baseRequirement, baseIntent, 25);
    expect(scope.quantity).toBe(25);
    expect(scope).not.toEqual(baseline);
    // Lane quantities come from quote_quantities in SQL, so requirement.quantity
    // alone does not alter the lane scope (see docs/quote-scope-trace.md).
    expect(build({ ...baseRequirement, quantity: 99 }).quantity).toBe(10);
  });

  it("uses only the server-confirmed deadline for need-by date", () => {
    const confirmed = build(baseRequirement, { ...baseIntent, activeDeadline: "2026-10-01" });
    expect(confirmed.requirements.requestedDeliveryDate).toBe("2026-10-01");
    expect(confirmed).not.toEqual(baseline);

    const unconfirmed = build(baseRequirement, { ...baseIntent, activeDeadline: null });
    expect(unconfirmed.requirements.requestedDeliveryDate).toBeNull();
  });

  it("never discloses the unconfirmed requirement date or its spec copies", () => {
    const scope = build(
      {
        ...baseRequirement,
        requested_by_date: "2027-01-01",
        spec_snapshot: {
          requestedByDate: "2027-01-01",
          shipping: { requestedByDateOverride: "2027-01-02", packagingNotes: "Foam" },
        },
      },
      { ...baseIntent, activeDeadline: null },
    );
    const serialized = JSON.stringify(scope);
    expect(serialized).not.toContain("2027-01-01");
    expect(serialized).not.toContain("2027-01-02");
    expect(scope.requirements.requestedDeliveryDate).toBeNull();
  });
});
