import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import {
  createEvidenceBackedEnvelopeEvaluator,
  type EvidenceBackedEnvelopeDecision,
  type EvidenceBackedEnvelopeInput,
} from "./evidenceBackedEnvelope.js";

const FICTIV_ENVELOPE = PROVIDER_CATALOG.fictiv.capabilityEnvelope;

export const FICTIV_ENVELOPE_REVISION =
  `fictiv-envelope.v${FICTIV_ENVELOPE.version}` as const;

export type FictivEnvelopeInput = EvidenceBackedEnvelopeInput;

const DOCUMENTED_UNSUPPORTED_CNC_EXTENSIONS = new Set([
  "f3d",
  "iges",
  "sldasm",
  "stl",
]);

const evaluateEvidenceBackedEnvelope = createEvidenceBackedEnvelopeEvaluator({
  providerKey: "fictiv",
  envelopeRevision: FICTIV_ENVELOPE_REVISION,
  envelope: FICTIV_ENVELOPE,
  quantityMaximum: "unknown",
  drawingDisposition: "unknown",
  toleranceDisposition: "unknown",
  geometryDisposition: "unknown",
});

/** Classifies only the public Fictiv CNC envelope; this never accesses a provider. */
export function evaluateFictivEnvelope(
  input: FictivEnvelopeInput,
): EvidenceBackedEnvelopeDecision {
  const decision = evaluateEvidenceBackedEnvelope(input);
  if (!decision.normalized.fileExtension
    || !DOCUMENTED_UNSUPPORTED_CNC_EXTENSIONS.has(decision.normalized.fileExtension)) {
    return decision;
  }

  return {
    ...decision,
    state: "unsupported",
    reasonCodes: [
      ...decision.reasonCodes.filter((reason) =>
        reason !== "file_format_unknown"
        && reason !== "eligible_evidence_backed_envelope"),
      "file_format_unsupported",
    ],
  };
}
