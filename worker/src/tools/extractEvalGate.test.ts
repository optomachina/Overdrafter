// @vitest-environment node

import { describe, expect, it } from "vitest";
import { DEFAULT_FIELD_FLOORS, scoreCorpus, valuesMatch } from "./extractEvalGate.js";

describe("valuesMatch", () => {
  it("compares case- and whitespace-insensitively", () => {
    expect(valuesMatch("6061-T6", "6061-t6")).toBe(true);
    expect(valuesMatch("Clear Anodize", "  clear   anodize  ")).toBe(true);
  });

  it("treats a missing extraction as a mismatch", () => {
    expect(valuesMatch("A", null)).toBe(false);
  });

  it("does not accept a different value", () => {
    expect(valuesMatch("1234-5678", "1234-5679")).toBe(false);
  });
});

describe("scoreCorpus", () => {
  it("passes when every field meets its floor", () => {
    const report = scoreCorpus([
      {
        caseId: "a",
        expected: { partNumber: "1234-5678", revision: "A" },
        actual: { partNumber: "1234-5678", revision: "A" },
      },
    ]);

    expect(report.passed).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it("fails the field that regressed and names the case", () => {
    const report = scoreCorpus(
      [
        {
          caseId: "spec-string-drawing",
          expected: { partNumber: "1234-5678" },
          actual: { partNumber: "MIL-STD-810" },
        },
      ],
      { partNumber: 0.9 },
    );

    expect(report.passed).toBe(false);
    expect(report.failures).toEqual([
      {
        caseId: "spec-string-drawing",
        field: "partNumber",
        expected: "1234-5678",
        actual: "MIL-STD-810",
      },
    ]);
  });

  it("scores a field only over cases that declare it", () => {
    // Two cases, only one of which has a finish callout. Getting that one
    // right is 100% finish accuracy, not 50%.
    const report = scoreCorpus(
      [
        { caseId: "a", expected: { finish: "ANODIZE" }, actual: { finish: "ANODIZE" } },
        { caseId: "b", expected: {}, actual: { finish: null } },
      ],
      { finish: 1 },
    );

    const finish = report.fields.find((field) => field.field === "finish");
    expect(finish).toMatchObject({ applicable: 1, correct: 1, accuracy: 1, passed: true });
    expect(report.passed).toBe(true);
  });

  it("treats an unmeasured field as passing rather than as a zero", () => {
    const report = scoreCorpus([{ caseId: "a", expected: { partNumber: "1" }, actual: { partNumber: "1" } }]);

    const material = report.fields.find((field) => field.field === "material");
    expect(material).toMatchObject({ applicable: 0, accuracy: 1, passed: true });
  });

  it("computes fractional accuracy against the floor", () => {
    const results = Array.from({ length: 10 }, (_, index) => ({
      caseId: `case-${index}`,
      expected: { revision: "A" },
      actual: { revision: index < 8 ? "A" : "B" },
    }));

    const atFloor = scoreCorpus(results, { revision: 0.8 });
    const aboveFloor = scoreCorpus(results, { revision: 0.85 });

    expect(atFloor.fields.find((field) => field.field === "revision")?.accuracy).toBeCloseTo(0.8);
    expect(atFloor.passed).toBe(true);
    expect(aboveFloor.passed).toBe(false);
  });
});

describe("DEFAULT_FIELD_FLOORS", () => {
  it("declares a floor in range for every gated field", () => {
    for (const field of ["partNumber", "revision", "description", "material", "finish"]) {
      const floor = DEFAULT_FIELD_FLOORS[field];
      expect(floor, `${field} has no declared floor`).toBeDefined();
      expect(floor).toBeGreaterThanOrEqual(0);
      expect(floor).toBeLessThanOrEqual(1);
    }
  });

  it("keeps description at zero while the wrapped-title gap is open", () => {
    // A zero floor means "known gap", not "accepted outcome". The parser cannot
    // reach a title that wraps past the two-line continuation window. When that
    // is fixed — or the gate runs with a provider key so the model fallback
    // participates — raise this and update the note on the corpus case.
    expect(DEFAULT_FIELD_FLOORS.description).toBe(0);
  });

  it("holds every other field to a real floor", () => {
    for (const field of ["partNumber", "revision", "material", "finish"]) {
      expect(DEFAULT_FIELD_FLOORS[field]).toBeGreaterThan(0.5);
    }
  });
});
