import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProviderDispatchDenialCode } from "./providerDispatchEnvelope.js";
import {
  classifyProviderDispatchRpcFailure,
  ProviderDispatchAuthorizationError,
  type ProviderDispatchClaim,
} from "./providerDispatchPreflight.js";
import { markProviderDispatchSideEffectStarted } from "./providerMutationPhase.js";

/**
 * OVD-734 durable permit consumption (draft `docs/migration-drafts/ovd-734.sql`).
 *
 * The OVD-459 preflight is a read-only check, so a task requeued onto another
 * worker would pass it again. Immediately before dispatch the worker therefore
 * consumes the permit through `public.api_consume_provider_dispatch_permit`,
 * which records the attempt atomically and refuses a second dispatch of the
 * same permit and envelope fingerprint on any worker (`permit_already_consumed`).
 * The single exception is one transient retry: attempt 2 is granted only if
 * attempt 1 never started a side effect and recorded
 * `transient_pre_launch_failure`.
 *
 * Fail closed: an RPC error, a timeout, a malformed response, or a denial
 * throws `ProviderDispatchAuthorizationError` and the adapter is never called.
 *
 * Order for every dispatch path (main-branch routing in `dispatchRouting.ts`,
 * and the OVD-461 seam in PR #682 once it lands):
 *   1. the OVD-459 preflight (unchanged, read-only)
 *   2. `consume`: first the in-process guard (fast check, no round trip), then
 *      the durable cross-worker RPC
 *   3. `startSideEffect`: stamped immediately before the first provider-facing
 *      action; only now is the key recorded in the in-process guard
 *   4. adapter, then `recordOutcome` (best effort)
 * A failure between 2 and 3 is recorded as transient, so exactly one retry can
 * dispatch. Because the in-process guard records the key only at step 3, that
 * retry is not refused locally when it lands on the same worker.
 *
 * Seam integration (#682): call `consume` and `startSideEffect` after the seam's
 * own guards and file capture, immediately before `adapter.execute`, and map a
 * thrown `ProviderDispatchAuthorizationError` with the seam's existing
 * `providerExecutionDenialFromError`. The seam's in-process
 * `ProviderAuthorizationConsumer.consume(key)` marks the key on first
 * presentation; it should run after `startSideEffect` succeeds, or be paired
 * with `has` beforehand, so a transient pre-launch failure does not turn the
 * one permitted retry into `authorization_replayed` on the same process.
 */

export const PROVIDER_DISPATCH_PERMIT_CONSUMPTION_SCHEMA = "provider-dispatch-permit-consumption.v1" as const;
const CONSUME_RPC = "api_consume_provider_dispatch_permit";
const SIDE_EFFECT_RPC = "api_mark_provider_dispatch_permit_side_effect_started";
const OUTCOME_RPC = "api_record_provider_dispatch_permit_outcome";

/**
 * Longest wait for any consumption RPC. The database gives up on a held lock
 * after 2s (lock_timeout); this bounds the round trip on top of that.
 */
export const PROVIDER_DISPATCH_PERMIT_RPC_TIMEOUT_MS = 5_000;
/** One dispatch plus one transient retry; the database enforces the same bound. */
export const PROVIDER_DISPATCH_PERMIT_MAX_ATTEMPTS = 2;

export type ProviderDispatchPermitAttempt = 1 | 2;
export type ProviderDispatchPermitOutcome = "transient_pre_launch_failure" | "completed" | "failed";

export type ProviderDispatchPermitConsumption = Readonly<{
  permitId: string;
  envelopeFingerprint: string;
  attempt: ProviderDispatchPermitAttempt;
  workerName: string;
  expiresAtMs: number;
}>;

export type ProviderDispatchPermitConsumeInput = {
  claim: Pick<ProviderDispatchClaim, "workQueueTaskId" | "vendorQuoteResultId" | "permitId" | "envelopeFingerprint">;
  workerName: string;
  /** The authorization's expiry; the in-process guard forgets the key after it. */
  expiresAt: string;
};

