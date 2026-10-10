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

/** Validate fractional digits before Number can round them to an integer. */
function positiveInteger(value: string | null): number | null {
  if (value === null || !/^[1-9]\d*(?:\.0+)?$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Accept cent-accurate USD, including harmless trailing decimal zeros. */
function positiveUsdCents(value: string | null): number | null {
  if (value === null || !/^(?:0|[1-9]\d*)(?:\.\d{1,2}0*)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(`${whole}${fraction.slice(0, 2).padEnd(2, "0")}`);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
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
    const quantity = positiveInteger(quantityText);
    const totalCents = positiveUsdCents(totalText);
    const unitCents = positiveUsdCents(unitText);
    const lead = positiveInteger(leadText);
    if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ids.has(id)
      || !label || !/^[a-zA-Z0-9 _-]{1,64}$/.test(label)
      || currency !== "USD" || quantity !== expectedQuantity || !Number.isSafeInteger(quantity)
      || totalCents === null || unitCents === null || lead === null || !Number.isSafeInteger(lead)) {
      return []; // Ambiguous packages never produce partial offers.
    }
    const expectedTotalCents = unitCents * quantity;
    if (!Number.isSafeInteger(expectedTotalCents) || Math.abs(totalCents - expectedTotalCents) > 1) {
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
      unitPriceUsd: { value: unitCents / 100, source: "selector", selector: `${container}[data-unit]` },
      totalPriceUsd: { value: totalCents / 100, source: "selector", selector: `${container}[data-total]` },
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
