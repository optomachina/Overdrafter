import path from "node:path";
import type {
  VendorArtifact,
  VendorQuoteAdapterInput,
  VendorQuoteAdapterOffer,
  VendorQuoteAdapterOutput,
} from "../types.js";
import { VendorAutomationError } from "../types.js";
import {
  isAllowedProviderUrl,
  type ProviderPortalDefinition,
  type ProviderPortalNormalizedOffer,
  type ProviderPortalTerminalState,
} from "./providerPortalKernel.js";

export const PROVIDER_ADAPTER_CONTRACT_REVISION = "provider-adapter-contract.v1" as const;

const PROHIBITED_ACTION_PATTERN = /(?:checkout|place[_ -]?order|submit[_ -]?order|purchase|payment|add[_ -]?to[_ -]?cart)/i;
const SAFE_PROHIBITION_VALUES: Readonly<Record<string, unknown>> = {
  checkoutAllowed: false,
  orderActions: "prohibited",
  orderProhibited: true,
  orderingProhibited: true,
  purchasingProhibited: true,
};

export type ProviderAdapterContractResult = {
  revision: typeof PROVIDER_ADAPTER_CONTRACT_REVISION;
  provider: string;
  terminalState: ProviderPortalTerminalState | "offers_extracted";
  normalizedOffers: ProviderPortalNormalizedOffer[];
  artifactRefs: string[];
  violations: string[];
  ok: boolean;
};

export type ProviderAdapterContractDefinition = Pick<
  ProviderPortalDefinition,
  "provider" | "allowedHosts" | "requirements" | "selectors"
>;

const FINITE_TERMINAL_STATES = new Set<ProviderPortalTerminalState>([
  "login_required",
  "captcha",
  "missing_session",
  "unexpected_origin",
  "selector_drift",
  "configuration_required",
  "manual_review",
  "unsupported",
  "unavailable",
]);

/** Checks that an adapter failure is finite, truthful, and price-free. */
export function evaluateProviderAdapterFailureContract(error: unknown): {
  ok: boolean;
  terminalState: ProviderPortalTerminalState | null;
  violations: string[];
} {
  const violations: string[] = [];
  if (!(error instanceof VendorAutomationError)) {
    return {
      ok: false,
      terminalState: null,
      violations: ["failure_is_not_vendor_automation_error"],
    };
  }
  const terminalState = typeof error.payload.terminalState === "string"
    && FINITE_TERMINAL_STATES.has(error.payload.terminalState as ProviderPortalTerminalState)
    ? error.payload.terminalState as ProviderPortalTerminalState
    : null;
  if (!terminalState) {
    violations.push("finite_terminal_state_missing");
  }
  if (
    typeof error.payload.totalPriceUsd === "number"
    || typeof error.payload.unitPriceUsd === "number"
    || Array.isArray(error.payload.offers) && error.payload.offers.length > 0
  ) {
    violations.push("failure_contains_publishable_price");
  }
  const prohibitedAction = findProhibitedAction(error.payload);
  if (prohibitedAction) {
    violations.push(`purchasing_action_observed:${prohibitedAction}`);
  }
  return {
    ok: violations.length === 0,
    terminalState,
    violations,
  };
}

function artifactRefs(artifacts: readonly VendorArtifact[]): string[] {
  return artifacts.map((artifact) => path.basename(artifact.localPath));
}

function findProhibitedAction(
  value: unknown,
  pathSegments: readonly string[] = [],
  depth = 0,
): string | null {
  if (depth > 6 || value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return PROHIBITED_ACTION_PATTERN.test(value)
      ? [...pathSegments, "value"].join(".")
      : null;
  }
  if (Array.isArray(value)) {
    return findProhibitedArrayAction(value, pathSegments, depth);
  }
  if (typeof value !== "object") {
    return null;
  }
  return findProhibitedObjectAction(value as Record<string, unknown>, pathSegments, depth);
}

function findProhibitedArrayAction(
  value: readonly unknown[],
  pathSegments: readonly string[],
  depth: number,
): string | null {
  for (const [index, entry] of value.entries()) {
    const violation = findProhibitedAction(entry, [...pathSegments, String(index)], depth + 1);
    if (violation) {
      return violation;
    }
  }
  return null;
}

function findProhibitedObjectAction(
  value: Readonly<Record<string, unknown>>,
  pathSegments: readonly string[],
  depth: number,
): string | null {
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const keyViolation = prohibitedKeyViolation(key, entry, pathSegments);
    if (keyViolation) {
      return keyViolation;
    }
    const violation = findProhibitedAction(entry, [...pathSegments, key], depth + 1);
    if (violation) {
      return violation;
    }
  }
  return null;
}

