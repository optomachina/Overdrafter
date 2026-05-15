import type { VendorStatus } from "./types.js";

export type PricingCurveObservationStatus = "priced" | "manual_review" | "failed" | "pending";

export type PricingCurveObservation = {
  requestedQuantity: number;
  unitPriceUsd: number | null;
  totalPriceUsd: number | null;
  leadTimeBusinessDays: number | null;
  vendorStatus?: VendorStatus | PricingCurveObservationStatus | null;
};

export type PricingCurveBreak = {
  fromQuantity: number;
  toQuantity: number;
  unitPriceChangeUsd: number;
  unitPriceChangePercent: number;
  totalPriceChangeUsd: number | null;
  leadTimeChangeBusinessDays: number | null;
};

export type PricingCurveAnalysis = {
  observations: PricingCurveObservation[];
  pricedObservations: PricingCurveObservation[];
  gapObservations: PricingCurveObservation[];
  priceBreaks: PricingCurveBreak[];
  unitPriceLogSlope: number | null;
  leadTimeChanges: Array<{
    fromQuantity: number;
    toQuantity: number;
    changeBusinessDays: number;
  }>;
  completeness: number;
  confidence: number;
  reliable: boolean;
  reason: "ok" | "no_observations" | "not_enough_priced_quantities";
};

export type PricingEstimate = {
  requestedQuantity: number;
  estimatedUnitPriceUsd: number;
  estimatedTotalPriceUsd: number;
  confidence: number;
  estimateOnly: true;
  requiresLiveVerification: true;
  countsAsRealQuote: false;
};