export type ProviderDispatchPermitConsumer = {
  /** Records the attempt durably, or throws `ProviderDispatchAuthorizationError`. */
  consume(input: ProviderDispatchPermitConsumeInput): Promise<ProviderDispatchPermitConsumption>;
  /** Stamps the side effect immediately before the first provider-facing action, or throws. */
  startSideEffect(consumption: ProviderDispatchPermitConsumption): Promise<void>;
  /** Best-effort one-way outcome stamp; never throws. */
  recordOutcome(consumption: ProviderDispatchPermitConsumption, outcome: ProviderDispatchPermitOutcome): Promise<void>;
};

/** In-process record of permits whose side effect started here. */
export type ProviderDispatchPermitLocalGuard = {
  has(key: string, nowMs: number): boolean;
  add(key: string, expiresAtMs: number, nowMs: number): void;
};

export function createProviderDispatchPermitLocalGuard(): ProviderDispatchPermitLocalGuard {
  const started = new Map<string, number>();
  const prune = (nowMs: number) => {
    for (const [key, expiresAtMs] of started) if (expiresAtMs <= nowMs) started.delete(key);
  };
  return {
    has(key, nowMs) {
      prune(nowMs);
      return started.has(key);
    },
    add(key, expiresAtMs, nowMs) {
      prune(nowMs);
      started.set(key, expiresAtMs);
    },
  };
}

const processLocalGuard = createProviderDispatchPermitLocalGuard();

export function providerDispatchPermitKey(permitId: string, envelopeFingerprint: string): string {
  return `${permitId}:${envelopeFingerprint}`;
}

/** Denials the consume and side-effect RPCs may return; anything else is malformed. */
const DATABASE_DENIALS: ReadonlySet<string> = new Set<ProviderDispatchDenialCode>([
  "permit_already_consumed",
  "provider_kill_switch_engaged",
  "permit_mismatch",
  "permit_state_missing",
  "permit_revoked",
  "permit_expired",
  "permit_not_yet_valid",
  "provider_mismatch",
  "scope_mismatch",
  "task_inactive",
  "task_lane_mismatch",
]);
const LOCK_NOT_AVAILABLE = "55P03";

type RpcResponse = { data: unknown; error: unknown; status?: unknown };

class RpcUnavailable extends Error {}

async function callWithTimeout(
  supabase: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<RpcResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(supabase.rpc(name, args) as unknown as PromiseLike<RpcResponse>),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RpcUnavailable("timeout")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    throw new RpcUnavailable("unavailable");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function plainRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;
  const record = value as Record<string, unknown>;
  const present = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (present.length !== expected.length || present.some((key, index) => key !== expected[index])) return null;
  return record;
}

/** As the preflight's classifier, plus the consumption RPCs' 2s lock_timeout as transient. */
function rpcFailureDenial(error: unknown, status: unknown): ProviderDispatchDenialCode {
  const code =
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
  if (code === LOCK_NOT_AVAILABLE) return "preflight_unavailable";
  return classifyProviderDispatchRpcFailure(error, status);
}

function deniedBy(data: unknown): ProviderDispatchDenialCode {
  const denied = plainRecord(data, ["schema", "consumed", "denial"]);
  if (
    denied?.schema === PROVIDER_DISPATCH_PERMIT_CONSUMPTION_SCHEMA &&
    denied.consumed === false &&
    typeof denied.denial === "string" &&
    DATABASE_DENIALS.has(denied.denial)
  ) {
    return denied.denial as ProviderDispatchDenialCode;
  }
  return "current_evidence_malformed";
}

/** A transient failure is retryable only while the one permitted retry remains. */
function consumptionError(denial: ProviderDispatchDenialCode, attempt?: ProviderDispatchPermitAttempt) {
  return new ProviderDispatchAuthorizationError(denial, {
    retryable: attempt === undefined || attempt < PROVIDER_DISPATCH_PERMIT_MAX_ATTEMPTS,
  });
}

