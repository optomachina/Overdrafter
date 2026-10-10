import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { callUntypedRpc } from "@/features/quotes/api/shared/rpc";

export type QuoteAccessIdentity = { actorUserId: string; organizationId: string; jobId: string };
export type QuoteAccess = QuoteAccessIdentity & {
  schema: "quote-access.v1";
  state: "eligible" | "blocked";
  source: "commercial_entitlement" | "free_beta" | null;
  reasonCode: "eligible" | "automatic_quote_disabled" | "beta_access_required" | "free_policy_unavailable";
  policyRevision: string | null;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = ["schema", "jobId", "organizationId", "actorUserId", "state", "source", "reasonCode", "policyRevision"];
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isBlockedReason(value: unknown): value is Exclude<QuoteAccess["reasonCode"], "eligible"> {
  return value === "automatic_quote_disabled" || value === "beta_access_required" || value === "free_policy_unavailable";
}

export function parseQuoteAccess(value: unknown, identity: QuoteAccessIdentity): QuoteAccess {
  const invalid = () => new TypeError("Quote access could not be verified.");
  if (!isRecord(value) || Object.keys(value).length !== fields.length ||
      !fields.every((key) => Object.prototype.hasOwnProperty.call(value, key))) throw invalid();
  if (value.schema !== "quote-access.v1" ||
      value.jobId !== identity.jobId || !uuid.test(identity.jobId) ||
      value.organizationId !== identity.organizationId || !uuid.test(identity.organizationId) ||
      value.actorUserId !== identity.actorUserId || !uuid.test(identity.actorUserId)) throw invalid();
  const { state, source, reasonCode, policyRevision } = value;
  if (state === "eligible" && reasonCode === "eligible") {
    if (source === "commercial_entitlement" && policyRevision === null) {
      return { ...identity, schema: "quote-access.v1", state, source, reasonCode, policyRevision: null };
    }
    if (source === "free_beta" && typeof policyRevision === "string" && policyRevision.trim().length > 0) {
      return { ...identity, schema: "quote-access.v1", state, source, reasonCode, policyRevision };
    }
  }
  if (state === "blocked" && source === null && policyRevision === null && isBlockedReason(reasonCode)) {
    return { ...identity, schema: "quote-access.v1", state, source: null, reasonCode, policyRevision: null };
  }
  throw invalid();
}

export async function fetchQuoteAccess(identity: QuoteAccessIdentity): Promise<QuoteAccess> {
  try {
    const { data, error } = await callUntypedRpc("api_get_quote_access", { p_job_id: identity.jobId });
    if (error) throw new Error("Quote access could not be verified.");
    return parseQuoteAccess(data, identity);
  } catch {
    throw new Error("Quote access could not be verified.");
  }
}

/** Policy snapshot only. Admission and worker reauthorize; this is not a quota reservation. */
export function useQuoteAccess(identity: QuoteAccessIdentity | null, enabled = true) {
  const queryClient = useQueryClient();
  const actorUserId = identity?.actorUserId;
  const organizationId = identity?.organizationId;
  const jobId = identity?.jobId;
  useEffect(() => () => {
    // Cancel the old identity/auth generation, including logout then relogin as the same user.
    void queryClient.cancelQueries({ queryKey: ["quote-access", actorUserId, organizationId, jobId], exact: true });
  }, [queryClient, actorUserId, organizationId, jobId, enabled]);
  const query = useQuery({
    queryKey: ["quote-access", identity?.actorUserId, identity?.organizationId, identity?.jobId],
    queryFn: () => {
      if (!identity) throw new Error("Quote access identity is unavailable.");
      return fetchQuoteAccess(identity);
    },
    enabled: Boolean(identity) && enabled,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnMount: "always",
    // Background refresh must not erase an uncertain submission's approval identity.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const available = Boolean(identity) && enabled && !query.isFetching && !query.isError;
  return {
    automaticEnabled: available && query.data?.state === "eligible",
    state: available ? query.data?.state ?? "unknown" : "unknown",
    isLoading: Boolean(identity) && enabled && query.isFetching,
    refresh: query.refetch,
  };
}
