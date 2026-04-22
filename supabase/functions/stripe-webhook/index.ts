import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
const stripeWebhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("Missing Supabase environment configuration.");
}

if (!stripeSecretKey || !stripeWebhookSecret) {
  throw new Error("Missing Stripe environment configuration.");
}

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2024-11-20.acacia",
  typescript: true,
});

const serviceClient = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// payments.order_id is a UUID FK; malformed metadata (or metadata from
// intents created before validation tightened) must not break webhook writes.
function projectIdToOrderId(paymentIntent: Stripe.PaymentIntent): string | null {
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

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed." });
  }

  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return json(400, { error: "Missing Stripe signature." });
  }

  const body = await request.text();

  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, stripeWebhookSecret);
  } catch (error) {
    console.error("stripe-webhook: signature verification failed", error);
    return json(400, { error: "Invalid webhook signature." });
  }

  try {
    if (event.type === "payment_intent.succeeded") {
      await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
    } else if (event.type === "payment_intent.payment_failed") {
      await handlePaymentIntentFailed(event.data.object as Stripe.PaymentIntent);
    }
  } catch (error) {
    console.error(`stripe-webhook: error handling event ${event.type}`, error);
    return json(500, { error: "Internal error processing webhook." });
  }

  return json(200, { received: true });
});

async function handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent) {
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
      console.log(`stripe-webhook: duplicate delivery for ${stripePaymentIntentId}, already captured`);
      return;
    }

    // Update existing record to captured
    const { error: updateError } = await serviceClient
      .from("payments")
      .update({ status: "captured", captured_at: new Date().toISOString() })
      .eq("stripe_payment_intent_id", stripePaymentIntentId);

    if (updateError) {
      throw new Error(`payments update to captured failed: ${updateError.message}`);
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
        console.log(`stripe-webhook: concurrent insert for ${stripePaymentIntentId}, already handled`);
        return;
      }

      throw new Error(`payments insert failed: ${insertError.message}`);
    }
  }

  // TODO: enqueue Xometry order placement task
  console.log(`stripe-webhook: payment captured for ${stripePaymentIntentId}, order placement enqueue pending`);
}

async function handlePaymentIntentFailed(paymentIntent: Stripe.PaymentIntent) {
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
      throw new Error(`payments update to failed failed: ${updateError.message}`);
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
