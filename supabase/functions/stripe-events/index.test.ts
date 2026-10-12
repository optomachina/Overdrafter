import { assertEquals } from "@std/assert";
import Stripe from "stripe";
import {
  catalogPriceMetadata,
  DEFAULT_CHECKOUT_LOOKUP_KEY,
  getCatalogPrice,
} from "../_shared/billingCatalog.ts";
import {
  createStripeEventHandler,
  STRIPE_EVENT_API_VERSION,
  type StripeEventRuntime,
  type StripeEventServiceClient,
} from "./index.ts";

const APPROVED_PRO = getCatalogPrice(DEFAULT_CHECKOUT_LOOKUP_KEY)!;

const WEBHOOK_SECRET = "whsec_ovd235";

function makeEvent(
  overrides: Partial<Stripe.Event> = {},
): Stripe.Event {
  return {
    api_version: STRIPE_EVENT_API_VERSION,
    created: 1_785_469_200,
    data: { object: {} },
    id: "evt_OVD235",
    livemode: false,
    object: "event",
    pending_webhooks: 1,
    request: null,
    type: "customer.subscription.updated",
    ...overrides,
  } as Stripe.Event;
}

function makeRuntime(
  event: Stripe.Event,
  rpc: StripeEventServiceClient["rpc"],
  onVerify?: (payload: string, signature: string, secret: string) => void,
): StripeEventRuntime {
  return {
    serviceClient: { rpc },
    stripe: {
      webhooks: {
        constructEventAsync: (
          payload: string,
          signature: string,
          secret: string,
        ) => {
          onVerify?.(payload, signature, secret);
          return Promise.resolve(event);
        },
      },
    } as unknown as Stripe,
    stripeWebhookSecret: WEBHOOK_SECRET,
  };
}

function signedRequest(body: string, signature = "t=1234,v1=verified") {
  return new Request("https://example.test/functions/v1/stripe-events", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body,
  });
}

Deno.test("rejects unsupported methods before runtime loading", async () => {
  let runtimeLoaded = false;
  const handler = createStripeEventHandler(
    () => undefined,
    () => {
      runtimeLoaded = true;
      throw new Error("runtime must not load");
    },
  );

  const response = await handler(
    new Request("https://example.test", { method: "GET" }),
  );

  assertEquals(response.status, 405);
  assertEquals(await response.json(), { error: "Method not allowed." });
  assertEquals(runtimeLoaded, false);
});

Deno.test("rejects missing signatures before runtime loading", async () => {
  let runtimeLoaded = false;
  const handler = createStripeEventHandler(
    () => undefined,
    () => {
      runtimeLoaded = true;
      throw new Error("runtime must not load");
    },
  );

  const response = await handler(
    new Request("https://example.test", {
      method: "POST",
      body: "{}",
    }),
  );

  assertEquals(response.status, 400);
  assertEquals(await response.json(), { error: "Missing Stripe signature." });
  assertEquals(runtimeLoaded, false);
});

Deno.test("rejects an invalid signature without persisting the event", async () => {
  let rpcCalled = false;
  const stripe = new Stripe("sk_test_ovd235", {
    apiVersion: STRIPE_EVENT_API_VERSION,
  });
  const runtime: StripeEventRuntime = {
    serviceClient: {
      rpc: () => {
        rpcCalled = true;
        return Promise.resolve({ data: null, error: null });
      },
    },
    stripe,
    stripeWebhookSecret: WEBHOOK_SECRET,
  };
  const handler = createStripeEventHandler(() => "configured", () => runtime);

  const response = await handler(signedRequest("{}", "invalid"));

  assertEquals(response.status, 400);
  assertEquals(await response.json(), { error: "Invalid webhook signature." });
  assertEquals(rpcCalled, false);
});

Deno.test("rejects a correctly signed event outside Stripe's timestamp tolerance", async () => {
  let rpcCalled = false;
  const stripe = new Stripe("sk_test_ovd235", {
    apiVersion: STRIPE_EVENT_API_VERSION,
  });
  const payload = JSON.stringify(makeEvent());
  const oldSignature = await stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret: WEBHOOK_SECRET,
    timestamp: Math.floor(Date.now() / 1000) - 600,
  });
  const runtime: StripeEventRuntime = {
    serviceClient: {
      rpc: () => {
        rpcCalled = true;
        return Promise.resolve({ data: null, error: null });
      },
    },
    stripe,
    stripeWebhookSecret: WEBHOOK_SECRET,
  };
  const handler = createStripeEventHandler(() => "configured", () => runtime);

  const response = await handler(signedRequest(payload, oldSignature));

  assertEquals(response.status, 400);
  assertEquals(await response.json(), { error: "Invalid webhook signature." });
  assertEquals(rpcCalled, false);
});

