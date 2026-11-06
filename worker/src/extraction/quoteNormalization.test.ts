// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildMaterialSearchTerms, buildMaterialSummaryTerms } from "../adapters/xometryConstraints";
import { normalizeQuoteFinish, normalizeQuoteMaterial } from "./pdfDrawing";

// OVD-1166: the drawing reader's normalized material must agree with the controlled Xometry beta gate
// (OVD-1163). The gate's regex is read from the migration itself so this test cannot drift from it.
const betaMigration = readFileSync(
  new URL("../../../supabase/migrations/20261104032300_ovd1163_beta_6061_and_quote_as_machined.sql", import.meta.url),
  "utf8",
);
const gatePattern = /v_material !~ '([^']+)'/.exec(betaMigration)?.[1];
if (!gatePattern) throw new Error("OVD-1163 6061 gate regex not found in its migration");
const sqlGate = new RegExp(gatePattern);

// The migration's own key: lower(btrim(material)) with every non [a-z0-9] removed.
function sqlGateAccepts(material: string) {
  return sqlGate.test(material.trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
}

const UNTEMPERED_6061 = [
  "6061",
  "6061 Alloy",
  "6061 ALLOY",
  "6061  alloy",
  "Al 6061",
  "AL-6061",
  "AL6061",
  "Al. 6061",
  "Aluminum 6061",
  "ALUMINUM 6061",
  "aluminium 6061",
  "6061 aluminum",
  "6061 Aluminium",
  "6061-Aluminum",
  "Alloy 6061",
  "ALLOY 6061",
  "Aluminum Alloy 6061",
  "6061 Aluminum Alloy",
  "6061 Al",
  " 6061 ",
  "6061.",
];

const T6_EQUIVALENT_6061 = [
  "6061-T6",
  "6061 T6",
  "6061-T6 Aluminum",
  "Aluminum 6061-T6",
  "AL 6061-T6",
  "6061-T651",
  "6061-T6511",
  "Aluminum 6061-T6511",
  "6061-T6/T651",
];

const OTHER_TEMPER_6061 = [
  "6061-O",
  "6061 O",
  "6061-F",
  "6061-T4",
  "Aluminum 6061-T4",
  "6061-T451",
  "6061 T62",
  "6061-T6/T4",
];

const UNRELATED_6061_TEXT = [
  "6061 Alloy per AMS-QQ-A-250/11",
  "6061 OR 7075",
  "6061 Alloy Bar Stock",
  "Aluminum 6061 or equivalent",
  "6061 Alloy, see note 4",
  "6061 Alum",
  "Steel 6061 insert",
  "60610",
  "16061",
];

describe("normalizeQuoteMaterial (OVD-1166)", () => {
  it.each(UNTEMPERED_6061)("normalizes %j without a temper to 6061-T6 Aluminum", (raw) => {
    expect(normalizeQuoteMaterial(raw)).toBe("6061-T6 Aluminum");
  });

  it.each(T6_EQUIVALENT_6061)("keeps the T6-equivalent %j as written", (raw) => {
    expect(normalizeQuoteMaterial(raw)).toBe(raw);
  });

  it.each(OTHER_TEMPER_6061)("never changes the explicit other temper %j", (raw) => {
    expect(normalizeQuoteMaterial(raw)).toBe(raw);
  });

  it.each(UNRELATED_6061_TEXT)("leaves %j, which mentions 6061 beside something else, alone", (raw) => {
    expect(normalizeQuoteMaterial(raw)).toBe(raw);
  });

  it("returns null for a missing material and leaves other materials as read", () => {
    expect(normalizeQuoteMaterial(null)).toBeNull();
    expect(normalizeQuoteMaterial("")).toBeNull();
    expect(normalizeQuoteMaterial("7075 Alloy")).toBe("7075 Alloy");
    expect(normalizeQuoteMaterial("304  Stainless")).toBe("304 Stainless");
  });
});

describe("normalized 6061 agrees with the OVD-1163 beta gate", () => {
  it.each(UNTEMPERED_6061)("the gate already accepts %j, and accepts what it normalizes to", (raw) => {
    expect(sqlGateAccepts(raw)).toBe(true);
    const normalized = normalizeQuoteMaterial(raw);
    expect(normalized).not.toBeNull();
    expect(sqlGateAccepts(normalized!)).toBe(true);
    expect(buildMaterialSearchTerms(normalized!)).toEqual(["6061-T6", "6061"]);
    expect(buildMaterialSummaryTerms(normalized!)).toEqual(["6061-T6x", "6061-T6"]);
  });

  it.each(T6_EQUIVALENT_6061)("the gate and Xometry accept the T6-equivalent %j as normalized", (raw) => {
    const normalized = normalizeQuoteMaterial(raw)!;
    expect(sqlGateAccepts(normalized)).toBe(true);
    expect(buildMaterialSearchTerms(normalized)).toEqual(["6061-T6", "6061"]);
  });

  it.each(OTHER_TEMPER_6061)("the gate and Xometry still refuse %j after normalization", (raw) => {
    const normalized = normalizeQuoteMaterial(raw)!;
    expect(sqlGateAccepts(normalized)).toBe(false);
    expect(buildMaterialSearchTerms(normalized)).toBeNull();
    expect(buildMaterialSummaryTerms(normalized)).toBeNull();
  });

  it("rewrites a material only when the gate accepts it without a temper", () => {
    for (const raw of [...UNTEMPERED_6061, ...T6_EQUIVALENT_6061, ...OTHER_TEMPER_6061, ...UNRELATED_6061_TEXT]) {
      const key = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
      const untemperedAndAccepted = sqlGateAccepts(raw) && !/6061t/.test(key);
      expect(normalizeQuoteMaterial(raw) !== raw.trim().replace(/\s+/g, " ")).toBe(untemperedAndAccepted);
    }
  });
});

describe("normalizeQuoteFinish anodize spellings (OVD-1166)", () => {
  it.each([
    ["ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2", "Black Anodize, Type II"],
    ["ANODIZE, BLACK, MIL-A-8625F, TYPE II, CLASS 2", "Black Anodize, Type II"],
    ["MIL-A-8625 TYPE II, BLACK", "Black Anodize, Type II"],
    ["MIL-A-8625F Type II Class 2 Black", "Black Anodize, Type II"],
    ["Black anodize per MIL-A-8625, Type II", "Black Anodize, Type II"],
    ["Type 2 anodize, black", "Black Anodize, Type II"],
    ["TYPE II BLACK ANODIZE", "Black Anodize, Type II"],
    ["ANODIZE TYPE II BLACK", "Black Anodize, Type II"],
    ["Black Anodized Type II", "Black Anodize, Type II"],
    ["ANODIZE PER MIL-A-8625 TYPE II, CLASS 2, COLOR: BLACK", "Black Anodize, Type II"],
    ["MIL-A-8625 TYPE III, BLACK", "Black Anodize, Type III"],
    ["Black Anodize Type III", "Black Anodize, Type III"],
    ["ANODIZE, BLACK, MIL-A-8625F, TYPE III CLASS 2", "Black Anodize, Type III"],
    ["Type 3 anodize, black", "Black Anodize, Type III"],
    ["Clear anodize, MIL-A-8625 Type II, Class 1", "Clear Anodize, Type II"],
    ["MIL-A-8625 TYPE II, CLEAR", "Clear Anodize, Type II"],
    ["black anodize per MIL-A-8625", "Black Anodize, MIL-A-8625"],
    ["BLACK ANODIZE PER MIL-A-8625F", "Black Anodize, MIL-A-8625"],
    ["BLACK ANODIZE PER MIL-PRF-8625 TYPE II", "Black Anodize, Type II"],
    ["BLACK ANODIZE PER MIL-PRF-8625F, TYPE II, CLASS 2", "Black Anodize, Type II"],
    ["MIL-PRF-8625", "Anodize, MIL-A-8625"],
    ["Black Anodize - Type II", "Black Anodize, Type II"],
    ["ANODIZE, BLACK, TYPE II, CL 2", "Black Anodize, Type II"],
    ["BLACK ANODIZE MIL A 8625 TYPE II", "Black Anodize, Type II"],
    ["SULFURIC ANODIZE TYPE II BLACK", "Black Anodize, Type II"],
    ["BLACK ANODIZE PER MIL-PRF-8625(F), TYPE II", "Black Anodize, Type II"],
    ["BLACK ANODIZE PER MIL-PRF-8625 (F), TYPE II", "Black Anodize, Type II"],
    ["ANODIZE, RED, TYPE II, CLASS 2", "Red Anodize, Type II"],
    ["CLEAR ANODIZE TYPE II CLASS 1", "Clear Anodize, Type II"],
    ["ANODIZE, DYED, TYPE II, CL 2", "Anodize, Type II, Class 2"],
    ["ANODIZE, DYED BLACK, TYPE II", "Black Anodize, Type II"],
  ])("normalizes %j to %j", (raw, expected) => {
    expect(normalizeQuoteFinish(raw)).toBe(expected);
  });

  it.each([
    ["ANODIZE PER MIL-A-8625 TYPE II", "Anodize, Type II"],
    ["MIL-A-8625 TYPE III", "Anodize, Type III"],
    ["Type 2 anodize", "Anodize, Type II"],
    ["ANODIZE PER MIL-A-8625", "Anodize, MIL-A-8625"],
    ["MIL-A-8625 TYPE II CLASS 1", "Anodize, Type II, Class 1"],
    ["ANODIZE TYPE II, CL 2", "Anodize, Type II, Class 2"],
  ])("never invents a colour the drawing does not give: %j", (raw, expected) => {
    expect(normalizeQuoteFinish(raw)).toBe(expected);
  });

  it.each([
    "BLACK ANODIZE TYPE II, MASK ALL THREADS",
    "ANODIZE TYPE II OR III, BLACK",
    "BLACK OR CLEAR ANODIZE TYPE II",
    "HARD ANODIZE",
    "Black Oxide",
    "AS MACHINED",
    "ANODIZE, BLACK, TYPE II, SEE NOTE 3",
    "BLACK CLEAR ANODIZE TYPE II",
    "BLACK ANODIZE TYPE II CL 1",
    "ANODIZE, DYED BLACK, TYPE II, CL 1",
    "ANODIZE, DYED, TYPE II, CL 1",
    "ANODIZE, DYED, TYPE II",
    "ANODIZE DYED",
    "CLEAR ANODIZE TYPE II CL 2",
    "NATURAL ANODIZE TYPE II CLASS 2",
    "ANODIZE TYPE II, BLACK - CLEAR",
    "ANODIZE TYPE II CLASS 1 OR CLASS 2",
    "BLACK ANODIZE - MASK THREADS",
  ])("leaves %j, which says more than an anodize callout, as read", (raw) => {
    expect(normalizeQuoteFinish(raw)).toBe(raw);
  });

  it("returns null for a missing finish", () => {
    expect(normalizeQuoteFinish(null)).toBeNull();
    expect(normalizeQuoteFinish("")).toBeNull();
  });
});