export function createProviderDispatchPermitConsumer(
  supabase: SupabaseClient,
  options: { timeoutMs?: number; localGuard?: ProviderDispatchPermitLocalGuard; now?: () => number } = {},
): ProviderDispatchPermitConsumer {
  const timeoutMs = options.timeoutMs ?? PROVIDER_DISPATCH_PERMIT_RPC_TIMEOUT_MS;
  const localGuard = options.localGuard ?? processLocalGuard;
  const now = options.now ?? Date.now;

  const recordOutcome: ProviderDispatchPermitConsumer["recordOutcome"] = async (consumption, outcome) => {
    try {
      await callWithTimeout(supabase, OUTCOME_RPC, {
        p_permit_id: consumption.permitId,
        p_attempt: consumption.attempt,
        p_worker_name: consumption.workerName,
        p_outcome: outcome,
      }, timeoutMs);
    } catch {
      // Best effort. A missing transient outcome only burns the retry (fail closed).
    }
  };

  return {
    async consume(input) {
      const { claim } = input;
      if (localGuard.has(providerDispatchPermitKey(claim.permitId, claim.envelopeFingerprint), now())) {
        throw consumptionError("permit_already_consumed");
      }
      let response: RpcResponse;
      try {
        response = await callWithTimeout(supabase, CONSUME_RPC, {
          p_work_queue_task_id: claim.workQueueTaskId,
          p_vendor_quote_result_id: claim.vendorQuoteResultId,
          p_permit_id: claim.permitId,
          p_envelope_fingerprint: claim.envelopeFingerprint,
          p_worker_name: input.workerName,
        }, timeoutMs);
      } catch {
        throw consumptionError("preflight_unavailable");
      }
      if (response.error) throw consumptionError(rpcFailureDenial(response.error, response.status));

      const granted = plainRecord(response.data, ["schema", "consumed", "permitId", "attempt"]);
      if (!granted || granted.consumed !== true) throw consumptionError(deniedBy(response.data));
      const attempt = granted.attempt;
      const expiresAtMs = Date.parse(input.expiresAt);
      if (
        granted.schema !== PROVIDER_DISPATCH_PERMIT_CONSUMPTION_SCHEMA ||
        granted.permitId !== claim.permitId ||
        (attempt !== 1 && attempt !== 2) ||
        !Number.isFinite(expiresAtMs)
      ) {
        throw consumptionError("current_evidence_malformed");
      }
      return Object.freeze({
        permitId: claim.permitId,
        envelopeFingerprint: claim.envelopeFingerprint,
        attempt,
        workerName: input.workerName,
        expiresAtMs,
      });
    },

    async startSideEffect(consumption) {
      let response: RpcResponse | null = null;
      try {
        response = await callWithTimeout(supabase, SIDE_EFFECT_RPC, {
          p_permit_id: consumption.permitId,
          p_attempt: consumption.attempt,
          p_worker_name: consumption.workerName,
        }, timeoutMs);
      } catch {
        response = null;
      }
      const marked = response && !response.error
        ? plainRecord(response.data, ["schema", "sideEffectStarted", "permitId", "attempt"])
        : null;
      if (
        marked?.schema === PROVIDER_DISPATCH_PERMIT_CONSUMPTION_SCHEMA &&
        marked.sideEffectStarted === true &&
        marked.permitId === consumption.permitId &&
        marked.attempt === consumption.attempt
      ) {
        localGuard.add(
          providerDispatchPermitKey(consumption.permitId, consumption.envelopeFingerprint),
          consumption.expiresAtMs,
          now(),
        );
        markProviderDispatchSideEffectStarted();
        return;
      }
      if (response && !response.error && plainRecord(response.data, ["schema", "consumed", "denial"])) {
        // The database refused the stamp (for example the kill switch engaged
        // in between). Terminal; nothing was launched.
        throw consumptionError(deniedBy(response.data), PROVIDER_DISPATCH_PERMIT_MAX_ATTEMPTS);
      }
      // Unconfirmed stamp: nothing was launched, so record the attempt as
      // transient. If the stamp did commit, the database refuses the transient
      // outcome and any retry is denied (fail closed).
      await recordOutcome(consumption, "transient_pre_launch_failure");
      throw consumptionError(
        response?.error ? rpcFailureDenial(response.error, response.status) : "preflight_unavailable",
        consumption.attempt,
      );
    },

    recordOutcome,
  };
}
