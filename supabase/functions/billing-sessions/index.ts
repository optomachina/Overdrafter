import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const BILLING_STRIPE_API_VERSION =
  "2024-11-20.acacia" as Stripe.LatestApiVersion;
export const PRO_MONTHLY_AMOUNT_CENTS = 4_900;

type BillingAction = "checkout" | "portal";
type EnvironmentReader = (name: string) => string | undefined;

type RpcError = {
  code?: string;
  message: string;
};

type RpcResult = {
  data: unknown;
  error: RpcError | null;
};

type AuthUser = {
  email?: string;
  id: string;
};

export type BillingUserClient = {
  auth: {
    getUser(): PromiseLike<{
      data: { user: AuthUser | null };
      error: RpcError | null;
    }>;
  };
  rpc(
    functionName: string,
    parameters: Record<string, unknown>,
  ): PromiseLike<RpcResult>;
};

export type BillingServiceClient = {
  rpc(
    functionName: string,
    parameters: Record<string, unknown>,
  ): PromiseLike<RpcResult>;
};

export type BillingStripeClient = {
  billingPortal: {
    sessions: {
      create(
        parameters: Stripe.BillingPortal.SessionCreateParams,
      ): PromiseLike<Stripe.BillingPortal.Session>;
    };
  };
  checkout: {
    sessions: {
      create(
        parameters: Stripe.Checkout.SessionCreateParams,
        options?: Stripe.RequestOptions,
      ): PromiseLike<Stripe.Checkout.Session>;
      list(
        parameters: Stripe.Checkout.SessionListParams,
      ): PromiseLike<{ data: Stripe.Checkout.Session[] }>;
    };
  };
  customers: {
    create(
      parameters: Stripe.CustomerCreateParams,
      options?: Stripe.RequestOptions,
    ): PromiseLike<Stripe.Customer>;
  };
  prices: {
    retrieve(
      priceId: string,
      parameters?: Stripe.PriceRetrieveParams,
    ): PromiseLike<Stripe.Price>;
  };
  subscriptions: {
    list(
      parameters: Stripe.SubscriptionListParams,
    ): PromiseLike<{ data: Stripe.Subscription[] }>;
  };
};

export type BillingRuntime = {
  appBaseUrl: URL;
  expectedLivemode: boolean;
  proMonthlyPriceId: string;
  serviceClient: BillingServiceClient;
  stripe: BillingStripeClient;
  userClientForAuthorization(authorization: string): BillingUserClient;
};

type RuntimeLoader = (
  getEnvironmentVariable: EnvironmentReader,
) => BillingRuntime;

type BillingPreparation = {
  organizationId: string;
  organizationName: string;
  stripeCustomerId?: string;
  stripeLivemode?: boolean;
};

const ORGANIZATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRICE_ID_PATTERN = /^price_[A-Za-z0-9]+$/;
const CUSTOMER_ID_PATTERN = /^cus_[A-Za-z0-9]+$/;
const CHECKOUT_SESSION_ID_PATTERN = /^cs_(?:test_|live_)?[A-Za-z0-9]+$/;

let cachedRuntime: BillingRuntime | undefined;

function corsHeaders() {
  return {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": "*",
  };
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json",
    },
  });
}

function parseBoolean(value: string | undefined): boolean | null {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}

function parseAppBaseUrl(value: string | undefined): URL | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    const isLocalHttp = url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (url.protocol !== "https:" && !isLocalHttp) {
      return null;
    }
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function loadBillingRuntime(
  getEnvironmentVariable: EnvironmentReader,
): BillingRuntime {
  if (cachedRuntime) {
    return cachedRuntime;
  }

  const appBaseUrl = parseAppBaseUrl(
    getEnvironmentVariable("OVERDRAFTER_APP_URL"),
  );
  const expectedLivemode = parseBoolean(
    getEnvironmentVariable("STRIPE_EXPECTED_LIVEMODE"),
  );
  const proMonthlyPriceId = getEnvironmentVariable(
    "STRIPE_PRO_MONTHLY_PRICE_ID",
  )?.trim();
  const stripeSecretKey = getEnvironmentVariable("STRIPE_SECRET_KEY");
  const supabaseAnonKey = getEnvironmentVariable("SUPABASE_ANON_KEY");
  const supabaseServiceRoleKey = getEnvironmentVariable(
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  const supabaseUrl = getEnvironmentVariable("SUPABASE_URL");

  if (!appBaseUrl || expectedLivemode === null) {
    throw new Error("Missing billing environment configuration.");
  }
  if (!proMonthlyPriceId || !PRICE_ID_PATTERN.test(proMonthlyPriceId)) {
    throw new Error("Missing Stripe Pro price configuration.");
  }
  if (!stripeSecretKey) {
    throw new Error("Missing Stripe secret configuration.");
  }
  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    throw new Error("Missing Supabase environment configuration.");
  }

  const stripe = new Stripe(stripeSecretKey, {
    apiVersion: BILLING_STRIPE_API_VERSION,
    typescript: true,
  });
  const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as BillingServiceClient;

  cachedRuntime = {
    appBaseUrl,
    expectedLivemode,
    proMonthlyPriceId,
    serviceClient,
    stripe,
    userClientForAuthorization: (authorization) =>
      createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false },
      }) as unknown as BillingUserClient,
  };

  return cachedRuntime;
}

