import { PROVIDER_CATALOG } from "../generated/provider-catalog.js";
import {
  classifyProviderPortalSnapshot,
  isAllowedProviderUrl,
  type ProviderPortalDefinition,
  type ProviderPortalOfferCandidate,
  type ProviderPortalReadCapability,
} from "./providerPortalKernel.js";
import { QUICKPARTS_ENVELOPE_REVISION } from "./quickpartsEnvelope.js";

export const QUICKPARTS_ADAPTER_REVISION = "quickparts-offline-adapter.v1";
const HOSTS = ["quickparts.com", "quickquote.quickparts.com"] as const;
const CARD = "[data-ovd-synthetic-quickparts-option]";

function positiveNumber(text: string | null): number | null {
  if (!text || !/^\d+(?:\.\d{1,2})?$/.test(text.trim())) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Exercises proposed option anchors against synthetic readers, never a live portal. */
export async function extractQuickpartsSyntheticOffers(
  reader: ProviderPortalReadCapability,
  expectedQuantity: number,
): Promise<ProviderPortalOfferCandidate[]> {
  const count = await reader.count(CARD);
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) return [];
  const offers: ProviderPortalOfferCandidate[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const container = `${CARD} >> nth=${index}`;
    const read = (field: string) => reader.readText(`${container} [data-${field}]`);
    const id = await reader.readAttribute(container, "data-option-id");
    const label = (await read("label"))?.trim();
    const quantity = positiveNumber(await read("quantity"));
    const unit = positiveNumber(await read("unit-price"));
    const total = positiveNumber(await read("total-price"));
    const currency = await read("currency");
    if (!id || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ids.has(id)) return [];
    ids.add(id);
    if (!label || quantity !== expectedQuantity || !Number.isSafeInteger(quantity)
      || unit === null || total === null || currency !== "USD") continue;
    if (Math.abs(Math.round(unit * quantity * 100) - Math.round(total * 100)) > 1) continue;
    const lead = positiveNumber(await read("lead-business-days"));
    offers.push({
      providerOptionId: id, providerLabel: label, quoteRef: null, quoteUrl: null, quantity,
      unitPriceUsd: { value: unit, source: "selector", selector: `${container} [data-unit-price]` },
      totalPriceUsd: { value: total, source: "selector", selector: `${container} [data-total-price]` },
      leadTimeBusinessDays: {
        value: lead !== null && Number.isSafeInteger(lead) ? lead : null,
        source: "selector", selector: `${container} [data-lead-business-days]`,
      },
      containerSelector: container, providerOptionIdSource: "attribute",
      shipReceiveBy: null, tier: null, sourcing: null,
      geographicOrigin: null, geographicOriginSource: "none",
      validUntil: null, validityDurationDays: null, validitySource: null, validityTerms: null,
      rawPayload: { fixtureKind: "synthetic", adapterRevision: QUICKPARTS_ADAPTER_REVISION },
    });
  }
  return offers;
}

/**
 * Local evaluation definition unavailable before session access. Real portal
 * anchors/configuration need separate review; no flag enables synthetic hooks.
 */
export function buildQuickpartsOfflinePortalDefinition(): ProviderPortalDefinition {
  return {
    provider: "quickparts", displayName: "Quickparts", manifestRevision: "provider-manifest.v1",
    envelopeRevision: QUICKPARTS_ENVELOPE_REVISION, adapterRevision: QUICKPARTS_ADAPTER_REVISION,
    accountMode: "existing_authenticated_account",
    routes: {
      publicUrl: "https://quickparts.com/",
      loginUrl: "https://quickquote.quickparts.com/#/login",
      uploadUrl: "https://quickquote.quickparts.com/",
    },
    allowedHosts: HOSTS,
    selectors: { cadUpload: "input[data-ovd-synthetic-quickparts-upload]" },
    supportedFileExtensions: PROVIDER_CATALOG.quickparts.capabilityEnvelope.files.values,
    terminalSignals: {
      login: [/login|sign[ -]?in/i], captcha: [/captcha|verify you are human/i],
      manualReview: [/manual review|engineering review|quote request received/i],
      configurationRequired: [/select material|configure your part/i],
      unavailable: [/service unavailable|maintenance/i],
    },
    requirements: { quoteOnly: true, orderProhibited: true, isolatedSession: true },
    hooks: {
      assessEligibility: () => ({ state: "unavailable", reason: "quickparts_reviewed_portal_evidence_missing" }),
      configure: () => undefined,
      classifyPortalState: (snapshot) => {
        if (!isAllowedProviderUrl(snapshot.url, HOSTS)) return "unexpected_origin";
        const state = classifyProviderPortalSnapshot(snapshot);
        return state === "ready" ? "selector_drift" : state;
      },
      // Synthetic extraction is deliberately unreachable from an actual session.
      extractOffers: () => [],
    },
  };
}
