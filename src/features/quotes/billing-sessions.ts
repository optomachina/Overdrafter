import { supabase } from "@/integrations/supabase/client";

export type HostedBillingAction = "checkout" | "portal";

type BillingSessionResponse = {
  error?: unknown;
  url?: unknown;
};

function readErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const error = (data as BillingSessionResponse).error;
  return typeof error === "string" && error.trim() ? error.trim() : null;
}

function readHostedBillingUrl(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const value = (data as BillingSessionResponse).url;
  if (typeof value !== "string") {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Requests a server-owned Stripe Checkout or Billing Portal session.
 *
 * The client intentionally sends no Stripe identifiers, prices, amounts,
 * billing modes, or redirect URLs.
 */
export async function requestHostedBillingSession(
  organizationId: string,
  action: HostedBillingAction,
): Promise<string> {
  const { data, error } = await supabase.functions.invoke("billing-sessions", {
    body: {
      action,
      organizationId,
    },
  });

  const customerSafeError = readErrorMessage(data);
  if (error || customerSafeError) {
    throw new Error(
      customerSafeError ??
        "Billing could not be opened. Free sourcing remains available.",
    );
  }

  const url = readHostedBillingUrl(data);
  if (!url) {
    throw new Error(
      "Billing could not be opened. Free sourcing remains available.",
    );
  }

  return url;
}

export async function openHostedBillingSession(
  organizationId: string,
  action: HostedBillingAction,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): Promise<void> {
  const url = await requestHostedBillingSession(organizationId, action);
  navigate(url);
}
