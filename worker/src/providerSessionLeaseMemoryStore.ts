import {
  isProviderSessionHolderToken,
  isProviderSessionIdentity,
  isProviderSessionOperatorAudit,
  isProviderSessionTaskRef,
  PROVIDER_SESSION_REPORTABLE_OUTCOMES,
  type ProviderSessionBindingKey,
  type ProviderSessionBlockingOutcome,
  type ProviderSessionIdentity,
  type ProviderSessionLeaseOperatorAudit,
  type ProviderSessionLeaseOperatorStore,
  type ProviderSessionLeaseOwnedRequest,
  type ProviderSessionReportableOutcome,
  type ProviderSessionLeaseStore,
  type ProviderSessionLeaseStoreAcquireRequest,
  type ProviderSessionLeaseStoreAcquireResponse,
  type ProviderSessionLeaseStoreClearResponse,
  type ProviderSessionLeaseStoreReleaseResponse,
  type ProviderSessionLeaseStoreRenewResponse,
  type ProviderSessionLeaseStoreReportResponse,
  type ProviderSessionLeaseStoreRevokeResponse,
} from "./providerSessionLease.js";

/**
 * In-memory ProviderSessionLeaseStore with the same semantics as the SQL RPCs in
 * supabase/migrations/20261012212325_ovd462_provider_session_lease.sql. Every method reads and writes
 * without an intervening await, so each call is atomic on the event loop, which
 * mirrors the per-binding advisory lock in Postgres. Intended for tests and
 * local fakes only; it is not a cross-process lock.
 */

type LeaseRowState = "active" | "released" | "expired" | "blocked" | "cleared" | "revoked";

export type ProviderSessionLeaseMemoryRow = {
  provider: string;
  accountRef: string;
  environment: string;
  sessionBindingRef: string;
  generation: number;
  state: LeaseRowState;
  ownerTaskRef: string | null;
  holderToken: string | null;
  outcome: ProviderSessionBlockingOutcome | null;
  ttlMs: number | null;
  maxRenewals: number | null;
  renewalCount: number;
  expiresAt: number | null;
  hardExpiresAt: number | null;
  revokedBy: ProviderSessionLeaseOperatorAudit | null;
  clearedBy: ProviderSessionLeaseOperatorAudit | null;
};

export type ProviderSessionLeaseMemoryStore = ProviderSessionLeaseStore &
  ProviderSessionLeaseOperatorStore & {
    /** Read-only snapshot for assertions. */
    rows(): ProviderSessionLeaseMemoryRow[];
  };

function sameKey(row: ProviderSessionLeaseMemoryRow, key: ProviderSessionBindingKey): boolean {
  return row.provider === key.provider && row.accountRef === key.accountRef && row.environment === key.environment;
}

