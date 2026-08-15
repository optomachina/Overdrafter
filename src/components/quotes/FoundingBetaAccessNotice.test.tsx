import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FoundingBetaAccessNotice } from "./FoundingBetaAccessNotice";

const mockAcceptNotice = vi.hoisted(() => vi.fn());
const mockAccess = vi.hoisted(() => ({
  status: "notice_required" as "notice_required" | "eligible" | "not_enrolled" | "revoked" | "unavailable",
  access: {
    state: "notice_required",
    policyRevision: "revision-1",
    termsPath: "/returned-terms",
    privacyPath: "/returned-privacy",
  } as Record<string, string> | null,
  canUpload: false,
  acceptNotice: mockAcceptNotice,
  isAcceptingNotice: false,
  acceptanceError: null,
  refetch: vi.fn(),
}));

vi.mock("@/features/quotes/use-founding-beta-access", () => ({
  useFoundingBetaAccess: () => mockAccess,
}));

describe("FoundingBetaAccessNotice", () => {
  beforeEach(() => {
    mockAcceptNotice.mockReset().mockResolvedValue(undefined);
    mockAccess.status = "notice_required";
    mockAccess.access = {
      state: "notice_required",
      policyRevision: "revision-1",
      termsPath: "/returned-terms",
      privacyPath: "/returned-privacy",
    };
  });

  it("uses the server-returned policy links and accepts only notice-required access", async () => {
    render(<FoundingBetaAccessNotice organizationId="org-1" userId="user-1" />);

    expect(screen.getByRole("link", { name: /Beta terms/ })).toHaveAttribute("href", "/returned-terms");
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/returned-privacy");
    fireEvent.click(screen.getByRole("button", { name: "Accept current notice" }));
    await waitFor(() => expect(mockAcceptNotice).toHaveBeenCalledOnce());
  });

  it("explains revocation while preserving existing records", () => {
    mockAccess.status = "revoked";
    mockAccess.access = null;
    render(<FoundingBetaAccessNotice organizationId="org-1" userId="user-1" />);

    expect(screen.getByText(/Existing parts and quotes remain available/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept current notice" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Contact support" })).toHaveAttribute(
      "href",
      "mailto:support@overdrafter.com",
    );
  });
});
