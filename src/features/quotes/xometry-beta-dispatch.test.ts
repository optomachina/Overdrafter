import { describe, expect, it } from "vitest";
import {
  classifyXometryBetaDispatchFailure,
  getXometryBetaDispatchDiagnosticCode,
  isExplicitXometryBetaDispatchDenial,
  parseXometryBetaDispatchResult,
  parseXometryBetaDispatchScope,
} from "./xometry-beta-dispatch";

function createScope() {
  return {
    organizationId: "org-1",
    jobId: "job-1",
    partId: "part-1",
    provider: "xometry",
    requestedQuantity: 1,
    scopeVersion: 1,
    scopeFingerprint: "a".repeat(64),
    declaredModelUnits: "inch",
    policyRevision: "founding-beta-2026-08-15",
    envelopeRevision: "xometry-controlled-beta-envelope.v1",
    scope: {
      schema: "quote-lane-scope.v1",
      vendor: "xometry",
      quantity: 1,
      part: {
        id: "part-1",
        cad: {
          fileId: "cad-1",
          sha256: "b".repeat(64),
          name: "validation.step",
          mimeType: "application/step",
          sizeBytes: 1024,
        },
        drawing: null,
      },
      requirements: {
        id: "requirements-1",
        capturedAt: "2026-08-15T00:00:00Z",
        description: "Validation bracket",
        partNumber: "VALIDATION-001",
        revision: "A",
        material: "6061-T6",
        finish: null,
        tightestToleranceInch: 0.005,
        requestedDeliveryDate: null,
        specification: {},
      },
    },
  };
}

describe("Xometry beta dispatch contracts", () => {
  it("parses an exact Xometry scope", () => {
    expect(parseXometryBetaDispatchScope(createScope())).toMatchObject({
      provider: "xometry",
      requestedQuantity: 1,
      declaredModelUnits: "inch",
    });
  });

  it.each([
    ["wrong provider", { provider: "fictiv" }],
    ["missing fingerprint", { scopeFingerprint: "" }],
    ["short fingerprint", { scopeFingerprint: "a".repeat(63) }],
    ["unsupported units", { declaredModelUnits: "centimeter" }],
    ["quantity drift", { requestedQuantity: 2 }],
    ["nonpositive quantity", { requestedQuantity: 0, scope: { ...createScope().scope, quantity: 0 } }],
    ["invalid scope version", { scopeVersion: 0 }],
  ])("fails closed for %s", (_label, override) => {
    expect(() => parseXometryBetaDispatchScope({ ...createScope(), ...override })).toThrow(
      "The Xometry confirmation scope is unavailable.",
    );
  });

  it("fails closed when a trusted file hash is malformed", () => {
    const scope = createScope();
    scope.scope.part.cad.sha256 = "not-a-sha256";

    expect(() => parseXometryBetaDispatchScope(scope)).toThrow(
      "The Xometry confirmation scope is unavailable.",
    );
  });

  it("fails closed when the nested part identity drifts", () => {
    const scope = createScope();
    scope.scope.part.id = "part-2";

    expect(() => parseXometryBetaDispatchScope(scope)).toThrow(
      "The Xometry confirmation scope is unavailable.",
    );
  });

  it.each([-1, 1.5])("fails closed for invalid file size %s", (sizeBytes) => {
    const scope = createScope();
    scope.scope.part.cad.sizeBytes = sizeBytes;

    expect(() => parseXometryBetaDispatchScope(scope)).toThrow(
      "The Xometry confirmation scope is unavailable.",
    );
  });

  it("fails closed for a negative tolerance", () => {
    const scope = createScope();
    scope.scope.requirements.tightestToleranceInch = -0.005;

    expect(() => parseXometryBetaDispatchScope(scope)).toThrow(
      "The Xometry confirmation scope is unavailable.",
    );
  });

  it("rejects a non-queued dispatch result", () => {
    expect(() => parseXometryBetaDispatchResult({ accepted: false, status: "denied" })).toThrow(
      "The Xometry quote request was not queued.",
    );
  });

  it("recognizes explicit denials from Supabase plain error objects", () => {
    const error = {
      code: "P0001",
      details: null,
      hint: null,
      message: "xometry_beta_new_lane_required",
    };

    expect(isExplicitXometryBetaDispatchDenial(error)).toBe(true);
    expect(getXometryBetaDispatchDiagnosticCode(error)).toBe("explicit_server_denial");
    expect(classifyXometryBetaDispatchFailure(error)).toEqual({
      accepted: false,
      created: false,
      diagnosticCode: "explicit_server_denial",
      status: "denied",
    });
  });

  it.each([
    [{ code: "PGRST003", message: "Database unavailable" }, "postgrest_failure"],
    [new TypeError("The Xometry quote request was not queued."), "invalid_server_response"],
    [new TypeError("Failed to fetch"), "network_failure"],
    [{ message: "Unexpected failure" }, "unknown_failure"],
  ] as const)("returns bounded diagnostics for ambiguous failure %#", (error, expected) => {
    expect(isExplicitXometryBetaDispatchDenial(error)).toBe(false);
    expect(getXometryBetaDispatchDiagnosticCode(error)).toBe(expected);
    expect(classifyXometryBetaDispatchFailure(error)).toMatchObject({
      diagnosticCode: expected,
      status: "unknown",
    });
  });
});
