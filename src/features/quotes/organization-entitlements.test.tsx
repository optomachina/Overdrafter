import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOrganizationQuoteCollectionMode } from "./organization-entitlements";

const { callUntypedRpcMock } = vi.hoisted(() => ({
  callUntypedRpcMock: vi.fn(),
}));

vi.mock("@/features/quotes/api/shared/rpc", () => ({
  callUntypedRpc: callUntypedRpcMock,
}));

vi.mock("@/features/quotes/client-workspace-fixtures", () => ({
  isFixtureModeEnabled: () => false,
}));

describe("useOrganizationQuoteCollectionMode", () => {
  beforeEach(() => {
    callUntypedRpcMock.mockReset();
  });

  it("starts a fresh request when the hook is re-enabled during an older request", async () => {
    let resolveFirstRequest: ((value: unknown) => void) | undefined;
    callUntypedRpcMock
      .mockImplementationOnce(() =>
        new Promise((resolve) => {
          resolveFirstRequest = resolve;
        })
      )
      .mockResolvedValueOnce({
        data: {
          automaticQuoteCollection: true,
          canManageBilling: true,
          hasStripeSubscription: true,
          plan: "pro",
          source: "subscription_active",
        },
        error: null,
      });

    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useOrganizationQuoteCollectionMode("organization-1", enabled),
      { initialProps: { enabled: true } },
    );

    await waitFor(() => expect(callUntypedRpcMock).toHaveBeenCalledTimes(1));
    rerender({ enabled: false });
    rerender({ enabled: true });

    await waitFor(() => expect(callUntypedRpcMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.plan).toBe("pro"));

    await act(async () => {
      resolveFirstRequest?.({
        data: {
          automaticQuoteCollection: false,
          canManageBilling: false,
          hasStripeSubscription: false,
          plan: "free",
          source: "stale",
        },
        error: null,
      });
      await Promise.resolve();
    });

    expect(result.current.plan).toBe("pro");
  });
});
