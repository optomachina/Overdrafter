import type { SupabaseClient } from "@supabase/supabase-js";
import { summarizeWorkerError } from "./errorSummary.js";
import { z } from "zod";
import type { QueueTaskRecord } from "./types.js";
import { VendorAutomationError } from "./types.js";
import type { buildVendorQuoteOfferPayloads } from "./vendorQuoteOffer.js";

type VendorQuoteOfferPayload = ReturnType<typeof buildVendorQuoteOfferPayloads>[number];

export type VendorQuoteResultFinalization = {
  status: string;
  unit_price_usd: number | null;
  total_price_usd: number | null;
  lead_time_business_days: number | null;
  quote_url: string | null;
  dfm_issues: unknown;
  notes: unknown;
  raw_payload: unknown;
};

const acceptanceSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted") }),
  z.object({ outcome: z.literal("request_canceled") }),
  z.object({ outcome: z.literal("replayed"), original_outcome: z.enum(["accepted", "request_canceled"]) }),
  z.object({ outcome: z.literal("stale") }),
  z.object({ outcome: z.literal("fenced") }),
  z.object({ outcome: z.literal("payload_mismatch") }),
]);
export type VendorQuoteAcceptance = z.infer<typeof acceptanceSchema>;

export function requireSuccessfulVendorQuoteAcceptance(outcome: VendorQuoteAcceptance) {
  if (outcome.outcome === "fenced" || outcome.outcome === "payload_mismatch") {
    throw persistenceFailure(outcome.outcome);
  }
}

function persistenceFailure(error: unknown, context: Record<string, unknown> = {}) {
  return new VendorAutomationError(
    `Vendor quote result finalization failed: ${summarizeWorkerError(error)}`,
    "persistence_failure",
    { reason: "quote_result_finalization_failed", ...context, acceptanceReason: summarizeWorkerError(error) },
  );
}

/** Follow-ups remain durable for the next maintenance pass if this drain fails. */
export async function drainQuoteRunRollups(supabase: SupabaseClient): Promise<void> {
  try {
    // Bounded so a stalled drain cannot hold task completion or the reaper loop.
    const { error } = await supabase.rpc("drain_quote_run_rollup_followups", { p_limit: 50 })
      .abortSignal(AbortSignal.timeout(10_000));
    if (error) throw error;
  } catch (error) {
    console.warn(JSON.stringify({
      service: "overdrafter-cad-worker", level: "warn", source: "worker.quote_run_rollups",
      message: `Quote run rollup drain failed: ${summarizeWorkerError(error)}`,
    }));
  }
}

type AcceptanceAttempt =
  | { kind: "settled"; outcome: VendorQuoteAcceptance }
  | { kind: "busy" }
  | { kind: "transport"; failure: unknown };

const BUSY_ATTEMPT_LIMIT = 10;
const TRANSPORT_ATTEMPT_LIMIT = 3;
const SETTLED_OUTCOMES = new Set(["accepted", "request_canceled", "replayed"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * SQLSTATE identifies a server rollback; network codes (including the codes
 * PostgREST copies from fetch errors) do not establish the outcome. No SQLSTATE
 * class starts with E.
 */
function isSqlStateError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string" && /^(?!E)[0-9A-Z]{5}$/.test(error.code);
}

function isBusyReply(data: unknown): boolean {
  return typeof data === "object" && data !== null && "outcome" in data && data.outcome === "busy";
}

async function attemptAcceptance(
  supabase: SupabaseClient,
  args: Record<string, unknown>,
  fail: (error: unknown) => VendorAutomationError,
): Promise<AcceptanceAttempt> {
  let data: unknown;
  try {
    const response = await supabase.rpc("accept_vendor_quote_result", args);
    if (response.error) throw response.error;
    data = response.data;
  } catch (error) {
    if (isSqlStateError(error)) throw fail(error);
    return { kind: "transport", failure: error };
  }
  if (data === null || data === undefined) return { kind: "transport", failure: "Acceptance response missing" };
  if (isBusyReply(data)) return { kind: "busy" };
  const parsed = acceptanceSchema.safeParse(data);
  if (!parsed.success) throw fail("Invalid acceptance response");
  return { kind: "settled", outcome: parsed.data };
}

/** Retries the identical claim and payload, including after an unknown commit. */
export async function acceptVendorQuoteResult(
  supabase: SupabaseClient,
  task: Pick<QueueTaskRecord, "id" | "locked_by" | "locked_at" | "attempts">,
  vendorQuoteResultId: string,
  result: VendorQuoteResultFinalization,
  offers: readonly VendorQuoteOfferPayload[],
  taskPayloadPatch: Record<string, unknown>,
): Promise<VendorQuoteAcceptance> {
  const args = {
    p_task_id: task.id, p_locked_by: task.locked_by,
    // Keep PostgREST's microseconds: Date conversion would invalidate the claim.
    p_locked_at: task.locked_at, p_attempts: task.attempts,
    p_vendor_quote_result_id: vendorQuoteResultId, p_result: result,
    p_offers: [...offers], p_task_payload_patch: taskPayloadPatch,
  };
  const context = { vendorQuoteResultId, offerKeys: offers.map((offer) => offer.offer_key) };
  const fail = (error: unknown) => persistenceFailure(error, context);
  let busyAttempts = 0;
  let transportAttempts = 0;
  // Each retry must wait for the previous reply, so the awaits are sequential by design.
  for (;;) {
    const attempt = await attemptAcceptance(supabase, args, fail);
    if (attempt.kind === "settled") {
      if (SETTLED_OUTCOMES.has(attempt.outcome.outcome)) await drainQuoteRunRollups(supabase);
      return attempt.outcome;
    }
    if (attempt.kind === "busy") {
      busyAttempts += 1;
      if (busyAttempts >= BUSY_ATTEMPT_LIMIT) throw fail("acceptance busy");
      await sleep(Math.random() * Math.min(3000, 200 * 2 ** (busyAttempts - 1)));
    } else {
      transportAttempts += 1;
      if (transportAttempts >= TRANSPORT_ATTEMPT_LIMIT) throw fail(attempt.failure);
      await sleep(Math.random() * 200 * 2 ** (transportAttempts - 1));
    }
  }
}
