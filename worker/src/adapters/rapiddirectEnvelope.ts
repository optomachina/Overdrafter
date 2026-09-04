import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import {
  createEvidenceBackedEnvelopeEvaluator,
  type EvidenceBackedEnvelopeDecision,
  type EvidenceBackedEnvelopeInput,
} from "./evidenceBackedEnvelope.js";

const RAPIDDIRECT_ENVELOPE = PROVIDER_CATALOG.rapiddirect.capabilityEnvelope;

export const RAPIDDIRECT_ENVELOPE_REVISION =
  `rapiddirect-envelope.v${RAPIDDIRECT_ENVELOPE.version}` as const;

export type RapidDirectEnvelopeInput = EvidenceBackedEnvelopeInput;
export type RapidDirectEnvelopeDecision = EvidenceBackedEnvelopeDecision;

/**
 * Classifies packages against RapidDirect's narrow public evidence envelope.
 * Unknown production bounds remain unknown and drawings require manual review.
 */
export const evaluateRapidDirectEnvelope = createEvidenceBackedEnvelopeEvaluator({
  providerKey: "rapiddirect",
  envelopeRevision: RAPIDDIRECT_ENVELOPE_REVISION,
  envelope: RAPIDDIRECT_ENVELOPE,
  quantityMaximum: "unknown",
  drawingDisposition: "unknown",
  toleranceDisposition: "unknown",
  geometryDisposition: "unknown",
});
