import {
  fingerprintProviderDispatchEnvelope,
  parseProviderDispatchEnvelope,
  type ProviderDispatchEnvelope,
} from "../src/providerDispatchEnvelope.js";
import type { ProviderDispatchAuthorization } from "../src/providerDispatchTypes.js";

type FixtureEnvelope = Record<string, unknown> & {
  scope: Record<string, unknown>;
  sourceFiles: Array<Record<string, unknown>>;
};

export type ProviderDispatchFixtureBinding = {
  cadSha256: string;
  drawingSha256?: string | null;
  requestedQuantity: number;
};

/**
 * Shared builder for the per-provider synthetic envelope fixtures. The fixture
 * JSON lists the CAD source first and an optional drawing second; this binds
 * the staged digests and quantity under test and re-parses the result so an
 * invalid fixture fails loudly. No provider, account, or customer data.
 */
export function buildProviderDispatchFixtureEnvelope(
  label: string,
  fixtureEnvelope: unknown,
  binding: ProviderDispatchFixtureBinding,
): ProviderDispatchEnvelope {
  const raw = structuredClone(fixtureEnvelope) as FixtureEnvelope;
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
  if (!parsed.ok) throw new Error(`${label} fixture envelope is invalid: ${parsed.denial}`);
  return parsed.envelope;
}

export function providerDispatchFixtureAuthorization(
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
