import fixture from "../../test-fixtures/provider-dispatch-envelope/fictiv-v1.json";
import {
  fingerprintProviderDispatchEnvelope,
  parseProviderDispatchEnvelope,
  type ProviderDispatchEnvelope,
} from "../src/providerDispatchEnvelope.js";
import type { ProviderDispatchAuthorization } from "../src/providerDispatchPreflight.js";

/** Synthetic Fictiv envelope fixture (OVD-673). No provider, account, or customer data. */
export function fictivDispatchEnvelope(binding: {
  cadSha256: string;
  drawingSha256?: string | null;
  requestedQuantity: number;
}): ProviderDispatchEnvelope {
  const raw = structuredClone(fixture.envelope) as Record<string, unknown> & {
    scope: Record<string, unknown>;
    sourceFiles: Array<Record<string, unknown>>;
  };
  raw.scope.requestedQuantity = binding.requestedQuantity;
  const sources = [{ ...raw.sourceFiles[0], sha256: binding.cadSha256 }];
  if (binding.drawingSha256) sources.push({ ...raw.sourceFiles[1], sha256: binding.drawingSha256 });
  raw.sourceFiles = sources;
  raw.outboundFiles = sources.map((file) => ({
    role: file.role,
    sourceSha256: file.sha256,
    sha256: file.sha256,
    derivation: "identity",
  }));
  const parsed = parseProviderDispatchEnvelope(raw);
  if (!parsed.ok) throw new Error(`Fictiv fixture envelope is invalid: ${parsed.denial}`);
  return parsed.envelope;
}

export function fictivDispatchAuthorization(
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
