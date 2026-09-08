import type { VendorQuoteAdapterInput, WorkerConfig } from "../types.js";
import { GEOMIQ_ENVELOPE_REVISION } from "./geomiqEnvelope.js";
import {
  classifyProviderPortalSnapshot,
  isAllowedProviderUrl,
  runProviderPortalKernel,
  type ProviderPortalDefinition,
  type ProviderPortalKernelResult,
  type ProviderPortalOfferCandidate,
  type ProviderPortalReadCapability,
  type ProviderPortalSnapshot,
  type ProviderPortalState,
} from "./providerPortalKernel.js";

export const GEOMIQ_ADAPTER_REVISION = "geomiq-offline-portal.v2" as const;

/** Classifies scrubbed states conservatively; an unknown page is selector drift. */
export function classifyGeomiqPortalState(snapshot: ProviderPortalSnapshot): ProviderPortalState {
  if (!isAllowedProviderUrl(snapshot.url, ["app.geomiq.com"])) {
    return "unexpected_origin";
  }
  const state = classifyProviderPortalSnapshot(snapshot);
  if (state === "captcha") {
    return state;
  }
  if (/\b(?:session expired|please sign in again|authentication required)\b/i.test(snapshot.bodyText)) {
    return "login_required";
  }
  if (state !== "ready") {
    return state;
  }
  if (/\b(?:unsupported material|unsupported file|cannot manufacture)\b/i.test(snapshot.bodyText)) {
    return "unsupported";
  }
  return "selector_drift";
}

/**
 * Offline definition only. Public app URL is evidenced, authenticated routes and
 * selectors are not. No flag or configuration can enable this definition.
 */
export function buildGeomiqPortalDefinition(): ProviderPortalDefinition {
  return {
    provider: "geomiq",
    displayName: "Geomiq",
    manifestRevision: "provider-manifest.v1",
    envelopeRevision: GEOMIQ_ENVELOPE_REVISION,
    adapterRevision: GEOMIQ_ADAPTER_REVISION,
    accountMode: "existing_authenticated_account",
    routes: {
      publicUrl: "https://app.geomiq.com/",
      loginUrl: "https://app.geomiq.com/",
      uploadUrl: "https://app.geomiq.com/",
    },
    allowedHosts: ["app.geomiq.com"],
    // Deliberately matches nothing. This is not an observed provider selector.
    selectors: { cadUpload: ":not(*)" },
    supportedFileExtensions: ["step", "stp"],
    terminalSignals: {
      login: [/login|sign[ -]?in/i],
      captcha: [/captcha|verify you are human|security check/i],
      manualReview: [/manual review|engineering review|quote request received/i],
      configurationRequired: [/select material|configure your part/i],
      unavailable: [/temporarily unavailable|service unavailable|maintenance/i],
    },
    requirements: { quoteOnly: true, orderProhibited: true, isolatedSession: true },
    hooks: {
      assessEligibility: () => ({
        state: "unavailable",
        reason: "geomiq_geometry_and_portal_evidence_unreviewed",
      }),
      configure: () => undefined,
      classifyPortalState: classifyGeomiqPortalState,
      // Fixture-only anchors below must never be used against the live portal.
      extractOffers: () => [],
    },
  };
}

/** Local kernel entry point; exact-file checks precede the unconditional evidence stop. */
export function runGeomiqLocalEvaluation(
  config: WorkerConfig,
  input: VendorQuoteAdapterInput,
): Promise<ProviderPortalKernelResult> {
  return runProviderPortalKernel(buildGeomiqPortalDefinition(), config, input);
}

const FIXTURE_CONTAINER = "[data-synthetic-geomiq-option]";

function positiveNumber(value: string | null): number | null {
  if (value === null || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Exercises anchored offer parsing against synthetic local fixtures only.
 * These reserved anchors are NOT observed Geomiq selectors. This helper is
 * intentionally disconnected from the portal definition and runtime routing.
 */
export async function extractGeomiqSyntheticOffers(
  reader: ProviderPortalReadCapability,
  expectedQuantity: number,
): Promise<ProviderPortalOfferCandidate[]> {
  const count = await reader.count(FIXTURE_CONTAINER);
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) {
    return [];
  }
  const offers: ProviderPortalOfferCandidate[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const container = `${FIXTURE_CONTAINER}:nth-of-type(${index + 1})`;
    const read = (field: string) => reader.readAttribute(container, `data-${field}`);
    const [id, label, currency, quantityText, totalText, unitText, leadText] = await Promise.all([
      read("option-id"), read("label"), read("currency"), read("quantity"), read("total"), read("unit"), read("lead-days"),
    ]);
    const quantity = positiveNumber(quantityText);
    const total = positiveNumber(totalText);
    const unit = positiveNumber(unitText);
    const lead = positiveNumber(leadText);
    if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ids.has(id)
      || !label || !/^[a-zA-Z0-9 _-]{1,64}$/.test(label)
      || currency !== "USD" || quantity !== expectedQuantity || !Number.isSafeInteger(quantity)
      || total === null || unit === null || lead === null || !Number.isSafeInteger(lead)
      || Math.abs(total - unit * quantity) > 0.011) {
      return []; // Ambiguous packages never produce partial offers.
    }
    ids.add(id);
    offers.push({
      providerOptionId: id,
      providerOptionIdSource: "attribute",
      providerLabel: label,
      quoteRef: null,
      quoteUrl: null,
      quantity,
      unitPriceUsd: { value: unit, source: "selector", selector: `${container}[data-unit]` },
      totalPriceUsd: { value: total, source: "selector", selector: `${container}[data-total]` },
      leadTimeBusinessDays: { value: lead, source: "selector", selector: `${container}[data-lead-days]` },
      shipReceiveBy: null,
      tier: null,
      sourcing: null,
      geographicOrigin: null,
      geographicOriginSource: "none",
      containerSelector: container,
      validUntil: null,
      validityDurationDays: null,
      validitySource: null,
      validityTerms: null,
      rawPayload: { syntheticFixture: true, providerObserved: false },
    });
  }
  return offers;
}
