import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import {
  createEvidenceBackedEnvelopeEvaluator,
  OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY,
  type EvidenceBackedEnvelopeDecision,
  type EvidenceBackedEnvelopeInput,
  type EvidenceBackedEnvelopeReason,
  type EvidenceBackedEnvelopeState,
} from "./evidenceBackedEnvelope.js";

const QUICKPARTS_ENVELOPE = PROVIDER_CATALOG.quickparts.capabilityEnvelope;

export const QUICKPARTS_ENVELOPE_REVISION =
  `quickparts-envelope.v${QUICKPARTS_ENVELOPE.version}` as const;
export const QUICKPARTS_OFFLINE_AUTHORIZATION_BOUNDARY =
  OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY;

export type QuickpartsEnvelopeInput = EvidenceBackedEnvelopeInput;
export type QuickpartsEnvelopeDecision = EvidenceBackedEnvelopeDecision;
export type QuickpartsEnvelopeReason = EvidenceBackedEnvelopeReason;
export type QuickpartsEnvelopeState = EvidenceBackedEnvelopeState;

const evaluateEvidenceBackedEnvelope = createEvidenceBackedEnvelopeEvaluator({
  providerKey: "quickparts",
  envelopeRevision: QUICKPARTS_ENVELOPE_REVISION,
  envelope: QUICKPARTS_ENVELOPE,
  quantityMaximum: "unknown",
  manualReviewFileExtensions: ["sldprt"],
  drawingDisposition: "unknown",
  toleranceDisposition: "unknown",
  geometryDisposition: "unknown",
});

/**
 * Classifies a package against Quickparts' public, evidence-backed envelope.
 * This function is pure and deliberately has no interaction or I/O capability.
 */
export function evaluateQuickpartsEnvelope(
  input: QuickpartsEnvelopeInput,
): QuickpartsEnvelopeDecision {
  return evaluateEvidenceBackedEnvelope(input);
}
