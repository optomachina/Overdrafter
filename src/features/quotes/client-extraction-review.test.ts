import { describe, expect, it } from "vitest";
import {
  parseZonedTimestampMicros,
  resolveClientExtractionReview,
} from "@/features/quotes/client-extraction-review";
import type { ClientExtractionDiagnostics, ClientPartPropertyState } from "@/features/quotes/types";

// Shapes match what api_list_client_part_metadata delivers: extractedAt/updatedAt are
// jsonb-rendered timestamptz values, projectPartProperties.updatedAt is timestamptz::text.
const EXTRACTED_AT = "2026-11-04T06:18:41.512345+00:00";
const SAVED_AFTER = "2026-11-04 06:25:03.104512+00";
const SAVED_BEFORE = "2026-11-04 06:10:00.000001+00";

const ALL_REVIEW_FIELDS = ["description", "partNumber", "revision", "material", "finish"];

function diagnostics(overrides: Partial<ClientExtractionDiagnostics> = {}): ClientExtractionDiagnostics {
  return {
    lifecycle: "partial",
    warningCount: 0,
    warnings: [],
    missingFields: [],
    reviewFields: ALL_REVIEW_FIELDS,
    lastFailureCode: null,
    lastFailureMessage: null,
    extractedAt: EXTRACTED_AT,
    failedAt: null,
    updatedAt: EXTRACTED_AT,
    pageCount: 1,
    hasCadFile: true,
    hasDrawingFile: true,
    ...overrides,
  };
}

// Part 1093-05589-02: description, material and finish entered; part number and revision kept.
function savedProperties(overrides: Partial<ClientPartPropertyState> = {}): ClientPartPropertyState {
  return {
    defaults: {
      description: "BRKT",
      partNumber: "1093-05589-02",
      revision: "B",
      material: "AL",
      finish: null,
    },
    overrides: {
      description: "Mounting bracket",
      material: "6061-T6",
      finish: "Clear anodize",
    },
    createdAt: SAVED_AFTER,
    updatedAt: SAVED_AFTER,
    ...overrides,
  };
}

