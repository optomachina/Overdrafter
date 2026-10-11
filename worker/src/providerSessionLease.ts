import { createHash, createHmac, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { VendorAutomationError, type VendorAutomationErrorCode } from "./types.js";

/**
 * OVD-462 provider session lease manager.
 *
 * One task at a time may hold the session binding for an exact provider,
 * approved account owner and runtime environment. The manager only ever handles
 * opaque references: `acct_<hex>` and `sb_<hex>` are HMAC-derived, so the raw
 * account, credentials, cookies, storage state and profile paths never reach a
 * permit, task payload, diagnostic or log line. Storage is pluggable: the
 * in-memory store backs tests, and the RPC store targets the service-role-only
 * functions proposed in docs/migration-drafts/ovd-462.sql.
 *
 * Lease loss is terminal for the task. Nothing here selects a different
 * session, account or credential source after contention, loss or a blocked
 * binding; callers get a bounded non-owning outcome instead.
 */

export const PROVIDER_SESSION_ENVIRONMENTS = ["production", "staging", "development", "test"] as const;
export type ProviderSessionEnvironment = (typeof PROVIDER_SESSION_ENVIRONMENTS)[number];

/** Outcomes that block the binding until an operator completes manual follow-up. */
export const PROVIDER_SESSION_BLOCKING_OUTCOMES = [
  "missing_session",
  "login_required",
  "challenge_required",
  "owner_revoked",
  "corrupt_state",
] as const;
export type ProviderSessionBlockingOutcome = (typeof PROVIDER_SESSION_BLOCKING_OUTCOMES)[number];
export type ProviderSessionTerminalOutcome = ProviderSessionBlockingOutcome | "lease_lost";

export const PROVIDER_SESSION_OUTCOME_DISPOSITION: Readonly<
  Record<ProviderSessionTerminalOutcome, { disposition: "manual_follow_up" | "terminal"; blocksBinding: boolean }>
> = Object.freeze({
  missing_session: { disposition: "manual_follow_up", blocksBinding: true },
  login_required: { disposition: "manual_follow_up", blocksBinding: true },
  challenge_required: { disposition: "manual_follow_up", blocksBinding: true },
  owner_revoked: { disposition: "manual_follow_up", blocksBinding: true },
  corrupt_state: { disposition: "manual_follow_up", blocksBinding: true },
  lease_lost: { disposition: "terminal", blocksBinding: false },
});

export type ProviderSessionIdentity = {
  provider: string;
  accountRef: string;
  environment: ProviderSessionEnvironment;
  sessionBindingRef: string;
};

export type ProviderSessionBindingKey = Pick<ProviderSessionIdentity, "provider" | "accountRef" | "environment">;

const PROVIDER = /^[a-z][a-z0-9_]{1,31}$/;
const ACCOUNT_REF = /^acct_[0-9a-f]{32}$/;
const SESSION_BINDING_REF = /^sb_[0-9a-f]{32}$/;
const TASK_REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HOLDER_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDENTITY_KEYS = ["accountRef", "environment", "provider", "sessionBindingRef"];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Exact-key validation: extra keys (for example storage state) are rejected, not ignored. */
export function isProviderSessionIdentity(value: unknown): value is ProviderSessionIdentity {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== IDENTITY_KEYS.length || keys.some((key, i) => key !== IDENTITY_KEYS[i])) return false;
  return (
    typeof value.provider === "string" && PROVIDER.test(value.provider) &&
    typeof value.accountRef === "string" && ACCOUNT_REF.test(value.accountRef) &&
    typeof value.environment === "string" &&
    (PROVIDER_SESSION_ENVIRONMENTS as readonly string[]).includes(value.environment) &&
    typeof value.sessionBindingRef === "string" && SESSION_BINDING_REF.test(value.sessionBindingRef)
  );
}

export function isProviderSessionTaskRef(value: unknown): value is string {
  return typeof value === "string" && TASK_REF.test(value);
}

export function isProviderSessionHolderToken(value: unknown): value is string {
  return typeof value === "string" && HOLDER_TOKEN.test(value);
}