Deno.test("verifies the raw body before durable ingestion and processing", async () => {
  const event = makeEvent();
  const rawBody = JSON.stringify(event);
  const calls: Array<{
    functionName: string;
    parameters: Record<string, unknown>;
  }> = [];
  const runtime = makeRuntime(
    event,
    (functionName, parameters) => {
      calls.push({ functionName, parameters });
      if (functionName === "api_ingest_stripe_event") {
        return Promise.resolve({
          data: { state: "pending", duplicate: false },
          error: null,
        });
      }

      return Promise.resolve({
        data: {
          state: "processed",
          replayed: false,
          attemptCount: 1,
        },
        error: null,
      });
    },
    (payload, signature, secret) => {
      assertEquals(payload, rawBody);
      assertEquals(signature, "t=1234,v1=verified");
      assertEquals(secret, WEBHOOK_SECRET);
    },
  );
  const handler = createStripeEventHandler(() => "configured", () => runtime);

  const response = await handler(signedRequest(rawBody));

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    received: true,
    state: "processed",
    replayed: false,
  });
  assertEquals(calls.length, 2);
  assertEquals(calls[0], {
    functionName: "api_ingest_stripe_event",
    parameters: {
      p_api_version: STRIPE_EVENT_API_VERSION,
      p_event_created_at: new Date(event.created * 1000).toISOString(),
      p_event_type: event.type,
      p_livemode: false,
      p_payload: event,
      p_stripe_event_id: event.id,
    },
  });
  assertEquals(calls[1], {
    functionName: "api_process_stripe_event",
    parameters: { p_stripe_event_id: event.id },
  });
});

Deno.test("returns a retryable error when durable ingestion fails", async () => {
  const event = makeEvent();
  let callCount = 0;
  const runtime = makeRuntime(event, () => {
    callCount += 1;
    return Promise.resolve({
      data: null,
      error: { code: "XX000", message: "database unavailable" },
    });
  });
  const handler = createStripeEventHandler(() => "configured", () => runtime);

  const response = await handler(signedRequest(JSON.stringify(event)));

  assertEquals(response.status, 500);
  assertEquals(await response.json(), { error: "Event persistence failed." });
  assertEquals(callCount, 1);
});

Deno.test("returns a retryable error when transactional processing fails", async () => {
  const event = makeEvent();
  let callCount = 0;
  const runtime = makeRuntime(event, () => {
    callCount += 1;
    if (callCount === 1) {
      return Promise.resolve({
        data: { state: "pending", duplicate: false },
        error: null,
      });
    }

    return Promise.resolve({
      data: {
        state: "failed",
        errorCode: "P0002",
        replayed: false,
        attemptCount: 1,
      },
      error: null,
    });
  });
  const handler = createStripeEventHandler(() => "configured", () => runtime);

  const response = await handler(signedRequest(JSON.stringify(event)));

  assertEquals(response.status, 500);
  assertEquals(await response.json(), { error: "Event processing failed." });
  assertEquals(callCount, 2);
});

Deno.test("acknowledges safely replayed and ignored events", async () => {
  const event = makeEvent({ type: "product.updated" });
  const states = [
    { state: "processed", replayed: true, attemptCount: 1 },
    { state: "ignored", replayed: false, attemptCount: 1 },
  ];

  for (const expected of states) {
    let callCount = 0;
    const runtime = makeRuntime(event, () => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve({
          data: { state: "pending", duplicate: expected.replayed },
          error: null,
        });
      }

      return Promise.resolve({ data: expected, error: null });
    });
    const handler = createStripeEventHandler(
      () => "configured",
      () => runtime,
    );

    const response = await handler(signedRequest(JSON.stringify(event)));

    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      received: true,
      state: expected.state,
      replayed: expected.replayed,
    });
  }
});

Deno.test("price.updated amount mismatch disables the catalog key without changing entitlements", async () => {
  const event = makeEvent({
    data: {
      object: {
        active: true,
        currency: "usd",
        id: "price_OVD725",
        livemode: false,
        lookup_key: DEFAULT_CHECKOUT_LOOKUP_KEY,
        metadata: catalogPriceMetadata(APPROVED_PRO),
        product: "prod_OVD725",
        recurring: { interval: "month", interval_count: 1 },
        type: "recurring",
        unit_amount: 200,
      } as unknown as Stripe.Price,
    },
    type: "price.updated",
  });
  const calls: Array<{ functionName: string; parameters: Record<string, unknown> }> = [];
  const runtime = makeRuntime(event, (functionName, parameters) => {
    calls.push({ functionName, parameters });
    if (functionName === "api_ingest_stripe_event") {
      return Promise.resolve({
        data: { state: "pending", duplicate: false },
        error: null,
      });
    }
    if (functionName === "api_process_stripe_event") {
      return Promise.resolve({
        data: { state: "processed", replayed: false, attemptCount: 1 },
        error: null,
      });
    }
    return Promise.resolve({ data: { disabled: true }, error: null });
  });
  const handler = createStripeEventHandler(() => "configured", () => runtime);

  const response = await handler(signedRequest(JSON.stringify(event)));

  assertEquals(response.status, 200);
  assertEquals(calls[2], {
    functionName: "api_disable_stripe_catalog_price",
    parameters: {
      p_lookup_key: DEFAULT_CHECKOUT_LOOKUP_KEY,
      p_livemode: false,
      p_reason: "amount_mismatch",
      p_stripe_event_id: event.id,
    },
  });
});

