import { beforeEach, describe, expect, it, vi } from "vitest";
import { acceptFoundingBetaNotice, getFoundingBetaAccess } from "./founding-beta-api";

const mockCallRpc = vi.hoisted(() => vi.fn());

vi.mock("@/features/quotes/api/shared/rpc", () => ({ callRpc: mockCallRpc }));

const ELIGIBLE = {
  state: "eligible",
  policyRevision: "founding-beta-2026-08-15",
  termsPath: "/legal/beta-terms",
  privacyPath: "/legal/privacy",
};

describe("Founding Beta access API", () => {
  beforeEach(() => mockCallRpc.mockReset());

  it("queries the exact target organization", async () => {
    mockCallRpc.mockResolvedValue({ data: ELIGIBLE, error: null });

    await expect(getFoundingBetaAccess("org-project")).resolves.toEqual(ELIGIBLE);
    expect(mockCallRpc).toHaveBeenCalledWith("api_get_founding_beta_access_state", {
      p_organization_id: "org-project",
    });
  });

  it("accepts only the revision returned by the access query", async () => {
    mockCallRpc.mockResolvedValue({ data: ELIGIBLE, error: null });

    await acceptFoundingBetaNotice({
      organizationId: "org-project",
      policyRevision: ELIGIBLE.policyRevision,
    });

    expect(mockCallRpc).toHaveBeenCalledWith("api_accept_founding_beta_notice", {
      p_organization_id: "org-project",
      p_policy_revision: ELIGIBLE.policyRevision,
    });
  });

  it("rejects malformed server payloads instead of enabling access", async () => {
    mockCallRpc.mockResolvedValue({ data: { state: "eligible" }, error: null });

    await expect(getFoundingBetaAccess("org-project")).rejects.toThrow("could not be verified");
  });
});
