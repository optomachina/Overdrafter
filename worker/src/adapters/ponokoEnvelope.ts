import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import {
  createEvidenceBackedEnvelopeEvaluator,
  OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY,
  type EvidenceBackedEnvelopeDecision,
  type EvidenceBackedEnvelopeInput,
} from "./evidenceBackedEnvelope.js";

const PONOKO_ENVELOPE = PROVIDER_CATALOG.ponoko.capabilityEnvelope;

export const PONOKO_ENVELOPE_REVISION =
  `ponoko-envelope.v${PONOKO_ENVELOPE.version}` as const;
export const PONOKO_OFFLINE_AUTHORIZATION_BOUNDARY =
  OFFLINE_ENVELOPE_AUTHORIZATION_BOUNDARY;

export type PonokoEnvelopeInput = EvidenceBackedEnvelopeInput;
export type PonokoEnvelopeDecision = EvidenceBackedEnvelopeDecision;

const evaluateEvidenceBackedEnvelope = createEvidenceBackedEnvelopeEvaluator({
  providerKey: "ponoko",
  envelopeRevision: PONOKO_ENVELOPE_REVISION,
  envelope: PONOKO_ENVELOPE,
  quantityMaximum: "bounded",
  drawingDisposition: "unknown",
  toleranceDisposition: "unknown",
  geometryDisposition: "manual_review",
});

/**
 * Classifies a package against Ponoko's public, evidence-backed envelope.
 * This function is pure and deliberately has no interaction or I/O capability.
 */
export function evaluatePonokoEnvelope(
  input: PonokoEnvelopeInput,
): PonokoEnvelopeDecision {
  const decision = evaluateEvidenceBackedEnvelope(input);
  if (
    decision.normalized.process !== "laser_engraving"
    || decision.normalized.fileExtension !== "step"
    || decision.reasonCodes.includes("file_format_unknown")
  ) {
    return decision;
  }

  return {
    ...decision,
    state: decision.state === "unsupported" ? "unsupported" : "unknown",
    reasonCodes: [
      ...decision.reasonCodes.filter(
        (reason) => reason !== "eligible_evidence_backed_envelope",
      ),
      "file_format_unknown",
    ],
  };
}