Deno.test("does not log catalog price disabled when disable fails", async () => {
  const event = makeEvent({
    data: {
      object: {
        active: true,
        currency: "usd",
        id: "price_OVD725",
        livemode: false,
        lookup_key: DEFAULT_CHECKOUT_LOOKUP_KEY,
        metadata: catalogPriceMetadata(APPROVED_PRO),
        product: "prod_OVD725",
        recurring: { interval: "month", interval_count: 1 },
        type: "recurring",
        unit_amount: 200,
      } as unknown as Stripe.Price,
    },
    type: "price.updated",
  });
  const runtime = makeRuntime(event, (functionName) => {
    if (functionName === "api_ingest_stripe_event") {
      return Promise.resolve({
        data: { state: "pending", duplicate: false },
        error: null,
      });
    }
    if (functionName === "api_process_stripe_event") {
      return Promise.resolve({
        data: { state: "processed", replayed: false, attemptCount: 1 },
        error: null,
      });
    }
    return Promise.resolve({
      data: null,
      error: { message: "function does not exist" },
    });
  });
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  const handler = createStripeEventHandler(
    (name) => name === "BILLING_TIER_CATALOG_ENABLED" ? "true" : "configured",
    () => runtime,
  );

  try {
    const response = await handler(signedRequest(JSON.stringify(event)));
    assertEquals(response.status, 200);
  } finally {
    console.error = originalError;
  }

  assertEquals(logs.some((line) => line.includes("catalog price disabled")), false);
  assertEquals(logs.some((line) => line.includes("catalog price disable failed")), true);
});

Deno.test("a matching price.updated with a product ID string does not disable the key", async () => {
  const event = makeEvent({
    data: {
      object: {
        active: true,
        currency: "usd",
        id: "price_OVD725",
        livemode: false,
        lookup_key: DEFAULT_CHECKOUT_LOOKUP_KEY,
        metadata: catalogPriceMetadata(APPROVED_PRO),
        object: "price",
        product: "prod_OVD725",
        recurring: { interval: "month", interval_count: 1 },
        type: "recurring",
        unit_amount: APPROVED_PRO.amountCents,
      } as unknown as Stripe.Price,
    },
    type: "price.updated",
  });
  const calls: string[] = [];
  const runtime = makeRuntime(event, (functionName) => {
    calls.push(functionName);
    if (functionName === "api_ingest_stripe_event") {
      return Promise.resolve({
        data: { state: "pending", duplicate: false },
        error: null,
      });
    }
    return Promise.resolve({
      data: { state: "processed", replayed: false, attemptCount: 1 },
      error: null,
    });
  });
  const handler = createStripeEventHandler(() => "configured", () => runtime);

  const response = await handler(signedRequest(JSON.stringify(event)));

  assertEquals(response.status, 200);
  assertEquals(calls, ["api_ingest_stripe_event", "api_process_stripe_event"]);
});

Deno.test("replaying price.updated is a no-op for catalog disable", async () => {
  const event = makeEvent({
    data: {
      object: {
        active: true,
        id: "price_OVD725",
        lookup_key: DEFAULT_CHECKOUT_LOOKUP_KEY,
        unit_amount: 200,
      } as unknown as Stripe.Price,
    },
    type: "price.updated",
  });
  const calls: string[] = [];
  const runtime = makeRuntime(event, (functionName) => {
    calls.push(functionName);
    if (functionName === "api_ingest_stripe_event") {
      return Promise.resolve({
        data: { state: "pending", duplicate: true },
        error: null,
      });
    }
    return Promise.resolve({
      data: { state: "processed", replayed: true, attemptCount: 1 },
      error: null,
    });
  });
  const handler = createStripeEventHandler(() => "configured", () => runtime);

  const response = await handler(signedRequest(JSON.stringify(event)));

  assertEquals(response.status, 200);
  assertEquals(calls, ["api_ingest_stripe_event", "api_process_stripe_event"]);
});
