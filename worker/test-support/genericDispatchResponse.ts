import { vi } from "vitest";
import fixture from "../../test-fixtures/provider-dispatch-envelope/v1.json";
import {
  canonicalizeProviderDispatchEnvelope,
  fingerprintProviderDispatchEnvelope,
  type ProviderDispatchEnvelope,
} from "../src/providerDispatchEnvelope.js";

export const GENERIC_PERMIT_ID = "00000000-0000-4000-8000-00000000457c";

/** A fictiv generic envelope derived from the shared OVD-457 golden. */
export function genericFictivEnvelope(overrides: Partial<ProviderDispatchEnvelope> = {}): ProviderDispatchEnvelope {
  const golden = structuredClone(fixture.golden.envelope) as unknown as ProviderDispatchEnvelope;
  return {
    ...golden,
    provider: "fictiv",
    envelope: { id: "fictiv-quote-envelope", version: 1 },
    admission: { policyRevision: "fictiv-generic-2026-10-03.v1", evidenceReference: "OVD-458" },
    sessionBindingId: `lease:${GENERIC_PERMIT_ID}`,
    ...overrides,
  };
}

/** Same-snapshot evidence for an approved, generically dispatchable Fictiv admission. */
export function genericAdmissionEvidence(): Record<string, unknown> {
  return {
    now: "2026-10-03T12:05:00.000Z",
    permitState: "active",
    admission: {
      policy_present: true,
      provider_admitted: true,
      generically_dispatchable: true,
      provider: "fictiv",
      admission_state: "approved",
      policy_revision: "fictiv-generic-2026-10-03.v1",
      evidence_reference: "OVD-458",
      permission_basis: "written_provider_authorization",
      supported_processes: ["cnc_milling"],
      accepted_file_extensions: ["step", "stp", "pdf"],
      session_owner: "overdrafter_managed",
      reviewed_at: "2026-10-02T12:00:00.123456+00:00",
      expires_at: null,
      reason_code: "provider_approved",
    },
    rollout: { capability: "automatic_quote_collection", enabled: true, revision: 3 },
  };
}

/** A well-formed, database-admitted `provider-dispatch-authorization.v1` response. */
export function genericAuthorizedResponse(envelope = genericFictivEnvelope()): Record<string, unknown> {
  return {
    schema: "provider-dispatch-authorization.v1",
    authorized: true,
    permitId: envelope.permit.permitId,
    provider: envelope.provider,
    envelopeFingerprint: fingerprintProviderDispatchEnvelope(envelope),
    canonicalEnvelope: canonicalizeProviderDispatchEnvelope(envelope),
    expiresAt: envelope.expiresAt,
    sessionBindingId: envelope.sessionBindingId,
    evidence: genericAdmissionEvidence(),
  };
}

export const CONSUME_PERMIT_RPC = "api_consume_provider_dispatch_permit";
export const PERMIT_SIDE_EFFECT_RPC = "api_mark_provider_dispatch_permit_side_effect_started";
export const PERMIT_OUTCOME_RPC = "api_record_provider_dispatch_permit_outcome";
const CONSUMPTION_SCHEMA = "provider-dispatch-permit-consumption.v1";

type SimulatedAttempt = { worker: string; sideEffectStarted: boolean; outcome: string | null };
type RpcResult = { data: unknown; error: unknown; status?: number };

/**
 * In-memory stand-in for the OVD-734 draft RPCs (docs/migration-drafts/ovd-734.sql):
 * one attempt per permit plus one retry after a transient, side-effect-free
 * attempt 1. Share one instance between simulated workers to model the database.
 */
export function createPermitConsumptionDatabase() {
  const attempts = new Map<string, SimulatedAttempt[]>();
  const denied = (denial: string): RpcResult => ({ data: { schema: CONSUMPTION_SCHEMA, consumed: false, denial }, error: null });
  const handle = (name: string, args: Record<string, unknown>): RpcResult | null => {
    if (![CONSUME_PERMIT_RPC, PERMIT_SIDE_EFFECT_RPC, PERMIT_OUTCOME_RPC].includes(name)) return null;
    const permitId = String(args.p_permit_id);
    const rows = attempts.get(permitId) ?? [];
    attempts.set(permitId, rows);
    if (name === CONSUME_PERMIT_RPC) {
      const first = rows[0];
      if (rows.length === 0 || (rows.length === 1 && !first.sideEffectStarted && first.outcome === "transient_pre_launch_failure")) {
        rows.push({ worker: String(args.p_worker_name), sideEffectStarted: false, outcome: null });
        return { data: { schema: CONSUMPTION_SCHEMA, consumed: true, permitId, attempt: rows.length }, error: null };
      }
      return denied("permit_already_consumed");
    }
    const attempt = Number(args.p_attempt);
    const row = rows[attempt - 1];
    if (name === PERMIT_SIDE_EFFECT_RPC) {
      if (!row || row.worker !== args.p_worker_name) return denied("permit_mismatch");
      if (row.sideEffectStarted || row.outcome !== null) return denied("permit_already_consumed");
      row.sideEffectStarted = true;
      return { data: { schema: CONSUMPTION_SCHEMA, sideEffectStarted: true, permitId, attempt }, error: null };
    }
    if (name === PERMIT_OUTCOME_RPC) {
      if (!row || row.worker !== args.p_worker_name) return denied("permit_mismatch");
      if (row.outcome !== null || (args.p_outcome === "transient_pre_launch_failure" && row.sideEffectStarted)) {
        return denied("permit_already_consumed");
      }
      row.outcome = String(args.p_outcome);
      return { data: { schema: CONSUMPTION_SCHEMA, outcomeRecorded: true, permitId, attempt, outcome: row.outcome }, error: null };
    }
    return null;
  };
  return { attempts, handle };
}

/** A `supabase.rpc` mock: consumption RPCs hit `database`; every other RPC resolves to `preflight`. */
export function genericDispatchRpc(preflight: RpcResult, database = createPermitConsumptionDatabase()) {
  return vi.fn(async (name: string, args: Record<string, unknown>) => database.handle(name, args) ?? preflight);
}
