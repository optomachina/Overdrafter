import { FICTIV_DISPATCH_ENVELOPE, type ProviderDispatchFileRole } from "../providerDispatchEnvelope.js";
import type { StagedFile, VendorQuoteAdapterInput } from "../types.js";

/**
 * OVD-673 adapter-side binding for production Fictiv launches. The worker's
 * provider-neutral preflight is authoritative; this re-checks, immediately
 * before any browser launch, that the authorization handed to the adapter is
 * the reviewed Fictiv envelope, still current, and bound to the exact bytes
 * and quantity the adapter is about to disclose. Live evaluation never reaches
 * this check; it carries its own operator-bound file authorization.
 */
export type FictivDispatchAuthorizationDenial =
  | "dispatch_authorization_missing"
  | "dispatch_authorization_provider_mismatch"
  | "dispatch_authorization_envelope_unreviewed"
  | "dispatch_authorization_expired"
  | "dispatch_authorization_quantity_mismatch"
  | "dispatch_authorization_file_mismatch";

function outboundMatchesStaged(
  outbound: ReadonlyMap<ProviderDispatchFileRole, string>,
  role: ProviderDispatchFileRole,
  staged: StagedFile | null,
): boolean {
  const authorized = outbound.get(role);
  if (!staged) return authorized === undefined;
  return typeof staged.trustedContentSha256 === "string" && authorized === staged.trustedContentSha256;
}

export function fictivDispatchAuthorizationDenial(
  input: VendorQuoteAdapterInput,
  nowMs: number = Date.now(),
): FictivDispatchAuthorizationDenial | null {
  const authorization = input.providerDispatchAuthorization;
  if (!authorization) return "dispatch_authorization_missing";

  const { envelope } = authorization;
  if (authorization.provider !== "fictiv" || envelope.provider !== "fictiv") {
    return "dispatch_authorization_provider_mismatch";
  }
  if (
    envelope.envelope.id !== FICTIV_DISPATCH_ENVELOPE.id ||
    envelope.envelope.version !== FICTIV_DISPATCH_ENVELOPE.version
  ) {
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
