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
