import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  openBillingPortal,
  requestBillingPortalSession,
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

  it("can request only the portal action for an existing subscription", async () => {
    supabaseMocks.invoke.mockResolvedValue({
      data: { url: "https://billing.stripe.com/p/session/test" },
      error: null,
    });

    await expect(
      requestBillingPortalSession("org-1"),
    ).resolves.toBe("https://billing.stripe.com/p/session/test");

    expect(supabaseMocks.invoke).toHaveBeenCalledWith("billing-sessions", {
      body: {
        action: "portal",
        organizationId: "org-1",
      },
    });
  });

  it("surfaces the customer-safe server error", async () => {
    const response = new Response(
      JSON.stringify({
        error: "Billing is temporarily unavailable. Your current product access is unchanged.",
      }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      },
    );
    supabaseMocks.invoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error("FunctionsHttpError"), {
        context: response,
      }),
      response,
    });

    await expect(
      requestBillingPortalSession("org-1"),
    ).rejects.toThrow(
      "Billing is temporarily unavailable. Your current product access is unchanged.",
    );
  });

  it("rejects non-HTTPS hosted URLs", async () => {
    supabaseMocks.invoke.mockResolvedValue({
      data: { url: "javascript:alert(1)" },
      error: null,
    });

    await expect(
      requestBillingPortalSession("org-1"),
    ).rejects.toThrow("Billing could not be opened");
  });

  it("navigates only after the server returns a valid hosted URL", async () => {
    supabaseMocks.invoke.mockResolvedValue({
      data: { url: "https://billing.stripe.com/p/session/test" },
      error: null,
    });
    const assign = vi.fn();

    await openBillingPortal("org-1", assign);

    expect(assign).toHaveBeenCalledWith(
      "https://billing.stripe.com/p/session/test",
    );
  });
});
