import { useQuery } from "@tanstack/react-query";
import { callUntypedRpc } from "@/features/quotes/api/shared/rpc";

/**
 * Server answer to "may this request use a quantity above 1?" (OVD-997, slice P1 of OVD-987).
 *
 * Blaine (2026-10-20): the controlled beta offers a quantity above 1 through a scoped grant, to one
 * named participant or to one request. The global switch stays off. This module only reads that
 * answer; it never grants anything, and the server resolver still denies any quantity it has not
 * scoped when a quote is requested, so a wrong client answer cannot widen what is quoted.
 *
 * Contract for the server read `api_get_quantity_scope(p_job_id uuid)` (not built yet; see the PR
 * body). It returns exactly these six keys for the signed-in caller, echoing the identity it checked:
 *   { schema: "quantity-scope.v1", jobId, organizationId, actorUserId,
 *     state: "single_only" | "multiple_allowed", grant: "participant" | "request" | null }
 * `grant` is null exactly when `state` is `single_only`. Only that verified answer can fix the field at
 * quantity 1 with the policy copy. An error, an answer for a different caller or job, or an answer that
 * does not match this contract is `unavailable`: the policy is unknown, so the field stays read only and
 * a save leaves the saved quantities as they are (it never writes 1 on the strength of a failed read).
 */

export type QuantityScopeIdentity = { actorUserId: string; organizationId: string; jobId: string };

export type QuantityScope = QuantityScopeIdentity & {
  schema: "quantity-scope.v1";
  state: "single_only" | "multiple_allowed";
  grant: "participant" | "request" | null;
};

/**
 * `unavailable` means there is no verified answer (read failed, answer did not match, or nothing to
 * ask yet). It is not the server saying `single_only`, the way `useQuoteAccess` reports `unknown`.
 */
export type QuantityScopeStatus = "loading" | "single_only" | "multiple_allowed" | "unavailable";

const FIELDS = ["schema", "jobId", "organizationId", "actorUserId", "state", "grant"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseQuantityScope(value: unknown, identity: QuantityScopeIdentity): QuantityScope {
  const invalid = () => new TypeError("Quantity scope could not be verified.");
  const keys = isRecord(value) ? Object.keys(value) : [];
  if (!isRecord(value) || keys.length !== FIELDS.length || !FIELDS.every((key) => keys.includes(key))) {
    throw invalid();
  }
  if (
    value.schema !== "quantity-scope.v1" ||
    !identity.jobId ||
    !identity.organizationId ||
    !identity.actorUserId ||
    value.jobId !== identity.jobId ||
    value.organizationId !== identity.organizationId ||
    value.actorUserId !== identity.actorUserId
  ) {
    throw invalid();
  }
  const { state, grant } = value;
  if (state === "single_only" && grant === null) {
    return { ...identity, schema: "quantity-scope.v1", state, grant: null };
  }
  if (state === "multiple_allowed" && (grant === "participant" || grant === "request")) {
    return { ...identity, schema: "quantity-scope.v1", state, grant };
  }
  throw invalid();
}

export async function fetchQuantityScope(identity: QuantityScopeIdentity): Promise<QuantityScope> {
  try {
    const { data, error } = await callUntypedRpc("api_get_quantity_scope", { p_job_id: identity.jobId });
    if (error) throw new Error("Quantity scope could not be verified.");
    return parseQuantityScope(data, identity);
  } catch {
    throw new Error("Quantity scope could not be verified.");
  }
}

/**
 * Policy snapshot for the editor only. `enabled` is false when the client flag is off or the session
 * is not verified, so no request is made then and the result is `unavailable` (the controller does not
 * read it with the flag off). Only a verified server answer is `single_only` or `multiple_allowed`.
 */
export function useQuantityScope(
  identity: QuantityScopeIdentity | null,
  enabled: boolean,
): { status: QuantityScopeStatus } {
  const query = useQuery({
    queryKey: ["quantity-scope", identity?.actorUserId, identity?.organizationId, identity?.jobId],
    queryFn: () => {
      if (!identity) throw new Error("Quantity scope identity is unavailable.");
      return fetchQuantityScope(identity);
    },
    enabled: Boolean(identity) && enabled,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (!enabled || !identity) return { status: "unavailable" };
  if (query.isFetching) return { status: "loading" };
  return { status: query.isError || !query.data ? "unavailable" : query.data.state };
}
