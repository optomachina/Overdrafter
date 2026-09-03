import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import {
  createEvidenceBackedEnvelopeEvaluator,
  type EvidenceBackedEnvelopeInput,
} from "./evidenceBackedEnvelope.js";

const GEOMIQ_ENVELOPE = PROVIDER_CATALOG.geomiq.capabilityEnvelope;

export const GEOMIQ_ENVELOPE_REVISION =
  `geomiq-envelope.v${GEOMIQ_ENVELOPE.version}` as const;

export type GeomiqEnvelopeInput = EvidenceBackedEnvelopeInput;

/**
 * Classifies a package against Geomiq's public, evidence-backed CNC envelope.
 * This pure evaluator cannot interact with Geomiq or grant production authority.
 */
export const evaluateGeomiqEnvelope = createEvidenceBackedEnvelopeEvaluator({
  providerKey: "geomiq",
  envelopeRevision: GEOMIQ_ENVELOPE_REVISION,
  envelope: GEOMIQ_ENVELOPE,
  quantityMaximum: "bounded",
  drawingDisposition: "unknown",
  toleranceDisposition: "supported",
  geometryDisposition: "unknown",
});
