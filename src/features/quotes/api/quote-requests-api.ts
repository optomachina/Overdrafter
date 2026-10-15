import type {
  QuoteRequestCancellationResult,
  QuoteLaneEligibility,
  QuoteRequestSubmissionResult,
  QuoteRunReadiness,
} from "@/features/quotes/types";
import type { ClientQuoteSelectionTarget } from "@/features/quotes/selection";
import type {
  VendorName,
} from "@/integrations/supabase/types";
import { getActiveClientWorkspaceGateway } from "@/features/quotes/client-workspace-fixtures";
import { callRpc, callUntypedRpc } from "./shared/rpc";
import { ensureData } from "./shared/response";
import { selectQuoteOption } from "./packages-api";
import type { ProviderFanoutGuards, QuoteRequestBudget } from "@/features/quotes/provider-fanout";
import {
  parseProviderDispatchResult,
  parseProviderDispatchScope,
  parseXometryBetaDispatchResult,
  parseXometryBetaDispatchScope,
  type ProviderDispatchScope,
  type XometryBetaDispatchResult,
  type XometryBetaDispatchScope,
  type XometryBetaModelUnits,
} from "@/features/quotes/xometry-beta-dispatch";

export async function setJobSelectedVendorQuoteOffer(jobId: string, offerId: string | null): Promise<string> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.setJobSelectedVendorQuoteOffer(jobId, offerId);
  }

  const { data, error } = await callRpc("api_set_job_selected_vendor_quote_offer", {
    p_job_id: jobId,
    p_vendor_quote_offer_id: offerId,
  });

  return ensureData(data, error);
}

/**
 * Persists a client comparison choice at the strongest available provenance boundary.
 * Published choices remain package-scoped; only pre-publication choices use the
 * legacy job-level offer pointer.
 */
export async function persistClientQuoteSelection(input: {
  jobId: string;
  target: ClientQuoteSelectionTarget;
}): Promise<string> {
  if (input.target.kind === "published_quote_option") {
    return selectQuoteOption({
      packageId: input.target.packageId,
      optionId: input.target.optionId,
    });
  }

  return setJobSelectedVendorQuoteOffer(input.jobId, input.target.offerId);
}

export async function startQuoteRun(
  jobId: string,
  autoPublishRequested = false,
): Promise<string> {
  const { data, error } = await callRpc("api_start_quote_run", {
    p_job_id: jobId,
    p_auto_publish_requested: autoPublishRequested,
  });

  return ensureData(data, error);
}

export async function requestQuote(
  jobId: string,
  selectedVendors: VendorName[] = [],
): Promise<QuoteRequestSubmissionResult> {
  const { data, error } = await callUntypedRpc("api_request_quote_scoped", {
    p_job_id: jobId,
    p_selected_vendors: selectedVendors,
  });

  const result = ensureData(data, error) as QuoteRequestSubmissionResult;

  return {
    ...result,
    quoteMode: result.quoteMode ?? "automatic",
  };
}

/**
 * The Xometry confirmation scope. With `fanoutVendors` (the providers one
 * confirmation reaches, Xometry among them) it reads the fan out variant
 * drafted in docs/migration-drafts/ovd-762-xometry-fanout-scope.sql, which
 * accepts Xometry alongside other enabled providers; without it the server
 * still requires Xometry to be the only enabled provider.
 */
export async function getXometryBetaDispatchScope(
  jobId: string,
  declaredModelUnits: XometryBetaModelUnits,
  fanoutVendors: readonly VendorName[] | null = null,
): Promise<XometryBetaDispatchScope> {
  const { data, error } = fanoutVendors
    ? await callUntypedRpc("api_get_xometry_beta_fanout_dispatch_scope", {
        p_job_id: jobId,
        p_declared_model_units: declaredModelUnits,
        p_fanout_vendors: fanoutVendors,
      })
    : await callRpc("api_get_xometry_beta_dispatch_scope", {
        p_job_id: jobId,
        p_declared_model_units: declaredModelUnits,
      });

  return parseXometryBetaDispatchScope(ensureData(data, error));
}

/** Binds a Xometry permit to one fan out confirmation and its provider set. */
export type XometryFanoutMarker = {
  confirmationReference: string;
  vendors: readonly VendorName[];
};

/** Any provider on the generic admission path; Xometry keeps its legacy RPCs. */
export type GenericDispatchProvider = Exclude<VendorName, "xometry">;

