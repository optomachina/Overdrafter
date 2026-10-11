import fixture from "../../test-fixtures/provider-dispatch-envelope/quickparts-v1.json";
import {
  fingerprintProviderDispatchEnvelope,
  parseProviderDispatchEnvelope,
  type ProviderDispatchEnvelope,
} from "../src/providerDispatchEnvelope.js";
import type { ProviderDispatchAuthorization } from "../src/providerDispatchTypes.js";

/** Synthetic Quickparts envelope fixture (OVD-674). No provider, account, or customer data. */
export function quickpartsDispatchEnvelope(binding: {
  cadSha256: string;
  requestedQuantity: number;
}): ProviderDispatchEnvelope {
  const raw = structuredClone(fixture.envelope) as Record<string, unknown> & {
    scope: Record<string, unknown>;
    sourceFiles: Array<Record<string, unknown>>;
  };
  raw.scope.requestedQuantity = binding.requestedQuantity;
  raw.sourceFiles = [{ ...raw.sourceFiles[0], sha256: binding.cadSha256 }];
  raw.outboundFiles = [{
    role: "cad",
    sourceSha256: binding.cadSha256,
    sha256: binding.cadSha256,
    derivation: "identity",
  }];
  const parsed = parseProviderDispatchEnvelope(raw);
  if (!parsed.ok) throw new Error(`Quickparts fixture envelope is invalid: ${parsed.denial}`);
  return parsed.envelope;
}

export function quickpartsDispatchAuthorization(
  envelope: ProviderDispatchEnvelope,
): ProviderDispatchAuthorization {
  return {
    permitId: envelope.permit.permitId,
    provider: envelope.provider,
    envelopeFingerprint: fingerprintProviderDispatchEnvelope(envelope),
    expiresAt: envelope.expiresAt,
    sessionBindingId: envelope.sessionBindingId,
    envelope,
  };
}