function prohibitedKeyViolation(
  key: string,
  entry: unknown,
  pathSegments: readonly string[],
): string | null {
  if (Object.hasOwn(SAFE_PROHIBITION_VALUES, key)) {
    return entry === SAFE_PROHIBITION_VALUES[key]
      ? null
      : [...pathSegments, key].join(".");
  }
  return PROHIBITED_ACTION_PATTERN.test(key)
    ? [...pathSegments, key].join(".")
    : null;
}

function terminalStateForOutput(output: VendorQuoteAdapterOutput): ProviderAdapterContractResult["terminalState"] {
  if (
    output.status === "instant_quote_received"
    || output.status === "official_quote_received"
  ) {
    return "offers_extracted";
  }
  if (output.status === "manual_review_pending") {
    return "manual_review";
  }
  if (output.status === "manual_vendor_followup") {
    const declared = output.rawPayload.terminalState;
    if (typeof declared === "string" && [
      "configuration_required",
      "unsupported",
      "unavailable",
      "selector_drift",
    ].includes(declared)) {
      return declared as ProviderPortalTerminalState;
    }
    return "configuration_required";
  }
  return "unavailable";
}

function normalizeContractOffer(
  definition: ProviderAdapterContractDefinition,
  input: VendorQuoteAdapterInput,
  output: VendorQuoteAdapterOutput,
  offer: VendorQuoteAdapterOffer,
  refs: string[],
): ProviderPortalNormalizedOffer {
  return {
    providerOptionId: offer.providerOptionId,
    providerLabel: offer.providerLabel,
    quoteRef: offer.quoteRef,
    quoteUrl: offer.quoteUrl && isAllowedProviderUrl(offer.quoteUrl, definition.allowedHosts)
      ? offer.quoteUrl
      : null,
    quantity: offer.quantity ?? input.requestedQuantity,
    unitPriceUsd: offer.unitPriceUsd,
    totalPriceUsd: offer.totalPriceUsd,
    leadTimeBusinessDays: offer.leadTimeBusinessDays,
    shipReceiveBy: offer.shipReceiveBy,
    tier: offer.tier,
    sourcing: offer.sourcing,
    geographicOrigin: offer.geographicOrigin ?? "unknown",
    sortRank: offer.sortRank,
    provenance: { ...offer.provenance },
    validUntil: output.validUntil ?? null,
    validityDurationDays: output.validityDurationDays ?? null,
    validitySource: output.validitySource ?? null,
    validityTerms: output.validityTerms ?? null,
    artifactRefs: [...refs],
    rawPayload: {
      normalizationRevision: "provider-adapter-contract-offer.v1",
      sourcePayloadRetained: false,
    },
  };
}

/**
 * Applies the provider-neutral quote-only output contract. It does not admit a
 * provider or persist offers; callers use the returned violations as local
 * certification evidence.
 */
export function evaluateProviderAdapterContract(input: {
  definition: ProviderAdapterContractDefinition;
  adapterInput: VendorQuoteAdapterInput;
  output: VendorQuoteAdapterOutput;
}): ProviderAdapterContractResult {
  const { definition, adapterInput, output } = input;
  const violations: string[] = [];
  const refs = artifactRefs(output.artifacts);
  const seenIds = new Set<string>();
  const normalizedOffers = (output.offers ?? []).map((offer) =>
    normalizeContractOffer(definition, adapterInput, output, offer, refs));
  validateDefinitionAndOutput(definition, output, violations);
  validateNormalizedOffers(definition, adapterInput, output, normalizedOffers, seenIds, violations);
  const terminalState = terminalStateForOutput(output);
  validateTerminalOutput(terminalState, output, normalizedOffers, violations);

  return {
    revision: PROVIDER_ADAPTER_CONTRACT_REVISION,
    provider: definition.provider,
    terminalState,
    normalizedOffers,
    artifactRefs: refs,
    violations,
    ok: violations.length === 0,
  };
}

function validateDefinitionAndOutput(
  definition: ProviderAdapterContractDefinition,
  output: VendorQuoteAdapterOutput,
  violations: string[],
): void {
  if (output.vendor !== definition.provider) {
    violations.push("provider_identity_mismatch");
  }
  if (!hasMandatorySafetyRequirements(definition)) {
    violations.push("definition_safety_requirements_missing");
  }
  const prohibitedDefinitionAction = findProhibitedAction(definition.selectors);
  if (prohibitedDefinitionAction) {
    violations.push(`purchasing_action_reachable:${prohibitedDefinitionAction}`);
  }
  const prohibitedOutputAction = findProhibitedAction(output.rawPayload);
  if (prohibitedOutputAction) {
    violations.push(`purchasing_action_observed:${prohibitedOutputAction}`);
  }
  if (output.quoteUrl && !isAllowedProviderUrl(output.quoteUrl, definition.allowedHosts)) {
    violations.push("quote_url_outside_allowed_hosts");
  }
}

