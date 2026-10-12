import {
  compareCodeUnits,
  isProviderSessionOperatorAudit,
  PROVIDER_SESSION_BLOCKING_OUTCOMES,
  type ProviderSessionBindingKey,
  type ProviderSessionBlockingOutcome,
  type ProviderSessionIdentity,
  type ProviderSessionLeaseOperatorAudit,
  type ProviderSessionLeaseOperatorStore,
  type ProviderSessionLeaseOwnedRequest,
  type ProviderSessionLeaseStore,
  type ProviderSessionLeaseStoreAcquireResponse,
  type ProviderSessionLeaseStoreClearResponse,
  type ProviderSessionLeaseStoreLost,
  type ProviderSessionLeaseStoreReleaseResponse,
  type ProviderSessionLeaseStoreRenewResponse,
  type ProviderSessionLeaseStoreReportResponse,
  type ProviderSessionLeaseStoreRevokeResponse,
} from "./providerSessionLease.js";

/**
 * ProviderSessionLeaseStore backed by the service-role-only RPCs proposed in
 * docs/migration-drafts/ovd-462.sql. Usable only after that migration is
 * applied (migration window 1); until then every call fails closed through the
 * manager's `unavailable` / unconfirmed paths.
 *
 * Worker code gets only `createProviderSessionLeaseRpcStore` (acquire, renew,
 * release, report). Operator revoke/clear live in a separate factory,
 * `createProviderSessionLeaseOperatorRpcStore`, for operator tooling only, and
 * require an actor and reason reference that the database records.
 *
 * Responses are parsed exact-key. Client errors are replaced by a fixed error
 * so PostgREST details (which can echo arguments) never reach logs.
 */

export type ProviderSessionLeaseRpcClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

export class ProviderSessionLeaseStoreError extends Error {
  constructor(readonly code: "rpc_failed" | "malformed_response") {
    super(code === "rpc_failed" ? "Provider session lease RPC failed." : "Provider session lease RPC returned a malformed response.");
    this.name = "ProviderSessionLeaseStoreError";
  }
}

export const PROVIDER_SESSION_LEASE_RPCS = Object.freeze({
  acquire: "acquire_provider_session_lease",
  renew: "renew_provider_session_lease",
  release: "release_provider_session_lease",
  reportOutcome: "report_provider_session_lease_outcome",
});

export const PROVIDER_SESSION_LEASE_OPERATOR_RPCS = Object.freeze({
  revokeBinding: "revoke_provider_session_binding",
  clearBlock: "clear_provider_session_binding_block",
});

type Json = Record<string, unknown>;

function malformed(): never {
  throw new ProviderSessionLeaseStoreError("malformed_response");
}

function exact(value: unknown, keys: string[]): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) malformed();
  const actual = Object.keys(value as Json).sort(compareCodeUnits);
  const expected = [...keys].sort(compareCodeUnits);
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) malformed();
  return value as Json;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) malformed();
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) malformed();
  return value as T;
}

function bool(value: unknown): boolean {
  if (typeof value !== "boolean") malformed();
  return value;
}

const OUTCOMES = PROVIDER_SESSION_BLOCKING_OUTCOMES;
const LOST_REASONS = ["released", "expired", "blocked", "cleared", "revoked", "renewal_exhausted"] as const;
const ENDED = ["released", "expired", "blocked", "cleared", "revoked"] as const;

function statusOf(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) malformed();
  const status = (value as Json).status;
  if (typeof status !== "string") malformed();
  return status;
}

function parseLost(data: unknown): ProviderSessionLeaseStoreLost {
  const row = exact(data, ["status", "reason", "outcome"]);
  return {
    status: "lost",
    reason: oneOf(row.reason, LOST_REASONS),
    outcome: row.outcome === null ? null : oneOf(row.outcome, OUTCOMES),
  };
}

function parseOwnerRejected(data: unknown) {
  const row = exact(data, ["status", "reason"]);
  return { status: "rejected" as const, reason: oneOf(row.reason, ["invalid_identity", "not_owner"] as const) };
}

function rpcCaller(client: ProviderSessionLeaseRpcClient) {
  return async function call(fn: string, args: Json): Promise<unknown> {
    let result: { data: unknown; error: unknown };
    try {
      result = await client.rpc(fn, args);
    } catch {
      throw new ProviderSessionLeaseStoreError("rpc_failed");
    }
    if (result.error) throw new ProviderSessionLeaseStoreError("rpc_failed");
    return result.data;
  };
}

function auditArgs(audit: ProviderSessionLeaseOperatorAudit): Json {
  return { p_actor_ref: audit.actorRef, p_reason_ref: audit.reasonRef };
}

function identityArgs(identity: ProviderSessionIdentity): Json {
  return {
    p_provider: identity.provider,
    p_account_ref: identity.accountRef,
    p_environment: identity.environment,
    p_session_binding_ref: identity.sessionBindingRef,
  };
}

function ownedArgs(request: ProviderSessionLeaseOwnedRequest): Json {
  return {
    ...identityArgs(request.identity),
    p_task_ref: request.taskRef,
    p_holder_token: request.holderToken,
    p_generation: request.generation,
  };
}

