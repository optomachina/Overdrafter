import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { StripePaymentPanel } from "@/components/quotes/StripePaymentPanel";

// Mock @stripe/stripe-js so tests don't make real network calls
vi.mock("@stripe/stripe-js", () => ({
  loadStripe: vi.fn(() => Promise.resolve(null)),
}));

// Mock @stripe/react-stripe-js
vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardElement: () => <div data-testid="card-element" />,
  useStripe: () => null,
  useElements: () => null,
}));

// Mock supabase client: the panel now reads the user's session access token
// instead of trusting the anon key, so tests need a stubbed session.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(() =>
        Promise.resolve({ data: { session: { access_token: "test-access-token" } } }),
      ),
    },
  },
}));

const defaultProps = {
  projectId: "proj-123",
  amountLabel: "$2,500.00",
};

describe("StripePaymentPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the Proceed to payment button initially", () => {
    render(<StripePaymentPanel {...defaultProps} />);
    expect(screen.getByRole("button", { name: /proceed to payment/i })).toBeInTheDocument();
  });

  it("shows loading state while setting up payment intent", async () => {
    // Keep the fetch pending so we can observe the loading state
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(<StripePaymentPanel {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: /proceed to payment/i }));

    await waitFor(() => {
      expect(screen.getByText(/setting up payment/i)).toBeInTheDocument();
    });

    vi.unstubAllGlobals();
  });

  it("shows error message when create-payment-intent returns 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: "Payment setup failed. Try again or contact support." }),
        }),
      ),
    );

    render(<StripePaymentPanel {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: /proceed to payment/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/payment setup failed\. try again or contact support\./i),
      ).toBeInTheDocument();
    });

    vi.unstubAllGlobals();
  });

  it("shows error message on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("Network error"))),
    );

    render(<StripePaymentPanel {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: /proceed to payment/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/payment setup failed\. try again or contact support\./i),
      ).toBeInTheDocument();
    });

    vi.unstubAllGlobals();
  });

  it("displays amount in the panel description", () => {
    render(<StripePaymentPanel {...defaultProps} />);
    expect(screen.getByText(/\$2,500\.00/)).toBeInTheDocument();
  });

  it("does not show the confirmation section before payment", () => {
    // Full paid-state flow is covered by E2E with Stripe test mode; here we
    // only assert the pre-payment initial state.
    render(<StripePaymentPanel {...defaultProps} />);
    expect(screen.queryByText(/payment confirmed/i)).not.toBeInTheDocument();
  });
});
