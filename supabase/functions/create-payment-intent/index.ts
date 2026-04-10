import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing Supabase environment configuration.");
}

if (!stripeSecretKey) {
  throw new Error("Missing STRIPE_SECRET_KEY environment variable.");
}

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2024-11-20.acacia",
  typescript: true,
});

type CreatePaymentIntentPayload = {
  projectId: string;
  amountCents: number;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed." });
  }

  const authorization = request.headers.get("Authorization");

  if (!authorization) {
    return json(401, { error: "You must be signed in to continue." });
  }

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser();

  if (userError || !user) {
    return json(401, { error: userError?.message ?? "You must be signed in to continue." });
  }

  let payload: CreatePaymentIntentPayload;

  try {
    payload = (await request.json()) as CreatePaymentIntentPayload;
  } catch {
    return json(400, { error: "Invalid request body." });
  }

  const { projectId, amountCents } = payload;

  if (!projectId || typeof projectId !== "string") {
    return json(400, { error: "projectId is required." });
  }

  if (!amountCents || typeof amountCents !== "number" || amountCents < 50) {
    return json(400, { error: "amountCents must be a positive number (minimum 50 cents)." });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      // Delayed capture: authorize now, capture after Xometry order placement
      capture_method: "manual",
      metadata: {
        projectId,
        userId: user.id,
      },
    });

    return json(200, { clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error("create-payment-intent: Stripe error", error);

    return json(500, {
      error: "Payment setup failed. Try again or contact support.",
    });
  }
});
