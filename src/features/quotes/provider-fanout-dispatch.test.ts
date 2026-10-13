import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderDispatchScope } from "@/features/quotes/xometry-beta-dispatch";

const api = vi.hoisted(() => ({
  getProviderDispatchScope: vi.fn(),
  getXometryBetaDispatchScope: vi.fn(),
  requestProviderDispatch: vi.fn(),
  requestXometryBetaDispatch: vi.fn(),
}));
vi.mock("@/features/quotes/api/quote-requests-api", () => api);

import { dispatchFanoutProvider, isSameConfirmedPackage } from "@/features/quotes/provider-fanout-dispatch";

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
      createApprovalReference: () => "ref-1",
    });

    expect(api.requestProviderDispatch).toHaveBeenCalledWith({
      jobId: "job-1",
      provider: "fictiv",
      declaredModelUnits: "inch",
      expectedScopeFingerprint: "b".repeat(64),
      noticeRevision: "founding-beta-2026-08-15",
      expectedEnvelopeRevision: "fictiv-envelope.v2",
      approvalReference: "ref-1",
    });
  });

  it("refuses a package that drifted from the confirmed one without sending", async () => {
    api.getProviderDispatchScope.mockResolvedValue(scope({ provider: "fictiv" }, "d".repeat(64)));

    await expect(
      dispatchFanoutProvider({ jobId: "job-1", provider: "fictiv", declaredModelUnits: "inch", confirmedScope: scope() }),
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
      createApprovalReference: () => "ref-2",
    });

    expect(api.requestXometryBetaDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ policyRevision: "founding-beta-2026-08-15", approvalReference: "ref-2" }),
    );
    expect(api.requestProviderDispatch).not.toHaveBeenCalled();
  });
});