function normalizeStatus(status: PricingCurveObservation["vendorStatus"]): PricingCurveObservationStatus {
  if (status === "priced") {
    return "priced";
  }

  if (status === "instant_quote_received" || status === "official_quote_received") {
    return "priced";
  }

  if (status === "manual_review" || status === "manual_review_pending" || status === "manual_vendor_followup") {
    return "manual_review";
  }

  if (status === "failed") {
    return "failed";
  }

  return "pending";
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundRatio(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function normalizeObservation(observation: PricingCurveObservation): PricingCurveObservation {
  const requestedQuantity = Math.max(1, Math.trunc(observation.requestedQuantity || 1));
  const totalPriceUsd =
    typeof observation.totalPriceUsd === "number" && Number.isFinite(observation.totalPriceUsd)
      ? observation.totalPriceUsd
      : null;
  let unitPriceUsd =
    typeof observation.unitPriceUsd === "number" && Number.isFinite(observation.unitPriceUsd)
      ? observation.unitPriceUsd
      : null;

  if (unitPriceUsd === null && totalPriceUsd !== null) {
    unitPriceUsd = totalPriceUsd / requestedQuantity;
  }

  return {
    requestedQuantity,
    unitPriceUsd: unitPriceUsd === null ? null : roundMoney(unitPriceUsd),
    totalPriceUsd: totalPriceUsd === null ? null : roundMoney(totalPriceUsd),
    leadTimeBusinessDays:
      typeof observation.leadTimeBusinessDays === "number" && Number.isFinite(observation.leadTimeBusinessDays)
        ? Math.trunc(observation.leadTimeBusinessDays)
        : null,
    vendorStatus: observation.vendorStatus ?? null,
  };
}

function isPricedObservation(observation: PricingCurveObservation): boolean {
  return (
    normalizeStatus(observation.vendorStatus) === "priced" &&
    typeof observation.unitPriceUsd === "number" &&
    observation.unitPriceUsd > 0
  );
}

function computePriceBreaks(pricedObservations: PricingCurveObservation[]): PricingCurveBreak[] {
  const breaks: PricingCurveBreak[] = [];

  for (let index = 1; index < pricedObservations.length; index += 1) {
    const previous = pricedObservations[index - 1];
    const current = pricedObservations[index];
    const unitPriceChangeUsd = roundMoney((current.unitPriceUsd ?? 0) - (previous.unitPriceUsd ?? 0));
    const previousUnit = previous.unitPriceUsd ?? 0;
    const totalPriceChangeUsd =
      current.totalPriceUsd !== null && previous.totalPriceUsd !== null
        ? roundMoney(current.totalPriceUsd - previous.totalPriceUsd)
        : null;
    const leadTimeChangeBusinessDays =
      current.leadTimeBusinessDays !== null && previous.leadTimeBusinessDays !== null
        ? current.leadTimeBusinessDays - previous.leadTimeBusinessDays
        : null;

    breaks.push({
      fromQuantity: previous.requestedQuantity,
      toQuantity: current.requestedQuantity,
      unitPriceChangeUsd,
      unitPriceChangePercent: previousUnit > 0 ? roundRatio(unitPriceChangeUsd / previousUnit) : 0,
      totalPriceChangeUsd,
      leadTimeChangeBusinessDays,
    });
  }

  return breaks;
}

function computeLeadTimeChanges(pricedObservations: PricingCurveObservation[]) {
  return computePriceBreaks(pricedObservations)
    .filter((priceBreak) => priceBreak.leadTimeChangeBusinessDays !== null)
    .map((priceBreak) => ({
      fromQuantity: priceBreak.fromQuantity,
      toQuantity: priceBreak.toQuantity,
      changeBusinessDays: priceBreak.leadTimeChangeBusinessDays ?? 0,
    }));
}

function computeLogSlope(pricedObservations: PricingCurveObservation[]): number | null {
  if (pricedObservations.length < 2) {
    return null;
  }

  const points = pricedObservations.map((observation) => ({
    x: Math.log(observation.requestedQuantity),
    y: Math.log(observation.unitPriceUsd ?? 1),
  }));
  const meanX = points.reduce((total, point) => total + point.x, 0) / points.length;
  const meanY = points.reduce((total, point) => total + point.y, 0) / points.length;
  let numerator = 0;
  let denominator = 0;

  points.forEach((point) => {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  });

  if (denominator === 0) {
    return null;
  }

  return roundRatio(numerator / denominator);
}

function computeConfidence(input: {
  observations: PricingCurveObservation[];
  pricedObservations: PricingCurveObservation[];
  gapObservations: PricingCurveObservation[];
}): number {
  if (input.pricedObservations.length < 2) {
    return 0;
  }

  const completeness = input.pricedObservations.length / Math.max(1, input.observations.length);
  const quantitySpan =
    input.pricedObservations.at(-1)!.requestedQuantity / input.pricedObservations[0].requestedQuantity;
  const spanScore = Math.min(1, Math.log10(Math.max(1, quantitySpan)) / 3);
  const gapPenalty = Math.min(0.3, input.gapObservations.length * 0.08);

  return roundRatio(Math.max(0, Math.min(1, 0.25 + completeness * 0.5 + spanScore * 0.25 - gapPenalty)));
}

/**
 * Summarizes observed quantity quote rows without filling gaps or treating estimates as vendor quotes.
 */
export function analyzePricingCurve(observations: readonly PricingCurveObservation[]): PricingCurveAnalysis {
  const normalizedObservations = observations
    .map((observation) => normalizeObservation(observation))
    .sort((left, right) => left.requestedQuantity - right.requestedQuantity);
  const pricedObservations = normalizedObservations.filter((observation) => isPricedObservation(observation));
  const gapObservations = normalizedObservations.filter((observation) => !isPricedObservation(observation));
  const completeness =
    normalizedObservations.length === 0 ? 0 : roundRatio(pricedObservations.length / normalizedObservations.length);
  const confidence = computeConfidence({
    observations: normalizedObservations,
    pricedObservations,
    gapObservations,
  });
  let reason: PricingCurveAnalysis["reason"] = "ok";

  if (normalizedObservations.length === 0) {
    reason = "no_observations";
  } else if (pricedObservations.length < 2) {
    reason = "not_enough_priced_quantities";
  }

  return {
    observations: normalizedObservations,
    pricedObservations,
    gapObservations,
    priceBreaks: computePriceBreaks(pricedObservations),
    unitPriceLogSlope: computeLogSlope(pricedObservations),
    leadTimeChanges: computeLeadTimeChanges(pricedObservations),
    completeness,
    confidence,
    reliable: reason === "ok",
    reason,
  };
}

/**
 * Gates internal estimator use behind reliability and the configured confidence threshold.
 */
export function shouldUsePricingEstimate(analysis: PricingCurveAnalysis, minimumConfidence: number): boolean {
  return analysis.reliable && analysis.confidence >= minimumConfidence;
}

/**
 * Produces an internal estimate for planning only; callers must still fetch a live vendor quote.
 */
export function estimateUnitPriceAtQuantity(
  analysis: PricingCurveAnalysis,
  requestedQuantity: number,
  minimumConfidence: number,
): PricingEstimate | null {
  if (!shouldUsePricingEstimate(analysis, minimumConfidence)) {
    return null;
  }

  if (analysis.unitPriceLogSlope === null || analysis.pricedObservations.length === 0) {
    return null;
  }

  const targetQuantity = Math.max(1, Math.trunc(requestedQuantity || 1));
  const anchor = analysis.pricedObservations[0];
  const anchorUnitPrice = anchor.unitPriceUsd ?? 0;

  if (anchorUnitPrice <= 0) {
    return null;
  }

  const estimatedUnitPriceUsd = roundMoney(
    anchorUnitPrice *
      Math.exp(analysis.unitPriceLogSlope * (Math.log(targetQuantity) - Math.log(anchor.requestedQuantity))),
  );

  return {
    requestedQuantity: targetQuantity,
    estimatedUnitPriceUsd,
    estimatedTotalPriceUsd: roundMoney(estimatedUnitPriceUsd * targetQuantity),
    confidence: analysis.confidence,
    estimateOnly: true,
    requiresLiveVerification: true,
    countsAsRealQuote: false,
  };
}