export function createProviderSessionLeaseMemoryStore(options: { now?: () => number } = {}): ProviderSessionLeaseMemoryStore {
  const now = options.now ?? (() => Date.now());
  const rows: ProviderSessionLeaseMemoryRow[] = [];

  const occupant = (key: ProviderSessionBindingKey) =>
    rows.find((row) => sameKey(row, key) && (row.state === "active" || row.state === "blocked"));
  const nextGeneration = (key: ProviderSessionBindingKey) => {
    const fromHistory = rows.filter((row) => sameKey(row, key)).reduce((max, row) => Math.max(max, row.generation), 0) + 1;
    const generation = Math.max(counters.get(keyOf(key)) ?? 1, fromHistory);
    counters.set(keyOf(key), generation + 1);
    return generation;
  };
  // Mirrors provider_session_bindings: a session binding registers to one key,
  // and the per-key generation counter survives lease-history deletion.
  const bindings = new Map<string, ProviderSessionBindingKey>();
  const counters = new Map<string, number>();
  const keyOf = (key: ProviderSessionBindingKey) => `${key.provider}|${key.accountRef}|${key.environment}`;
  const bindingUsedElsewhere = (identity: ProviderSessionIdentity) => {
    const registered = bindings.get(identity.sessionBindingRef);
    return registered !== undefined && keyOf(registered) !== keyOf(identity);
  };
  const register = (identity: ProviderSessionIdentity) => {
    if (!bindings.has(identity.sessionBindingRef)) {
      bindings.set(identity.sessionBindingRef, {
        provider: identity.provider,
        accountRef: identity.accountRef,
        environment: identity.environment,
      });
    }
  };
  const expireStale = (key: ProviderSessionBindingKey, at: number) => {
    for (const row of rows) {
      if (sameKey(row, key) && row.state === "active" && (row.expiresAt ?? 0) <= at) row.state = "expired";
    }
  };
  const findOwned = (request: ProviderSessionLeaseOwnedRequest) => {
    const row = rows.find((candidate) => sameKey(candidate, request.identity) && candidate.generation === request.generation);
    if (!row || row.holderToken === null || row.sessionBindingRef !== request.identity.sessionBindingRef
      || row.ownerTaskRef !== request.taskRef || row.holderToken !== request.holderToken) {
      return null;
    }
    return row;
  };

  return {
    async acquire(request: ProviderSessionLeaseStoreAcquireRequest): Promise<ProviderSessionLeaseStoreAcquireResponse> {
      const { identity } = request;
      if (!isProviderSessionIdentity(identity) || !isProviderSessionTaskRef(request.taskRef)
        || !isProviderSessionHolderToken(request.holderToken)) {
        return { status: "rejected", reason: "invalid_identity" };
      }
      const { ttlSeconds, maxRenewals, maxDurationSeconds } = request;
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 5 || ttlSeconds > 300
        || !Number.isInteger(maxRenewals) || maxRenewals < 0 || maxRenewals > 720
        || !Number.isInteger(maxDurationSeconds) || maxDurationSeconds < ttlSeconds || maxDurationSeconds > 14_400) {
        return { status: "rejected", reason: "invalid_policy" };
      }
      const at = now();
      if (bindingUsedElsewhere(identity)) return { status: "rejected", reason: "binding_mismatch" };
      expireStale(identity, at);
      const current = occupant(identity);
      if (current?.state === "blocked") return { status: "manual_follow_up", outcome: current.outcome! };
      if (current) {
        if (current.ownerTaskRef === request.taskRef && current.holderToken === request.holderToken
          && current.sessionBindingRef === identity.sessionBindingRef) {
          return {
            status: "acquired",
            generation: current.generation,
            idempotent: true,
            expiresInMs: Math.max(0, current.expiresAt! - at),
            renewalsRemaining: current.maxRenewals! - current.renewalCount,
          };
        }
        return {
          status: "contended",
          retryAfterMs: Math.min(Math.max(1, Math.ceil(current.expiresAt! - at)), ttlSeconds * 1000),
        };
      }
      register(identity);
      const generation = nextGeneration(identity);
      rows.push({
        provider: identity.provider,
        accountRef: identity.accountRef,
        environment: identity.environment,
        sessionBindingRef: identity.sessionBindingRef,
        generation,
        state: "active",
        ownerTaskRef: request.taskRef,
        holderToken: request.holderToken,
        outcome: null,
        ttlMs: ttlSeconds * 1000,
        maxRenewals,
        renewalCount: 0,
        expiresAt: at + ttlSeconds * 1000,
        hardExpiresAt: at + maxDurationSeconds * 1000,
        revokedBy: null,
        clearedBy: null,
      });
      return { status: "acquired", generation, idempotent: false, expiresInMs: ttlSeconds * 1000, renewalsRemaining: maxRenewals };
    },

    async renew(request: ProviderSessionLeaseOwnedRequest): Promise<ProviderSessionLeaseStoreRenewResponse> {
      if (!isProviderSessionIdentity(request.identity)) return { status: "rejected", reason: "invalid_identity" };
      const row = findOwned(request);
      if (!row) return { status: "rejected", reason: "not_owner" };
      if (row.state !== "active") return { status: "lost", reason: row.state, outcome: row.outcome };
      const at = now();
      if (row.expiresAt! <= at) {
        row.state = "expired";
        return { status: "lost", reason: "expired", outcome: null };
      }
      // Denied, but the row stays active until its current expiresAt: the holder
      // may still run until the deadline it was given.
      if (row.renewalCount >= row.maxRenewals! || row.hardExpiresAt! <= at) {
        return { status: "lost", reason: "renewal_exhausted", outcome: null };
      }
      row.renewalCount += 1;
      row.expiresAt = Math.min(at + row.ttlMs!, row.hardExpiresAt!);
      return { status: "renewed", expiresInMs: row.expiresAt - at, renewalsRemaining: row.maxRenewals! - row.renewalCount };
    },

    async release(request: ProviderSessionLeaseOwnedRequest): Promise<ProviderSessionLeaseStoreReleaseResponse> {
      if (!isProviderSessionIdentity(request.identity)) return { status: "rejected", reason: "invalid_identity" };
      const row = findOwned(request);
      if (!row) return { status: "rejected", reason: "not_owner" };
      if (row.state !== "active") return { status: "released", changed: false, finalState: row.state };
      row.state = row.expiresAt! <= now() ? "expired" : "released";
      return { status: "released", changed: row.state === "released", finalState: row.state };
    },

    async reportOutcome(
      request: ProviderSessionLeaseOwnedRequest & { outcome: ProviderSessionReportableOutcome },
    ): Promise<ProviderSessionLeaseStoreReportResponse> {
      if (!isProviderSessionIdentity(request.identity)) return { status: "rejected", reason: "invalid_identity" };
      if (!(PROVIDER_SESSION_REPORTABLE_OUTCOMES as readonly string[]).includes(request.outcome)) {
        return { status: "rejected", reason: "invalid_outcome" };
      }
      const row = findOwned(request);
      if (!row) return { status: "rejected", reason: "not_owner" };
      if (row.state !== "active") return { status: "lost", reason: row.state, outcome: row.outcome };
      if (row.expiresAt! <= now()) {
        row.state = "expired";
        return { status: "lost", reason: "expired", outcome: null };
      }
      row.state = "blocked";
      row.outcome = request.outcome;
      return { status: "blocked", outcome: request.outcome, generation: row.generation };
    },

    async revokeBinding(
      identity: ProviderSessionIdentity,
      audit: ProviderSessionLeaseOperatorAudit,
    ): Promise<ProviderSessionLeaseStoreRevokeResponse> {
      if (!isProviderSessionIdentity(identity)) return { status: "rejected", reason: "invalid_identity" };
      if (!isProviderSessionOperatorAudit(audit)) return { status: "rejected", reason: "invalid_actor" };
      if (bindingUsedElsewhere(identity)) return { status: "rejected", reason: "binding_mismatch" };
      const current = occupant(identity);
      if (current && current.sessionBindingRef !== identity.sessionBindingRef) {
        return { status: "rejected", reason: "binding_mismatch" };
      }
      if (current?.state === "blocked") return { status: "blocked", outcome: current.outcome!, generation: current.generation };
      // The revoked holder's row ends as "revoked"; the block gets a fresh generation.
      if (current) {
        current.state = "revoked";
        current.outcome = "owner_revoked";
      }
      register(identity);
      const generation = nextGeneration(identity);
      rows.push({
        provider: identity.provider,
        accountRef: identity.accountRef,
        environment: identity.environment,
        sessionBindingRef: identity.sessionBindingRef,
        generation,
        state: "blocked",
        ownerTaskRef: null,
        holderToken: null,
        outcome: "owner_revoked",
        ttlMs: null,
        maxRenewals: null,
        renewalCount: 0,
        expiresAt: null,
        hardExpiresAt: null,
        revokedBy: { ...audit },
        clearedBy: null,
      });
      return { status: "blocked", outcome: "owner_revoked", generation };
    },

    async clearBlock(
      key: ProviderSessionBindingKey,
      generation: number,
      audit: ProviderSessionLeaseOperatorAudit,
    ): Promise<ProviderSessionLeaseStoreClearResponse> {
      const probe = { ...key, sessionBindingRef: `sb_${"0".repeat(32)}` };
      if (!isProviderSessionIdentity(probe)) return { status: "rejected", reason: "invalid_identity" };
      if (!isProviderSessionOperatorAudit(audit)) return { status: "rejected", reason: "invalid_actor" };
      const row = rows.find((candidate) => sameKey(candidate, key) && candidate.generation === generation && candidate.state === "blocked");
      if (!row) return { status: "rejected", reason: "not_blocked" };
      row.state = "cleared";
      row.clearedBy = { ...audit };
      return { status: "cleared" };
    },

    rows() {
      return rows.map((row) => ({
        ...row,
        revokedBy: row.revokedBy && { ...row.revokedBy },
        clearedBy: row.clearedBy && { ...row.clearedBy },
      }));
    },
  };
}
