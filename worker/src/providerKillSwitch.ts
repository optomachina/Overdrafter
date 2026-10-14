import type { SupabaseClient } from "@supabase/supabase-js";
import { markTaskCancelled } from "./queue.js";
import { abortAwareCheckpoint } from "./providerAbort.js";
import type { QueueTaskRecord, VendorName, VendorQuoteAdapterInput } from "./types.js";

/**
 * OVD-722 worker side of the per-provider and global kill switch.
 *
 * The switch is runtime data in `private.provider_kill_switches` and
 * `private.provider_global_kill_switch`, read through the service-role RPC
 * `api_worker_provider_kill_switch_state` on every checkpoint. Nothing is
 * cached in the worker process, so an admin flip takes effect at the next
 * checkpoint with no deploy or restart.
 *
 * Every checkpoint fails closed: an engaged switch, an RPC error, a malformed
 * response, or a read slower than `PROVIDER_KILL_SWITCH_TIMEOUT_MS` refuses
 * before any browser launch, navigation, upload, configuration, or API call.
 *
 * Adapters re-check immediately before each mutation step, not only at the
 * start of a phase. A request the browser already sent before the switch was
 * engaged cannot be recalled; the next step is what stops.
 */

export const PROVIDER_KILL_SWITCH_RPC = "api_worker_provider_kill_switch_state";
export const PROVIDER_KILL_SWITCH_STATE_SCHEMA = "provider-kill-switch-state.v1" as const;
export const PROVIDER_KILL_SWITCH_TIMEOUT_MS = 2_000;
/** Terminal: the switch is engaged for this provider or globally. */
export const PROVIDER_KILL_SWITCH_ENGAGED = "provider_kill_switch_engaged" as const;
/** Refused because the state could not be read; retryable before any provider mutation. */
export const PROVIDER_KILL_SWITCH_UNAVAILABLE = "provider_kill_switch_unavailable" as const;
/** Truthful terminal reason recorded on tasks cancelled by the switch. */
export const CANCELLED_PROVIDER_DISABLED = "cancelled_provider_disabled" as const;
/** Customer-facing note; other providers continue. */
export const PROVIDER_TEMPORARILY_UNAVAILABLE_NOTE = "Provider temporarily unavailable.";

export type ProviderKillSwitchReasonCode =
  | typeof PROVIDER_KILL_SWITCH_ENGAGED
  | typeof PROVIDER_KILL_SWITCH_UNAVAILABLE;

export type ProviderKillSwitchCheckpointName =
  | "claim"
  | "server_preflight"
  | "before_launch"
  | "before_navigation"
  | "before_upload"
  | "before_configure"
  | "before_save";

export class ProviderKillSwitchError extends Error {
  readonly retryable: boolean;

  constructor(
    public readonly reasonCode: ProviderKillSwitchReasonCode,
    public readonly provider: VendorName,
    public readonly checkpoint: ProviderKillSwitchCheckpointName,
  ) {
    super(
      reasonCode === PROVIDER_KILL_SWITCH_ENGAGED
        ? `The ${provider} kill switch is engaged; refused at ${checkpoint}.`
        : `The ${provider} kill switch state could not be read; refused at ${checkpoint}.`,
    );
    this.name = "ProviderKillSwitchError";
    this.retryable = reasonCode === PROVIDER_KILL_SWITCH_UNAVAILABLE;
  }
}

/** Returns the raw RPC payload for one provider; throws on any transport or SQL error. */
export type ProviderKillSwitchReader = (provider: VendorName) => Promise<unknown>;

/** A bound checkpoint: resolves only when the switch is verifiably disengaged. */
export type ProviderKillSwitchGuard = (checkpoint: ProviderKillSwitchCheckpointName) => Promise<void>;

export function supabaseProviderKillSwitchReader(supabase: SupabaseClient): ProviderKillSwitchReader {
  return async (provider) => {
    const { data, error } = await supabase.rpc(PROVIDER_KILL_SWITCH_RPC, { p_provider: provider });
    if (error) throw new Error("provider kill switch read failed");
    return data;
  };
}

const STATE_KEYS = ["schema", "provider", "engaged", "globalEngaged"] as const;

/**
 * Strict parse. Only an exact v1 object for the requested provider with both
 * flags literally `false` counts as disengaged; anything else is unknown.
 */
