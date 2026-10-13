import type { VendorName } from "@/integrations/supabase/types";
import {
  getProviderDispatchScope,
  getXometryBetaDispatchScope,
  requestProviderDispatch,
  requestXometryBetaDispatch,
} from "@/features/quotes/api/quote-requests-api";
import type {
  ProviderDispatchScope,
  XometryBetaDispatchResult,
  XometryBetaModelUnits,
} from "@/features/quotes/xometry-beta-dispatch";

/** JSON with object keys sorted at every depth, so equal packages compare equal. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : Number(left > right)));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The provider neutral part of a scope: everything the customer reviewed in the
 * dialog. It covers the requirement snapshot in full (capturedAt from
 * approved_part_requirements.updated_at, material, finish, tolerance, process
 * and the rest of the specification, quantity, delivery date), the destination,
 * and every file with its hash. Only the vendor, fingerprint, notice, and
 * envelope differ between providers, and the server checks those against the
 * candidate's own scope.
 */
export function getConfirmedPackageKey(scope: ProviderDispatchScope): string {
  return canonicalJson({
    organizationId: scope.organizationId,
    jobId: scope.jobId,
    partId: scope.partId,
    requestedQuantity: scope.requestedQuantity,
    declaredModelUnits: scope.declaredModelUnits,
    scope: { ...scope.scope, vendor: undefined },
  });
}

/**
 * True when `candidate` discloses exactly the package the customer confirmed.
 * Comparing only the requirement id is not enough: the row is upserted on
 * part_id, so an edit keeps the id while changing what would be disclosed.
 */
export function isSameConfirmedPackage(confirmed: ProviderDispatchScope, candidate: ProviderDispatchScope): boolean {
  return getConfirmedPackageKey(confirmed) === getConfirmedPackageKey(candidate);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The approval reference for one extra provider, derived from the customer's
 * confirmation reference as a name based UUID (RFC 9562 version 5, with the
 * confirmation reference as namespace and "provider-fanout:<provider>" as
 * name). Anyone holding the confirmation reference can recompute it, so each
 * extra permit traces back to the confirmation in the audit trail, and a replay
 * of the same confirmation reuses the same reference instead of a new one.
 */
export async function deriveFanoutApprovalReference(confirmationReference: string, provider: VendorName): Promise<string> {
  if (!UUID_PATTERN.test(confirmationReference)) {
    throw new TypeError("provider_dispatch_approval_reference_required");
  }
  const namespaceHex = confirmationReference.split("-").join("");
  const namespace = Array.from({ length: 16 }, (_, index) => Number.parseInt(namespaceHex.slice(index * 2, index * 2 + 2), 16));
  const name = new TextEncoder().encode(`provider-fanout:${provider}`);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-1", new Uint8Array([...namespace, ...name])));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Issues one generic dispatch request for an extra fan out provider, through
 * the same scope and permit RPCs the primary uses (OVD-458/459). A package that
 * drifted from the confirmed one is refused before any request is sent.
 */
export async function dispatchFanoutProvider(input: {
  jobId: string;
  provider: VendorName;
  declaredModelUnits: XometryBetaModelUnits;
  confirmedScope: ProviderDispatchScope;
  /** The customer's confirmation reference; each extra's reference derives from it. */
  confirmationReference: string;
}): Promise<XometryBetaDispatchResult> {
  const { jobId, provider, declaredModelUnits } = input;
  const scope =
    provider === "xometry"
      ? await getXometryBetaDispatchScope(jobId, declaredModelUnits)
      : await getProviderDispatchScope(jobId, provider, declaredModelUnits);
  if (!isSameConfirmedPackage(input.confirmedScope, scope)) {
    // Matches the explicit generic denial list, so it reports as denied.
    throw new Error("provider_dispatch_scope_mismatch");
  }
  const approvalReference = await deriveFanoutApprovalReference(input.confirmationReference, provider);
  if (provider === "xometry") {
    return requestXometryBetaDispatch({
      jobId,
      declaredModelUnits,
      expectedScopeFingerprint: scope.scopeFingerprint,
      policyRevision: scope.policyRevision,
      approvalReference,
    });
  }
  return requestProviderDispatch({
    jobId,
    provider,
    declaredModelUnits,
    expectedScopeFingerprint: scope.scopeFingerprint,
    noticeRevision: scope.policyRevision,
    expectedEnvelopeRevision: scope.envelopeRevision,
    approvalReference,
  });
}
