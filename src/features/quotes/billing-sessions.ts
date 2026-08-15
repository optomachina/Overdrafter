import { supabase } from "@/integrations/supabase/client";

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

function readErrorResponse(
  error: unknown,
  response: Response | undefined,
): Response | null {
  if (response instanceof Response) {
    return response;
  }
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return null;
  }

  const context = (error as { context?: unknown }).context;
  return context instanceof Response ? context : null;
}

async function readFunctionErrorMessage(
  data: unknown,
  error: unknown,
  response: Response | undefined,
): Promise<string | null> {
  const messageFromData = readErrorMessage(data);
  if (messageFromData) {
    return messageFromData;
  }

  const errorResponse = readErrorResponse(error, response);
  if (!errorResponse) {
    return null;
  }

  try {
    return readErrorMessage(await errorResponse.clone().json());
  } catch {
    return null;
  }
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
 * Requests a server-owned Stripe Billing Portal session for an existing
 * subscription.
 *
 * The client intentionally sends no Stripe identifiers, prices, amounts,
 * billing modes, or redirect URLs.
 */
export async function requestBillingPortalSession(
  organizationId: string,
): Promise<string> {
  const { data, error, response } = await supabase.functions.invoke("billing-sessions", {
    body: {
      action: "portal",
      organizationId,
    },
  });

  const customerSafeError = await readFunctionErrorMessage(
    data,
    error,
    response,
  );
  if (error || customerSafeError) {
    throw new Error(
      customerSafeError ??
        "Billing could not be opened. Your current product access is unchanged.",
    );
  }

  const url = readHostedBillingUrl(data);
  if (!url) {
    throw new Error(
      "Billing could not be opened. Your current product access is unchanged.",
    );
  }

  return url;
}

export async function openBillingPortal(
  organizationId: string,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): Promise<void> {
  const url = await requestBillingPortalSession(organizationId);
  navigate(url);
}