export async function requestXometryBetaDispatch(input: {
  jobId: string;
  declaredModelUnits: XometryBetaModelUnits;
  expectedScopeFingerprint: string;
  policyRevision: string;
  approvalReference: string;
  fanout?: XometryFanoutMarker | null;
}): Promise<XometryBetaDispatchResult> {
  const { data, error } = input.fanout
    ? await callUntypedRpc("api_request_xometry_beta_fanout_dispatch", {
        p_job_id: input.jobId,
        p_declared_model_units: input.declaredModelUnits,
        p_expected_scope_fingerprint: input.expectedScopeFingerprint,
        p_policy_revision: input.policyRevision,
        p_approval_reference: input.approvalReference,
        p_fanout_confirmation_reference: input.fanout.confirmationReference,
        p_fanout_vendors: input.fanout.vendors,
        p_authority_to_share: true,
        p_non_export_controlled: true,
        p_quote_only: true,
      })
    : await callRpc("api_request_xometry_beta_dispatch", {
        p_job_id: input.jobId,
        p_declared_model_units: input.declaredModelUnits,
        p_expected_scope_fingerprint: input.expectedScopeFingerprint,
        p_policy_revision: input.policyRevision,
        p_approval_reference: input.approvalReference,
        p_authority_to_share: true,
        p_non_export_controlled: true,
        p_quote_only: true,
      });

  return parseXometryBetaDispatchResult(ensureData(data, error));
}

/**
 * Generic confirmation scope for a non-Xometry provider (OVD-458/OVD-673). The
 * server denies every provider without an approved admission policy and an
 * active reviewed envelope, so this cannot widen dispatch on its own.
 */
export async function getProviderDispatchScope(
  jobId: string,
  provider: GenericDispatchProvider,
  declaredModelUnits: XometryBetaModelUnits,
): Promise<ProviderDispatchScope> {
  const { data, error } = await callRpc("api_get_provider_dispatch_scope", {
    p_job_id: jobId,
    p_provider: provider,
    p_declared_model_units: declaredModelUnits,
  });

  return parseProviderDispatchScope(ensureData(data, error), provider);
}

export async function requestProviderDispatch(input: {
  jobId: string;
  provider: GenericDispatchProvider;
  declaredModelUnits: XometryBetaModelUnits;
  expectedScopeFingerprint: string;
  noticeRevision: string;
  expectedEnvelopeRevision: string;
  approvalReference: string;
}): Promise<XometryBetaDispatchResult> {
  const { data, error } = await callRpc("api_request_provider_dispatch", {
    p_job_id: input.jobId,
    p_provider: input.provider,
    p_declared_model_units: input.declaredModelUnits,
    p_expected_scope_fingerprint: input.expectedScopeFingerprint,
    p_notice_revision: input.noticeRevision,
    p_expected_envelope_revision: input.expectedEnvelopeRevision,
    p_approval_reference: input.approvalReference,
    p_authority_to_share: true,
    p_non_export_controlled: true,
    p_quote_only: true,
  });

  return parseProviderDispatchResult(ensureData(data, error), input.provider);
}

function isVendorArray(value: unknown): value is VendorName[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseQuoteRequestBudget(value: unknown): QuoteRequestBudget | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const budget = value as Record<string, unknown>;
  const keys = [
    "userWindowMinutes",
    "userMaxRequestsPerWindow",
    "userRequestsRemaining",
    "orgPendingCostCeilingUsd",
    "costPerLaneUsd",
    "orgPendingCostHeadroomUsd",
  ] as const;
  if (!keys.every((key) => isNonNegativeNumber(budget[key]))) return undefined;
  return Object.fromEntries(keys.map((key) => [key, budget[key]])) as QuoteRequestBudget;
}

/**
 * Kill switch, export declaration, providers at today's cap, and the caller's
 * quote request budget for a job (drafted in
 * docs/migration-drafts/provider-fanout-guards.sql). Any malformed field
 * throws, and the caller then sends to the primary provider only.
 */
export async function getProviderFanoutGuards(jobId: string): Promise<ProviderFanoutGuards> {
  const { data, error } = await callUntypedRpc("api_get_provider_fanout_guards", {
    p_job_id: jobId,
  });
  const result = ensureData(data, error) as Record<string, unknown> | null;
  const quoteRequestBudget = parseQuoteRequestBudget(result?.quoteRequestBudget);
  if (
    !result ||
    !isVendorArray(result.killSwitchedProviders) ||
    !isVendorArray(result.providersAtDailyCap) ||
    (result.exportDeclaration !== "clean" && result.exportDeclaration !== "not_clean") ||
    quoteRequestBudget === undefined
  ) {
    throw new TypeError("Provider fan out guards are unavailable.");
  }
  return {
    killSwitchedProviders: result.killSwitchedProviders,
    exportDeclaration: result.exportDeclaration,
    providersAtDailyCap: result.providersAtDailyCap,
    quoteRequestBudget,
  };
}