export function parseProviderKillSwitchState(
  data: unknown,
  provider: VendorName,
): { engaged: boolean } | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (Object.getPrototypeOf(data) !== Object.prototype) return null;
  const keys = Object.keys(data);
  if (keys.length !== STATE_KEYS.length || !STATE_KEYS.every((key) => keys.includes(key))) return null;
  const state = data as Record<(typeof STATE_KEYS)[number], unknown>;
  if (state.schema !== PROVIDER_KILL_SWITCH_STATE_SCHEMA || state.provider !== provider) return null;
  if (typeof state.engaged !== "boolean" || typeof state.globalEngaged !== "boolean") return null;
  return { engaged: state.engaged || state.globalEngaged };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("provider kill switch read timed out")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function assertProviderKillSwitchDisengaged(input: {
  reader: ProviderKillSwitchReader;
  provider: VendorName;
  checkpoint: ProviderKillSwitchCheckpointName;
  timeoutMs?: number;
}): Promise<void> {
  let data: unknown;
  try {
    data = await withTimeout(
      Promise.resolve().then(() => input.reader(input.provider)),
      input.timeoutMs ?? PROVIDER_KILL_SWITCH_TIMEOUT_MS,
    );
  } catch {
    throw new ProviderKillSwitchError(PROVIDER_KILL_SWITCH_UNAVAILABLE, input.provider, input.checkpoint);
  }
  const state = parseProviderKillSwitchState(data, input.provider);
  if (!state) {
    throw new ProviderKillSwitchError(PROVIDER_KILL_SWITCH_UNAVAILABLE, input.provider, input.checkpoint);
  }
  if (state.engaged) {
    throw new ProviderKillSwitchError(PROVIDER_KILL_SWITCH_ENGAGED, input.provider, input.checkpoint);
  }
}

export function createProviderKillSwitchGuard(
  reader: ProviderKillSwitchReader,
  provider: VendorName,
  timeoutMs?: number,
): ProviderKillSwitchGuard {
  return (checkpoint) => assertProviderKillSwitchDisengaged({ reader, provider, checkpoint, timeoutMs });
}

export function isProviderKillSwitchEngaged(error: unknown): error is ProviderKillSwitchError {
  return error instanceof ProviderKillSwitchError && error.reasonCode === PROVIDER_KILL_SWITCH_ENGAGED;
}

/**
 * Wraps an adapter's quote so the final kill-switch read sits immediately
 * before the launch, and hands the same guard to the adapter for its own
 * navigation, upload, configuration, and save checkpoints. `onLaunch` fires
 * only once the before_launch read passed.
 */
export function guardProviderQuote<T>(
  guard: ProviderKillSwitchGuard,
  quote: (input: VendorQuoteAdapterInput) => Promise<T>,
  onLaunch?: () => void,
): (input: VendorQuoteAdapterInput) => Promise<T> {
  return async (input) => {
    await guard("before_launch");
    onLaunch?.();
    return quote({ ...input, providerKillSwitchCheckpoint: abortAwareCheckpoint(guard, input.signal) });
  };
}

/** Lane record for a task cancelled by the switch. Customer note only; other providers' lanes are untouched. */
export function providerDisabledResultRecord(input: {
  error: ProviderKillSwitchError;
  requestedQuantity: number;
  providerMutationPossible?: boolean;
}): { status: "failed"; notes: string[]; raw_payload: Record<string, unknown> } {
  return {
    status: "failed",
    notes: [PROVIDER_TEMPORARILY_UNAVAILABLE_NOTE],
    raw_payload: {
      failureCode: CANCELLED_PROVIDER_DISABLED,
      killSwitchReasonCode: input.error.reasonCode,
      killSwitchCheckpoint: input.error.checkpoint,
      providerMutationPossible: input.providerMutationPossible === true,
      requestedQuantity: input.requestedQuantity,
      retryScheduledFor: null,
    },
  };
}

/** Marks the queue task `cancelled` with reason `cancelled_provider_disabled`. */
export function markTaskCancelledForDisabledProvider(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
  error: ProviderKillSwitchError,
): Promise<void> {
  return markTaskCancelled(supabase, task, `${CANCELLED_PROVIDER_DISABLED}: ${error.message}`, {
    cancellationReason: CANCELLED_PROVIDER_DISABLED,
    killSwitchCheckpoint: error.checkpoint,
  });
}

/**
 * Ends a claimed vendor task in the truthful terminal state for a switched-off
 * provider: the queue task is `cancelled` with reason
 * `cancelled_provider_disabled`, and the customer-visible result reads
 * "Provider temporarily unavailable." Other providers' lanes are untouched.
 */
export async function cancelVendorTaskForDisabledProvider(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
  input: {
    vendorQuoteResultId: string;
    error: ProviderKillSwitchError;
    requestedQuantity: number;
    providerMutationPossible?: boolean;
  },
): Promise<void> {
  const { error: resultError } = await supabase
    .from("vendor_quote_results")
    .update(providerDisabledResultRecord(input))
    .eq("id", input.vendorQuoteResultId);
  if (resultError) throw resultError;

  await markTaskCancelledForDisabledProvider(supabase, task, input.error);
}

