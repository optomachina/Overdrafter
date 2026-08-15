import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFoundingBetaAccess } from "./use-founding-beta-access";

const mockGetAccess = vi.hoisted(() => vi.fn());
const mockAcceptNotice = vi.hoisted(() => vi.fn());

vi.mock("@/features/quotes/api/founding-beta-api", () => ({
  getFoundingBetaAccess: mockGetAccess,
  acceptFoundingBetaNotice: mockAcceptNotice,
}));

const NOTICE_REQUIRED = {
  state: "notice_required" as const,
  policyRevision: "revision-1",
  termsPath: "/legal/beta-terms",
  privacyPath: "/legal/privacy",
};
const ELIGIBLE = { ...NOTICE_REQUIRED, state: "eligible" as const };

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useFoundingBetaAccess", () => {
  beforeEach(() => {
    mockGetAccess.mockReset().mockResolvedValue(NOTICE_REQUIRED);
    mockAcceptNotice.mockReset().mockResolvedValue(ELIGIBLE);
  });

  it("is fail-closed until the target user and organization resolve", () => {
    const { result } = renderHook(
      () => useFoundingBetaAccess({ organizationId: undefined, userId: undefined }),
      { wrapper: createWrapper() },
    );

    expect(result.current.status).toBe("unavailable");
    expect(result.current.canUpload).toBe(false);
    expect(mockGetAccess).not.toHaveBeenCalled();
  });

  it("stays fail-closed when the authoritative query fails", async () => {
    mockGetAccess.mockRejectedValue(new Error("network unavailable"));
    const { result } = renderHook(
      () => useFoundingBetaAccess({ organizationId: "org-1", userId: "user-1" }),
      { wrapper: createWrapper() },
    );

    expect(result.current.canUpload).toBe(false);
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.canUpload).toBe(false);
  });

  it("binds acceptance to the queried revision and immediately enables uploads", async () => {
    const { result } = renderHook(
      () => useFoundingBetaAccess({ organizationId: "org-1", userId: "user-1" }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.status).toBe("notice_required"));
    await act(async () => result.current.acceptNotice());

    expect(mockAcceptNotice).toHaveBeenCalledWith({
      organizationId: "org-1",
      policyRevision: "revision-1",
    });
    await waitFor(() => expect(result.current.status).toBe("eligible"));
    expect(result.current.canUpload).toBe(true);
  });

  it("refreshes the current revision after stale acceptance is rejected", async () => {
    const revisionTwo = {
      ...NOTICE_REQUIRED,
      policyRevision: "revision-2",
      termsPath: "/legal/beta-terms-v2",
    };
    mockGetAccess
      .mockResolvedValueOnce(NOTICE_REQUIRED)
      .mockResolvedValue(revisionTwo);
    mockAcceptNotice.mockRejectedValue(new Error("The current Founding Beta notice must be accepted."));
    const { result } = renderHook(
      () => useFoundingBetaAccess({ organizationId: "org-1", userId: "user-1" }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.access?.policyRevision).toBe("revision-1"));
    await act(async () => {
      await expect(result.current.acceptNotice()).rejects.toThrow("current Founding Beta notice");
    });
    expect(mockGetAccess).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.access?.policyRevision).toBe("revision-2"));
    expect(result.current.access?.termsPath).toBe("/legal/beta-terms-v2");
  });
});
