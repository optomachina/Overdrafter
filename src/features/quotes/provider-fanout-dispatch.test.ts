import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderDispatchScope } from "@/features/quotes/xometry-beta-dispatch";

const api = vi.hoisted(() => ({
  getProviderDispatchScope: vi.fn(),
  getXometryBetaDispatchScope: vi.fn(),
  requestProviderDispatch: vi.fn(),
  requestXometryBetaDispatch: vi.fn(),
}));
vi.mock("@/features/quotes/api/quote-requests-api", () => api);

import {
  deriveFanoutApprovalReference,
  dispatchFanoutProvider,
  isSameConfirmedPackage,
} from "@/features/quotes/provider-fanout-dispatch";

const CONFIRMATION_REFERENCE = "6f1c2a4e-8b3d-4c5e-9f7a-0123456789ab";

function scope(overrides: Partial<ProviderDispatchScope> = {}, cadSha = "c".repeat(64)): ProviderDispatchScope {
  return {
    organizationId: "org-1",
    jobId: "job-1",
    partId: "part-1",
    provider: "xometry",
    requestedQuantity: 10,
    scopeVersion: 1,
    scopeFingerprint: "a".repeat(64),
    declaredModelUnits: "inch",
    policyRevision: "founding-beta-2026-08-15",
    envelopeRevision: "xometry-envelope.v1",
    scope: {
      schema: "quote-lane-scope.v1",
      vendor: "xometry",
      quantity: 10,
      destination: {
        confirmationRevision: "1",
        state: "confirmed",
        street: "1 Main St",
        city: "Austin",
        region: "TX",
        postalCode: "78701",
        country: "US",
      },
      part: {
        id: "part-1",
        cad: { fileId: "cad-1", sha256: cadSha, name: "part.step", mimeType: null, sizeBytes: 10 },
        drawing: null,
      },
      requirements: {
        id: "req-1",
        capturedAt: "2026-10-13T00:00:00Z",
        description: null,
        partNumber: null,
        revision: null,
        material: "6061",
        finish: null,
        tightestToleranceInch: 0.005,
        requestedDeliveryDate: null,
        specification: { process: "CNC milling" },
      },
    },
    ...overrides,
  };
}

