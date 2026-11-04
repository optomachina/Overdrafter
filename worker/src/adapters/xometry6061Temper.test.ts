import { describe, expect, it } from "vitest";
import { buildMaterialSearchTerms, buildMaterialSummaryTerms } from "./xometryConstraints.js";

// OVD-1163: 6061 written without a temper is the beta's 6061-T6; an explicit other temper is refused.
describe("Xometry 6061 material mapping (OVD-1163)", () => {
  it.each([
    "6061",
    "6061 Alloy",
    "Al 6061",
    "AL-6061",
    "6061 aluminum",
    "Aluminum 6061",
    "aluminium 6061",
    "6061-T6",
    "6061-T6 Aluminum",
    "Aluminum 6061-T6",
    "6061 T6",
    "6061-T651",
    "Aluminum 6061-T6511",
    "6061-T6/T651",
    "6061-T6 aluminum, for machining",
    "6061 T6 bar stock",
  ])("maps %s to Xometry's 6061-T6 selection", (material) => {
    expect(buildMaterialSearchTerms(material)).toEqual(["6061-T6", "6061"]);
    expect(buildMaterialSummaryTerms(material)).toEqual(["6061-T6x", "6061-T6"]);
  });

  it.each([
    "6061-O", "6061 O", "6061-T4", "Aluminum 6061-T4", "6061-T451", "6061-F", "6061 T62",
    // Any stated temper other than T6/T651/T6511 refuses, not only the first one.
    "6061-T6/T4", "6061-T6 (T4)", "6061-T651/O", "Aluminum 6061-T6 or T4",
  ])(
    "refuses the explicit other temper %s instead of quoting it as 6061-T6",
    (material) => {
      expect(buildMaterialSearchTerms(material)).toBeNull();
      expect(buildMaterialSummaryTerms(material)).toBeNull();
    },
  );

  it("leaves other alloys' mappings unchanged", () => {
    expect(buildMaterialSearchTerms("7075-T6")).toEqual(["7075-T6", "7075"]);
    expect(buildMaterialSummaryTerms("Aluminum 7075")).toEqual(["7075-T6x", "7075-T6"]);
  });
});