export async function getQuoteLaneEligibility(
  jobId: string,
  selectedVendors?: VendorName[],
): Promise<QuoteLaneEligibility[]> {
  const { data, error } = await callUntypedRpc("api_get_quote_lane_eligibility", {
    p_job_id: jobId,
    p_selected_vendors: selectedVendors ?? null,
  });

  const result = ensureData(data, error);
  if (!Array.isArray(result)) {
    throw new Error("Expected quote lane eligibility to be returned as an array.");
  }
  return result as QuoteLaneEligibility[];
}

export async function requestManualQuote(
  jobId: string,
): Promise<QuoteRequestSubmissionResult> {
  const { data, error } = await callRpc("api_request_manual_quote", {
    p_job_id: jobId,
    p_force_retry: false,
  });

  return ensureData(data, error) as QuoteRequestSubmissionResult;
}

export async function requestQuotes(
  jobIds: string[],
): Promise<QuoteRequestSubmissionResult[]> {
  const distinctJobIds = [...new Set(jobIds.filter(Boolean))];

  if (distinctJobIds.length === 0) {
    return [];
  }

  const { data, error } = await callRpc("api_request_quotes", {
    p_job_ids: distinctJobIds,
    p_force_retry: false,
  });

  const results = ensureData(data, error);

  if (!Array.isArray(results)) {
    throw new Error("Expected quote request results to be returned as an array.");
  }

  return results.map((result) => ({
    ...(result as QuoteRequestSubmissionResult),
    quoteMode: (result as QuoteRequestSubmissionResult).quoteMode ?? "automatic",
  }));
}

export async function requestManualQuotes(
  jobIds: string[],
): Promise<QuoteRequestSubmissionResult[]> {
  const distinctJobIds = [...new Set(jobIds.filter(Boolean))];

  if (distinctJobIds.length === 0) {
    return [];
  }

  const { data, error } = await callRpc("api_request_manual_quotes", {
    p_job_ids: distinctJobIds,
    p_force_retry: false,
  });

  const results = ensureData(data, error);

  if (!Array.isArray(results)) {
    throw new Error("Expected manual quote request results to be returned as an array.");
  }

  return results as QuoteRequestSubmissionResult[];
}

export async function cancelQuoteRequest(
  requestId: string,
): Promise<QuoteRequestCancellationResult> {
  const { data, error } = await callRpc("api_cancel_quote_request", {
    p_request_id: requestId,
  });

  return ensureData(data, error) as QuoteRequestCancellationResult;
}

export async function enqueueDebugVendorQuote(input: {
  jobId: string;
  quoteRunId: string;
  partId: string;
  vendor: VendorName;
  requestedQuantity: number;
}): Promise<string> {
  const { data, error } = await callRpc("api_enqueue_debug_vendor_quote", {
    p_quote_run_id: input.quoteRunId,
    p_part_id: input.partId,
    p_vendor: input.vendor,
    p_requested_quantity: input.requestedQuantity,
  });

  const result = ensureData(data, error) as { taskId: string; created: boolean; reason: string | null };

  if (!result.created && result.reason) {
    throw new Error(result.reason);
  }

  return result.taskId;
}

export async function getQuoteRunReadiness(
  quoteRunId: string,
): Promise<QuoteRunReadiness> {
  const { data, error } = await callRpc("api_get_quote_run_readiness", {
    p_quote_run_id: quoteRunId,
  });

  const readiness = ensureData(data, error) as QuoteRunReadiness;

  return {
    ready: Boolean(readiness.ready),
    successfulVendorQuotes: Number(readiness.successfulVendorQuotes ?? 0),
    failedVendorQuotes: Number(readiness.failedVendorQuotes ?? 0),
    blockingVendorStates: Number(readiness.blockingVendorStates ?? 0),
    unapprovedExtractions: Number(readiness.unapprovedExtractions ?? 0),
    repairTasks: Number(readiness.repairTasks ?? 0),
    priorRequirementsMatch: Boolean(readiness.priorRequirementsMatch),
    reasons: readiness.reasons ?? [],
  };
}
