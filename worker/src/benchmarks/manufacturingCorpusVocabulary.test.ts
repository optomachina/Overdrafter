// @vitest-environment node

import { describe, expect, it } from "vitest";
import type {
  ManufacturingCorpusArtifactClass,
  ManufacturingCorpusDataClassification,
  ManufacturingCorpusRedistributionLevel,
  ManufacturingCorpusSourceClass,
} from "./manufacturingCorpusVocabulary.js";
import {
  MANUFACTURING_PROCESS_FAMILIES,
  MANUFACTURING_QUALIFICATION_TARGETS,
  manufacturingCorpusArtifactClassSchema,
  manufacturingCorpusDataClassificationSchema,
  manufacturingCorpusHasDuplicates,
  manufacturingCorpusIsJsonValue,
  manufacturingCorpusJsonValueSchema,
  manufacturingCorpusOpaqueReferenceSchema,
  manufacturingCorpusRedistributionLevelSchema,
  manufacturingCorpusSha256Schema,
  manufacturingCorpusSourceClassSchema,
  manufacturingCorpusStableIdSchema,
  manufacturingCorpusUtcTimestampSchema,
  manufacturingProcessFamilySchema,
  manufacturingQualificationTargetSchema,
} from "./manufacturingCorpusVocabulary.js";

describe("manufacturing corpus vocabulary", () => {
  it("accepts every declared catalog value and rejects unknown values", () => {
    const typedExamples: [
      ManufacturingCorpusSourceClass,
      ManufacturingCorpusArtifactClass,
      ManufacturingCorpusDataClassification,
      ManufacturingCorpusRedistributionLevel,
    ] = ["synthetic", "cad_model", "public", "internal_only"];
    expect(typedExamples).toEqual([
      "synthetic",
      "cad_model",
      "public",
      "internal_only",
    ]);

    const catalogs = [
      [manufacturingProcessFamilySchema, MANUFACTURING_PROCESS_FAMILIES],
      [
        manufacturingQualificationTargetSchema,
        MANUFACTURING_QUALIFICATION_TARGETS,
      ],
      [
        manufacturingCorpusSourceClassSchema,
        manufacturingCorpusSourceClassSchema.options,
      ],
      [
        manufacturingCorpusArtifactClassSchema,
        manufacturingCorpusArtifactClassSchema.options,
      ],
      [
        manufacturingCorpusDataClassificationSchema,
        manufacturingCorpusDataClassificationSchema.options,
      ],
      [
        manufacturingCorpusRedistributionLevelSchema,
        manufacturingCorpusRedistributionLevelSchema.options,
      ],
    ] as const;

    for (const [schema, values] of catalogs) {
      for (const value of values) {
        expect(schema.safeParse(value).success).toBe(true);
      }
      expect(schema.safeParse("future_value").success).toBe(false);
    }
  });

  it("validates shared scalar boundaries and duplicate detection", () => {
    expect(manufacturingCorpusStableIdSchema.parse("processor.v1-a")).toBe(
      "processor.v1-a",
    );
    for (const value of [
      "",
      ".",
      "..",
      "Uppercase",
      "has space",
      "../processor",
      "processor/path",
      "processor\\path",
    ]) {
      expect(manufacturingCorpusStableIdSchema.safeParse(value).success).toBe(
        false,
      );
    }

    expect(manufacturingCorpusOpaqueReferenceSchema.parse(" ref-1 ")).toBe(
      "ref-1",
    );
    expect(manufacturingCorpusOpaqueReferenceSchema.safeParse("   ").success).toBe(
      false,
    );
    expect(
      manufacturingCorpusOpaqueReferenceSchema.safeParse("x".repeat(513))
        .success,
    ).toBe(false);

    expect(manufacturingCorpusSha256Schema.safeParse("a".repeat(64)).success).toBe(
      true,
    );
    for (const value of ["A".repeat(64), "a".repeat(63), "g".repeat(64)]) {
      expect(manufacturingCorpusSha256Schema.safeParse(value).success).toBe(
        false,
      );
    }

    expect(
      manufacturingCorpusUtcTimestampSchema.safeParse(
        "2026-07-30T23:59:00.000Z",
      ).success,
    ).toBe(true);
    for (const value of [
      "2026-07-30T23:59:00+00:00",
      "2026-02-30T00:00:00.000Z",
      "not-a-date",
    ]) {
      expect(
        manufacturingCorpusUtcTimestampSchema.safeParse(value).success,
      ).toBe(false);
    }

    expect(manufacturingCorpusHasDuplicates([])).toBe(false);
    expect(manufacturingCorpusHasDuplicates(["a", "b"])).toBe(false);
    expect(manufacturingCorpusHasDuplicates(["a", "a"])).toBe(true);
  });

  it("accepts JSON values and rejects non-serializable values", () => {
    expect(
      manufacturingCorpusJsonValueSchema.safeParse({
        count: 2,
        nested: [true, null, "value"],
      }).success,
    ).toBe(true);

    const shared = { value: "reused" };
    expect(
      manufacturingCorpusJsonValueSchema.safeParse({ first: shared, second: shared })
        .success,
    ).toBe(true);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const sparse = new Array(2);
    sparse[1] = "value";
    const nestedUndefined = { nested: ["value", undefined] };
    const symbolKeyed = { value: true };
    Object.defineProperty(symbolKeyed, Symbol("hidden"), {
      enumerable: true,
      value: "not-json",
    });
    const inheritedToJson = ["value"];
    Object.setPrototypeOf(
      inheritedToJson,
      Object.create(Array.prototype, {
        toJSON: {
          value: () => "mutated",
        },
      }),
    );
    const outOfRangeArray = [];
    Object.defineProperty(outOfRangeArray, "4294967295", {
      enumerable: true,
      value: "discarded by JSON.stringify",
    });
    const hostileProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile prototype trap");
        },
      },
    );

    for (const value of [
      new Date("2026-07-30T00:00:00Z"),
      undefined,
      () => "value",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1n,
      Symbol("value"),
      cyclic,
      sparse,
      nestedUndefined,
      symbolKeyed,
      inheritedToJson,
      outOfRangeArray,
    ]) {
      expect(manufacturingCorpusJsonValueSchema.safeParse(value).success).toBe(
        false,
      );
    }
    expect(manufacturingCorpusIsJsonValue(hostileProxy)).toBe(false);
  });
});
