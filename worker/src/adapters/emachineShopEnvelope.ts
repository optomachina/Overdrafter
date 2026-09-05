import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import {
  createEvidenceBackedEnvelopeEvaluator,
  type EvidenceBackedEnvelopeInput,
} from "./evidenceBackedEnvelope.js";

const EMACHINESHOP_ENVELOPE = PROVIDER_CATALOG.emachineshop.capabilityEnvelope;

export const EMACHINESHOP_ENVELOPE_REVISION =
  `emachineshop-envelope.v${EMACHINESHOP_ENVELOPE.version}` as const;

export type EMachineShopEnvelopeInput = EvidenceBackedEnvelopeInput;

/**
 * Classifies eMachineShop packages without interacting with either quote path.
 * Guidance-only policy ensures this evaluator can never authorize automation.
 */
export const evaluateEMachineShopEnvelope =
  createEvidenceBackedEnvelopeEvaluator({
    providerKey: "emachineshop",
    envelopeRevision: EMACHINESHOP_ENVELOPE_REVISION,
    envelope: EMACHINESHOP_ENVELOPE,
    quantityMaximum: "bounded",
    manualReviewFileExtensions: ["dxf", "jpg", "obj", "pdf", "png", "stl"],
    drawingDisposition: "manual_review",
    toleranceDisposition: "unknown",
    geometryDisposition: "unknown",
    guidanceOnly: true,
  });
