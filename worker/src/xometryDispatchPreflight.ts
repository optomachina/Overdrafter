import type { SupabaseClient } from "@supabase/supabase-js";
import type { VendorAdapter } from "./adapters/base.js";
import type {
  VendorName,
  VendorQuoteAdapterInput,
  VendorQuoteAdapterOutput,
  WorkerConfig,
  XometryDispatchAuthorization,
} from "./types.js";

const XOMETRY_ENVELOPE_REVISION = "xometry-controlled-beta-envelope.v1" as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOUNDED_DENIAL_REASON_CODES = new Set([
  "dispatch_preflight_invalid_input",
  "dispatch_task_not_running",
  "dispatch_task_identity_mismatch",
  "dispatch_permit_binding_missing",
  "dispatch_permit_identity_mismatch",
  "dispatch_lane_identity_mismatch",
  "dispatch_request_inactive",
  "dispatch_beta_authorization_revoked",
  "dispatch_automatic_access_revoked",
  "dispatch_rollout_disabled",
  "dispatch_provider_configuration_changed",
  "dispatch_staged_scope_changed",
  "dispatch_current_scope_changed",
]);

type WorkerPreflightDecision = {
  authorized?: unknown;
  reasonCode?: unknown;
  permitId?: unknown;
  provider?: unknown;
  scopeFingerprint?: unknown;
  envelopeRevision?: unknown;
  nonExportControlled?: unknown;
};

export class XometryDispatchAuthorizationError extends Error {
  constructor(public readonly reasonCode: string) {
    super("Xometry dispatch authorization was denied before browser launch.");
    this.name = "XometryDispatchAuthorizationError";
  }
}

function parseAuthorization(data: unknown): XometryDispatchAuthorization {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new XometryDispatchAuthorizationError("dispatch_preflight_unavailable");
  }

  const decision = data as WorkerPreflightDecision;
  if (decision.authorized !== true) {
    const reasonCode =
      typeof decision.reasonCode === "string" &&
      BOUNDED_DENIAL_REASON_CODES.has(decision.reasonCode)
        ? decision.reasonCode
        : "dispatch_authorization_denied";
    throw new XometryDispatchAuthorizationError(reasonCode);
  }

  if (
    typeof decision.permitId !== "string" ||
    !UUID_PATTERN.test(decision.permitId) ||
    decision.provider !== "xometry" ||
    typeof decision.scopeFingerprint !== "string" ||
    !SHA256_PATTERN.test(decision.scopeFingerprint) ||
    decision.envelopeRevision !== XOMETRY_ENVELOPE_REVISION ||
    decision.nonExportControlled !== true
  ) {
    throw new XometryDispatchAuthorizationError("dispatch_preflight_invalid_response");
  }

  return {
    permitId: decision.permitId,
    provider: "xometry",
    scopeFingerprint: decision.scopeFingerprint,
    envelopeRevision: XOMETRY_ENVELOPE_REVISION,
    nonExportControlled: true,
  };
}

/**
 * Obtains the server-authoritative, service-role-only decision for the exact
 * staged scope. The returned object intentionally contains no customer file
 * names, scope payload, credentials, or browser/session data.
 */
export async function authorizeXometryDispatch(
  supabase: SupabaseClient,
  input: {
    workQueueTaskId: string;
    vendorQuoteResultId: string;
    scopeSnapshot: Record<string, unknown>;
    workerName: string;
    claimedAt: string;
  },
): Promise<XometryDispatchAuthorization> {
  const { data, error } = await supabase.rpc(
    "api_authorize_xometry_beta_worker_dispatch",
    {
      p_work_queue_task_id: input.workQueueTaskId,
      p_vendor_quote_result_id: input.vendorQuoteResultId,
      p_scope_snapshot: input.scopeSnapshot,
      p_expected_worker_name: input.workerName,
      p_expected_claimed_at: input.claimedAt,
    },
  );

  if (error) {
    throw new XometryDispatchAuthorizationError("dispatch_preflight_unavailable");
  }

  return parseAuthorization(data);
}

/**
 * Keeps the final database decision and adapter invocation adjacent. Simulated
 * adapters disclose nothing externally and remain available for local tests.
 */
export async function quoteWithDispatchPreflight(input: {
  supabase: SupabaseClient;
  config: Pick<WorkerConfig, "workerMode" | "workerName">;
  workQueueTaskId: string;
  vendorQuoteResultId: string;
  claimedAt: string;
  vendor: VendorName;
  scopeSnapshot: Record<string, unknown>;
  adapter: Pick<VendorAdapter, "quote">;
  quoteInput: VendorQuoteAdapterInput;
  onAuthorized?: () => void;
}): Promise<VendorQuoteAdapterOutput> {
  if (input.config.workerMode !== "live") {
    input.onAuthorized?.();
    return input.adapter.quote(input.quoteInput);
  }

  if (input.vendor !== "xometry") {
    throw new XometryDispatchAuthorizationError("dispatch_live_provider_not_permitted");
  }

  const authorization = await authorizeXometryDispatch(input.supabase, {
    workQueueTaskId: input.workQueueTaskId,
    vendorQuoteResultId: input.vendorQuoteResultId,
    scopeSnapshot: input.scopeSnapshot,
    workerName: input.config.workerName,
    claimedAt: input.claimedAt,
  });

  input.onAuthorized?.();
  return input.adapter.quote({
    ...input.quoteInput,
    xometryDispatchAuthorization: authorization,
  });
}
