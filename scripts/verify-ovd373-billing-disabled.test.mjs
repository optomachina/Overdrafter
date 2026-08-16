import { describe, expect, it, vi } from "vitest";
import {
  BILLING_DISABLED_ERROR,
  OVD373_BILLING_PROJECT_REF,
  getProjectRefFromPublicJwt,
  verifyHostedBillingDisabled,
} from "./verify-ovd373-billing-disabled.mjs";

function publicJwt(projectRef = OVD373_BILLING_PROJECT_REF) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ ref: projectRef, role: "anon" })}.signature`;
}

function response(status, payload) {
  return {
    status,
    json: vi.fn().mockResolvedValue(payload),
  };
}

describe("OVD-373 hosted billing-disabled verifier", () => {
  it("accepts only the exact pre-auth Founding Beta response", async () => {
    const token = publicJwt();
    const fetchImpl = vi.fn().mockResolvedValue(response(503, { error: BILLING_DISABLED_ERROR }));

    await expect(verifyHostedBillingDisabled({ fetchImpl, publicJwt: token })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://${OVD373_BILLING_PROJECT_REF}.supabase.co/functions/v1/billing-sessions`,
      expect.objectContaining({
        method: "POST",
        headers: {
          apikey: token,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "checkout",
          organizationId: "00000000-0000-4000-8000-000000000000",
        }),
      }),
    );
  });

  it.each([
    [200, { error: BILLING_DISABLED_ERROR }],
    [401, { error: BILLING_DISABLED_ERROR }],
    [503, { error: "Pro billing is temporarily unavailable. Free sourcing remains available." }],
    [503, { error: "New subscriptions are temporarily unavailable." }],
    [503, {}],
  ])("rejects status %s with a non-authoritative response", async (status, payload) => {
    const fetchImpl = vi.fn().mockResolvedValue(response(status, payload));
    await expect(
      verifyHostedBillingDisabled({ fetchImpl, publicJwt: publicJwt() }),
    ).rejects.toThrow("did not prove the disabled boundary");
  });

  it("rejects malformed JSON and network failures", async () => {
    const malformedFetch = vi.fn().mockResolvedValue({
      status: 503,
      json: vi.fn().mockRejectedValue(new Error("bad json")),
    });
    await expect(
      verifyHostedBillingDisabled({ fetchImpl: malformedFetch, publicJwt: publicJwt() }),
    ).rejects.toThrow("non-JSON");

    const failedFetch = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(
      verifyHostedBillingDisabled({ fetchImpl: failedFetch, publicJwt: publicJwt() }),
    ).rejects.toThrow("offline");
  });

  it("rejects a public JWT from another project before sending", async () => {
    const fetchImpl = vi.fn();
    expect(() => getProjectRefFromPublicJwt(publicJwt("other-project"))).toThrow(
      "does not belong to the production project",
    );
    await expect(
      verifyHostedBillingDisabled({ fetchImpl, publicJwt: publicJwt("other-project") }),
    ).rejects.toThrow("does not belong to the production project");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