function parseRequestPayload(
  payload: unknown,
): { action: BillingAction; organizationId: string } | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const allowedKeys = new Set(["action", "organizationId"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    return null;
  }

  if (
    record.action !== "checkout" &&
    record.action !== "portal"
  ) {
    return null;
  }
  if (
    typeof record.organizationId !== "string" ||
    !ORGANIZATION_ID_PATTERN.test(record.organizationId)
  ) {
    return null;
  }

  return {
    action: record.action,
    organizationId: record.organizationId,
  };
}

function parseBillingPreparation(data: unknown): BillingPreparation | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }

  const record = data as Record<string, unknown>;
  if (
    typeof record.organizationId !== "string" ||
    !ORGANIZATION_ID_PATTERN.test(record.organizationId) ||
    typeof record.organizationName !== "string" ||
    record.organizationName.trim().length === 0
  ) {
    return null;
  }
  if (
    record.stripeCustomerId !== undefined &&
    (
      typeof record.stripeCustomerId !== "string" ||
      !CUSTOMER_ID_PATTERN.test(record.stripeCustomerId)
    )
  ) {
    return null;
  }
  if (
    record.stripeLivemode !== undefined &&
    typeof record.stripeLivemode !== "boolean"
  ) {
    return null;
  }

  return {
    organizationId: record.organizationId,
    organizationName: record.organizationName.trim(),
    stripeCustomerId: record.stripeCustomerId as string | undefined,
    stripeLivemode: record.stripeLivemode as boolean | undefined,
  };
}

function buildReturnUrl(
  appBaseUrl: URL,
  state: "cancelled" | "portal_return" | "success",
): string {
  const url = new URL(appBaseUrl);
  url.searchParams.set("billing", state);
  return url.toString();
}

