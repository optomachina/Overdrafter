import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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
const LEGACY_PROJECT_PAYMENTS_DISABLED_CODE =
  "legacy_project_payments_disabled";

type EnvironmentReader = (name: string) => string | undefined;

export function isLegacyProjectPaymentsEnabled(
  value: string | undefined,
): boolean {
  return value?.trim().toLowerCase() === "true";
}

async function parsePayload(
  request: Request,
): Promise<CreatePaymentIntentPayload | null> {
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
    return {
      ok: false,
      status: 500,
      error: "Payment setup failed. Try again or contact support.",
    };
  }

  if (!data) {
    return {
      ok: false,
      status: 403,
      error: "You do not have access to this project.",
    };
  }

  return { ok: true };
}

function toFiniteNumber(value: number | string | null | undefined): number {
  if (value == null) {
    return Number.NaN;
  }
  return typeof value === "string" ? Number(value) : value;
}

function sumOfferCents(
  rows: OfferRow[],
): { totalCents: number; hasUnpricedJob: boolean } {
  let totalCents = 0;
  let hasUnpricedJob = false;

  for (const row of rows) {
    const job = row.jobs;
    const priceUsd = job?.vendor_quote_offers?.total_price_usd;
    const numeric = toFiniteNumber(priceUsd);

    // Any job without a selected offer, or whose selected offer has a
    // missing / non-finite / non-positive price, invalidates the charge.
    // Silently skipping would let multi-job projects authorize a partial
    // amount instead of the true total.
    if (
      job?.selected_vendor_quote_offer_id == null ||
      !Number.isFinite(numeric) ||
      numeric <= 0
    ) {
      hasUnpricedJob = true;
      continue;
    }

    totalCents += Math.round(numeric * 100);
  }

  return { totalCents, hasUnpricedJob };
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
    return {
      ok: false,
      status: 500,
      error: "Payment setup failed. Try again or contact support.",
    };
  }

  const rows = (data ?? []) as unknown as OfferRow[];
  const { totalCents, hasUnpricedJob } = sumOfferCents(rows);

  if (hasUnpricedJob || totalCents <= 0) {
    return {
      ok: false,
      status: 400,
      error:
        "This project has no priced selection yet. Choose a vendor quote before paying.",
    };
  }

  if (totalCents < STRIPE_MIN_AMOUNT_CENTS) {
    return {
      ok: false,
      status: 400,
      error:
        `Payment amount must be at least ${STRIPE_MIN_AMOUNT_CENTS} cents.`,
    };
  }

  return { ok: true, totalCents };
}

export async function handleCreatePaymentIntent(
  request: Request,
  getEnvironmentVariable: EnvironmentReader = (name) => Deno.env.get(name),
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed." });
  }

  if (
    !isLegacyProjectPaymentsEnabled(
      getEnvironmentVariable("LEGACY_PROJECT_PAYMENTS_ENABLED"),
    )
  ) {
    return json(503, {
      error: "Legacy project payments are disabled.",
      code: LEGACY_PROJECT_PAYMENTS_DISABLED_CODE,
    });
  }

  const supabaseUrl = getEnvironmentVariable("SUPABASE_URL");
  const supabaseAnonKey = getEnvironmentVariable("SUPABASE_ANON_KEY");
  const supabaseServiceRoleKey =
    getEnvironmentVariable("SUPABASE_SERVICE_ROLE_KEY") ??
      getEnvironmentVariable("SERVICE_ROLE_KEY");
  const stripeSecretKey = getEnvironmentVariable("STRIPE_SECRET_KEY");

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
    // Preserve the legacy endpoint's pinned API version even when the
    // floating npm:stripe@17 type package advances its latest literal.
    apiVersion: "2024-11-20.acacia" as Stripe.LatestApiVersion,
    typescript: true,
  });

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
    return json(401, {
      error: userError?.message ?? "You must be signed in to continue.",
    });
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

  const priceResult = await resolveAuthoritativePriceCents(
    serviceClient,
    projectId,
  );
  if (!priceResult.ok) {
    return json(priceResult.status, { error: priceResult.error });
  }

  try {
    // Stable idempotency key keyed on (project, user, amount) so retries,
    // duplicate clicks, or remounts reuse the same PaymentIntent instead of
    // authorizing the card multiple times.
    const idempotencyKey =
      `create-payment-intent:${projectId}:${user.id}:${priceResult.totalCents}`;
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: priceResult.totalCents,
        currency: "usd",
        // Delayed capture: authorize now, capture after Xometry order placement
        capture_method: "manual",
        metadata: {
          projectId,
          userId: user.id,
        },
      },
      { idempotencyKey },
    );

    return json(200, { clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error("create-payment-intent: Stripe error", error);

    return json(500, {
      error: "Payment setup failed. Try again or contact support.",
    });
  }
}

if (import.meta.main) {
  Deno.serve((request) => handleCreatePaymentIntent(request));
}
