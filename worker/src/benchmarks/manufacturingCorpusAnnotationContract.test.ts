// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  MANUFACTURING_CORPUS_ANNOTATION_SCHEMA_VERSION,
  manufacturingCorpusAnnotationSchema,
} from "./manufacturingCorpusAnnotationContract.js";

function makeEvidence() {
  return [
    {
      artifactId: "artifact-cad",
      locator: "face-012",
    },
  ];
}

function makeValidAnnotation() {
  const evidence = makeEvidence();
  return {
    schemaVersion: MANUFACTURING_CORPUS_ANNOTATION_SCHEMA_VERSION,
    annotationRevision: "1.0.0",
    caseId: "case-1",
    review: {
      state: "approved" as const,
      reviewerRole: "manufacturing_reviewer",
      reviewerRef: "user:manufacturing-reviewer",
      reviewedAt: "2026-07-30T00:00:00Z",
      reviewRef: "review:case-1:v1",
      reviewPolicyVersion: "manufacturing-review.v1",
    },
    expected: {
      productStructure: {
        definitionCount: {
          state: "known" as const,
          value: 1,
          evidence,
        },
        occurrenceCount: {
          state: "known" as const,
          value: 1,
          evidence,
        },
      },
      units: {
        length: {
          state: "known" as const,
          value: "mm" as const,
          evidence,
        },
      },
      commonFeatures: [
        {
          label: "through_hole",
          count: 2,
          parameters: {
            nominalDiameterMm: 6.35,
          },
          evidence,
        },
      ],
      requirements: [
        {
          key: "surface_finish",
          value: {
            maximumRa: 1.6,
          },
          unit: "um",
          governing: true,
          evidence,
        },
      ],
      candidateRoutes: [
        {
          processFamily: "cnc_milling" as const,
          state: "applicable" as const,
          evidence,
        },
      ],
      unsupportedStates: [
        {
          code: "freeform_profile_unresolved",
          evidence,
        },
      ],
      execution: {
        outcome: "success" as const,
        diagnosticCodes: [],
      },
    },
  };
}

