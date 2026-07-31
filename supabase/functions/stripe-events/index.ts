import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const STRIPE_EVENT_API_VERSION =
  "2024-11-20.acacia" as Stripe.LatestApiVersion;

type EnvironmentReader = (name: string) => string | undefined;

type RpcError = {
  code?: string;
  message: string;
};

type RpcResult = {
  data: unknown;
  error: RpcError | null;
};

export type StripeEventServiceClient = {
  rpc(
    functionName: string,
    parameters: Record<string, unknown>,
  ): PromiseLike<RpcResult>;
};

export type StripeEventRuntime = {
  serviceClient: StripeEventServiceClient;
  stripe: Stripe;
  stripeWebhookSecret: string;
};

type RuntimeLoader = (
  getEnvironmentVariable: EnvironmentReader,
) => StripeEventRuntime;

let cachedRuntime: StripeEventRuntime | undefined;

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function loadStripeEventRuntime(
  getEnvironmentVariable: EnvironmentReader,
): StripeEventRuntime {
  if (cachedRuntime) {
    return cachedRuntime;
  }

  const supabaseUrl = getEnvironmentVariable("SUPABASE_URL");
  const supabaseServiceKey = getEnvironmentVariable(
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  const stripeSecretKey = getEnvironmentVariable("STRIPE_SECRET_KEY");
  const stripeWebhookSecret = getEnvironmentVariable(
    "STRIPE_SUBSCRIPTION_WEBHOOK_SECRET",
  );

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Missing Supabase environment configuration.");
  }

  if (!stripeSecretKey || !stripeWebhookSecret) {
    throw new Error("Missing Stripe environment configuration.");
  }

  cachedRuntime = {
    serviceClient: createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as StripeEventServiceClient,
    stripe: new Stripe(stripeSecretKey, {
      apiVersion: STRIPE_EVENT_API_VERSION,
      typescript: true,
    }),
    stripeWebhookSecret,
  };

  return cachedRuntime;
}

function readResultState(data: unknown): {
  attemptCount?: number;
  replayed: boolean;
  state: string;
} | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }

  const record = data as Record<string, unknown>;
  if (typeof record.state !== "string") {
    return null;
  }

  return {
    attemptCount: typeof record.attemptCount === "number"
      ? record.attemptCount
      : undefined,
    replayed: record.replayed === true,
    state: record.state,
  };
}

/**
 * Creates the signature-only Stripe commercial event handler.
 *
 * The raw request body is verified before the event is durably inserted.
 * Database RPCs own deduplication, transactional projection updates, and
 * replay state; this HTTP boundary never trusts client-supplied Stripe IDs.
 */
export function createStripeEventHandler(
  getEnvironmentVariable: EnvironmentReader = (name) => Deno.env.get(name),
  loadRuntime: RuntimeLoader = loadStripeEventRuntime,
) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return json(405, { error: "Method not allowed." });
    }

    const signature = request.headers.get("stripe-signature");
    if (!signature) {
      return json(400, { error: "Missing Stripe signature." });
    }

    let runtime: StripeEventRuntime;
    try {
      runtime = loadRuntime(getEnvironmentVariable);
    } catch {
      console.error("stripe-events: runtime configuration failed");
      return json(500, { error: "Webhook configuration error." });
    }

    const rawBody = await request.text();
    let event: Stripe.Event;

    try {
      event = await runtime.stripe.webhooks.constructEventAsync(
        rawBody,
        signature,
        runtime.stripeWebhookSecret,
      );
    } catch {
      console.warn("stripe-events: signature verification failed");
      return json(400, { error: "Invalid webhook signature." });
    }

    const { error: ingestError } = await runtime.serviceClient.rpc(
      "api_ingest_stripe_event",
      {
        p_api_version: event.api_version ?? "unversioned",
        p_event_created_at: new Date(event.created * 1000).toISOString(),
        p_event_type: event.type,
        p_livemode: event.livemode,
        p_payload: event,
        p_stripe_event_id: event.id,
      },
    );

    if (ingestError) {
      console.error("stripe-events: durable ingestion failed");
      return json(500, { error: "Event persistence failed." });
    }

    const { data: processData, error: processError } = await runtime
      .serviceClient.rpc("api_process_stripe_event", {
        p_stripe_event_id: event.id,
      });

    if (processError) {
      console.error("stripe-events: event processing RPC failed");
      return json(500, { error: "Event processing failed." });
    }

    const result = readResultState(processData);
    if (!result || result.state === "failed") {
      console.error("stripe-events: event requires retry");
      return json(500, { error: "Event processing failed." });
    }

    return json(200, {
      received: true,
      state: result.state,
      replayed: result.replayed,
    });
  };
}

if (import.meta.main) {
  Deno.serve(createStripeEventHandler());
}
