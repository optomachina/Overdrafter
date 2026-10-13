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

/**
 * True when `candidate` discloses the same package the customer confirmed:
 * same org, job, part, files, quantity, destination revision, and approved
 * requirements. Provider specific fields (fingerprint, notice, envelope) differ
 * by design and are checked by the server against the candidate's own scope.
 */
export function isSameConfirmedPackage(confirmed: ProviderDispatchScope, candidate: ProviderDispatchScope): boolean {
  const a = confirmed.scope;
  const b = candidate.scope;
  return (
    confirmed.organizationId === candidate.organizationId &&
    confirmed.jobId === candidate.jobId &&
    confirmed.partId === candidate.partId &&
    confirmed.requestedQuantity === candidate.requestedQuantity &&
    confirmed.declaredModelUnits === candidate.declaredModelUnits &&
    a.part.cad.sha256 === b.part.cad.sha256 &&
    (a.part.drawing?.sha256 ?? null) === (b.part.drawing?.sha256 ?? null) &&
    a.destination.confirmationRevision === b.destination.confirmationRevision &&
    a.requirements.id === b.requirements.id
  );
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
  createApprovalReference?: () => string;
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
  const approvalReference = (input.createApprovalReference ?? (() => globalThis.crypto.randomUUID()))();
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
