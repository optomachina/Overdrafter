import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import {
  createEvidenceBackedEnvelopeEvaluator,
  OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY,
  type EvidenceBackedEnvelopeDecision,
  type EvidenceBackedEnvelopeInput,
} from "./evidenceBackedEnvelope.js";

const PROTOLABS_ENVELOPE = PROVIDER_CATALOG.protolabs.capabilityEnvelope;

export const PROTOLABS_ENVELOPE_REVISION =
  `protolabs-envelope.v${PROTOLABS_ENVELOPE.version}` as const;
export const PROTOLABS_OFFLINE_AUTHORIZATION_BOUNDARY =
  OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY;

export type ProtolabsEnvelopeInput = EvidenceBackedEnvelopeInput;
export type ProtolabsEnvelopeDecision = EvidenceBackedEnvelopeDecision;

const evaluateEvidenceBackedEnvelope = createEvidenceBackedEnvelopeEvaluator({
  providerKey: "protolabs",
  envelopeRevision: PROTOLABS_ENVELOPE_REVISION,
  envelope: PROTOLABS_ENVELOPE,
  quantityMaximum: "unknown",
  drawingDisposition: "unknown",
  toleranceDisposition: "unknown",
  geometryDisposition: "unknown",
});

/**
 * Classifies a package against Protolabs' public, evidence-backed envelope.
 * This function is pure and deliberately has no interaction or I/O capability.
 */
export function evaluateProtolabsEnvelope(
  input: ProtolabsEnvelopeInput,
): ProtolabsEnvelopeDecision {
  return evaluateEvidenceBackedEnvelope(input);
}