describe("dispatchFanoutProvider", () => {
  beforeEach(() => vi.resetAllMocks());

  it("sends one generic request with the provider's own scope revisions", async () => {
    api.getProviderDispatchScope.mockResolvedValue(
      scope({ provider: "fictiv", scopeFingerprint: "b".repeat(64), envelopeRevision: "fictiv-envelope.v2" }),
    );
    api.requestProviderDispatch.mockResolvedValue({ created: true });

    await dispatchFanoutProvider({
      jobId: "job-1",
      provider: "fictiv",
      declaredModelUnits: "inch",
      confirmedScope: scope(),
      confirmationReference: CONFIRMATION_REFERENCE,
    });

    expect(api.requestProviderDispatch).toHaveBeenCalledWith({
      jobId: "job-1",
      provider: "fictiv",
      declaredModelUnits: "inch",
      expectedScopeFingerprint: "b".repeat(64),
      noticeRevision: "founding-beta-2026-08-15",
      expectedEnvelopeRevision: "fictiv-envelope.v2",
      approvalReference: await deriveFanoutApprovalReference(CONFIRMATION_REFERENCE, "fictiv"),
    });
  });

  it("refuses a package that drifted from the confirmed one without sending", async () => {
    api.getProviderDispatchScope.mockResolvedValue(scope({ provider: "fictiv" }, "d".repeat(64)));

    await expect(
      dispatchFanoutProvider({
        jobId: "job-1",
        provider: "fictiv",
        declaredModelUnits: "inch",
        confirmedScope: scope(),
        confirmationReference: CONFIRMATION_REFERENCE,
      }),
    ).rejects.toThrow("provider_dispatch_scope_mismatch");
    expect(api.requestProviderDispatch).not.toHaveBeenCalled();
    expect(isSameConfirmedPackage(scope(), scope({ requestedQuantity: 11 }))).toBe(false);
  });

  it("uses the legacy Xometry path when Xometry is an extra provider", async () => {
    api.getXometryBetaDispatchScope.mockResolvedValue(scope());
    api.requestXometryBetaDispatch.mockResolvedValue({ created: false });

    await dispatchFanoutProvider({
      jobId: "job-1",
      provider: "xometry",
      declaredModelUnits: "inch",
      confirmedScope: scope({ provider: "fictiv" }),
      confirmationReference: CONFIRMATION_REFERENCE,
    });

    expect(api.requestXometryBetaDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        policyRevision: "founding-beta-2026-08-15",
        approvalReference: await deriveFanoutApprovalReference(CONFIRMATION_REFERENCE, "xometry"),
      }),
    );
    expect(api.requestProviderDispatch).not.toHaveBeenCalled();
  });

  it("refuses an extra when the requirement row was edited after review under the same id", async () => {
    // The dialog showed 6061 at plus or minus 0.005; a second tab then edits
    // the same approved_part_requirements row to titanium at 0.0005.
    const confirmed = scope();
    const edited = scope({ provider: "fictiv", scopeFingerprint: "e".repeat(64) });
    edited.scope = {
      ...edited.scope,
      vendor: "fictiv",
      requirements: {
        ...edited.scope.requirements,
        id: confirmed.scope.requirements.id,
        capturedAt: "2026-10-13T00:05:00Z",
        material: "Titanium Grade 5",
        tightestToleranceInch: 0.0005,
      },
    };
    api.getProviderDispatchScope.mockResolvedValue(edited);

    await expect(
      dispatchFanoutProvider({
        jobId: "job-1",
        provider: "fictiv",
        declaredModelUnits: "inch",
        confirmedScope: confirmed,
        confirmationReference: CONFIRMATION_REFERENCE,
      }),
    ).rejects.toThrow("provider_dispatch_scope_mismatch");
    expect(api.requestProviderDispatch).not.toHaveBeenCalled();
  });

  it("compares every reviewed field but ignores provider specific ones", () => {
    const base = scope();
    const withRequirement = (changes: Partial<ProviderDispatchScope["scope"]["requirements"]>) => ({
      ...base,
      scope: { ...base.scope, requirements: { ...base.scope.requirements, ...changes } },
    });

    expect(
      isSameConfirmedPackage(
        base,
        scope({
          provider: "fictiv",
          scopeFingerprint: "f".repeat(64),
          envelopeRevision: "fictiv-envelope.v2",
          scope: { ...base.scope, vendor: "fictiv" },
        }),
      ),
    ).toBe(true);
    expect(isSameConfirmedPackage(base, withRequirement({ capturedAt: "2026-10-14T00:00:00Z" }))).toBe(false);
    expect(isSameConfirmedPackage(base, withRequirement({ material: "7075" }))).toBe(false);
    expect(isSameConfirmedPackage(base, withRequirement({ finish: "Anodized" }))).toBe(false);
    expect(isSameConfirmedPackage(base, withRequirement({ tightestToleranceInch: 0.001 }))).toBe(false);
    expect(isSameConfirmedPackage(base, withRequirement({ requestedDeliveryDate: "2026-11-01" }))).toBe(false);
    expect(isSameConfirmedPackage(base, withRequirement({ specification: { process: "CNC turning" } }))).toBe(false);
    expect(isSameConfirmedPackage(base, { ...base, scope: { ...base.scope, quantity: 11 } })).toBe(false);
    expect(
      isSameConfirmedPackage(base, {
        ...base,
        scope: { ...base.scope, part: { ...base.scope.part, cad: { ...base.scope.part.cad, name: "other.step" } } },
      }),
    ).toBe(false);
    // Key order inside the specification does not matter.
    expect(
      isSameConfirmedPackage(
        withRequirement({ specification: { process: "CNC milling", thread: "none" } }),
        withRequirement({ specification: { thread: "none", process: "CNC milling" } }),
      ),
    ).toBe(true);
  });
});

describe("deriveFanoutApprovalReference", () => {
  it("derives a stable version 5 UUID per provider from the confirmation reference", async () => {
    const fictiv = await deriveFanoutApprovalReference(CONFIRMATION_REFERENCE, "fictiv");

    // Matches RFC 9562 uuid5(confirmation reference, "provider-fanout:fictiv").
    expect(fictiv).toBe("0b673c5f-2661-5117-8011-217b09c9fa76");
    expect(await deriveFanoutApprovalReference(CONFIRMATION_REFERENCE, "fictiv")).toBe(fictiv);
    expect(await deriveFanoutApprovalReference(CONFIRMATION_REFERENCE, "sendcutsend")).not.toBe(fictiv);
    expect(fictiv).not.toBe(CONFIRMATION_REFERENCE);
    await expect(deriveFanoutApprovalReference("not-a-uuid", "fictiv")).rejects.toThrow(TypeError);
  });
});
