import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ChatGptReadDependencies, ChatGptPrincipal } from "./tools";

/** A server-resolved connection from the future outer OAuth bridge, not tool input. */
export interface OverdrafterConnection extends ChatGptPrincipal {
  accessToken: string;
}

const projectionSchema = z.array(z.object({
  jobId: z.string().uuid().toLowerCase(),
  vendorQuotes: z.array(z.object({
    id: z.string().uuid().toLowerCase(),
    organization_id: z.string().uuid().toLowerCase(),
    vendor: z.string(),
    status: z.string(),
    requested_quantity: z.number(),
    total_price_usd: z.number().nullable(),
    lead_time_business_days: z.number().nullable(),
  })).max(100),
})).max(1);

/**
 * Compose existing user-scoped services, without storage/refresh or privileged keys.
 * The outer bridge must check OAuth audience, expiry and revocation before passing
 * the server-held upstream session. getUser alone is not a grant-revocation check.
 */
export function createSupabaseChatGptReader(options: {
  url: string;
  publishableKey: string;
  connection: OverdrafterConnection;
  isEnabled: () => boolean;
  fetch?: typeof fetch;
}): ChatGptReadDependencies {
  if (!options.publishableKey.startsWith("sb_publishable_")) {
    throw new Error("A Supabase publishable key is required; privileged and legacy keys are unsupported.");
  }
  const endpoint = new URL(options.url);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1")) {
    throw new Error("Supabase requires HTTPS or the local fixture host.");
  }
  const connection = { ...options.connection, scopes: [...options.connection.scopes] };
  const upstreamFetch = options.fetch ?? fetch;
  const client = createClient(options.url, options.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: { Authorization: `Bearer ${connection.accessToken}` },
      fetch: (input, init) => upstreamFetch(input, {
        ...init, redirect: "error", signal: AbortSignal.timeout(10_000),
      }),
    },
  });
  const principal = {
    userId: connection.userId.toLowerCase(),
    organizationId: connection.organizationId.toLowerCase(),
    scopes: connection.scopes,
  };
  return {
    isEnabled: options.isEnabled,
    async resolvePrincipal() {
      if (!options.isEnabled()) return null;
      const { data, error } = await client.auth.getUser(connection.accessToken);
      if (error || data.user?.id.toLowerCase() !== principal.userId || data.user.is_anonymous) return null;
      const membership = await client.from("organization_memberships")
        .select("organization_id").eq("user_id", principal.userId)
        .eq("organization_id", principal.organizationId).maybeSingle();
      if (membership.error) throw new Error("Membership unavailable.");
      if (!membership.data || membership.data.organization_id !== principal.organizationId) return null;
      return principal;
    },
    async readAuthorizedJob(requestPrincipal, jobId) {
      if (!options.isEnabled() || requestPrincipal.userId !== principal.userId ||
          requestPrincipal.organizationId !== principal.organizationId) return null;
      // Both reads carry the user's JWT. RLS controls job visibility; the existing
      // workspace RPC independently applies user_can_access_job at read time.
      const job = await client.from("jobs").select("id,organization_id,status")
        .eq("id", jobId).eq("organization_id", principal.organizationId).maybeSingle();
      if (job.error) throw new Error("Job unavailable.");
      if (!job.data) return null;
      const projection = await client.rpc("api_list_client_quote_workspace", { p_job_ids: [jobId] });
      if (projection.error) throw new Error("Quote projection unavailable.");
      const rows = projectionSchema.parse(projection.data);
      const row = rows[0];
      if (!row || row.jobId !== jobId || row.vendorQuotes.some((quote) => quote.organization_id !== principal.organizationId)) return null;
      return {
        organizationId: job.data.organization_id,
        job: { id: job.data.id, status: job.data.status },
        quotes: row.vendorQuotes.map((quote) => ({
          id: quote.id, vendor: quote.vendor, status: quote.status,
          quantity: quote.requested_quantity, totalPriceUsd: quote.total_price_usd,
          leadTimeBusinessDays: quote.lead_time_business_days,
        })),
      };
    },
  };
}
