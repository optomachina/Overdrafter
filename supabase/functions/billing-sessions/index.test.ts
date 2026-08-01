import { assertEquals, assertObjectMatch } from "@std/assert";
import type Stripe from "stripe";
import {
  type BillingRuntime,
  type BillingServiceClient,
  type BillingStripeClient,
  type BillingUserClient,
  createBillingSessionHandler,
  PRO_MONTHLY_AMOUNT_CENTS,
} from "./index.ts";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000002281";
const USER_ID = "00000000-0000-4000-8000-000000002282";
const RESERVATION_TOKEN = "00000000-0000-4000-8000-000000002289";

function request(
  body: Record<string, unknown>,
  authorization = "Bearer ovd228",
) {
  return new Request(
    "https://example.test/functions/v1/billing-sessions",
    {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

function validPrice(
  overrides: Partial<Stripe.Price> = {},
): Stripe.Price {
  return {
    active: true,
    billing_scheme: "per_unit",
    created: 1_785_469_200,
    currency: "usd",
    currency_options: null,
    custom_unit_amount: null,
    id: "price_OVD228Pro",
    livemode: false,
    lookup_key: null,
    metadata: {},
    nickname: null,
    object: "price",
    product: {
      active: true,
      created: 1_785_469_200,
      default_price: null,
      description: null,
      id: "prod_OVD228",
      images: [],
      livemode: false,
      marketing_features: [],
      metadata: {},
      name: "OverDrafter Pro",
      object: "product",
      package_dimensions: null,
      shippable: null,
      statement_descriptor: null,
      tax_code: null,
      type: "service",
      unit_label: null,
      updated: 1_785_469_200,
      url: null,
    },
    recurring: {
      interval: "month",
      interval_count: 1,
      meter: null,
      trial_period_days: null,
      usage_type: "licensed",
    },
    tax_behavior: "unspecified",
    tiers_mode: null,
    transform_quantity: null,
    type: "recurring",
    unit_amount: PRO_MONTHLY_AMOUNT_CENTS,
    unit_amount_decimal: String(PRO_MONTHLY_AMOUNT_CENTS),
    ...overrides,
  } as Stripe.Price;
}

function makeRuntime(options: {
  checkoutSessions?: Stripe.Checkout.Session[];
  preparation?: Record<string, unknown>;
  preparationError?: { message: string };
  price?: Stripe.Price;
  reservation?: { acquired: boolean; reservationToken?: string };
  reservations?: Array<{
    acquired: boolean;
    reservationToken?: string;
    stripeCheckoutSessionId?: string;
  }>;
  rpc?: BillingServiceClient["rpc"];
  subscriptions?: Stripe.Subscription[];
  user?: { id: string } | null;
} = {}) {
  const calls = {
    checkout: [] as Array<{
      options: Stripe.RequestOptions | undefined;
      parameters: Stripe.Checkout.SessionCreateParams;
    }>,
    checkoutList: [] as Stripe.Checkout.SessionListParams[],
    customer: [] as Array<{
      options: Stripe.RequestOptions | undefined;
      parameters: Stripe.CustomerCreateParams;
    }>,
    portal: [] as Stripe.BillingPortal.SessionCreateParams[],
    price: [] as Array<{
      id: string;
      parameters: Stripe.PriceRetrieveParams | undefined;
    }>,
    rpc: [] as Array<{
      name: string;
      parameters: Record<string, unknown>;
    }>,
    subscriptionList: [] as Stripe.SubscriptionListParams[],
  };

  const userClient: BillingUserClient = {
    auth: {
      getUser: () =>
        Promise.resolve({
          data: { user: options.user === null ? null : { id: USER_ID } },
          error: options.user === null ? { message: "not signed in" } : null,
        }),
    },
    rpc: (name, parameters) => {
      assertEquals(name, "api_prepare_organization_billing_session");
      assertEquals(parameters, { p_organization_id: ORGANIZATION_ID });
      return Promise.resolve({
        data: options.preparation ?? {
          organizationId: ORGANIZATION_ID,
          organizationName: "OVD 228 Optics",
        },
        error: options.preparationError ?? null,
      });
    },
  };

  let reservationIndex = 0;
  const defaultRpc: BillingServiceClient["rpc"] = (name, parameters) => {
    calls.rpc.push({ name, parameters });
    if (name === "api_bind_organization_stripe_customer") {
      return Promise.resolve({
        data: {
          organizationId: ORGANIZATION_ID,
          stripeCustomerId: "cus_OVD228",
          stripeLivemode: false,
        },
        error: null,
      });
    }
    if (name === "api_acquire_organization_billing_checkout") {
      const sequencedReservation = options.reservations?.[reservationIndex];
      reservationIndex += 1;
      return Promise.resolve({
        data: sequencedReservation ?? options.reservation ?? {
          acquired: true,
          reservationToken: RESERVATION_TOKEN,
        },
        error: null,
      });
    }
    return Promise.resolve({ data: {}, error: null });
  };

  const stripe: BillingStripeClient = {
    billingPortal: {
      sessions: {
        create: (parameters) => {
          calls.portal.push(parameters);
          return Promise.resolve({
            configuration: "bpc_OVD228",
            created: 1_785_469_200,
            customer: "cus_OVD228",
            id: "bps_OVD228",
            livemode: false,
            locale: null,
            object: "billing_portal.session",
            on_behalf_of: null,
            return_url: parameters.return_url ?? null,
            url: "https://billing.stripe.com/p/session/ovd228",
          } as Stripe.BillingPortal.Session);
        },
      },
    },
    checkout: {
      sessions: {
        create: (parameters, requestOptions) => {
          calls.checkout.push({ parameters, options: requestOptions });
          return Promise.resolve({
            id: "cs_test_OVD228",
            object: "checkout.session",
            url: "https://checkout.stripe.com/c/pay/ovd228",
          } as Stripe.Checkout.Session);
        },
        list: (parameters) => {
          calls.checkoutList.push(parameters);
          return Promise.resolve({
            data: options.checkoutSessions ?? [],
          });
        },
      },
    },
    customers: {
      create: (parameters, requestOptions) => {
        calls.customer.push({ parameters, options: requestOptions });
        return Promise.resolve({
          id: "cus_OVD228",
          livemode: false,
          object: "customer",
        } as Stripe.Customer);
      },
    },
    prices: {
      retrieve: (id, parameters) => {
        calls.price.push({ id, parameters });
        return Promise.resolve(options.price ?? validPrice());
      },
    },
    subscriptions: {
      list: (parameters) => {
        calls.subscriptionList.push(parameters);
        return Promise.resolve({
          data: options.subscriptions ?? [],
        });
      },
    },
  };

  const runtime: BillingRuntime = {
    appBaseUrl: new URL("https://app.overdrafter.com/"),
    expectedLivemode: false,
    proMonthlyPriceId: "price_OVD228Pro",
    serviceClient: {
      rpc: options.rpc ?? defaultRpc,
    },
    stripe,
    userClientForAuthorization: () => userClient,
  };

  return { calls, runtime };
}

function enabledEnvironment(name: string) {
  return name === "BILLING_SELF_SERVICE_ENABLED" ? "true" : "configured";
}

Deno.test("disabled billing degrades before loading secrets or Stripe", async () => {
  let loaded = false;
  const handler = createBillingSessionHandler(
    () => "false",
    () => {
      loaded = true;
      throw new Error("runtime must not load");
    },
  );

  const response = await handler(
    request({ action: "checkout", organizationId: ORGANIZATION_ID }),
  );

  assertEquals(response.status, 503);
  assertEquals(await response.json(), {
    error:
      "Pro billing is temporarily unavailable. Free sourcing remains available.",
  });
  assertEquals(loaded, false);
});

Deno.test("rejects client-supplied Stripe and redirect identifiers", async () => {
  let loaded = false;
  const handler = createBillingSessionHandler(
    enabledEnvironment,
    () => {
      loaded = true;
      throw new Error("runtime must not load");
    },
  );

  const response = await handler(
    request({
      action: "checkout",
      organizationId: ORGANIZATION_ID,
      priceId: "price_attacker",
      successUrl: "https://attacker.example",
    }),
  );

  assertEquals(response.status, 400);
  assertEquals(await response.json(), { error: "Invalid billing request." });
  assertEquals(loaded, false);
});

Deno.test("requires a valid authenticated user", async () => {
  const { runtime } = makeRuntime({ user: null });
  const handler = createBillingSessionHandler(
    enabledEnvironment,
    () => runtime,
  );

  const response = await handler(
    request({ action: "checkout", organizationId: ORGANIZATION_ID }),
  );

  assertEquals(response.status, 401);
  assertEquals(await response.json(), {
    error: "You must be signed in to continue.",
  });
});

Deno.test("denies non-owner and cross-organization billing access", async () => {
  const { calls, runtime } = makeRuntime({
    preparationError: {
      message:
        "Only the organization billing owner can manage this subscription.",
    },
  });
  const handler = createBillingSessionHandler(
    enabledEnvironment,
    () => runtime,
  );

  const response = await handler(
    request({ action: "checkout", organizationId: ORGANIZATION_ID }),
  );

  assertEquals(response.status, 403);
  assertEquals(calls.price.length, 0);
  assertEquals(calls.checkout.length, 0);
});

Deno.test("refuses Checkout when the configured catalog entry is not exactly $49 monthly", async () => {
  const { calls, runtime } = makeRuntime({
    price: validPrice({ unit_amount: 4_800 }),
  });
  const handler = createBillingSessionHandler(
    enabledEnvironment,
    () => runtime,
  );

  const response = await handler(
    request({ action: "checkout", organizationId: ORGANIZATION_ID }),
  );

  assertEquals(response.status, 503);
  assertEquals(await response.json(), {
    error:
      "Pro checkout is temporarily unavailable. Free sourcing remains available.",
  });
  assertEquals(calls.customer.length, 0);
  assertEquals(calls.checkout.length, 0);
});

Deno.test("creates a server-owned monthly Checkout and binds the organization customer", async () => {
  const { calls, runtime } = makeRuntime();
  const handler = createBillingSessionHandler(
    enabledEnvironment,
    () => runtime,
  );

  const response = await handler(
    request({ action: "checkout", organizationId: ORGANIZATION_ID }),
  );

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    url: "https://checkout.stripe.com/c/pay/ovd228",
  });
  assertEquals(calls.price, [{
    id: "price_OVD228Pro",
    parameters: { expand: ["product"] },
  }]);
  assertEquals(calls.customer.length, 1);
  assertObjectMatch(calls.customer[0], {
    parameters: {
      metadata: {
        organization_id: ORGANIZATION_ID,
        product: "overdrafter",
      },
      name: "OVD 228 Optics",
    },
    options: {
      idempotencyKey: `overdrafter:organization:${ORGANIZATION_ID}:customer`,
    },
  });
  assertEquals(calls.checkout.length, 1);
  assertObjectMatch(calls.checkout[0].parameters, {
    allow_promotion_codes: false,
    cancel_url: "https://app.overdrafter.com/?billing=cancelled",
    client_reference_id: ORGANIZATION_ID,
    customer: "cus_OVD228",
    line_items: [{ price: "price_OVD228Pro", quantity: 1 }],
    mode: "subscription",
    success_url: "https://app.overdrafter.com/?billing=success",
  });
  assertEquals(calls.checkout[0].parameters.metadata, {
    billing_interval: "month",
    organization_id: ORGANIZATION_ID,
    plan: "pro",
    stripe_price_id: "price_OVD228Pro",
  });
  assertEquals(calls.checkout[0].parameters.subscription_data?.metadata, {
    billing_interval: "month",
    organization_id: ORGANIZATION_ID,
    plan: "pro",
  });
  assertEquals(calls.checkout[0].options, {
    idempotencyKey:
      `overdrafter:organization:${ORGANIZATION_ID}:pro-checkout:${RESERVATION_TOKEN}`,
  });
  assertEquals(
    calls.rpc.map((call) => call.name),
    [
      "api_configure_stripe_pro_price",
      "api_bind_organization_stripe_customer",
      "api_acquire_organization_billing_checkout",
      "api_finalize_organization_billing_checkout",
      "api_record_billing_checkout_started",
    ],
  );
});

Deno.test("serializes concurrent Checkout creation with a durable reservation", async () => {
  const { calls, runtime } = makeRuntime({
    reservation: { acquired: false },
  });
  const handler = createBillingSessionHandler(
    enabledEnvironment,
    () => runtime,
  );

  const response = await handler(
    request({ action: "checkout", organizationId: ORGANIZATION_ID }),
  );

  assertEquals(response.status, 409);
  assertEquals(await response.json(), {
    error: "Checkout is already being prepared. Try again in a moment.",
  });
  assertEquals(calls.checkout.length, 0);
  assertEquals(
    calls.rpc.at(-1)?.name,
    "api_acquire_organization_billing_checkout",
  );
});

Deno.test("reuses the durable idempotency token after an ambiguous Stripe failure", async () => {
  const { calls, runtime } = makeRuntime({
    reservations: [
      { acquired: true, reservationToken: RESERVATION_TOKEN },
      { acquired: false, reservationToken: RESERVATION_TOKEN },
    ],
  });
  let createAttempt = 0;
  runtime.stripe.checkout.sessions.create = (parameters, requestOptions) => {
    calls.checkout.push({ parameters, options: requestOptions });
    createAttempt += 1;
    if (createAttempt === 1) {
      return Promise.reject(new Error("ambiguous Stripe timeout"));
    }
    return Promise.resolve({
      id: "cs_test_OVD228Retry",
      object: "checkout.session",
      url: "https://checkout.stripe.com/c/pay/ovd228-retry",
    } as Stripe.Checkout.Session);
  };
  const handler = createBillingSessionHandler(
    enabledEnvironment,
    () => runtime,
  );

  const firstResponse = await handler(
    request({ action: "checkout", organizationId: ORGANIZATION_ID }),
  );
  const secondResponse = await handler(
    request({ action: "checkout", organizationId: ORGANIZATION_ID }),
  );

  assertEquals(firstResponse.status, 502);
  assertEquals(secondResponse.status, 200);
  assertEquals(calls.checkout.length, 2);
  assertEquals(
    calls.checkout[0].options?.idempotencyKey,
    calls.checkout[1].options?.idempotencyKey,
  );
  assertEquals(
    calls.rpc.filter((call) =>
      call.name === "api_release_organization_billing_checkout"
    ).length,
    0,
  );
});

Deno.test("rejects Checkout when the Stripe customer already has a non-terminal subscription", async () => {
  const { calls, runtime } = makeRuntime({
    preparation: {
      organizationId: ORGANIZATION_ID,
      organizationName: "OVD 228 Optics",
      stripeCustomerId: "cus_OVD228",
      stripeLivemode: false,
    },
    subscriptions: [{
      id: "sub_OVD228",
      object: "subscription",
      status: "active",
    } as Stripe.Subscription],
  });
  const handler = createBillingSessionHandler(
    enabledEnvironment,
    () => runtime,
  );

  const response = await handler(
    request({ action: "checkout", organizationId: ORGANIZATION_ID }),
  );

  assertEquals(response.status, 409);
  assertEquals(await response.json(), {
    error:
      "This organization already has a Stripe subscription. Use Manage billing instead.",
  });
  assertEquals(calls.subscriptionList, [{
    customer: "cus_OVD228",
    limit: 100,
    status: "all",
  }]);
  assertEquals(calls.checkoutList.length, 0);
  assertEquals(calls.checkout.length, 0);
});

Deno.test("reuses an open Checkout session for the same organization and launch price", async () => {
  const { calls, runtime } = makeRuntime({
    checkoutSessions: [{
      client_reference_id: ORGANIZATION_ID,
      id: "cs_test_OVD228Open",
      metadata: {
        billing_interval: "month",
        organization_id: ORGANIZATION_ID,
        plan: "pro",
        stripe_price_id: "price_OVD228Pro",
      },
      mode: "subscription",
      object: "checkout.session",
      status: "open",
      url: "https://checkout.stripe.com/c/pay/ovd228-open",
    } as unknown as Stripe.Checkout.Session],
    preparation: {
      organizationId: ORGANIZATION_ID,
      organizationName: "OVD 228 Optics",
      stripeCustomerId: "cus_OVD228",
      stripeLivemode: false,
    },
  });
  const handler = createBillingSessionHandler(
    enabledEnvironment,
    () => runtime,
  );

  const response = await handler(
    request({ action: "checkout", organizationId: ORGANIZATION_ID }),
  );

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    url: "https://checkout.stripe.com/c/pay/ovd228-open",
  });
  assertEquals(calls.checkoutList, [{
    customer: "cus_OVD228",
    limit: 10,
    status: "open",
  }]);
  assertEquals(calls.checkout.length, 0);
  assertEquals(
    calls.rpc.at(-1)?.name,
    "api_record_billing_checkout_started",
  );
});