describe("resolveClientExtractionReview (OVD-1165)", () => {
  it("drops fields with a customer override from Verify and Missing", () => {
    const result = resolveClientExtractionReview(
      diagnostics({
        missingFields: ["tightestToleranceInch", "threads"],
        reviewFields: ALL_REVIEW_FIELDS,
      }),
      savedProperties({
        overrides: {
          description: "Mounting bracket",
          material: "6061-T6",
          finish: "Clear anodize",
          tightestToleranceInch: 0.001,
        },
        updatedAt: SAVED_BEFORE,
      }),
    );

    expect(result?.lifecycle).toBe("partial");
    expect(result?.reviewFields).toEqual(["partNumber", "revision"]);
    expect(result?.missingFields).toEqual(["threads"]);
  });

  it("does not treat a blank or placeholder override as an entered value", () => {
    const result = resolveClientExtractionReview(
      diagnostics({ missingFields: ["material", "threads"], reviewFields: ["description"] }),
      savedProperties({
        overrides: { material: "Unknown material", threads: "", description: "   " },
        updatedAt: SAVED_BEFORE,
      }),
    );

    expect(result?.missingFields).toEqual(["material", "threads"]);
    expect(result?.reviewFields).toEqual(["description"]);
  });

  it("clears the production banner once request details were saved after the drawing was read", () => {
    const result = resolveClientExtractionReview(diagnostics(), savedProperties());

    expect(result?.lifecycle).toBe("succeeded");
    expect(result?.reviewFields).toEqual([]);
    expect(result?.missingFields).toEqual([]);
  });

  it("keeps Missing fields that still have no value after a later save", () => {
    const result = resolveClientExtractionReview(
      diagnostics({
        missingFields: ["finish", "tightestToleranceInch", "threads", "revision"],
        reviewFields: ["description", "partNumber"],
      }),
      savedProperties({
        defaults: { revision: "C", finish: null, threads: "1/4-20 UNC" },
        overrides: { threads: "" },
      }),
    );

    expect(result?.lifecycle).toBe("partial");
    expect(result?.reviewFields).toEqual([]);
    expect(result?.missingFields).toEqual(["finish", "tightestToleranceInch", "threads"]);
  });

  it("brings the still-flagged fields back after a newer drawing read", () => {
    const rereadAt = "2026-11-04T07:02:00.000000+00:00";
    const result = resolveClientExtractionReview(
      diagnostics({ extractedAt: rereadAt, updatedAt: rereadAt, missingFields: ["tightestToleranceInch"] }),
      savedProperties(),
    );

    expect(result?.lifecycle).toBe("partial");
    expect(result?.reviewFields).toEqual(["partNumber", "revision"]);
    expect(result?.missingFields).toEqual(["tightestToleranceInch"]);
  });

  it("uses the later of the extraction and task times as the drawing read time", () => {
    const result = resolveClientExtractionReview(
      diagnostics({ updatedAt: "2026-11-04T06:30:00+00:00" }),
      savedProperties(),
    );

    expect(result?.reviewFields).toEqual(["partNumber", "revision"]);
  });

  it.each([
    ["no save time", { updatedAt: null }, {}],
    ["an unzoned save time", { updatedAt: "2026-11-04 06:25:03" }, {}],
    ["an unreadable save time", { updatedAt: "yesterday" }, {}],
    ["no extraction time", {}, { extractedAt: null }],
    ["a save at the same instant", { updatedAt: "2026-11-04 06:18:41.512345+00" }, {}],
  ] as const)("keeps unconfirmed fields flagged with %s", (_label, propertyPatch, diagnosticsPatch) => {
    const result = resolveClientExtractionReview(
      diagnostics(diagnosticsPatch),
      savedProperties(propertyPatch),
    );

    expect(result?.lifecycle).toBe("partial");
    expect(result?.reviewFields).toEqual(["partNumber", "revision"]);
  });

  it("keeps every raw field when the customer has saved nothing", () => {
    const raw = diagnostics({ missingFields: ["tightestToleranceInch"] });
    const result = resolveClientExtractionReview(raw, null);

    expect(result?.reviewFields).toEqual(ALL_REVIEW_FIELDS);
    expect(result?.missingFields).toEqual(["tightestToleranceInch"]);
  });

  it.each(["queued", "extracting", "failed", "uploaded", "succeeded"] as const)(
    "leaves the %s state unchanged",
    (lifecycle) => {
      const raw = diagnostics({ lifecycle, missingFields: ["material"] });

      expect(resolveClientExtractionReview(raw, savedProperties())).toBe(raw);
    },
  );

  it("keeps a warnings-only notice until the customer saves after the drawing read", () => {
    const raw = diagnostics({ reviewFields: [], warningCount: 1, warnings: ["Low confidence title block."] });
    const result = resolveClientExtractionReview(raw, savedProperties({ updatedAt: SAVED_BEFORE }));

    expect(result?.lifecycle).toBe("partial");
    expect(result?.warningCount).toBe(1);
  });

  it("acknowledges warnings-only notices with a save after the drawing read", () => {
    const raw = diagnostics({ reviewFields: [], warningCount: 1, warnings: ["Low confidence title block."] });

    expect(resolveClientExtractionReview(raw, savedProperties())?.lifecycle).toBe("succeeded");
  });

  it("keeps the notice for remaining warnings when overrides cleared every field without a later save", () => {
    const result = resolveClientExtractionReview(
      diagnostics({ reviewFields: ["material"], warningCount: 2, warnings: ["a", "b"] }),
      savedProperties({ updatedAt: SAVED_BEFORE }),
    );

    expect(result?.lifecycle).toBe("partial");
    expect(result?.reviewFields).toEqual([]);
    expect(result?.warningCount).toBe(2);
  });

  it("clears fields and warnings together once the customer saved after the drawing read", () => {
    const result = resolveClientExtractionReview(
      diagnostics({ warningCount: 2, warnings: ["a", "b"] }),
      savedProperties(),
    );

    expect(result?.lifecycle).toBe("succeeded");
  });

  it("orders a save in the same millisecond as the drawing read by its microseconds", () => {
    const sameMillisecond = { extractedAt: "2026-11-04T06:18:41.512345+00:00", updatedAt: "2026-11-04T06:18:41.512345+00:00" };

    expect(
      resolveClientExtractionReview(diagnostics(sameMillisecond), savedProperties({ updatedAt: "2026-11-04 06:18:41.512346+00" }))
        ?.lifecycle,
    ).toBe("succeeded");
    expect(
      resolveClientExtractionReview(diagnostics(sameMillisecond), savedProperties({ updatedAt: "2026-11-04 06:18:41.512344+00" }))
        ?.reviewFields,
    ).toEqual(["partNumber", "revision"]);
  });

  it("does not modify the raw diagnostics", () => {
    const raw = diagnostics();
    resolveClientExtractionReview(raw, savedProperties());

    expect(raw.lifecycle).toBe("partial");
    expect(raw.reviewFields).toEqual(ALL_REVIEW_FIELDS);
  });
});

describe("parseZonedTimestampMicros", () => {
  it("reads jsonb and text renderings of the same instant identically", () => {
    const expected = Date.UTC(2026, 10, 4, 6, 25, 3) * 1000 + 104512;

    expect(parseZonedTimestampMicros("2026-11-04 06:25:03.104512+00")).toBe(expected);
    expect(parseZonedTimestampMicros("2026-11-04T06:25:03.104512+00:00")).toBe(expected);
    expect(parseZonedTimestampMicros("2026-11-04T06:25:03.104512Z")).toBe(expected);
    expect(parseZonedTimestampMicros("2026-11-04 11:55:03.104512+0530")).toBe(expected);
  });

  it("keeps microseconds and pads shorter fractions", () => {
    const wholeSecond = Date.UTC(2026, 10, 4, 6, 25, 3) * 1000;

    expect(parseZonedTimestampMicros("2026-11-04 06:25:03.104513+00")).toBe(wholeSecond + 104513);
    expect(parseZonedTimestampMicros("2026-11-04 06:25:03.1+00")).toBe(wholeSecond + 100000);
    expect(parseZonedTimestampMicros("2026-11-04 06:25:03+00")).toBe(wholeSecond);
  });

  it.each([null, undefined, "", "2026-11-04 06:25:03", "-infinity", "not a date"])(
    "returns null for %s",
    (value) => {
      expect(parseZonedTimestampMicros(value)).toBeNull();
    },
  );
});
