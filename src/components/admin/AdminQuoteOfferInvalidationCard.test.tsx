import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminQuoteOfferInvalidationCard } from "./AdminQuoteOfferInvalidationCard";

const apiMock = vi.hoisted(() => ({
  fetchCommercialAdminAccess: vi.fn(),
  invalidateAdminVendorQuoteOffer: vi.fn(),
}));

vi.mock("@/features/quotes/api/commercial-admin-access-api", () => ({
  fetchCommercialAdminAccess: apiMock.fetchCommercialAdminAccess,
}));
vi.mock("@/features/quotes/api/manual-quote-admin-api", () => ({
  invalidateAdminVendorQuoteOffer: apiMock.invalidateAdminVendorQuoteOffer,
}));
vi.mock("@/components/auth/MfaStepUpDialog", () => ({
  MfaStepUpDialog: ({ open, onVerified }: { open: boolean; onVerified: () => Promise<void> }) =>
    open ? <button onClick={() => void onVerified()}>Complete MFA</button> : null,
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const offer = {
  id: "offer-1",
  supplier: "Xometry",
  valid_until: "2026-09-10T23:59:59.999Z",
  invalidated_at: null,
} as never;

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AdminQuoteOfferInvalidationCard jobId="job-1" offers={[offer]} />
    </QueryClientProvider>,
  );
}

describe("AdminQuoteOfferInvalidationCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("crypto", { randomUUID: () => "attempt-1" });
    apiMock.invalidateAdminVendorQuoteOffer.mockResolvedValue({
      offerId: "offer-1",
      invalidatedAt: "2026-08-12T12:00:00.000Z",
      alreadyInvalidated: false,
      auditEventId: "event-1",
    });
  });

  it("requires MFA and a reason before invalidating an offer", async () => {
    apiMock.fetchCommercialAdminAccess.mockResolvedValue({
      hasCapability: true,
      hasAal2: false,
    });
    renderCard();

    fireEvent.change(await screen.findByLabelText("Invalidation reason"), {
      target: { value: "Vendor withdrew pricing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Invalidate" }));
    expect(apiMock.invalidateAdminVendorQuoteOffer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Complete MFA" }));
    await waitFor(() => expect(apiMock.invalidateAdminVendorQuoteOffer).toHaveBeenCalledWith({
      offerId: "offer-1",
      reason: "Vendor withdrew pricing",
      idempotencyKey: "quote-offer-invalidate:offer-1:attempt-1",
    }));
  });
});
