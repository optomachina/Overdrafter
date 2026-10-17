import type { SupabaseClient } from "@supabase/supabase-js";
import { markTaskCancelled } from "./queue.js";
import { abortAwareCheckpoint, throwIfProviderAborted } from "./providerAbort.js";
import type { QueueTaskRecord, VendorName, VendorQuoteAdapterInput } from "./types.js";

/**
 * OVD-829 (OVD-828 S1) universal per-supplier settings: the on/off switch and
 * the optional daily quote cap, both runtime data on the supplier's row in
 * `private.provider_kill_switches`. Every live dispatch, whatever the adapter,
 * passes `assertProviderDispatchAllowed` once, immediately before launch (see
 * `guardProviderDispatch`). Adapters hold no cap or switch code of their own.
 *
 * There is no default cap. A supplier is capped only when an admin set a
 * positive integer; null, an unreadable cap, a missing settings RPC, or a
 * corrupt value all mean no cap. The kill switch still fails closed.
 *
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
  /** Replaces the plain before_launch read; `guardProviderDispatch` passes the full settings check. */
  beforeLaunch: () => Promise<unknown> = () => guard("before_launch"),
): (input: VendorQuoteAdapterInput) => Promise<T> {
  return async (input) => {
    throwIfProviderAborted(input.signal, "before_launch");
    await beforeLaunch();
    throwIfProviderAborted(input.signal, "before_launch");
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

// --------------------------------------------------------------------------- settings (OVD-829)

export const PROVIDER_SETTINGS_RPC = "api_worker_provider_settings_state";
export const PROVIDER_SETTINGS_STATE_SCHEMA = "provider-settings-state.v1" as const;
export const PROVIDER_DISPATCH_RESERVE_RPC = "api_worker_reserve_provider_dispatch";
export const PROVIDER_DISPATCH_RESERVATION_SCHEMA = "provider-dispatch-reservation.v1" as const;
/** Terminal for the day: the supplier's daily quote cap is spent. */
export const PROVIDER_DAILY_CAP_REACHED = "provider_daily_cap_reached" as const;
/** The durable counter could not be reached; nothing was dispatched. */
export const PROVIDER_DISPATCH_COUNTER_UNAVAILABLE = "provider_dispatch_counter_unavailable" as const;

export type ProviderDispatchRefusalCode =
  | typeof PROVIDER_DAILY_CAP_REACHED
  | typeof PROVIDER_DISPATCH_COUNTER_UNAVAILABLE;

export type ProviderSettings = {
  provider: VendorName;
  /** False when switched off, globally or for this supplier, or when the switch cannot be read. */
  enabled: boolean;
  /** Why `enabled` is false: engaged, or unreadable (fail closed). Null when enabled. */
  disabledReason: ProviderKillSwitchReasonCode | null;
  /** Null means no cap: none set by an admin, or the cap could not be read. */
  dailyQuoteCap: number | null;
  /** "unavailable" when the cap could not be read (no cap applies). */
  capSource: "database" | "unavailable";
};

/** Raw RPC payload readers; each throws on any transport or SQL error. */
export type ProviderSettingsPort = {
  readKillSwitch: ProviderKillSwitchReader;
  readSettings: (provider: VendorName) => Promise<unknown>;
  /** Atomic check and increment of today's dispatch count (one call per dispatch). */
  reserveDispatch: (provider: VendorName) => Promise<unknown>;
};

export class ProviderDispatchRefusedError extends Error {
  readonly retryable: boolean;

  constructor(
    public readonly reasonCode: ProviderDispatchRefusalCode,
    public readonly provider: VendorName,
    public readonly dailyQuoteCap: number | null = null,
    public readonly usedToday: number | null = null,
  ) {
    super(
      reasonCode === PROVIDER_DAILY_CAP_REACHED
        ? `${provider} reached its daily quote cap of ${dailyQuoteCap ?? "?"}; nothing was sent.`
        : `${provider} dispatch could not be counted against its daily cap; nothing was sent.`,
    );
    this.name = "ProviderDispatchRefusedError";
    this.retryable = reasonCode === PROVIDER_DISPATCH_COUNTER_UNAVAILABLE;
  }
}

function rpcReader(supabase: SupabaseClient, rpc: string, failure: string) {
  return async (provider: VendorName) => {
    const { data, error } = await supabase.rpc(rpc, { p_provider: provider });
    if (error) throw new Error(failure);
    return data;
  };
}

export function supabaseProviderSettingsPort(
  supabase: SupabaseClient,
  overrides: Partial<ProviderSettingsPort> = {},
): ProviderSettingsPort {
  return {
    readKillSwitch: overrides.readKillSwitch ?? supabaseProviderKillSwitchReader(supabase),
    readSettings: overrides.readSettings ?? rpcReader(supabase, PROVIDER_SETTINGS_RPC, "provider settings read failed"),
    reserveDispatch:
      overrides.reserveDispatch ?? rpcReader(supabase, PROVIDER_DISPATCH_RESERVE_RPC, "provider dispatch reserve failed"),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isDailyQuoteCap(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function isUsage(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The cap from a v1 settings read, or undefined when the payload is not an
 * exact match. Only a positive integer is a cap; null is no cap.
 */
export function parseProviderDailyQuoteCap(data: unknown, provider: VendorName): number | null | undefined {
  if (!isPlainRecord(data)) return undefined;
  if (data.schema !== PROVIDER_SETTINGS_STATE_SCHEMA || data.provider !== provider) return undefined;
  return isDailyQuoteCap(data.dailyQuoteCap) ? data.dailyQuoteCap : undefined;
}

type Reservation =
  | { allowed: true; cap: number | null; used: number }
  | { allowed: false; reason: "provider_disabled" | typeof PROVIDER_DAILY_CAP_REACHED; cap: number | null; used: number };

/** Strict parse of the counter's answer; anything else is null (fail closed). */
export function parseProviderDispatchReservation(data: unknown, provider: VendorName): Reservation | null {
  if (!isPlainRecord(data)) return null;
  if (data.schema !== PROVIDER_DISPATCH_RESERVATION_SCHEMA || data.provider !== provider) return null;
  if (!isDailyQuoteCap(data.cap) || !isUsage(data.used)) return null;
  if (data.allowed === true && data.reason === null) return { allowed: true, cap: data.cap, used: data.used };
  if (data.allowed === false && (data.reason === "provider_disabled" || data.reason === PROVIDER_DAILY_CAP_REACHED)) {
    return { allowed: false, reason: data.reason, cap: data.cap, used: data.used };
  }
  return null;
}

/**
 * OVD-829 deployment gate. Which counter the dispatch gate uses:
 *   * "durable": one atomic reservation through
 *     `api_worker_reserve_provider_dispatch` per dispatch, shared by every
 *     worker and surviving restarts. When that RPC is missing or failing, a
 *     supplier with an admin-set cap is refused
 *     (`provider_dispatch_counter_unavailable`); an uncapped supplier, or one
 *     whose cap cannot be read either, dispatches uncounted (no cap).
 *   * "process_local": the pre-migration fallback. The kill switch is still
 *     read and fails closed; the cap comes from `getProviderSettings` (an
 *     unreadable cap, including a missing settings RPC, is no cap) and
 *     dispatches of a capped supplier are counted in this process only, so
 *     each worker process and each operator run has its own daily allowance
 *     and a restart resets it.
 * `WORKER_PROVIDER_DURABLE_DISPATCH_CAP=on` selects "durable". It must stay
 * off (the default) until docs/migration-drafts/ovd-828-s1.sql is applied, and
 * must be turned on in the same window once it is.
 */
export const PROVIDER_DURABLE_DISPATCH_CAP_ENV = "WORKER_PROVIDER_DURABLE_DISPATCH_CAP";
export type ProviderDispatchCapMode = "durable" | "process_local";

export function providerDispatchCapMode(setting: "off" | "on" | undefined): ProviderDispatchCapMode {
  return setting === "on" ? "durable" : "process_local";
}

/** For operator tools, which read process.env rather than the worker config. Anything but "on" is off. */
export function providerDispatchCapModeFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderDispatchCapMode {
  return providerDispatchCapMode(env[PROVIDER_DURABLE_DISPATCH_CAP_ENV]?.trim() === "on" ? "on" : "off");
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The "process_local" counter: per supplier, per UTC day, in this process.
 * Pre-migration fallback only; never used once the durable counter is on.
 * Like the durable counter, a reservation is never refunded.
 */
export class ProcessLocalDispatchCounter {
  private day = "";
  private readonly counts = new Map<VendorName, number>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private roll(): void {
    const today = utcDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.counts.clear();
    }
  }

  used(provider: VendorName): number {
    this.roll();
    return this.counts.get(provider) ?? 0;
  }

  /**
   * Synchronous check and increment, so two dispatches in this process cannot
   * both take the last slot. An uncapped supplier (null) is neither counted nor refused.
   */
  reserve(provider: VendorName, cap: number | null): { allowed: boolean; used: number } {
    const used = this.used(provider);
    if (cap === null) return { allowed: true, used };
    if (used >= cap) return { allowed: false, used };
    this.counts.set(provider, used + 1);
    return { allowed: true, used: used + 1 };
  }
}

const sharedProcessLocalDispatchCounter = new ProcessLocalDispatchCounter();

/**
 * One supplier's settings, read fresh. The on/off read fails closed (an
 * unreadable switch is off, with `disabledReason` saying which). The cap does
 * not: an unreadable, missing (pre-migration RPC), or invalid cap is no cap,
 * because there is no default cap to fall back to. Counts nothing. The
 * "process_local" dispatch gate reads the cap through this.
 */
export async function getProviderSettings(
  provider: VendorName,
  port: Pick<ProviderSettingsPort, "readKillSwitch" | "readSettings">,
  timeoutMs: number = PROVIDER_KILL_SWITCH_TIMEOUT_MS,
): Promise<ProviderSettings> {
  let disabledReason: ProviderKillSwitchReasonCode | null = null;
  try {
    await assertProviderKillSwitchDisengaged({ reader: port.readKillSwitch, provider, checkpoint: "claim", timeoutMs });
  } catch (error) {
    disabledReason = error instanceof ProviderKillSwitchError ? error.reasonCode : PROVIDER_KILL_SWITCH_UNAVAILABLE;
  }
  let cap: number | null | undefined;
  try {
    cap = parseProviderDailyQuoteCap(
      await withTimeout(Promise.resolve().then(() => port.readSettings(provider)), timeoutMs),
      provider,
    );
  } catch {
    cap = undefined;
  }
  const enabled = disabledReason === null;
  return cap === undefined
    ? { provider, enabled, disabledReason, dailyQuoteCap: null, capSource: "unavailable" }
    : { provider, enabled, disabledReason, dailyQuoteCap: cap, capSource: "database" };
}

export type ProviderDispatchGateOptions = {
  /** Defaults to "durable", the strict mode; production callers pass the deployment setting. */
  capMode?: ProviderDispatchCapMode;
  timeoutMs?: number;
  /** Test seam for the "process_local" counter. */
  localCounter?: ProcessLocalDispatchCounter;
};

/**
 * The single dispatch gate every supplier passes once, right before launch.
 *
 * "durable": the kill switch (fails closed; engaged throws the OVD-722
 * `ProviderKillSwitchError`, which ends the lane `cancelled_provider_disabled`),
 * then one atomic reservation against the durable daily counter. The counter
 * re-checks the switch under its row lock, so a flip between the two reads
 * still refuses as provider_disabled. A null cap (the default) is counted but
 * never refused; a stored cap that is not a positive integer reads as no cap.
 * A spent cap throws `provider_daily_cap_reached`. An unreachable or malformed
 * counter throws `provider_dispatch_counter_unavailable` only when
 * `getProviderSettings` reads a positive cap; otherwise there is no cap and
 * the dispatch proceeds.
 * Nothing is counted in process.
 *
 * "process_local": `getProviderSettings` (switch fails closed, an unreadable
 * cap is no cap), then the in-process counter. See `ProviderDispatchCapMode`.
 */
export async function assertProviderDispatchAllowed(
  provider: VendorName,
  port: ProviderSettingsPort,
  options: ProviderDispatchGateOptions = {},
): Promise<{ dailyQuoteCap: number | null; usedToday: number }> {
  const timeoutMs = options.timeoutMs ?? PROVIDER_KILL_SWITCH_TIMEOUT_MS;
  if (options.capMode === "process_local") {
    const settings = await getProviderSettings(provider, port, timeoutMs);
    if (settings.disabledReason !== null) {
      throw new ProviderKillSwitchError(settings.disabledReason, provider, "before_launch");
    }
    const local = (options.localCounter ?? sharedProcessLocalDispatchCounter).reserve(provider, settings.dailyQuoteCap);
    if (!local.allowed) {
      throw new ProviderDispatchRefusedError(PROVIDER_DAILY_CAP_REACHED, provider, settings.dailyQuoteCap, local.used);
    }
    return { dailyQuoteCap: settings.dailyQuoteCap, usedToday: local.used };
  }

  await assertProviderKillSwitchDisengaged({
    reader: port.readKillSwitch,
    provider,
    checkpoint: "before_launch",
    timeoutMs,
  });
  let reservation: Reservation | null = null;
  try {
    reservation = parseProviderDispatchReservation(
      await withTimeout(Promise.resolve().then(() => port.reserveDispatch(provider)), timeoutMs),
      provider,
    );
  } catch {
    reservation = null;
  }
  if (!reservation) {
    // The counter could not answer. Refuse only a supplier an admin capped: an
    // uncapped supplier, or one whose cap cannot be read either, has no cap to
    // enforce. The kill switch above already failed closed.
    const settings = await getProviderSettings(provider, port, timeoutMs);
    if (settings.disabledReason !== null) {
      throw new ProviderKillSwitchError(settings.disabledReason, provider, "before_launch");
    }
    if (settings.dailyQuoteCap !== null) {
      throw new ProviderDispatchRefusedError(PROVIDER_DISPATCH_COUNTER_UNAVAILABLE, provider, settings.dailyQuoteCap);
    }
    return { dailyQuoteCap: null, usedToday: 0 };
  }
  if (reservation.allowed) return { dailyQuoteCap: reservation.cap, usedToday: reservation.used };
  if (reservation.reason === "provider_disabled") {
    throw new ProviderKillSwitchError(PROVIDER_KILL_SWITCH_ENGAGED, provider, "before_launch");
  }
  throw new ProviderDispatchRefusedError(PROVIDER_DAILY_CAP_REACHED, provider, reservation.cap, reservation.used);
}

/**
 * `guardProviderQuote` with the full settings check as its before_launch step.
 * Every live dispatch caller wraps its adapter with this: the generic
 * pipeline, the Xometry/simulate route, and the operator CLI tools (through
 * `guardOperatorQuote`). A new adapter is covered with no code of its own.
 * Mid-run checkpoints still read the kill switch only.
 *
 * The reservation is taken before the adapter's own steps (for the generic
 * route, before the inner export-control recheck), so a lane refused after it,
 * or a reservation that commits after the client timeout, still counts. That
 * only ever over-counts, which is the safe direction.
 */
export function guardProviderDispatch<T>(input: {
  provider: VendorName;
  port: ProviderSettingsPort;
  /** Required so every caller states the deployment setting it runs under. */
  capMode: ProviderDispatchCapMode;
  quote: (input: VendorQuoteAdapterInput) => Promise<T>;
  onLaunch?: () => void;
  timeoutMs?: number;
  localCounter?: ProcessLocalDispatchCounter;
}): (input: VendorQuoteAdapterInput) => Promise<T> {
  return guardProviderQuote(
    createProviderKillSwitchGuard(input.port.readKillSwitch, input.provider, input.timeoutMs),
    input.quote,
    input.onLaunch,
    () => assertProviderDispatchAllowed(input.provider, input.port, {
      capMode: input.capMode,
      timeoutMs: input.timeoutMs,
      localCounter: input.localCounter,
    }),
  );
}
