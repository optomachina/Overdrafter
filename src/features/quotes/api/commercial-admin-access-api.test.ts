import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCommercialAdminAccess } from "./commercial-admin-access-api";

const { callUntypedRpcMock } = vi.hoisted(() => ({
  callUntypedRpcMock: vi.fn(),
}));

vi.mock("./shared/rpc", () => ({
  callUntypedRpc: callUntypedRpcMock,
}));

describe("commercial-admin-access-api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads billing-admin capability and AAL2 independently", async () => {
    callUntypedRpcMock
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: false, error: null });

    await expect(fetchCommercialAdminAccess()).resolves.toEqual({
      hasCapability: true,
      hasAal2: false,
    });
    expect(callUntypedRpcMock).toHaveBeenNthCalledWith(
      1,
      "current_user_has_commercial_capability",
      { p_capability: "billing_admin" },
    );
    expect(callUntypedRpcMock).toHaveBeenNthCalledWith(
      2,
      "current_user_has_aal2",
    );
  });

  it.each([
    [
      "capability",
      { data: "true", error: null },
      { data: true, error: null },
    ],
    ["AAL2", { data: true, error: null }, { data: 1, error: null }],
  ])(
    "fails closed for a non-boolean %s response",
    async (_label, capability, aal2) => {
      callUntypedRpcMock
        .mockResolvedValueOnce(capability)
        .mockResolvedValueOnce(aal2);

      await expect(fetchCommercialAdminAccess()).rejects.toThrow(TypeError);
    },
  );

  it.each([
    [
      "capability",
      { data: null, error: { message: "Access lookup failed." } },
      { data: true, error: null },
    ],
    [
      "AAL2",
      { data: true, error: null },
      { data: null, error: { message: "AAL lookup failed." } },
    ],
  ])("propagates the %s RPC error", async (_label, capability, aal2) => {
    callUntypedRpcMock
      .mockResolvedValueOnce(capability)
      .mockResolvedValueOnce(aal2);

    await expect(fetchCommercialAdminAccess()).rejects.toEqual(
      capability.error ?? aal2.error,
    );
  });
});
