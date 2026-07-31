import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";
import { isLegacyProjectPaymentsEnabled } from "../_shared/legacy-project-payments.ts";

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type EnvironmentReader = (name: string) => string | undefined;

export type StripeWebhookRuntime = {
  stripe: Stripe;
  stripeWebhookSecret: string;
  serviceClient: SupabaseClient;
};

type RuntimeLoader = (
  getEnvironmentVariable: EnvironmentReader,
) => StripeWebhookRuntime;

let cachedRuntime: StripeWebhookRuntime | undefined;

function loadStripeWebhookRuntime(
  getEnvironmentVariable: EnvironmentReader,
): StripeWebhookRuntime {
  if (cachedRuntime) {
    return cachedRuntime;
  }

  const supabaseUrl = getEnvironmentVariable("SUPABASE_URL");
  const supabaseServiceKey = getEnvironmentVariable(
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  const stripeSecretKey = getEnvironmentVariable("STRIPE_SECRET_KEY");
  const stripeWebhookSecret = getEnvironmentVariable("STRIPE_WEBHOOK_SECRET");

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Missing Supabase environment configuration.");
  }

  if (!stripeSecretKey || !stripeWebhookSecret) {
    throw new Error("Missing Stripe environment configuration.");
  }

  cachedRuntime = {
    stripe: new Stripe(stripeSecretKey, {
      // The SDK type accepts only its bundled latest literal. Keep this
      // contained legacy integration pinned to the API version it used before
      // the feature gate was added.
      apiVersion: "2024-11-20.acacia" as Stripe.LatestApiVersion,
      typescript: true,
    }),
    stripeWebhookSecret,
    serviceClient: createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  };

  return cachedRuntime;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// payments.order_id is a UUID FK; malformed metadata (or metadata from
// intents created before validation tightened) must not break webhook writes.
function projectIdToOrderId(
  paymentIntent: Stripe.PaymentIntent,
): string | null {
  const value = paymentIntent.metadata?.projectId;
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    if (value) {
      console.warn(
        `stripe-webhook: ignoring non-UUID projectId "${value}" for intent ${paymentIntent.id}`,
      );
    }
    return null;
  }
  return value;
}

/**
 * Creates the contained legacy Stripe webhook request handler.
 *
 * The handler defaults to a successful no-op while legacy project payments are
 * disabled. When enabled, it verifies Stripe signatures before applying
 * idempotent payment-status updates through the service-role client.
 *
 * @param getEnvironmentVariable - Injectable reader for the server-only flag
 * and enabled-path secrets.
 * @param loadRuntime - Injectable Stripe and Supabase runtime loader used after
 * the gate is enabled.
 * @returns An HTTP request handler for the legacy Stripe webhook endpoint.
 */
export function createStripeWebhookHandler(
  getEnvironmentVariable: EnvironmentReader = (name) => Deno.env.get(name),
  loadRuntime: RuntimeLoader = loadStripeWebhookRuntime,
) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return json(405, { error: "Method not allowed." });
    }

    if (
      !isLegacyProjectPaymentsEnabled(
        getEnvironmentVariable("LEGACY_PROJECT_PAYMENTS_ENABLED"),
      )
    ) {
      return json(200, {
        received: true,
        ignored: true,
        reason: "legacy_project_payments_disabled",
      });
    }

    const signature = request.headers.get("stripe-signature");

    if (!signature) {
      return json(400, { error: "Missing Stripe signature." });
    }

    let runtime: StripeWebhookRuntime;

    try {
      runtime = loadRuntime(getEnvironmentVariable);
    } catch (error) {
      console.error("stripe-webhook: runtime configuration failed", error);
      return json(500, { error: "Webhook configuration error." });
    }

    const body = await request.text();
    let event: Stripe.Event;

    try {
      event = await runtime.stripe.webhooks.constructEventAsync(
        body,
        signature,
        runtime.stripeWebhookSecret,
      );
    } catch (error) {
      console.error("stripe-webhook: signature verification failed", error);
      return json(400, { error: "Invalid webhook signature." });
    }

    try {
      if (event.type === "payment_intent.succeeded") {
        await handlePaymentIntentSucceeded(
          event.data.object as Stripe.PaymentIntent,
          runtime.serviceClient,
        );
      } else if (event.type === "payment_intent.payment_failed") {
        await handlePaymentIntentFailed(
          event.data.object as Stripe.PaymentIntent,
          runtime.serviceClient,
        );
      }
    } catch (error) {
      console.error(
        `stripe-webhook: error handling event ${event.type}`,
        error,
      );
      return json(500, { error: "Internal error processing webhook." });
    }

    return json(200, { received: true });
  };
}

