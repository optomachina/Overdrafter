import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import {
  createEvidenceBackedEnvelopeEvaluator,
  OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY,
  type EvidenceBackedEnvelopeDecision,
  type EvidenceBackedEnvelopeInput,
} from "./evidenceBackedEnvelope.js";

const WEERG_ENVELOPE = PROVIDER_CATALOG.weerg.capabilityEnvelope;

export const WEERG_ENVELOPE_REVISION = `weerg-envelope.v${WEERG_ENVELOPE.version}` as const;
export const WEERG_OFFLINE_AUTHORIZATION_BOUNDARY =
  OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY;

export type WeergEnvelopeInput = EvidenceBackedEnvelopeInput;
export type WeergEnvelopeDecision = EvidenceBackedEnvelopeDecision;

const evaluateEvidenceBackedEnvelope = createEvidenceBackedEnvelopeEvaluator({
  providerKey: "weerg",
  envelopeRevision: WEERG_ENVELOPE_REVISION,
  envelope: WEERG_ENVELOPE,
  quantityMaximum: "bounded",
  drawingDisposition: "manual_review",
  toleranceDisposition: "unknown",
  geometryDisposition: "manual_review",
});

/**
 * Classifies a package against Weerg's public, evidence-backed envelope.
 * This function is pure and deliberately has no interaction or I/O capability.
 */
export function evaluateWeergEnvelope(
  input: WeergEnvelopeInput,
): WeergEnvelopeDecision {
  return evaluateEvidenceBackedEnvelope(input);
}
