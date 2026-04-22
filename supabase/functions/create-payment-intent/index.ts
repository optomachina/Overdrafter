import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
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
const supabaseServiceRoleKey =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY");
const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing Supabase environment configuration.");
}

if (!supabaseServiceRoleKey) {
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY environment variable.");
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
};

type OfferRow = {
  job_id: string;
  jobs: {
    selected_vendor_quote_offer_id: string | null;
    vendor_quote_offers: { total_price_usd: number | string | null } | null;
  } | null;
};

type PriceResult =
  | { ok: true; totalCents: number }
  | { ok: false; status: number; error: string };

const STRIPE_MIN_AMOUNT_CENTS = 50;

async function parsePayload(request: Request): Promise<CreatePaymentIntentPayload | null> {
  try {
    return (await request.json()) as CreatePaymentIntentPayload;
  } catch {
    return null;
  }
}

async function verifyProjectAccess(
  userClient: SupabaseClient,
  projectId: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { data, error } = await userClient
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle();

  if (error) {
    console.error("create-payment-intent: project lookup failed", error);
    return { ok: false, status: 500, error: "Payment setup failed. Try again or contact support." };
  }

  if (!data) {
    return { ok: false, status: 403, error: "You do not have access to this project." };
  }

  return { ok: true };
}

function sumOfferCents(rows: OfferRow[]): { totalCents: number; missingSelection: boolean } {
  let totalCents = 0;
  let missingSelection = false;

  for (const row of rows) {
    const job = row.jobs;
    const priceUsd = job?.vendor_quote_offers?.total_price_usd;

    if (priceUsd == null) {
      if (job?.selected_vendor_quote_offer_id == null) {
        missingSelection = true;
      }
      continue;
    }

    const numeric = typeof priceUsd === "string" ? Number(priceUsd) : priceUsd;
    if (Number.isFinite(numeric)) {
      totalCents += Math.round(numeric * 100);
    }
  }

  return { totalCents, missingSelection };
}

async function resolveAuthoritativePriceCents(
  serviceClient: SupabaseClient,
  projectId: string,
): Promise<PriceResult> {
  const { data, error } = await serviceClient
    .from("project_jobs")
    .select(
      "job_id, jobs!inner(selected_vendor_quote_offer_id, vendor_quote_offers!jobs_selected_vendor_quote_offer_id_fkey(total_price_usd))",
    )
    .eq("project_id", projectId);

  if (error) {
    console.error("create-payment-intent: offer lookup failed", error);
    return { ok: false, status: 500, error: "Payment setup failed. Try again or contact support." };
  }

  const rows = (data ?? []) as unknown as OfferRow[];
  const { totalCents, missingSelection } = sumOfferCents(rows);

  if (missingSelection || totalCents <= 0) {
    return {
      ok: false,
      status: 400,
      error: "This project has no priced selection yet. Choose a vendor quote before paying.",
    };
  }

  if (totalCents < STRIPE_MIN_AMOUNT_CENTS) {
    return {
      ok: false,
      status: 400,
      error: `Payment amount must be at least ${STRIPE_MIN_AMOUNT_CENTS} cents.`,
    };
  }

  return { ok: true, totalCents };
}

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

  // Authenticated client uses the caller's JWT (from the Authorization header).
  // RLS enforces project access below.
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

  const payload = await parsePayload(request);

  if (!payload) {
    return json(400, { error: "Invalid request body." });
  }

  const { projectId } = payload;

  if (!projectId || typeof projectId !== "string") {
    return json(400, { error: "projectId is required." });
  }

  const accessCheck = await verifyProjectAccess(userClient, projectId);
  if (!accessCheck.ok) {
    return json(accessCheck.status, { error: accessCheck.error });
  }

  // Service-role client reads authoritative pricing. vendor_quote_offers is
  // internal-only under RLS, so this lookup must bypass RLS — but only after
  // project access has been verified above.
  const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const priceResult = await resolveAuthoritativePriceCents(serviceClient, projectId);
  if (!priceResult.ok) {
    return json(priceResult.status, { error: priceResult.error });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: priceResult.totalCents,
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
