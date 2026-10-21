import type { ProviderPortalOfferCandidate, ProviderPortalReadCapability } from "./providerPortalKernel.js";

/** Where one provider option card and its fields are read from. */
export type UsdOfferCardLocators = {
  revision: string;
  card: string;
  optionIdAttribute: string;
  /** Each selector is resolved inside the indexed card. */
  fields: {
    label: string;
    quantity: string;
    unitPrice: string;
    totalPrice: string;
    currency: string;
    leadBusinessDays: string;
  };
  /** `display` additionally accepts a leading `$` and thousands separators. */
  priceFormat: "plain" | "display";
  /**
   * Joins the indexed card and a field selector. A real browser needs `>>`
   * after `nth=`; the synthetic form is kept only for its pinned reader tests.
   */
  fieldJoin: " " | " >> ";
};

const OPTION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

function positiveNumber(text: string | null): number | null {
  if (!text || !/^\d+(?:\.\d{1,2})?$/.test(text.trim())) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function positivePrice(text: string | null, format: UsdOfferCardLocators["priceFormat"]): number | null {
  if (format === "plain" || !text) return positiveNumber(text);
  const match = /^\$?\s?(\d{1,3}(?:,\d{3})*|\d+)(\.\d{1,2})?$/.exec(text.trim());
  return match ? positiveNumber(`${match[1].replaceAll(",", "")}${match[2] ?? ""}`) : null;
}

/** Unit and total must be safe-integer cents and agree within one cent for the quantity. */
function pricesAgree(unit: number, total: number, quantity: number): boolean {
  const unitCents = Math.round(unit * 100);
  const totalCents = Math.round(total * 100);
  const expectedTotalCents = unitCents * quantity;
  return Number.isSafeInteger(unitCents)
    && Number.isSafeInteger(totalCents)
    && Number.isSafeInteger(expectedTotalCents)
    && Math.abs(expectedTotalCents - totalCents) <= 1;
}

function leadBusinessDays(leadText: string): number | null {
  // Check integer syntax before conversion can round a fractional large value.
  const lead = /^\d+(?:\.0{1,2})?$/.test(leadText) ? positiveNumber(leadText) : null;
  return lead !== null && Number.isSafeInteger(lead) ? lead : null;
}

/**
 * Reads and validates one indexed option card. Returns null when the card is
 * malformed, repeats an id already in `ids`, or disagrees with the request.
 */
async function readUsdOfferCard(
  reader: ProviderPortalReadCapability,
  expectedQuantity: number,
  locators: UsdOfferCardLocators,
  rawPayload: Record<string, unknown>,
  index: number,
  ids: Set<string>,
): Promise<ProviderPortalOfferCandidate | null> {
  const container = `${locators.card} >> nth=${index}`;
  const field = (name: keyof UsdOfferCardLocators["fields"]) =>
    `${container}${locators.fieldJoin}${locators.fields[name]}`;
  const read = (name: keyof UsdOfferCardLocators["fields"]) => reader.readText(field(name));
  const id = await reader.readAttribute(container, locators.optionIdAttribute);
  const label = (await read("label"))?.trim();
  const quantity = positiveNumber(await read("quantity"));
  const unit = positivePrice(await read("unitPrice"), locators.priceFormat);
  const total = positivePrice(await read("totalPrice"), locators.priceFormat);
  const currency = (await read("currency"))?.trim();
  if (!id || !OPTION_ID_PATTERN.test(id) || ids.has(id)) return null;
  ids.add(id);
  if (!label || quantity !== expectedQuantity || !Number.isSafeInteger(quantity)
    || unit === null || total === null || currency !== "USD") return null;
  if (!pricesAgree(unit, total, quantity)) return null;
  const leadTimeBusinessDays = leadBusinessDays((await read("leadBusinessDays"))?.trim() ?? "");
  return {
    providerOptionId: id, providerLabel: label, quoteRef: null, quoteUrl: null, quantity,
    unitPriceUsd: { value: unit, source: "selector", selector: field("unitPrice") },
    totalPriceUsd: { value: total, source: "selector", selector: field("totalPrice") },
    leadTimeBusinessDays: {
      value: leadTimeBusinessDays,
      source: leadTimeBusinessDays === null ? "none" : "selector",
      selector: leadTimeBusinessDays === null ? null : field("leadBusinessDays"),
    },
    containerSelector: container, providerOptionIdSource: "attribute",
    shipReceiveBy: null, tier: null, sourcing: null,
    geographicOrigin: null, geographicOriginSource: "none",
    validUntil: null, validityDurationDays: null, validitySource: null, validityTerms: null,
    rawPayload: { ...rawPayload, locatorRevision: locators.revision },
  };
}

/**
 * Reads anchored USD option cards. Rejects options whose unit/total cents or
 * quantity product are not safe integers; accepted prices must agree within
 * one cent and match the requested quantity, and the card must anchor `USD`.
 * Any malformed option withholds the entire batch to avoid incomplete
 * comparisons.
 */
export async function extractUsdOfferCards(
  reader: ProviderPortalReadCapability,
  expectedQuantity: number,
  locators: UsdOfferCardLocators,
  rawPayload: Record<string, unknown>,
): Promise<ProviderPortalOfferCandidate[]> {
  const count = await reader.count(locators.card);
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) return [];
  const offers: ProviderPortalOfferCandidate[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const offer = await readUsdOfferCard(reader, expectedQuantity, locators, rawPayload, index, ids);
    if (!offer) return [];
    offers.push(offer);
  }
  return offers;
}