function hmacHex(namespaceKey: Uint8Array, parts: string[]): string {
  if (!(namespaceKey instanceof Uint8Array) || namespaceKey.byteLength < 32) {
    throw new Error("Provider session namespace key must be at least 32 bytes.");
  }
  return createHmac("sha256", namespaceKey).update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

/**
 * Derives the opaque account reference. `accountMaterial` (for example the
 * approved login) is consumed here and never returned, stored or logged.
 */
export function deriveProviderAccountRef(namespaceKey: Uint8Array, provider: string, accountMaterial: string): string {
  if (!PROVIDER.test(provider) || typeof accountMaterial !== "string" || accountMaterial.length === 0) {
    throw new Error("Provider account reference input is invalid.");
  }
  return `acct_${hmacHex(namespaceKey, ["ovd462.account.v1", provider, accountMaterial])}`;
}

/**
 * Derives the opaque session-binding reference for one provider-local
 * storage/profile slot. The provider, account and environment are part of the
 * derivation, so a binding can never collide across providers or environments.
 */
export function deriveProviderSessionBindingRef(
  namespaceKey: Uint8Array,
  key: ProviderSessionBindingKey,
  slot: string,
): string {
  if (!PROVIDER.test(key.provider) || !ACCOUNT_REF.test(key.accountRef)
    || !(PROVIDER_SESSION_ENVIRONMENTS as readonly string[]).includes(key.environment)
    || typeof slot !== "string" || slot.length === 0) {
    throw new Error("Provider session binding input is invalid.");
  }
  return `sb_${hmacHex(namespaceKey, ["ovd462.binding.v1", key.provider, key.accountRef, key.environment, slot])}`;
}

/** Non-reversible tag for correlating log lines; never contains a reference. */
export function providerSessionBindingTag(identity: ProviderSessionIdentity): string {
  return createHash("sha256")
    .update(["ovd462.tag.v1", identity.provider, identity.accountRef, identity.environment, identity.sessionBindingRef].join("\u0000"))
    .digest("hex")
    .slice(0, 12);
}

// --------------------------------------------------------------------------- policy

export type ProviderSessionLeasePolicy = {
  /** Lease time-to-live per grant or renewal (5-300 s, matches SQL bounds). */
  ttlSeconds: number;
  /** Finite renewal budget (0-720). */
  maxRenewals: number;
  /** Hard cap on total lease lifetime (ttl-14400 s). */
  maxDurationSeconds: number;
  /** Local deadline margin subtracted from every confirmed expiry. */
  safetyMarginMs: number;
  /** Heartbeat interval for runWithLease. */
  heartbeatIntervalMs: number;
  /** Bounded store attempts per acquire when the store call itself fails. */
  acquireAttempts: number;
};

export const DEFAULT_PROVIDER_SESSION_LEASE_POLICY: Readonly<ProviderSessionLeasePolicy> = Object.freeze({
  ttlSeconds: 60,
  maxRenewals: 60,
  maxDurationSeconds: 3_600,
  safetyMarginMs: 10_000,
  heartbeatIntervalMs: 20_000,
  acquireAttempts: 2,
});

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function isValidProviderSessionLeasePolicy(policy: ProviderSessionLeasePolicy): boolean {
  const ttlMs = policy.ttlSeconds * 1000;
  return (
    isInt(policy.ttlSeconds, 5, 300) &&
    isInt(policy.maxRenewals, 0, 720) &&
    isInt(policy.maxDurationSeconds, policy.ttlSeconds, 14_400) &&
    isInt(policy.safetyMarginMs, 0, Math.floor(ttlMs / 2)) &&
    isInt(policy.heartbeatIntervalMs, 1, ttlMs - policy.safetyMarginMs - 1) &&
    isInt(policy.acquireAttempts, 1, 3)
  );
}

// --------------------------------------------------------------------------- store contract

export type ProviderSessionLeaseOwner = { identity: ProviderSessionIdentity; taskRef: string; holderToken: string };
export type ProviderSessionLeaseOwnedRequest = ProviderSessionLeaseOwner & { generation: number };
export type ProviderSessionLeaseStoreAcquireRequest = ProviderSessionLeaseOwner & {
  ttlSeconds: number;
  maxRenewals: number;
  maxDurationSeconds: number;
};

export type ProviderSessionLeaseRejectReason = "invalid_identity" | "invalid_policy" | "binding_mismatch" | "not_owner";
export type ProviderSessionLeaseLostReason = "released" | "expired" | "blocked" | "cleared" | "renewal_exhausted";
export type ProviderSessionLeaseEndedState = "released" | "expired" | "blocked" | "cleared";

export type ProviderSessionLeaseStoreAcquireResponse =
  | { status: "acquired"; generation: number; idempotent: boolean; expiresInMs: number; renewalsRemaining: number }
  | { status: "contended"; retryAfterMs: number }
  | { status: "manual_follow_up"; outcome: ProviderSessionBlockingOutcome }
  | { status: "rejected"; reason: Exclude<ProviderSessionLeaseRejectReason, "not_owner"> };

export type ProviderSessionLeaseStoreLost = {
  status: "lost";
  reason: ProviderSessionLeaseLostReason;
  outcome: ProviderSessionBlockingOutcome | null;
};
type OwnerRejected = { status: "rejected"; reason: "invalid_identity" | "not_owner" };

export type ProviderSessionLeaseStoreRenewResponse =
  | { status: "renewed"; expiresInMs: number; renewalsRemaining: number }
  | ProviderSessionLeaseStoreLost
  | OwnerRejected;

export type ProviderSessionLeaseStoreReleaseResponse =
  | { status: "released"; changed: boolean; finalState: ProviderSessionLeaseEndedState }
  | OwnerRejected;

export type ProviderSessionLeaseStoreReportResponse =
  | { status: "blocked"; outcome: ProviderSessionBlockingOutcome; generation: number }
  | ProviderSessionLeaseStoreLost
  | OwnerRejected;

export type ProviderSessionLeaseStoreRevokeResponse =
  | { status: "blocked"; outcome: ProviderSessionBlockingOutcome; generation: number }
  | { status: "rejected"; reason: "invalid_identity" | "binding_mismatch" };

export type ProviderSessionLeaseStoreClearResponse =
  | { status: "cleared" }
  | { status: "rejected"; reason: "invalid_identity" | "not_blocked" };

/**
 * Atomic lease storage. Each method must be linearizable per binding key:
 * the Postgres implementation serializes with a transaction advisory lock and a
 * unique partial index; the in-memory implementation runs each call without an
 * await between read and write.
 */
export interface ProviderSessionLeaseStore {
  acquire(request: ProviderSessionLeaseStoreAcquireRequest): Promise<ProviderSessionLeaseStoreAcquireResponse>;
  renew(request: ProviderSessionLeaseOwnedRequest): Promise<ProviderSessionLeaseStoreRenewResponse>;
  release(request: ProviderSessionLeaseOwnedRequest): Promise<ProviderSessionLeaseStoreReleaseResponse>;
  reportOutcome(
    request: ProviderSessionLeaseOwnedRequest & { outcome: ProviderSessionBlockingOutcome },
  ): Promise<ProviderSessionLeaseStoreReportResponse>;
}

/** Operator-only actions; not reachable from the task-facing manager. */
export interface ProviderSessionLeaseOperatorStore {
  revokeBinding(identity: ProviderSessionIdentity): Promise<ProviderSessionLeaseStoreRevokeResponse>;
  clearBlock(key: ProviderSessionBindingKey, generation: number): Promise<ProviderSessionLeaseStoreClearResponse>;
}

// --------------------------------------------------------------------------- errors and logging

/** Thrown by assertHeld(); the caller must stop before any further provider action. */
export class ProviderSessionLeaseLostError extends Error {
  readonly code = "provider_session_lease_lost" as const;
  constructor(readonly outcome: ProviderSessionTerminalOutcome) {
    super("Provider session lease is no longer held; stopping before any further provider action.");
    this.name = "ProviderSessionLeaseLostError";
  }
}

/** Adapters throw this to report a session condition that needs manual follow-up. */
export class ProviderSessionOutcomeError extends Error {
  constructor(readonly outcome: ProviderSessionBlockingOutcome) {
    super("Provider session requires manual follow-up.");
    this.name = "ProviderSessionOutcomeError";
  }
}

const VENDOR_ERROR_OUTCOMES: Partial<Record<VendorAutomationErrorCode, ProviderSessionBlockingOutcome>> = {
  login_required: "login_required",
  captcha: "challenge_required",
  anti_detection_block: "challenge_required",
};

/** Maps existing adapter failures and explicit outcome errors to a bounded session outcome. */
export function providerSessionOutcomeForError(error: unknown): ProviderSessionBlockingOutcome | null {
  if (error instanceof ProviderSessionOutcomeError) return error.outcome;
  if (error instanceof VendorAutomationError) return VENDOR_ERROR_OUTCOMES[error.code] ?? null;
  return null;
}

export type ProviderSessionLeaseLogEvent = {
  event:
    | "provider_session_lease.acquired"
    | "provider_session_lease.contended"
    | "provider_session_lease.manual_follow_up"
    | "provider_session_lease.rejected"
    | "provider_session_lease.unavailable"
    | "provider_session_lease.renewed"
    | "provider_session_lease.renew_unconfirmed"
    | "provider_session_lease.lost"
    | "provider_session_lease.released"
    | "provider_session_lease.release_unconfirmed"
    | "provider_session_lease.outcome_reported";
  provider: string;
  environment: string;
  bindingTag: string;
  generation?: number;
  outcome?: ProviderSessionTerminalOutcome;
  reason?: string;
  retryAfterMs?: number;
  renewalsRemaining?: number;
};

export type ProviderSessionLeaseLogger = (event: ProviderSessionLeaseLogEvent) => void;

function defaultLogger(event: ProviderSessionLeaseLogEvent): void {
  console.info(JSON.stringify({ level: "info", source: "providerSessionLease", ...event }));
}

// --------------------------------------------------------------------------- lease handle

export type ProviderSessionLeaseSummary = {
  schema: "provider-session-lease.v1";
  provider: string;
  environment: ProviderSessionEnvironment;
  bindingTag: string;
  generation: number;
  taskRef: string;
};

export type ProviderSessionLeaseRenewResult =
  | { kind: "renewed"; renewalsRemaining: number }
  | { kind: "unconfirmed" }
  | { kind: "lost"; outcome: ProviderSessionTerminalOutcome };

export type ProviderSessionLeaseReleaseResult = { kind: "released" } | { kind: "release_unconfirmed" };

export type ProviderSessionLeaseReportResult = {
  kind: "manual_follow_up" | "lost";
  outcome: ProviderSessionTerminalOutcome;
  recorded: boolean;
};

type HandleState = "held" | "lost" | "ended";

type HandleDeps = {
  store: ProviderSessionLeaseStore;
  now: () => number;
  log: ProviderSessionLeaseLogger;
  safetyMarginMs: number;
};

export class ProviderSessionLease {
  readonly provider: string;
  readonly environment: ProviderSessionEnvironment;
  readonly bindingTag: string;
  readonly generation: number;
  readonly taskRef: string;
  #identity: ProviderSessionIdentity;
  #holderToken: string;
  #deps: HandleDeps;
  #state: HandleState = "held";
  #deadline: number;
  #outcome: ProviderSessionTerminalOutcome | null = null;
  #releaseConfirmed = false;
  #renewalsRemaining: number;

  constructor(owner: ProviderSessionLeaseOwner, generation: number, deadline: number, renewalsRemaining: number, deps: HandleDeps) {
    this.#identity = { ...owner.identity };
    this.#holderToken = owner.holderToken;
    this.#deps = deps;
    this.#deadline = deadline;
    this.#renewalsRemaining = renewalsRemaining;
    this.provider = owner.identity.provider;
    this.environment = owner.identity.environment;
    this.bindingTag = providerSessionBindingTag(owner.identity);
    this.generation = generation;
    this.taskRef = owner.taskRef;
    Object.freeze(this);
  }

  /** Local view: held, not ended, and before the skew-safe local deadline. */
  isHeld(): boolean {
    return this.#state === "held" && this.#deps.now() < this.#deadline;
  }

  /** Milliseconds until the local deadline; 0 once the lease is not held. */
  remainingMs(): number {
    return this.isHeld() ? this.#deadline - this.#deps.now() : 0;
  }

  /** Remaining confirmed renewals as of the last store response. */
  get renewalsRemaining(): number {
    return this.#renewalsRemaining;
  }

  /** Terminal outcome once the lease is no longer held, otherwise null. */
  get outcome(): ProviderSessionTerminalOutcome | null {
    return this.#outcome;
  }

  /** Call immediately before every provider action. */
  assertHeld(): void {
    if (this.isHeld()) return;
    if (this.#state === "held") this.#markLost("lease_lost", "deadline");
    throw new ProviderSessionLeaseLostError(this.#outcome ?? "lease_lost");
  }

  async renew(): Promise<ProviderSessionLeaseRenewResult> {
    if (this.#state !== "held") return { kind: "lost", outcome: this.#outcome ?? "lease_lost" };
    const startedAt = this.#deps.now();
    if (startedAt >= this.#deadline) {
      this.#markLost("lease_lost", "deadline");
      return { kind: "lost", outcome: "lease_lost" };
    }
    let response: ProviderSessionLeaseStoreRenewResponse;
    try {
      response = await this.#deps.store.renew(this.#owned());
    } catch {
      // Ownership is unconfirmed but still bounded by the last confirmed deadline.
      this.#emit("provider_session_lease.renew_unconfirmed");
      return { kind: "unconfirmed" };
    }
    if (this.#state !== "held") return { kind: "lost", outcome: this.#outcome ?? "lease_lost" };
    if (response.status === "renewed") {
      this.#deadline = startedAt + response.expiresInMs - this.#deps.safetyMarginMs;
      this.#renewalsRemaining = response.renewalsRemaining;
      this.#emit("provider_session_lease.renewed", { renewalsRemaining: response.renewalsRemaining });
      return { kind: "renewed", renewalsRemaining: response.renewalsRemaining };
    }
    const outcome: ProviderSessionTerminalOutcome =
      response.status === "lost" && response.reason === "blocked" && response.outcome ? response.outcome : "lease_lost";
    this.#markLost(outcome, response.reason);
    return { kind: "lost", outcome };
  }

  /** Idempotent. Stops local use immediately, even if the store call fails. */
  async release(): Promise<ProviderSessionLeaseReleaseResult> {
    if (this.#releaseConfirmed) return { kind: "released" };
    if (this.#state === "held") this.#state = "ended";
    let response: ProviderSessionLeaseStoreReleaseResponse;
    try {
      response = await this.#deps.store.release(this.#owned());
    } catch {
      this.#emit("provider_session_lease.release_unconfirmed");
      return { kind: "release_unconfirmed" };
    }
    this.#releaseConfirmed = true;
    this.#emit("provider_session_lease.released", {
      reason: response.status === "released" ? response.finalState : response.reason,
    });
    return { kind: "released" };
  }

  /** Records a blocking outcome for the binding and ends this lease. */
  async reportOutcome(outcome: ProviderSessionBlockingOutcome): Promise<ProviderSessionLeaseReportResult> {
    if (!(PROVIDER_SESSION_BLOCKING_OUTCOMES as readonly string[]).includes(outcome)) {
      throw new Error("Unknown provider session outcome.");
    }
    if (!this.isHeld()) {
      if (this.#state === "held") this.#markLost("lease_lost", "deadline");
      return { kind: "lost", outcome: this.#outcome ?? "lease_lost", recorded: false };
    }
    this.#state = "ended";
    this.#outcome = outcome;
    let response: ProviderSessionLeaseStoreReportResponse;
    try {
      response = await this.#deps.store.reportOutcome({ ...this.#owned(), outcome });
    } catch {
      this.#emit("provider_session_lease.outcome_reported", { outcome, reason: "unconfirmed" });
      return { kind: "manual_follow_up", outcome, recorded: false };
    }
    this.#releaseConfirmed = true;
    if (response.status === "blocked") {
      this.#emit("provider_session_lease.outcome_reported", { outcome });
      return { kind: "manual_follow_up", outcome, recorded: true };
    }
    this.#emit("provider_session_lease.outcome_reported", { outcome, reason: response.reason });
    return { kind: "manual_follow_up", outcome, recorded: false };
  }

  /** Safe projection for permits, task payloads and diagnostics. */
  toJSON(): ProviderSessionLeaseSummary {
    return {
      schema: "provider-session-lease.v1",
      provider: this.provider,
      environment: this.environment,
      bindingTag: this.bindingTag,
      generation: this.generation,
      taskRef: this.taskRef,
    };
  }

  [inspect.custom](): ProviderSessionLeaseSummary {
    return this.toJSON();
  }

  #owned(): ProviderSessionLeaseOwnedRequest {
    return {
      identity: { ...this.#identity },
      taskRef: this.taskRef,
      holderToken: this.#holderToken,
      generation: this.generation,
    };
  }

  #markLost(outcome: ProviderSessionTerminalOutcome, reason: string): void {
    this.#state = "lost";
    this.#outcome = outcome;
    this.#emit("provider_session_lease.lost", { outcome, reason });
  }

  #emit(event: ProviderSessionLeaseLogEvent["event"], extra: Partial<ProviderSessionLeaseLogEvent> = {}): void {
    this.#deps.log({
      event,
      provider: this.provider,
      environment: this.environment,
      bindingTag: this.bindingTag,
      generation: this.generation,
      ...extra,
    });
  }
}

// --------------------------------------------------------------------------- manager

export type ProviderSessionLeaseRequest = { identity: ProviderSessionIdentity; taskRef: string };

export type ProviderSessionLeaseAcquireResult =
  | { kind: "acquired"; lease: ProviderSessionLease }
  | { kind: "contended"; retryAfterMs: number }
  | { kind: "manual_follow_up"; outcome: ProviderSessionBlockingOutcome }
  | { kind: "rejected"; reason: "invalid_identity" | "invalid_policy" | "binding_mismatch" }
  | { kind: "unavailable" };

export type ProviderSessionLeaseContext = {
  /** Aborted with ProviderSessionLeaseLostError as soon as the lease is lost. */
  signal: AbortSignal;
  /** Call immediately before every provider action. */
  assertHeld(): void;
  lease: ProviderSessionLeaseSummary;
};

export type ProviderSessionLeaseRunResult<T> =
  | { kind: "completed"; value: T }
  | { kind: "lease_lost"; outcome: ProviderSessionTerminalOutcome }
  | Exclude<ProviderSessionLeaseAcquireResult, { kind: "acquired" }>;

export type ProviderSessionLeaseManagerOptions = {
  store: ProviderSessionLeaseStore;
  policy?: Partial<ProviderSessionLeasePolicy>;
  now?: () => number;
  log?: ProviderSessionLeaseLogger;
  holderToken?: () => string;
};

export type ProviderSessionLeaseManager = {
  readonly policy: Readonly<ProviderSessionLeasePolicy>;
  acquire(request: ProviderSessionLeaseRequest): Promise<ProviderSessionLeaseAcquireResult>;
  runWithLease<T>(
    request: ProviderSessionLeaseRequest,
    operation: (context: ProviderSessionLeaseContext) => Promise<T>,
  ): Promise<ProviderSessionLeaseRunResult<T>>;
};

export function createProviderSessionLeaseManager(options: ProviderSessionLeaseManagerOptions): ProviderSessionLeaseManager {
  const policy: ProviderSessionLeasePolicy = Object.freeze({ ...DEFAULT_PROVIDER_SESSION_LEASE_POLICY, ...options.policy });
  if (!isValidProviderSessionLeasePolicy(policy)) throw new Error("Provider session lease policy is out of bounds.");
  const store = options.store;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? defaultLogger;
  const newHolderToken = options.holderToken ?? randomUUID;
  const ttlMs = policy.ttlSeconds * 1000;

  async function acquire(request: ProviderSessionLeaseRequest): Promise<ProviderSessionLeaseAcquireResult> {
    const identity = isPlainRecord(request) ? request.identity : undefined;
    if (!isPlainRecord(request) || !isProviderSessionIdentity(identity) || !isProviderSessionTaskRef(request.taskRef)) {
      log({ event: "provider_session_lease.rejected", provider: "invalid", environment: "invalid", bindingTag: "invalid", reason: "invalid_identity" });
      return { kind: "rejected", reason: "invalid_identity" };
    }
    const holderToken = newHolderToken();
    if (!isProviderSessionHolderToken(holderToken)) throw new Error("Provider session holder token generator is invalid.");
    const owner: ProviderSessionLeaseOwner = { identity: { ...identity }, taskRef: request.taskRef, holderToken };
    const base = { provider: identity.provider, environment: identity.environment, bindingTag: providerSessionBindingTag(identity) };

    // Retrying with the same holder token is safe: the store treats it as the
    // exact owner, so a lost response cannot leave an orphan second lease.
    for (let attempt = 1; attempt <= policy.acquireAttempts; attempt += 1) {
      const startedAt = now();
      let response: ProviderSessionLeaseStoreAcquireResponse;
      try {
        response = await store.acquire({
          ...owner,
          identity: { ...owner.identity },
          ttlSeconds: policy.ttlSeconds,
          maxRenewals: policy.maxRenewals,
          maxDurationSeconds: policy.maxDurationSeconds,
        });
      } catch {
        continue;
      }
      switch (response.status) {
        case "acquired": {
          const lease = new ProviderSessionLease(
            owner,
            response.generation,
            startedAt + response.expiresInMs - policy.safetyMarginMs,
            response.renewalsRemaining,
            { store, now, log, safetyMarginMs: policy.safetyMarginMs },
          );
          log({ event: "provider_session_lease.acquired", ...base, generation: response.generation, renewalsRemaining: response.renewalsRemaining });
          return { kind: "acquired", lease };
        }
        case "contended": {
          const retryAfterMs = Math.min(Math.max(1, Math.ceil(response.retryAfterMs)), ttlMs);
          log({ event: "provider_session_lease.contended", ...base, retryAfterMs });
          return { kind: "contended", retryAfterMs };
        }
        case "manual_follow_up":
          log({ event: "provider_session_lease.manual_follow_up", ...base, outcome: response.outcome });
          return { kind: "manual_follow_up", outcome: response.outcome };
        case "rejected":
          log({ event: "provider_session_lease.rejected", ...base, reason: response.reason });
          return { kind: "rejected", reason: response.reason };
      }
    }
    log({ event: "provider_session_lease.unavailable", ...base });
    return { kind: "unavailable" };
  }

  async function runWithLease<T>(
    request: ProviderSessionLeaseRequest,
    operation: (context: ProviderSessionLeaseContext) => Promise<T>,
  ): Promise<ProviderSessionLeaseRunResult<T>> {
    const acquired = await acquire(request);
    if (acquired.kind !== "acquired") return acquired;
    const lease = acquired.lease;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const abortIfLost = () => {
      if (!controller.signal.aborted && !lease.isHeld()) {
        controller.abort(new ProviderSessionLeaseLostError(lease.outcome ?? "lease_lost"));
      }
    };
    // The watchdog fires at the local deadline, so an unconfirmed renewal stops
    // the operation before the store could grant the binding to anyone else.
    const armWatchdog = () => {
      if (watchdog !== undefined) clearTimeout(watchdog);
      if (stopped || controller.signal.aborted) return;
      watchdog = setTimeout(abortIfLost, lease.remainingMs());
    };
    const schedule = () => {
      if (stopped || controller.signal.aborted) return;
      timer = setTimeout(() => void beat(), policy.heartbeatIntervalMs);
    };
    const beat = async () => {
      if (stopped) return;
      const result = await lease.renew();
      if (result.kind === "lost") {
        controller.abort(new ProviderSessionLeaseLostError(result.outcome));
        return;
      }
      abortIfLost();
      armWatchdog();
      schedule();
    };
    armWatchdog();
    schedule();

    const assertHeld = () => {
      try {
        lease.assertHeld();
      } catch (error) {
        abortIfLost();
        throw error;
      }
    };

    let value: T | undefined;
    let failure: { error: unknown } | null = null;
    try {
      value = await operation({ signal: controller.signal, assertHeld, lease: lease.toJSON() });
    } catch (error) {
      failure = { error };
    } finally {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      if (watchdog !== undefined) clearTimeout(watchdog);
    }

    const outcome = failure ? providerSessionOutcomeForError(failure.error) : null;
    if (outcome && lease.isHeld()) {
      const reported = await lease.reportOutcome(outcome);
      return reported.kind === "manual_follow_up"
        ? { kind: "manual_follow_up", outcome }
        : { kind: "lease_lost", outcome: reported.outcome };
    }
    abortIfLost();
    if (controller.signal.aborted) {
      await lease.release();
      const reason = controller.signal.reason;
      return { kind: "lease_lost", outcome: reason instanceof ProviderSessionLeaseLostError ? reason.outcome : "lease_lost" };
    }
    await lease.release();
    if (failure) throw failure.error;
    return { kind: "completed", value: value as T };
  }

  return { policy, acquire, runWithLease };
}