export function createProviderSessionLeaseRpcStore(client: ProviderSessionLeaseRpcClient): ProviderSessionLeaseStore {
  const call = rpcCaller(client);

  return {
    async acquire(request): Promise<ProviderSessionLeaseStoreAcquireResponse> {
      const data = await call(PROVIDER_SESSION_LEASE_RPCS.acquire, {
        ...identityArgs(request.identity),
        p_task_ref: request.taskRef,
        p_holder_token: request.holderToken,
        p_ttl_seconds: request.ttlSeconds,
        p_max_renewals: request.maxRenewals,
        p_max_duration_seconds: request.maxDurationSeconds,
      });
      switch (statusOf(data)) {
        case "acquired": {
          const row = exact(data, ["status", "generation", "idempotent", "expires_in_ms", "renewals_remaining"]);
          const generation = count(row.generation);
          if (generation < 1) malformed();
          return {
            status: "acquired",
            generation,
            idempotent: bool(row.idempotent),
            expiresInMs: count(row.expires_in_ms),
            renewalsRemaining: count(row.renewals_remaining),
          };
        }
        case "contended":
          return { status: "contended", retryAfterMs: count(exact(data, ["status", "retry_after_ms"]).retry_after_ms) };
        case "manual_follow_up":
          return { status: "manual_follow_up", outcome: oneOf(exact(data, ["status", "outcome"]).outcome, OUTCOMES) };
        case "rejected":
          return {
            status: "rejected",
            reason: oneOf(exact(data, ["status", "reason"]).reason, ["invalid_identity", "invalid_policy", "binding_mismatch"] as const),
          };
        default:
          return malformed();
      }
    },

    async renew(request): Promise<ProviderSessionLeaseStoreRenewResponse> {
      const data = await call(PROVIDER_SESSION_LEASE_RPCS.renew, ownedArgs(request));
      switch (statusOf(data)) {
        case "renewed": {
          const row = exact(data, ["status", "expires_in_ms", "renewals_remaining"]);
          return { status: "renewed", expiresInMs: count(row.expires_in_ms), renewalsRemaining: count(row.renewals_remaining) };
        }
        case "lost":
          return parseLost(data);
        case "rejected":
          return parseOwnerRejected(data);
        default:
          return malformed();
      }
    },

    async release(request): Promise<ProviderSessionLeaseStoreReleaseResponse> {
      const data = await call(PROVIDER_SESSION_LEASE_RPCS.release, ownedArgs(request));
      switch (statusOf(data)) {
        case "released": {
          const row = exact(data, ["status", "changed", "final_state"]);
          return { status: "released", changed: bool(row.changed), finalState: oneOf(row.final_state, ENDED) };
        }
        case "rejected":
          return parseOwnerRejected(data);
        default:
          return malformed();
      }
    },

    async reportOutcome(request): Promise<ProviderSessionLeaseStoreReportResponse> {
      const data = await call(PROVIDER_SESSION_LEASE_RPCS.reportOutcome, { ...ownedArgs(request), p_outcome: request.outcome });
      switch (statusOf(data)) {
        case "blocked": {
          const row = exact(data, ["status", "outcome", "generation"]);
          return { status: "blocked", outcome: oneOf(row.outcome, OUTCOMES), generation: count(row.generation) };
        }
        case "lost":
          return parseLost(data);
        case "rejected": {
          const reason = oneOf(exact(data, ["status", "reason"]).reason, ["invalid_identity", "not_owner", "invalid_outcome"] as const);
          return { status: "rejected", reason };
        }
        default:
          return malformed();
      }
    },
  };
}

/** Operator tooling only. Never pass this store to the worker lease manager. */
export function createProviderSessionLeaseOperatorRpcStore(client: ProviderSessionLeaseRpcClient): ProviderSessionLeaseOperatorStore {
  const call = rpcCaller(client);

  return {
    async revokeBinding(identity, audit): Promise<ProviderSessionLeaseStoreRevokeResponse> {
      if (!isProviderSessionOperatorAudit(audit)) return { status: "rejected", reason: "invalid_actor" };
      const data = await call(PROVIDER_SESSION_LEASE_OPERATOR_RPCS.revokeBinding, { ...identityArgs(identity), ...auditArgs(audit) });
      switch (statusOf(data)) {
        case "blocked": {
          const row = exact(data, ["status", "outcome", "generation"]);
          return {
            status: "blocked",
            outcome: oneOf<ProviderSessionBlockingOutcome>(row.outcome, OUTCOMES),
            generation: count(row.generation),
          };
        }
        case "rejected":
          return {
            status: "rejected",
            reason: oneOf(exact(data, ["status", "reason"]).reason, ["invalid_identity", "invalid_actor", "binding_mismatch"] as const),
          };
        default:
          return malformed();
      }
    },

    async clearBlock(
      key: ProviderSessionBindingKey,
      generation: number,
      audit: ProviderSessionLeaseOperatorAudit,
    ): Promise<ProviderSessionLeaseStoreClearResponse> {
      if (!isProviderSessionOperatorAudit(audit)) return { status: "rejected", reason: "invalid_actor" };
      const data = await call(PROVIDER_SESSION_LEASE_OPERATOR_RPCS.clearBlock, {
        p_provider: key.provider,
        p_account_ref: key.accountRef,
        p_environment: key.environment,
        p_generation: generation,
        ...auditArgs(audit),
      });
      switch (statusOf(data)) {
        case "cleared":
          exact(data, ["status"]);
          return { status: "cleared" };
        case "rejected":
          return {
            status: "rejected",
            reason: oneOf(exact(data, ["status", "reason"]).reason, ["invalid_identity", "invalid_actor", "not_blocked"] as const),
          };
        default:
          return malformed();
      }
    },
  };
}