if (import.meta.main) {
  Deno.serve(createStripeWebhookHandler());
}

async function handlePaymentIntentSucceeded(
  paymentIntent: Stripe.PaymentIntent,
  serviceClient: SupabaseClient,
) {
  const stripePaymentIntentId = paymentIntent.id;

  // Idempotency: check if we've already processed this payment_intent
  const { data: existing, error: lookupError } = await serviceClient
    .from("payments")
    .select("id, status")
    .eq("stripe_payment_intent_id", stripePaymentIntentId)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`payments lookup failed: ${lookupError.message}`);
  }

  if (existing) {
    if (existing.status === "captured") {
      // Already processed — idempotent delivery, safe to ignore
      console.log(
        `stripe-webhook: duplicate delivery for ${stripePaymentIntentId}, already captured`,
      );
      return;
    }

    // Update existing record to captured
    const { error: updateError } = await serviceClient
      .from("payments")
      .update({ status: "captured", captured_at: new Date().toISOString() })
      .eq("stripe_payment_intent_id", stripePaymentIntentId);

    if (updateError) {
      throw new Error(
        `payments update to captured failed: ${updateError.message}`,
      );
    }
  } else {
    // Insert new payment record
    const { error: insertError } = await serviceClient.from("payments").insert({
      stripe_payment_intent_id: stripePaymentIntentId,
      amount_cents: paymentIntent.amount,
      status: "captured",
      order_id: projectIdToOrderId(paymentIntent),
      authorized_at: new Date(paymentIntent.created * 1000).toISOString(),
      captured_at: new Date().toISOString(),
    });

    if (insertError) {
      // Unique constraint violation means a concurrent handler already inserted — safe to ignore
      if (insertError.code === "23505") {
        console.log(
          `stripe-webhook: concurrent insert for ${stripePaymentIntentId}, already handled`,
        );
        return;
      }

      throw new Error(`payments insert failed: ${insertError.message}`);
    }
  }

  // TODO: enqueue Xometry order placement task
  console.log(
    `stripe-webhook: payment captured for ${stripePaymentIntentId}, order placement enqueue pending`,
  );
}

async function handlePaymentIntentFailed(
  paymentIntent: Stripe.PaymentIntent,
  serviceClient: SupabaseClient,
) {
  const stripePaymentIntentId = paymentIntent.id;

  const { data: existing, error: lookupError } = await serviceClient
    .from("payments")
    .select("id, status")
    .eq("stripe_payment_intent_id", stripePaymentIntentId)
    .maybeSingle();

  if (lookupError) {
    throw new Error(`payments lookup failed: ${lookupError.message}`);
  }

  if (existing) {
    // Guard against out-of-order webhook delivery downgrading an already
    // captured payment back to "failed".
    if (existing.status === "captured") {
      console.log(
        `stripe-webhook: ignoring failed event for already-captured intent ${stripePaymentIntentId}`,
      );
      return;
    }

    const { error: updateError } = await serviceClient
      .from("payments")
      .update({ status: "failed", failed_at: new Date().toISOString() })
      .eq("stripe_payment_intent_id", stripePaymentIntentId);

    if (updateError) {
      throw new Error(
        `payments update to failed failed: ${updateError.message}`,
      );
    }
  } else {
    const { error: insertError } = await serviceClient.from("payments").insert({
      stripe_payment_intent_id: stripePaymentIntentId,
      amount_cents: paymentIntent.amount,
      status: "failed",
      order_id: projectIdToOrderId(paymentIntent),
      authorized_at: new Date(paymentIntent.created * 1000).toISOString(),
      failed_at: new Date().toISOString(),
    });

    if (insertError) {
      if (insertError.code === "23505") {
        console.log(
          `stripe-webhook: concurrent insert for ${stripePaymentIntentId}, already handled`,
        );
        return;
      }
      throw new Error(`payments insert failed: ${insertError.message}`);
    }
  }

  console.log(`stripe-webhook: payment failed for ${stripePaymentIntentId}`);
}
