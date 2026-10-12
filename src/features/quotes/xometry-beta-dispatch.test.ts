import { describe, expect, it } from "vitest";
import {
  classifyXometryBetaDispatchFailure,
  getXometryBetaDispatchDenialMessage,
  getXometryBetaDispatchDiagnosticCode,
  getXometryBetaScopeFailureMessage,
  isDispatchJobBusy,
  isExplicitXometryBetaDispatchDenial,
  isXometryBetaJobBusy,
  parseProviderDispatchResult,
  parseProviderDispatchScope,
  parseXometryBetaDispatchResult,
  parseXometryBetaDispatchScope,
} from "./xometry-beta-dispatch";
import { resolveLiveDispatchProvider } from "./live-dispatch-provider";

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
      destination: { confirmationRevision: "1", state: "confirmed", street: "123 Test Ave", city: "Tucson", region: "AZ", postalCode: "85701", country: "US" },
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

  it("fails closed when the exact destination is missing or inferred", () => {
    const scope = createScope();
    expect(() => parseXometryBetaDispatchScope({ ...scope, scope: { ...scope.scope, destination: null } })).toThrow();
    expect(() => parseXometryBetaDispatchScope({ ...scope, scope: { ...scope.scope, destination: { ...scope.scope.destination, state: "inferred" } } })).toThrow();
  });

  it.each([undefined, "", "0", "1.5", 1])("fails closed for an invalid confirmation revision %s", (confirmationRevision) => {
    const scope = createScope();
    expect(() => parseXometryBetaDispatchScope({ ...scope, scope: {
      ...scope.scope, destination: { ...scope.scope.destination, confirmationRevision },
    } })).toThrow("The Xometry confirmation scope is unavailable.");
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


describe("free admission denials", () => {
  it.each(["free_allowance_unavailable", "free_policy_unavailable"])("classifies %s as definitive without treating a transport error as denial", (reason) => {
    expect(classifyXometryBetaDispatchFailure({ message: reason }).status).toBe("denied");
    expect(classifyXometryBetaDispatchFailure(new TypeError("Failed to fetch")).status).toBe("unknown");
  });
});


it("recognizes the server rollout denial without confusing other P0001 errors with denial", () => {
  expect(classifyXometryBetaDispatchFailure({ code: "P0001", message: "automatic_quote_disabled" })).toEqual({
    accepted: false, created: false, status: "denied", diagnosticCode: "explicit_server_denial",
  });
  expect(classifyXometryBetaDispatchFailure({ code: "P0001", message: "unrecognized_failure" })).toMatchObject({
    status: "unknown", diagnosticCode: "postgrest_failure",
  });
});

describe("busy admission denial", () => {
  const busy = { code: "P0001", details: null, hint: null, message: "xometry_beta_job_busy" };

  it("maps xometry_beta_job_busy to a retry message that never claims nothing was queued", () => {
    expect(isXometryBetaJobBusy(busy)).toBe(true);
    expect(isXometryBetaJobBusy(new Error("xometry_beta_job_busy"))).toBe(true);
    expect(isXometryBetaJobBusy({ message: "xometry_beta_job_busy_other" })).toBe(false);
    expect(getXometryBetaDispatchDenialMessage(busy)).toBe(
      "This part is being updated in another session. Try again in a moment.",
    );
    expect(getXometryBetaDispatchDenialMessage(busy)).not.toMatch(/queued/i);
  });

  it("keeps a fresh busy request a definitive denial", () => {
    for (const options of [undefined, {}, { uncertainReplay: false }]) {
      expect(classifyXometryBetaDispatchFailure(busy, options)).toEqual({
        accepted: false,
        created: false,
        diagnosticCode: "explicit_server_denial",
        status: "denied",
      });
    }
  });

  it("keeps an exact uncertain replay refused as busy unknown, so its recovery stays open", () => {
    expect(classifyXometryBetaDispatchFailure(busy, { uncertainReplay: true })).toEqual({
      accepted: false,
      created: false,
      diagnosticCode: "explicit_server_denial",
      status: "unknown",
    });
    // Any other denial of the replay stays definitive.
    expect(
      classifyXometryBetaDispatchFailure({ code: "P0001", message: "xometry_beta_scope_changed" }, { uncertainReplay: true }),
    ).toMatchObject({ status: "denied" });
  });

  it("maps the generic path's provider_dispatch_job_busy to the same retry message and recovery rules", () => {
    const genericBusy = { code: "P0001", details: null, hint: null, message: "provider_dispatch_job_busy" };
    expect(isDispatchJobBusy(genericBusy)).toBe(true);
    expect(isDispatchJobBusy(busy)).toBe(true);
    expect(isDispatchJobBusy(new Error("provider_dispatch_job_busy"))).toBe(true);
    expect(isDispatchJobBusy({ message: "provider_dispatch_job_busy_other" })).toBe(false);
    expect(isDispatchJobBusy({ message: "provider_dispatch_scope_mismatch" })).toBe(false);
    // A lookalike server code is not the busy refusal, so it is not an explicit denial either.
    expect(isExplicitXometryBetaDispatchDenial(genericBusy)).toBe(true);
    expect(isExplicitXometryBetaDispatchDenial({ message: "provider_dispatch_job_busy_other" })).toBe(false);
    expect(isExplicitXometryBetaDispatchDenial({ message: "xprovider_dispatch_job_busy" })).toBe(false);
    expect(isXometryBetaJobBusy(genericBusy)).toBe(false);
    expect(getXometryBetaDispatchDenialMessage(genericBusy)).toBe(getXometryBetaDispatchDenialMessage(busy));
    expect(getXometryBetaDispatchDenialMessage(genericBusy)).not.toMatch(/queued/i);
    expect(classifyXometryBetaDispatchFailure(genericBusy)).toEqual({
      accepted: false,
      created: false,
      diagnosticCode: "explicit_server_denial",
      status: "denied",
    });
    expect(classifyXometryBetaDispatchFailure(genericBusy, { uncertainReplay: true })).toEqual({
      accepted: false,
      created: false,
      diagnosticCode: "explicit_server_denial",
      status: "unknown",
    });
  });

  it("keeps the refreshed-scope message for every other denial", () => {
    expect(getXometryBetaDispatchDenialMessage({ message: "xometry_beta_scope_changed" })).toBe(
      "The current package was not queued. Review the refreshed scope and try again.",
    );
    expect(getXometryBetaDispatchDenialMessage(new Error("xometry_beta_job_busy_other"))).toBe(
      "The current package was not queued. Review the refreshed scope and try again.",
    );
  });
});

describe("generic Fictiv dispatch contract (OVD-673)", () => {
  /** The provider-dispatch-scope.v1 preview api_get_provider_dispatch_scope returns. */
  function createFictivScope() {
    const legacy = createScope();
    const { policyRevision, ...rest } = legacy;
    return {
      ...rest,
      schema: "provider-dispatch-scope.v1",
      provider: "fictiv",
      noticeRevision: policyRevision,
      envelopeRevision: "fictiv-quote-envelope.v1",
      scope: { ...legacy.scope, vendor: "fictiv" },
    };
  }

  it("parses the generic preview and carries its notice revision as the confirmed policy revision", () => {
    expect(parseProviderDispatchScope(createFictivScope(), "fictiv")).toMatchObject({
      provider: "fictiv",
      policyRevision: "founding-beta-2026-08-15",
      envelopeRevision: "fictiv-quote-envelope.v1",
      scope: { vendor: "fictiv" },
    });
  });

  it.each([
    ["the legacy Xometry preview", () => createScope()],
    ["a missing generic schema", () => ({ ...createFictivScope(), schema: undefined })],
    ["an unknown generic schema", () => ({ ...createFictivScope(), schema: "provider-dispatch-scope.v2" })],
    ["a Xometry-scoped lane", () => ({ ...createFictivScope(), scope: { ...createFictivScope().scope, vendor: "xometry" } })],
    ["another provider", () => ({ ...createFictivScope(), provider: "protolabs" })],
    ["a missing notice revision", () => ({ ...createFictivScope(), noticeRevision: undefined })],
  ])("fails closed for %s", (_label, scope) => {
    expect(() => parseProviderDispatchScope(scope(), "fictiv")).toThrow("The Fictiv confirmation scope is unavailable.");
  });

  it("never accepts a Fictiv preview on the Xometry path", () => {
    expect(() => parseXometryBetaDispatchScope(createFictivScope())).toThrow(
      "The Xometry confirmation scope is unavailable.",
    );
  });

  it("requires a queued generic result to name Fictiv", () => {
    const queued = {
      accepted: true,
      created: true,
      deduplicated: false,
      permitId: "permit-1",
      quoteRequestId: "request-1",
      quoteRunId: "run-1",
      scopeFingerprint: "a".repeat(64),
      status: "queued",
    };
    expect(parseProviderDispatchResult({ ...queued, provider: "fictiv" }, "fictiv")).toMatchObject({ accepted: true });
    expect(() => parseProviderDispatchResult(queued, "fictiv")).toThrow("The Fictiv quote request was not queued.");
    expect(() => parseProviderDispatchResult({ ...queued, provider: "xometry" }, "fictiv")).toThrow();
  });

  it("treats every generic server refusal as definitive, but not internal invariants or lookalikes", () => {
    for (const code of [
      "provider_dispatch_admission_disabled",
      "provider_dispatch_provider_envelope_unknown",
      "provider_dispatch_rollout_disabled",
      "provider_dispatch_scope_mismatch",
      "provider_dispatch_trusted_cad_required",
      "provider_dispatch_commercial_entitlement_required",
      "provider_dispatch_permit_expired",
      "provider_dispatch_permit_revoked",
    ]) {
      expect(classifyXometryBetaDispatchFailure({ code: "P0001", message: code })).toMatchObject({ status: "denied" });
    }
    for (const code of [
      "provider_dispatch_created_lane_mismatch",
      "provider_dispatch_admission_disabled_other",
      "xprovider_dispatch_scope_mismatch",
    ]) {
      expect(classifyXometryBetaDispatchFailure({ code: "P0001", message: code })).toMatchObject({ status: "unknown" });
    }
  });

  it("names the configured provider in scope failure copy", () => {
    expect(getXometryBetaScopeFailureMessage({ message: "provider_dispatch_admission_disabled" }, "fictiv")).toBe(
      "This package is not currently eligible for controlled Fictiv beta dispatch. Review its access, files, and manufacturing requirements.",
    );
    expect(getXometryBetaScopeFailureMessage(new Error("boom"), "fictiv")).toBe(
      "The current Fictiv confirmation scope could not be verified. Try the scope check again.",
    );
  });

  it("selects Fictiv only for the exact configured value", () => {
    expect(resolveLiveDispatchProvider(undefined)).toBe("xometry");
    expect(resolveLiveDispatchProvider("")).toBe("xometry");
    expect(resolveLiveDispatchProvider("xometry")).toBe("xometry");
    expect(resolveLiveDispatchProvider("protolabs")).toBe("xometry");
    expect(resolveLiveDispatchProvider(" Fictiv ")).toBe("fictiv");
  });
});