/**
 * Settles a lane when the claim check cannot read the switch and the queue's
 * retries are spent. Nothing was sent, so the lane ends failed with a plain
 * note. It is not routed to manual quoting: an unreadable switch may be an
 * engaged one.
 */
export async function failVendorResultForUnavailableKillSwitch(
  supabase: SupabaseClient,
  input: {
    vendorQuoteResultId: string;
    error: ProviderKillSwitchError;
    retryCount: number;
    requestedQuantity: number;
  },
): Promise<void> {
  const { error: resultError } = await supabase
    .from("vendor_quote_results")
    .update({
      status: "failed",
      notes: [PROVIDER_TEMPORARILY_UNAVAILABLE_NOTE],
      raw_payload: {
        failureCode: PROVIDER_KILL_SWITCH_UNAVAILABLE,
        killSwitchReasonCode: input.error.reasonCode,
        killSwitchCheckpoint: input.error.checkpoint,
        providerMutationPossible: false,
        requestedQuantity: input.requestedQuantity,
        retryCount: input.retryCount,
        retryScheduledFor: null,
        requiresManualVendorFollowUp: false,
      },
    })
    .eq("id", input.vendorQuoteResultId);
  if (resultError) throw resultError;
}

export const PROVIDER_KILL_SWITCH_SWEEP_RPC = "api_worker_cancel_provider_disabled_tasks";

export type ProviderKillSwitchSweepResult = {
  cancelled: number;
  /** Lanes the sweep moved from queued to failed. */
  resultsUpdated: number;
  /** Rows left queued because one of their updates raised; the claim check settles them. */
  skipped: number;
  quoteRuns: { jobId: string; quoteRunId: string }[];
};

function sweepCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Operator log lines for one sweep: what was cancelled, and any rows it had to skip. */
export function providerKillSwitchSweepWarnings(result: ProviderKillSwitchSweepResult): {
  message: string;
  context: Record<string, number>;
}[] {
  const warnings: { message: string; context: Record<string, number> }[] = [];
  if (result.cancelled > 0) {
    warnings.push({
      message: `Cancelled ${result.cancelled} queued task(s) for switched-off providers.`,
      context: { cancelled: result.cancelled, resultsUpdated: result.resultsUpdated },
    });
  }
  if (result.skipped > 0) {
    warnings.push({
      message: `Kill-switch sweep skipped ${result.skipped} queued task(s) whose cancellation raised; they stay queued until a worker claims them.`,
      context: { skipped: result.skipped },
    });
  }
  return warnings;
}

/**
 * Periodic sweep so queued tasks for a switched-off provider do not sit parked
 * until a worker happens to claim them. The RPC cancels atomically (skipping
 * rows another worker holds) and reports the quote runs whose job status the
 * caller must refresh.
 */
export async function sweepProviderDisabledTasks(
  supabase: SupabaseClient,
): Promise<ProviderKillSwitchSweepResult> {
  const { data, error } = await supabase.rpc(PROVIDER_KILL_SWITCH_SWEEP_RPC);
  if (error) throw error;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("provider kill switch sweep returned a malformed response");
  }
  const record = data as Record<string, unknown>;
  const cancelled = sweepCount(record.cancelled);
  const quoteRuns = Array.isArray(record.quoteRuns)
    ? record.quoteRuns.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const { jobId, quoteRunId } = entry as Record<string, unknown>;
        return typeof jobId === "string" && typeof quoteRunId === "string" ? [{ jobId, quoteRunId }] : [];
      })
    : [];
  return {
    cancelled,
    resultsUpdated: sweepCount(record.resultsUpdated),
    skipped: sweepCount(record.skipped),
    quoteRuns,
  };
}

/**
 * Claim-time check for a `run_vendor_quote` task. Engaged: the task ends
 * `cancelled_provider_disabled` and the caller must stop. Unreadable: throws
 * the retryable `ProviderKillSwitchError` before anything provider-facing ran.
 */
export async function checkProviderKillSwitchAtClaim(input: {
  supabase: SupabaseClient;
  reader?: ProviderKillSwitchReader;
  task: QueueTaskRecord;
  vendor: VendorName;
  vendorQuoteResultId: string;
  requestedQuantity: number;
}): Promise<"proceed" | "cancelled"> {
  try {
    await assertProviderKillSwitchDisengaged({
      reader: input.reader ?? supabaseProviderKillSwitchReader(input.supabase),
      provider: input.vendor,
      checkpoint: "claim",
    });
    return "proceed";
  } catch (error) {
    if (!isProviderKillSwitchEngaged(error)) throw error;
    await cancelVendorTaskForDisabledProvider(input.supabase, input.task, {
      vendorQuoteResultId: input.vendorQuoteResultId,
      error,
      requestedQuantity: input.requestedQuantity,
    });
    return "cancelled";
  }
}