function isValidHostedUrl(url: string | null | undefined): url is string {
  if (!url) {
    return false;
  }
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function isBlockingSubscription(subscription: Stripe.Subscription): boolean {
  return subscription.status !== "canceled" &&
    subscription.status !== "incomplete_expired";
}

function findReusableCheckoutSession(
  sessions: Stripe.Checkout.Session[],
  organizationId: string,
  priceId: string,
): Stripe.Checkout.Session | null {
  return sessions.find((session) =>
    session.status === "open" &&
    session.mode === "subscription" &&
    session.client_reference_id === organizationId &&
    session.metadata?.organization_id === organizationId &&
    session.metadata?.plan === "pro" &&
    session.metadata?.billing_interval === "month" &&
    session.metadata?.stripe_price_id === priceId &&
    isValidHostedUrl(session.url)
  ) ?? null;
}

function isValidMonthlyProPrice(
  price: Stripe.Price,
  configuredPriceId: string,
  expectedLivemode: boolean,
): boolean {
  if (
    price.id !== configuredPriceId ||
    !price.active ||
    price.livemode !== expectedLivemode ||
    price.currency.toLowerCase() !== "usd" ||
    price.unit_amount !== PRO_MONTHLY_AMOUNT_CENTS ||
    price.type !== "recurring" ||
    price.recurring?.interval !== "month" ||
    price.recurring.interval_count !== 1
  ) {
    return false;
  }

  const product = price.product;
  if (typeof product === "string") {
    return false;
  }
  if ("deleted" in product && product.deleted) {
    return false;
  }

  return product.active === true;
}

async function resolveStripeCustomer(
  runtime: BillingRuntime,
  preparation: BillingPreparation,
): Promise<string> {
  if (preparation.stripeCustomerId) {
    if (preparation.stripeLivemode !== runtime.expectedLivemode) {
      throw new Error("billing_customer_mode_mismatch");
    }
    return preparation.stripeCustomerId;
  }

  const customer = await runtime.stripe.customers.create(
    {
      metadata: {
        organization_id: preparation.organizationId,
        product: "overdrafter",
      },
      name: preparation.organizationName,
    },
    {
      idempotencyKey:
        `overdrafter:organization:${preparation.organizationId}:customer`,
    },
  );

  if (
    !CUSTOMER_ID_PATTERN.test(customer.id) ||
    customer.livemode !== runtime.expectedLivemode
  ) {
    throw new Error("billing_customer_invalid");
  }

  const { data, error } = await runtime.serviceClient.rpc(
    "api_bind_organization_stripe_customer",
    {
      p_livemode: runtime.expectedLivemode,
      p_organization_id: preparation.organizationId,
      p_stripe_customer_id: customer.id,
    },
  );
  if (error) {
    throw new Error("billing_customer_binding_failed");
  }

  const bound = parseBillingPreparation({
    organizationId: preparation.organizationId,
    organizationName: preparation.organizationName,
    ...(
      data && typeof data === "object" && !Array.isArray(data)
        ? data as Record<string, unknown>
        : {}
    ),
  });
  if (
    !bound?.stripeCustomerId ||
    bound.stripeCustomerId !== customer.id ||
    bound.stripeLivemode !== runtime.expectedLivemode
  ) {
    throw new Error("billing_customer_binding_invalid");
  }

  return bound.stripeCustomerId;
}

function safeErrorStatus(error: RpcError): number {
  if (
    error.message.includes("billing owner") ||
    error.message.includes("access")
  ) {
    return 403;
  }
  return 500;
}

/**
 * Creates the authenticated billing-session boundary.
 *
 * The browser supplies only an organization and action. Stripe object IDs,
 * catalog values, mode, and redirect URLs come exclusively from server
 * configuration and guarded database state.
 */
export function createBillingSessionHandler(
  getEnvironmentVariable: EnvironmentReader = (name) => Deno.env.get(name),
  loadRuntime: RuntimeLoader = loadBillingRuntime,
  now: () => number = Date.now,
) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return json(405, { error: "Method not allowed." });
    }
    if (getEnvironmentVariable("BILLING_SELF_SERVICE_ENABLED") !== "true") {
      return json(503, {
        error:
          "Pro billing is temporarily unavailable. Free sourcing remains available.",
      });
    }

    const authorization = request.headers.get("Authorization");
    if (!authorization) {
      return json(401, { error: "You must be signed in to continue." });
    }

    let requestPayload: unknown;
    try {
      requestPayload = await request.json();
    } catch {
      return json(400, { error: "Invalid request body." });
    }
    const payload = parseRequestPayload(requestPayload);
    if (!payload) {
      return json(400, { error: "Invalid billing request." });
    }

    let runtime: BillingRuntime;
    try {
      runtime = loadRuntime(getEnvironmentVariable);
    } catch {
      console.error("billing-sessions: runtime configuration failed");
      return json(503, {
        error:
          "Pro billing is temporarily unavailable. Free sourcing remains available.",
      });
    }

    const userClient = runtime.userClientForAuthorization(authorization);
    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();
    if (userError || !user) {
      return json(401, { error: "You must be signed in to continue." });
    }

    const { data: preparationData, error: preparationError } = await userClient
      .rpc("api_prepare_organization_billing_session", {
        p_organization_id: payload.organizationId,
      });
    if (preparationError) {
      return json(safeErrorStatus(preparationError), {
        error: safeErrorStatus(preparationError) === 403
          ? "Only the organization billing owner can manage this subscription."
          : "Billing access could not be confirmed. Try again.",
      });
    }

    const preparation = parseBillingPreparation(preparationData);
    if (
      !preparation ||
      preparation.organizationId !== payload.organizationId
    ) {
      console.error("billing-sessions: invalid preparation response");
      return json(500, {
        error: "Billing access could not be confirmed. Try again.",
      });
    }

    try {
      if (payload.action === "portal") {
        if (!preparation.stripeCustomerId) {
          return json(409, {
            error: "This organization does not have a billing account yet.",
          });
        }
        if (preparation.stripeLivemode !== runtime.expectedLivemode) {
          console.error("billing-sessions: customer mode mismatch");
          return json(503, {
            error:
              "Billing management is temporarily unavailable. Try again later.",
          });
        }

        const portalSession = await runtime.stripe.billingPortal.sessions
          .create({
            customer: preparation.stripeCustomerId,
            return_url: buildReturnUrl(runtime.appBaseUrl, "portal_return"),
          });
        if (!isValidHostedUrl(portalSession.url)) {
          throw new Error("billing_portal_url_invalid");
        }
        return json(200, { url: portalSession.url });
      }

      const price = await runtime.stripe.prices.retrieve(
        runtime.proMonthlyPriceId,
        { expand: ["product"] },
      );
      if (
        !isValidMonthlyProPrice(
          price,
          runtime.proMonthlyPriceId,
          runtime.expectedLivemode,
        )
      ) {
        console.error(
          "billing-sessions: configured Pro price failed validation",
        );
        return json(503, {
          error:
            "Pro checkout is temporarily unavailable. Free sourcing remains available.",
        });
      }

      const { error: priceConfigurationError } = await runtime.serviceClient
        .rpc(
          "api_configure_stripe_pro_price",
          {
            p_livemode: runtime.expectedLivemode,
            p_stripe_price_id: runtime.proMonthlyPriceId,
          },
        );
      if (priceConfigurationError) {
        throw new Error("billing_price_allowlist_failed");
      }

      const customerId = await resolveStripeCustomer(runtime, preparation);
      const subscriptions = await runtime.stripe.subscriptions.list({
        customer: customerId,
        limit: 100,
        status: "all",
      });
      if (subscriptions.data.some(isBlockingSubscription)) {
        return json(409, {
          error:
            "This organization already has a Stripe subscription. Use Manage billing instead.",
        });
      }

      const openCheckoutSessions = await runtime.stripe.checkout.sessions.list({
        customer: customerId,
        limit: 10,
        status: "open",
      });
      const reusableCheckoutSession = findReusableCheckoutSession(
        openCheckoutSessions.data,
        preparation.organizationId,
        runtime.proMonthlyPriceId,
      );
      if (reusableCheckoutSession) {
        const { error: auditError } = await runtime.serviceClient.rpc(
          "api_record_billing_checkout_started",
          {
            p_actor_user_id: user.id,
            p_organization_id: preparation.organizationId,
            p_stripe_checkout_session_id: reusableCheckoutSession.id,
          },
        );
        if (auditError) {
          throw new Error("billing_checkout_audit_failed");
        }
        return json(200, { url: reusableCheckoutSession.url });
      }

      const checkoutSession = await runtime.stripe.checkout.sessions.create(
        {
          allow_promotion_codes: false,
          cancel_url: buildReturnUrl(runtime.appBaseUrl, "cancelled"),
          client_reference_id: preparation.organizationId,
          customer: customerId,
          line_items: [
            {
              price: runtime.proMonthlyPriceId,
              quantity: 1,
            },
          ],
          metadata: {
            billing_interval: "month",
            organization_id: preparation.organizationId,
            plan: "pro",
            stripe_price_id: runtime.proMonthlyPriceId,
          },
          mode: "subscription",
          subscription_data: {
            metadata: {
              billing_interval: "month",
              organization_id: preparation.organizationId,
              plan: "pro",
            },
          },
          success_url: buildReturnUrl(runtime.appBaseUrl, "success"),
        },
        {
          idempotencyKey:
            `overdrafter:organization:${preparation.organizationId}:pro-checkout:${
              Math.floor(now() / 900_000)
            }`,
        },
      );
      if (
        !CHECKOUT_SESSION_ID_PATTERN.test(checkoutSession.id) ||
        !isValidHostedUrl(checkoutSession.url)
      ) {
        throw new Error("billing_checkout_session_invalid");
      }

      const { error: auditError } = await runtime.serviceClient.rpc(
        "api_record_billing_checkout_started",
        {
          p_actor_user_id: user.id,
          p_organization_id: preparation.organizationId,
          p_stripe_checkout_session_id: checkoutSession.id,
        },
      );
      if (auditError) {
        throw new Error("billing_checkout_audit_failed");
      }

      return json(200, { url: checkoutSession.url });
    } catch {
      console.error("billing-sessions: Stripe session creation failed");
      return json(502, {
        error:
          "Stripe could not open billing right now. Free sourcing remains available.",
      });
    }
  };
}

if (import.meta.main) {
  Deno.serve(createBillingSessionHandler());
}