function hasMandatorySafetyRequirements(definition: ProviderAdapterContractDefinition): boolean {
  return definition.requirements.quoteOnly === true
    && definition.requirements.orderProhibited === true
    && definition.requirements.isolatedSession === true;
}

function validateNormalizedOffers(
  definition: ProviderAdapterContractDefinition,
  adapterInput: VendorQuoteAdapterInput,
  output: VendorQuoteAdapterOutput,
  offers: readonly ProviderPortalNormalizedOffer[],
  seenIds: Set<string>,
  violations: string[],
): void {
  for (const [offerIndex, offer] of offers.entries()) {
    validateNormalizedOffer({
      definition,
      adapterInput,
      sourceOffer: output.offers?.[offerIndex],
      offer,
      seenIds,
      violations,
    });
  }
}

function validateNormalizedOffer(input: {
  definition: ProviderAdapterContractDefinition;
  adapterInput: VendorQuoteAdapterInput;
  sourceOffer: VendorQuoteAdapterOffer | undefined;
  offer: ProviderPortalNormalizedOffer;
  seenIds: Set<string>;
  violations: string[];
}): void {
  const { definition, adapterInput, sourceOffer, offer, seenIds, violations } = input;
  if (sourceOffer?.quoteUrl && !isAllowedProviderUrl(sourceOffer.quoteUrl, definition.allowedHosts)) {
    violations.push("offer_quote_url_outside_allowed_hosts");
  }
  if (!offer.providerOptionId.trim() || seenIds.has(offer.providerOptionId)) {
    violations.push("provider_option_id_missing_or_duplicate");
  }
  seenIds.add(offer.providerOptionId);
  validateOfferValues(offer, adapterInput, violations);
  validateOfferProvenance(offer, violations);
}

function validateOfferValues(
  offer: ProviderPortalNormalizedOffer,
  adapterInput: VendorQuoteAdapterInput,
  violations: string[],
): void {
  if (offer.quantity !== adapterInput.requestedQuantity) {
    violations.push("offer_quantity_mismatch");
  }
  if (
    !Number.isFinite(offer.totalPriceUsd)
    || offer.totalPriceUsd <= 0
    || !Number.isFinite(offer.unitPriceUsd)
    || offer.unitPriceUsd <= 0
  ) {
    violations.push("offer_price_invalid");
  }
  if (offer.validUntil === null && offer.validityDurationDays === null && offer.validitySource !== null) {
    violations.push("offer_validity_source_without_value");
  }
}

function validateOfferProvenance(
  offer: ProviderPortalNormalizedOffer,
  violations: string[],
): void {
  if (offer.provenance.priceSource !== "selector") {
    violations.push("offer_price_unanchored");
  }
  if (offer.leadTimeBusinessDays !== null && offer.provenance.leadTimeSource !== "selector") {
    violations.push("offer_lead_time_unanchored");
  }
  if (!offer.provenance.containerSelector.trim()) {
    violations.push("offer_container_anchor_missing");
  }
  if (offer.geographicOrigin === "unknown" && offer.provenance.geographicOriginSource !== "none") {
    violations.push("unknown_geographic_origin_has_claimed_source");
  }
}

function validateTerminalOutput(
  terminalState: ProviderAdapterContractResult["terminalState"],
  output: VendorQuoteAdapterOutput,
  normalizedOffers: readonly ProviderPortalNormalizedOffer[],
  violations: string[],
): void {
  if (terminalState === "offers_extracted") {
    if (normalizedOffers.length === 0) {
      violations.push("priced_status_without_normalized_offer");
    }
    return;
  }
  if (
    output.totalPriceUsd !== null
    || output.unitPriceUsd !== null
    || normalizedOffers.length > 0
  ) {
    violations.push("terminal_failure_contains_publishable_price");
  }
}

/** Throws a compact failure suitable for shared adapter contract tests. */
export function assertProviderAdapterContract(
  input: Parameters<typeof evaluateProviderAdapterContract>[0],
): ProviderAdapterContractResult {
  const result = evaluateProviderAdapterContract(input);
  if (!result.ok) {
    throw new Error(`Provider adapter contract failed: ${result.violations.join(", ")}`);
  }
  return result;
}