describe("manufacturing corpus annotation contract", () => {
  it("parses a reviewed v1 annotation and rejects future shapes", () => {
    const annotation = makeValidAnnotation();
    expect(manufacturingCorpusAnnotationSchema.parse(annotation)).toEqual(
      annotation,
    );
    expect(
      manufacturingCorpusAnnotationSchema.safeParse({
        ...annotation,
        schemaVersion: "manufacturing-corpus-annotation.v2",
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusAnnotationSchema.safeParse({
        ...annotation,
        futureField: true,
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusAnnotationSchema.safeParse({
        ...annotation,
        review: {
          ...annotation.review,
          futureField: true,
        },
      }).success,
    ).toBe(false);
  });

  it("requires internally consistent pending and approved review provenance", () => {
    const annotation = makeValidAnnotation();
    expect(
      manufacturingCorpusAnnotationSchema.safeParse({
        ...annotation,
        review: {
          state: "pending_manufacturing_review",
          reviewerRole: null,
          reviewerRef: null,
          reviewedAt: null,
          reviewRef: null,
          reviewPolicyVersion: null,
        },
      }).success,
    ).toBe(true);
    expect(
      manufacturingCorpusAnnotationSchema.safeParse({
        ...annotation,
        review: {
          ...annotation.review,
          reviewerRef: null,
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusAnnotationSchema.safeParse({
        ...annotation,
        review: {
          state: "pending_manufacturing_review",
          reviewerRole: "manufacturing_reviewer",
          reviewerRef: null,
          reviewedAt: null,
          reviewRef: null,
          reviewPolicyVersion: null,
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["known", { state: "known", value: 2, evidence: makeEvidence() }],
    [
      "unsupported",
      {
        state: "unsupported",
        reasonCode: "assembly_not_supported",
        evidence: makeEvidence(),
      },
    ],
    [
      "not_applicable",
      {
        state: "not_applicable",
        reasonCode: "single_body",
        evidence: makeEvidence(),
      },
    ],
    [
      "parse_failed",
      {
        state: "parse_failed",
        reasonCode: "invalid_product_structure",
        evidence: makeEvidence(),
      },
    ],
  ])("preserves the %s product-structure count state", (_name, count) => {
    const annotation = makeValidAnnotation();
    expect(
      manufacturingCorpusAnnotationSchema.safeParse({
        ...annotation,
        expected: {
          ...annotation.expected,
          productStructure: {
            ...annotation.expected.productStructure,
            definitionCount: count,
          },
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    ["known", { state: "known", value: "in", evidence: makeEvidence() }],
    [
      "missing",
      {
        state: "missing",
        reasonCode: "length_unit_missing",
        evidence: makeEvidence(),
      },
    ],
    [
      "unsupported",
      {
        state: "unsupported",
        reasonCode: "length_unit_unsupported",
        evidence: makeEvidence(),
      },
    ],
    [
      "conflicting",
      {
        state: "conflicting",
        reasonCode: "drawing_model_unit_conflict",
        evidence: makeEvidence(),
      },
    ],
    [
      "parse_failed",
      {
        state: "parse_failed",
        reasonCode: "length_unit_parse_failed",
        evidence: makeEvidence(),
      },
    ],
  ])("preserves the %s length-unit state", (_name, length) => {
    const annotation = makeValidAnnotation();
    expect(
      manufacturingCorpusAnnotationSchema.safeParse({
        ...annotation,
        expected: {
          ...annotation.expected,
          units: {
            length,
          },
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    [
      "structure",
      (annotation: ReturnType<typeof makeValidAnnotation>) => {
        annotation.expected.productStructure.definitionCount.evidence = [];
      },
    ],
    [
      "units",
      (annotation: ReturnType<typeof makeValidAnnotation>) => {
        annotation.expected.units.length.evidence = [];
      },
    ],
    [
      "features",
      (annotation: ReturnType<typeof makeValidAnnotation>) => {
        annotation.expected.commonFeatures[0].evidence = [];
      },
    ],
    [
      "requirements",
      (annotation: ReturnType<typeof makeValidAnnotation>) => {
        annotation.expected.requirements[0].evidence = [];
      },
    ],
    [
      "routes",
      (annotation: ReturnType<typeof makeValidAnnotation>) => {
        annotation.expected.candidateRoutes[0].evidence = [];
      },
    ],
    [
      "unsupported states",
      (annotation: ReturnType<typeof makeValidAnnotation>) => {
        annotation.expected.unsupportedStates[0].evidence = [];
      },
    ],
  ])("requires evidence for %s", (_name, removeEvidence) => {
    const annotation = makeValidAnnotation();
    removeEvidence(annotation);
    expect(manufacturingCorpusAnnotationSchema.safeParse(annotation).success).toBe(
      false,
    );
  });

  it("rejects non-JSON feature parameters and requirement values", () => {
    const annotation = makeValidAnnotation();
    expect(
      manufacturingCorpusAnnotationSchema.safeParse({
        ...annotation,
        expected: {
          ...annotation.expected,
          commonFeatures: [
            {
              ...annotation.expected.commonFeatures[0],
              parameters: {
                invalid: new Date("2026-07-30T00:00:00Z"),
              },
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusAnnotationSchema.safeParse({
        ...annotation,
        expected: {
          ...annotation.expected,
          requirements: [
            {
              ...annotation.expected.requirements[0],
              value: Number.NaN,
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("enforces success and bounded-failure diagnostics", () => {
    const annotation = makeValidAnnotation();
    expect(
      manufacturingCorpusAnnotationSchema.safeParse({
        ...annotation,
        expected: {
          ...annotation.expected,
          execution: {
            outcome: "success",
            diagnosticCodes: ["unexpected_diagnostic"],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusAnnotationSchema.safeParse({
        ...annotation,
        expected: {
          ...annotation.expected,
          execution: {
            outcome: "bounded_failure",
            diagnosticCodes: [],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusAnnotationSchema.safeParse({
        ...annotation,
        expected: {
          ...annotation.expected,
          execution: {
            outcome: "bounded_failure",
            diagnosticCodes: ["malformed_source"],
          },
        },
      }).success,
    ).toBe(true);
  });
});
