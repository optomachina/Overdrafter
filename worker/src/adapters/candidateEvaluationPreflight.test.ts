// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { VendorName } from "../types.js";
import { evaluateCandidateEvaluationPreflight } from "./candidateEvaluationPreflight.js";

type Input = Parameters<typeof evaluateCandidateEvaluationPreflight>[1];
function input(fileName = "block.step"): Input {
  return {
    stagedCadFile: { originalName: fileName, localPath: "/unused", storageBucket: "fixture", storagePath: "fixture" },
    stagedDrawingFile: null,
    requestedQuantity: 1,
    requirement: {
      id: "fixture", part_id: "fixture", description: null, part_number: null, revision: null,
      material: "aluminum_6061", finish: "as machined", tightest_tolerance_inch: 0.005,
      quantity: 1, quote_quantities: [1], requested_by_date: null, applicable_vendors: [],
      spec_snapshot: { process: "cnc_machining", geometryWithinReviewedEnvelope: true },
    },
  };
}

describe("candidate local evaluation preflight", () => {
  it.each(["rapiddirect", "protolabsnetwork", "protolabs"] as const)("keeps %s unknown despite plausible fixture metadata", (vendor) => {
    const fixture = input(vendor === "protolabs" ? "block.stp" : "block.step");
    fixture.requirement.material = vendor === "protolabs" ? "aluminum_6061_t651" : "aluminum_6061";
    const decision = evaluateCandidateEvaluationPreflight(vendor, fixture)!;
    expect(decision.state).toBe("unknown");
    expect(decision.envelopeRevision).toBe(`${vendor}-envelope.v1`);
    expect(decision.reasonCodes).toEqual(expect.arrayContaining([
      "process_unknown", "account_mode_unknown", "geometry_requirement_unknown", "tolerance_requirement_unknown",
    ]));
    expect(decision.normalized).toMatchObject({ process: null, accountMode: null,
      geometryWithinReviewedEnvelope: null, requestedToleranceMm: null });
  });

  it.each(["stp", "stl", "igs"])("does not inherit Network's stale generic .%s allowance", (extension) => {
    expect(evaluateCandidateEvaluationPreflight("protolabsnetwork", input(`block.${extension}`))?.reasonCodes)
      .toContain("file_format_unknown");
  });

  it("distinguishes Protolabs STEP and plain 6061 from its reviewed STP/T651 package", () => {
    const decision = evaluateCandidateEvaluationPreflight("protolabs", input())!;
    expect(decision.reasonCodes).toEqual(expect.arrayContaining(["file_format_unknown", "material_unknown"]));
  });

  it("does not infer the filename from a storage path when the staged name is missing or mismatched", () => {
    const fixture = input("actual.dxf");
    fixture.stagedCadFile!.storagePath = "apparently-eligible.step";
    fixture.stagedCadFile!.localPath = "/unused/apparently-eligible.step";
    expect(evaluateCandidateEvaluationPreflight("rapiddirect", fixture)?.reasonCodes).toContain("file_format_unknown");
    fixture.stagedCadFile = null;
    expect(evaluateCandidateEvaluationPreflight("rapiddirect", fixture)?.normalized.fileExtension).toBeNull();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid requested quantity %s", (quantity) => {
    const fixture = input();
    fixture.requestedQuantity = quantity;
    const decision = evaluateCandidateEvaluationPreflight("rapiddirect", fixture)!;
    expect(decision.state).toBe("unsupported");
    expect(decision.reasonCodes).toContain("quantity_invalid");
  });

  it("keeps quantity above the reviewed minimum unknown", () => {
    const fixture = input();
    fixture.requestedQuantity = 2;
    expect(evaluateCandidateEvaluationPreflight("protolabsnetwork", fixture)?.reasonCodes)
      .toContain("quantity_above_reviewed_minimum_unknown");
  });

  it("projects actual drawing presence without treating public PDF support as automation evidence", () => {
    const fixture = input();
    fixture.stagedDrawingFile = { ...fixture.stagedCadFile!, originalName: "drawing.pdf" };
    const decision = evaluateCandidateEvaluationPreflight("protolabsnetwork", fixture)!;
    expect(decision.normalized.drawingIncluded).toBe(true);
    expect(decision.reasonCodes).toContain("drawings_require_manual_review");
    expect(decision.state).toBe("unknown");
  });

  it.each(["xometry", "weerg", "rmfg"] as VendorName[])("does not change %s eligibility", (vendor) => {
    expect(evaluateCandidateEvaluationPreflight(vendor, input())).toBeNull();
  });
});
