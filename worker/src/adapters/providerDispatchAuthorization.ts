import type { ProviderDispatchFileRole } from "../providerDispatchTypes.js";
import type { StagedFile, VendorName, VendorQuoteAdapterInput } from "../types.js";

/**
 * Adapter-side binding for production generic-provider launches (OVD-673,
 * OVD-674). The worker's provider-neutral preflight is authoritative; this
 * re-checks, immediately before any browser launch, that the authorization
 * handed to the adapter names the expected provider and its reviewed envelope,
 * is still current, and is bound to the exact bytes and quantity the adapter is
 * about to disclose. Live evaluation never reaches this check; it carries its
 * own operator-bound file authorization.
 */
export type ProviderDispatchAuthorizationDenial =
  | "dispatch_authorization_missing"
  | "dispatch_authorization_provider_mismatch"
  | "dispatch_authorization_envelope_unreviewed"
  | "dispatch_authorization_expired"
  | "dispatch_authorization_quantity_mismatch"
  | "dispatch_authorization_file_mismatch";

export type ReviewedAdapterDispatchEnvelope = {
  provider: VendorName;
  id: string;
  version: number;
};

function outboundMatchesStaged(
  outbound: ReadonlyMap<ProviderDispatchFileRole, string>,
  role: ProviderDispatchFileRole,
  staged: StagedFile | null,
): boolean {
  const authorized = outbound.get(role);
  if (!staged) return authorized === undefined;
  return typeof staged.trustedContentSha256 === "string" && authorized === staged.trustedContentSha256;
}

export function providerDispatchAuthorizationDenial(
  input: VendorQuoteAdapterInput,
  reviewed: ReviewedAdapterDispatchEnvelope,
  nowMs: number = Date.now(),
): ProviderDispatchAuthorizationDenial | null {
  const authorization = input.providerDispatchAuthorization;
  if (!authorization) return "dispatch_authorization_missing";

  const { envelope } = authorization;
  if (authorization.provider !== reviewed.provider || envelope.provider !== reviewed.provider) {
    return "dispatch_authorization_provider_mismatch";
  }
  if (envelope.envelope.id !== reviewed.id || envelope.envelope.version !== reviewed.version) {
    return "dispatch_authorization_envelope_unreviewed";
  }
  const expiresMs = Date.parse(authorization.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs || authorization.expiresAt !== envelope.expiresAt) {
    return "dispatch_authorization_expired";
  }
  if (envelope.scope.requestedQuantity !== input.requestedQuantity) {
    return "dispatch_authorization_quantity_mismatch";
  }

  // Every file the adapter uploads must be an authorized identity disclosure,
  // and the authorization must not name a file the adapter would not upload.
  const outbound = new Map(envelope.outboundFiles.map((file) => [file.role, file.sha256]));
  if (
    outbound.size !== envelope.outboundFiles.length ||
    !outboundMatchesStaged(outbound, "cad", input.stagedCadFile) ||
    !outboundMatchesStaged(outbound, "drawing", input.stagedDrawingFile)
  ) {
    return "dispatch_authorization_file_mismatch";
  }

  return null;
}
