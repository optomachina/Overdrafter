import { readFile } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizeProviderDispatch, type ProviderDispatchClaim } from "./providerDispatchPreflight.js";
import type { ProviderDispatchFileRole } from "./providerDispatchTypes.js";
import type { ProviderExecutionCapturedFile, ProviderExecutionEnvironment } from "./providerExecutionSeam.js";
import {
  runProviderTaskPipeline,
  type ProviderDaySwitch,
  type ProviderSessionLeaseSetting,
  type ProviderTaskLane,
  type ProviderTaskLeasePort,
  type ProviderTaskOutcome,
  type ProviderTaskPipelineDeps,
} from "./providerTaskPipeline.js";
import type { StagedFile, VendorName, VendorQuoteAdapterInput } from "./types.js";

/**
 * OVD-464 database wiring for the generic provider route. Builds the pipeline's
 * dependencies from the claimed task and turns its outcome into one finite
 * visible state on the lane and the task. Every write here is final for the
 * claim: nothing is rethrown into the worker's generic task retry.
 */

export type ProviderTaskRouteInput = {
  supabase: SupabaseClient;
  workerName: string;
  claimedAt: string;
  task: { id: string; attempts: number; organizationId: string; quoteRunId: string };
  claim: ProviderDispatchClaim;
  scopeSnapshot: Record<string, unknown>;
  requestedQuantity: number;
  environment: ProviderExecutionEnvironment;
  adapterRevision: string;
  leaseSetting: ProviderSessionLeaseSetting;
  quoteInput: VendorQuoteAdapterInput;
  adapter: ProviderTaskPipelineDeps["adapter"];
  persist: ProviderTaskPipelineDeps["persist"];
  daySwitch: ProviderDaySwitch;
  lease?: ProviderTaskLeasePort;
  consumer?: ProviderTaskPipelineDeps["consumer"];
  onAdapterStart?: () => void;
};

export async function readProviderTaskLane(
  supabase: SupabaseClient,
  vendorQuoteResultId: string,
): Promise<ProviderTaskLane> {
  const { data, error } = await supabase
    .from("quote_request_lanes")
    .select("id, quote_request_id, quote_run_id, vendor_quote_result_id, scope_fingerprint")
    .eq("vendor_quote_result_id", vendorQuoteResultId)
    .single();
  if (error || !data) throw new Error("Quote request lane was not found.");
  const row = data as Record<string, unknown>;
  for (const key of ["id", "quote_request_id", "quote_run_id", "vendor_quote_result_id", "scope_fingerprint"]) {
    if (typeof row[key] !== "string" || (row[key] as string).length === 0) throw new Error("Quote request lane is malformed.");
  }
  return {
    laneId: row.id as string,
    quoteRequestId: row.quote_request_id as string,
    quoteRunId: row.quote_run_id as string,
    vendorQuoteResultId: row.vendor_quote_result_id as string,
    scopeFingerprint: row.scope_fingerprint as string,
  };
}

export async function readStagedProviderFiles(
  staged: { cad: StagedFile | null; drawing: StagedFile | null },
  roles: readonly ProviderDispatchFileRole[],
): Promise<ProviderExecutionCapturedFile[]> {
  return Promise.all(
    roles.map(async (role) => {
      const file = staged[role];
      if (!file) throw new Error("Authorized file was not staged.");
      return { role, bytes: new Uint8Array(await readFile(file.localPath)) };
    }),
  );
}

export function runGenericProviderTask(input: ProviderTaskRouteInput): Promise<ProviderTaskOutcome> {
  return runProviderTaskPipeline(
    {
      task: input.task,
      claim: input.claim,
      requestedQuantity: input.requestedQuantity,
      environment: input.environment,
      adapterRevision: input.adapterRevision,
      leaseSetting: input.leaseSetting,
      quoteInput: input.quoteInput,
    },
    {
      readLane: () => readProviderTaskLane(input.supabase, input.claim.vendorQuoteResultId),
      authorize: () =>
        authorizeProviderDispatch(input.supabase, {
          claim: input.claim,
          scopeSnapshot: input.scopeSnapshot,
          workerName: input.workerName,
          claimedAt: input.claimedAt,
        }),
      readCapturedFiles: (roles) =>
        readStagedProviderFiles({ cad: input.quoteInput.stagedCadFile, drawing: input.quoteInput.stagedDrawingFile }, roles),
      adapter: input.adapter,
      persist: input.persist,
      lease: input.lease ?? null,
      daySwitch: input.daySwitch,
      consumer: input.consumer,
      onAdapterStart: input.onAdapterStart,
    },
  );
}

/** Operator facing note for an outcome. Stable codes only; never adapter text. */
export function providerTaskOutcomeNote(vendor: VendorName, outcome: ProviderTaskOutcome): string {
  switch (outcome.disposition) {
    case "persisted":
      return `${vendor} quote collected and validated.`;
    case "requeue":
      return `${vendor} automation did not finish (${outcome.code}). One retry is scheduled for ${outcome.retryAt}.`;
    case "manual_follow_up":
      return outcome.providerDisabledForDay
        ? `${vendor} reported ${outcome.code}. Automation for ${vendor} is off for the rest of the UTC day; manual follow up is required.`
        : `${vendor} automation stopped at ${outcome.stage} (${outcome.code}); manual follow up is required.`;
    default:
      return `${vendor} automation failed at ${outcome.stage} (${outcome.code}) and will not be retried.`;
  }
}

/** Lane status and the raw payload fields recorded for a non persisted outcome. */
export function providerTaskFailureRecord(
  vendor: VendorName,
  outcome: ProviderTaskOutcome,
  context: { retryCount: number; requestedQuantity: number },
): { status: "queued" | "manual_vendor_followup" | "failed"; notes: string[]; raw_payload: Record<string, unknown> } {
  let status: "queued" | "manual_vendor_followup" | "failed" = "failed";
  if (outcome.disposition === "requeue") status = "queued";
  else if (outcome.disposition === "manual_follow_up") status = "manual_vendor_followup";
  return {
    status,
    notes: [providerTaskOutcomeNote(vendor, outcome)],
    raw_payload: {
      vendor,
      source: "provider-task-pipeline",
      failureCode: outcome.code,
      failureStage: outcome.stage,
      adapterStarted: outcome.adapterStarted,
      providerMutationPossible: outcome.adapterStarted,
      retryCount: context.retryCount,
      retryScheduledFor: outcome.retryAt,
      requiresManualVendorFollowUp: status === "manual_vendor_followup",
      manualFollowUpReason: status === "manual_vendor_followup" ? outcome.code : null,
      providerDisabledForDay: outcome.providerDisabledForDay,
      providerResultRejection: outcome.rejection,
      requestedQuantity: context.requestedQuantity,
    },
  };
}

