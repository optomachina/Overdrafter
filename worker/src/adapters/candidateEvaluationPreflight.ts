import type { VendorName, VendorQuoteAdapterInput } from "../types.js";
import type { EvidenceBackedEnvelopeDecision, EvidenceBackedEnvelopeInput } from "./evidenceBackedEnvelope.js";
import { evaluateRapidDirectEnvelope } from "./rapiddirectEnvelope.js";
import { evaluateProtolabsNetworkEnvelope } from "./protolabsNetworkEnvelope.js";
import { evaluateProtolabsEnvelope } from "./protolabsEnvelope.js";

export const CANDIDATE_EVALUATION_PREFLIGHT_REVISION = "candidate-evaluation-preflight.v1";

type CandidateInput = Pick<VendorQuoteAdapterInput,
  "stagedCadFile" | "stagedDrawingFile" | "requirement" | "requestedQuantity">;

/**
 * Projects only available package facts into the existing conservative envelopes.
 * Call after exact-file authorization and before delegation. This pure decision
 * grants no interaction authority: reviewed process, account, geometry and
 * tolerance metadata are absent, so these candidates cannot become eligible.
 * In particular, harness material/tolerance defaults and spec_snapshot fields
 * are not a substitute for reviewed package facts.
 */
export function evaluateCandidateEvaluationPreflight(
  vendor: VendorName,
  input: CandidateInput,
): EvidenceBackedEnvelopeDecision | null {
  let evaluate: typeof evaluateRapidDirectEnvelope | null = null;
  if (vendor === "rapiddirect") evaluate = evaluateRapidDirectEnvelope;
  else if (vendor === "protolabsnetwork") evaluate = evaluateProtolabsNetworkEnvelope;
  else if (vendor === "protolabs") evaluate = evaluateProtolabsEnvelope;
  if (!evaluate) return null;

  const envelopeInput: EvidenceBackedEnvelopeInput = {
    process: null,
    material: input.requirement.material,
    fileName: input.stagedCadFile?.originalName ?? null,
    quantity: input.requestedQuantity,
    accountMode: null,
    drawingIncluded: input.stagedDrawingFile !== null,
    explicitToleranceRequirement: null,
    requestedToleranceMm: null,
    explicitGeometryRequirements: null,
    geometryWithinReviewedEnvelope: null,
  };
  return evaluate(envelopeInput);
}
