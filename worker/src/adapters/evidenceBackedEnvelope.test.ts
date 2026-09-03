// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { ProviderCapabilityEnvelope } from "../generated/provider-catalog.js";
import {
  createEvidenceBackedEnvelopeEvaluator,
  OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY,
  type EvidenceBackedEnvelopeInput,
  type EvidenceBackedEnvelopePolicy,
} from "./evidenceBackedEnvelope.js";

const envelope = {
  version: 1,
  processes: { status: "supported", values: ["cnc_machining"] },
  materials: { status: "supported", values: ["aluminum_6061"] },
  files: { status: "supported", values: ["step", "stp"] },
  quantity: { status: "supported", minimum: 1, maximum: 10 },
  tolerance: { status: "supported", minimumMm: 0.01, maximumMm: 0.1 },
  geometry: { status: "unknown", constraints: [] },
  drawings: { status: "unknown", values: [] },
  accountModes: { status: "supported", values: ["existing_authenticated_account"] },
} as const satisfies ProviderCapabilityEnvelope;

function input(overrides: Partial<EvidenceBackedEnvelopeInput> = {}): EvidenceBackedEnvelopeInput {
  return {
    process: "cnc_machining",
    material: "aluminum_6061",
    fileName: "part.step",
    quantity: 1,
    accountMode: "existing_authenticated_account",
    drawingIncluded: false,
    explicitToleranceRequirement: false,
    explicitGeometryRequirements: false,
    ...overrides,
  };
}

function policy(overrides: Partial<EvidenceBackedEnvelopePolicy> = {}) {
  return {
    providerKey: "fixture",
    envelopeRevision: "fixture-envelope.v1",
    envelope,
    quantityMaximum: "bounded",
    drawingDisposition: "unknown",
    toleranceDisposition: "supported",
    geometryDisposition: "unknown",
    ...overrides,
  } satisfies EvidenceBackedEnvelopePolicy;
}

describe("evidence-backed envelope evaluator", () => {
  it("accepts only a fully evidenced package without granting runtime authority", () => {
    const evaluate = createEvidenceBackedEnvelopeEvaluator(policy());
    expect(evaluate(input())).toMatchObject({
      providerKey: "fixture",
      state: "eligible_for_evaluation",
      reasonCodes: ["eligible_evidence_backed_envelope"],
      authorizationBoundary: OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY,
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid quantity %s",
    (quantity) => {
      const evaluate = createEvidenceBackedEnvelopeEvaluator(policy());
      expect(evaluate(input({ quantity }))).toMatchObject({
        state: "unsupported",
        reasonCodes: expect.arrayContaining(["quantity_invalid"]),
      });
    },
  );

  it("distinguishes bounded, unknown, and evidenced-unbounded quantity policies", () => {
    expect(createEvidenceBackedEnvelopeEvaluator(policy())(input({ quantity: 11 }))).toMatchObject({
      state: "unsupported",
      reasonCodes: expect.arrayContaining(["quantity_outside_supported_range"]),
    });
    expect(createEvidenceBackedEnvelopeEvaluator(policy({
      envelope: { ...envelope, quantity: { status: "supported", minimum: 1, maximum: null } },
      quantityMaximum: "unknown",
    }))(input({ quantity: 2 }))).toMatchObject({
      state: "unknown",
      reasonCodes: expect.arrayContaining(["quantity_above_reviewed_minimum_unknown"]),
    });
    expect(createEvidenceBackedEnvelopeEvaluator(policy({
      envelope: { ...envelope, quantity: { status: "supported", minimum: 1, maximum: null } },
      quantityMaximum: "unbounded",
    }))(input({ quantity: 100_000 }))).toMatchObject({ state: "eligible_for_evaluation" });
  });

  it("keeps non-evidenced identity and package fields unknown", () => {
    const evaluate = createEvidenceBackedEnvelopeEvaluator(policy());
    const decision = evaluate(input({
      process: "sheet_fabrication",
      material: "steel",
      fileName: "part.obj",
      accountMode: "guest",
    }));
    expect(decision).toMatchObject({
      state: "unknown",
      reasonCodes: expect.arrayContaining([
        "process_unknown",
        "material_unknown",
        "file_format_unknown",
        "account_mode_unknown",
      ]),
    });
  });

  it("routes reviewed file and requirement cases to manual review", () => {
    const evaluate = createEvidenceBackedEnvelopeEvaluator(policy({
      manualReviewFileExtensions: ["sldprt"],
      drawingDisposition: "manual_review",
      toleranceDisposition: "manual_review",
      geometryDisposition: "manual_review",
    }));
    expect(evaluate(input({ fileName: "part.SLDPRT" }))).toMatchObject({
      state: "manual_review",
      reasonCodes: ["file_requires_manual_review"],
    });
    expect(evaluate(input({ drawingIncluded: true }))).toMatchObject({
      state: "manual_review",
      reasonCodes: ["drawings_require_manual_review"],
    });
  });

  it("requires an exact evidenced numeric tolerance when tolerance is requested", () => {
    const evaluate = createEvidenceBackedEnvelopeEvaluator(policy());
    expect(evaluate(input({
      explicitToleranceRequirement: true,
      requestedToleranceMm: 0.05,
    }))).toMatchObject({ state: "eligible_for_evaluation" });
    expect(evaluate(input({ explicitToleranceRequirement: true }))).toMatchObject({
      state: "unknown",
      reasonCodes: expect.arrayContaining(["tolerance_requirement_unknown"]),
    });
  });

  it("never marks a guidance-only provider eligible for automated evaluation", () => {
    const evaluate = createEvidenceBackedEnvelopeEvaluator(policy({ guidanceOnly: true }));
    expect(evaluate(input())).toMatchObject({
      state: "manual_review",
      reasonCodes: ["guidance_only_provider"],
      authorizationBoundary: OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY,
    });
  });
});
