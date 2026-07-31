import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  openHostedBillingSession,
  requestHostedBillingSession,
} from "./billing-sessions";

const supabaseMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: supabaseMocks.invoke,
    },
  },
}));

describe("billing sessions", () => {
  beforeEach(() => {
    supabaseMocks.invoke.mockReset();
  });

  it("sends only the organization and server-owned billing action", async () => {
    supabaseMocks.invoke.mockResolvedValue({
      data: { url: "https://checkout.stripe.com/c/pay/test" },
      error: null,
    });

    await expect(
      requestHostedBillingSession("org-1", "checkout"),
    ).resolves.toBe("https://checkout.stripe.com/c/pay/test");

    expect(supabaseMocks.invoke).toHaveBeenCalledWith("billing-sessions", {
      body: {
        action: "checkout",
        organizationId: "org-1",
      },
    });
  });

  it("surfaces the customer-safe server error", async () => {
    supabaseMocks.invoke.mockResolvedValue({
      data: {
        error:
          "Pro billing is temporarily unavailable. Free sourcing remains available.",
      },
      error: new Error("FunctionsHttpError"),
    });

    await expect(
      requestHostedBillingSession("org-1", "checkout"),
    ).rejects.toThrow(
      "Pro billing is temporarily unavailable. Free sourcing remains available.",
    );
  });

  it("rejects non-HTTPS hosted URLs", async () => {
    supabaseMocks.invoke.mockResolvedValue({
      data: { url: "javascript:alert(1)" },
      error: null,
    });

    await expect(
      requestHostedBillingSession("org-1", "portal"),
    ).rejects.toThrow("Billing could not be opened");
  });

  it("navigates only after the server returns a valid hosted URL", async () => {
    supabaseMocks.invoke.mockResolvedValue({
      data: { url: "https://billing.stripe.com/p/session/test" },
      error: null,
    });
    const assign = vi.fn();

    await openHostedBillingSession("org-1", "portal", assign);

    expect(assign).toHaveBeenCalledWith(
      "https://billing.stripe.com/p/session/test",
    );
  });
});