Deno.test("reuses the bound customer and opens the Billing Portal", async () => {
  const { calls, runtime } = makeRuntime({
    preparation: {
      organizationId: ORGANIZATION_ID,
      organizationName: "OVD 228 Optics",
      stripeCustomerId: "cus_OVD228",
      stripeLivemode: false,
    },
  });
  const handler = createBillingSessionHandler(
    enabledEnvironment,
    () => runtime,
  );

  const response = await handler(
    request({ action: "portal", organizationId: ORGANIZATION_ID }),
  );

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    url: "https://billing.stripe.com/p/session/ovd228",
  });
  assertEquals(calls.price.length, 0);
  assertEquals(calls.customer.length, 0);
  assertEquals(calls.portal, [{
    customer: "cus_OVD228",
    return_url: "https://app.overdrafter.com/?billing=portal_return",
  }]);
});

Deno.test("does not open a cross-mode customer in the Billing Portal", async () => {
  const { calls, runtime } = makeRuntime({
    preparation: {
      organizationId: ORGANIZATION_ID,
      organizationName: "OVD 228 Optics",
      stripeCustomerId: "cus_OVD228",
      stripeLivemode: true,
    },
  });
  const handler = createBillingSessionHandler(
    enabledEnvironment,
    () => runtime,
  );

  const response = await handler(
    request({ action: "portal", organizationId: ORGANIZATION_ID }),
  );

  assertEquals(response.status, 503);
  assertEquals(calls.portal.length, 0);
});
