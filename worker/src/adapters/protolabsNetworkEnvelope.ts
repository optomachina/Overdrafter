import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import {
  createEvidenceBackedEnvelopeEvaluator,
  type EvidenceBackedEnvelopeInput,
} from "./evidenceBackedEnvelope.js";

const PROTOLABS_NETWORK_ENVELOPE = PROVIDER_CATALOG.protolabsnetwork.capabilityEnvelope;

export const PROTOLABS_NETWORK_ENVELOPE_REVISION =
  `protolabsnetwork-envelope.v${PROTOLABS_NETWORK_ENVELOPE.version}` as const;

export type ProtolabsNetworkEnvelopeInput = EvidenceBackedEnvelopeInput;

/**
 * Classifies a package against Protolabs Network's public, evidence-backed CNC envelope.
 * The evaluator is pure and cannot authorize provider interaction or production admission.
 */
export const evaluateProtolabsNetworkEnvelope = createEvidenceBackedEnvelopeEvaluator({
  providerKey: "protolabsnetwork",
  envelopeRevision: PROTOLABS_NETWORK_ENVELOPE_REVISION,
  envelope: PROTOLABS_NETWORK_ENVELOPE,
  quantityMaximum: "unknown",
  drawingDisposition: "manual_review",
  toleranceDisposition: "unknown",
  geometryDisposition: "unknown",
});
