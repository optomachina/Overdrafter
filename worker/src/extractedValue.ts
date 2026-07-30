/**
 * Provenance contract for values read out of pages the system does not control.
 *
 * Vendor portals are an untrusted, drifting input surface, exactly like model
 * output. Both are handled the same way here: carry the value together with
 * where it came from, and let one policy decide what that provenance is
 * allowed to do. Nothing downstream should read a bare number without also
 * reading how it was obtained.
 */

/**
 * How a value was recovered from a vendor page.
 *
 * - `selector`  — read from a scoped locator the adapter declares for this vendor.
 * - `body_text` — recovered by scanning whole-page text *after every declared
 *   locator missed*. This is a defect signal, not a slower path to the same answer.
 * - `none`      — not found at all.
 */
export type ValueSource = "selector" | "body_text" | "none";

/** A value plus the provenance needed to decide whether it may be trusted. */
export type ExtractedValue<T> = {
  value: T | null;
  source: ValueSource;
  selector: string | null;
};

export type PriceGateReason = "anchored" | "unanchored_price" | "no_price";

export type PriceGate = {
  /** True only when the price is anchored well enough to reach a customer. */
  trusted: boolean;
  /** Price the parser saw but that is not trustworthy. Evidence only — never quote this. */
  unanchoredPriceUsd: number | null;
  /**
   * Every declared price locator missed. The adapter's contract with this
   * vendor's UI is broken and needs a human to re-anchor it.
   */
  locatorDriftDetected: boolean;
  reason: PriceGateReason;
};

/**
 * Decides whether a scraped price may be published as a vendor quote.
 *
 * An unanchored price means every locator the adapter declares for this vendor
 * missed, and the number was recovered by taking the first currency-looking
 * string anywhere in the page body. On a page whose structure has changed
 * enough to defeat every selector, that string is as likely to be a promotion,
 * a shipping threshold, or a struck-through list price as it is to be the
 * quote. The system fails closed: the observation is kept as evidence and the
 * lane routes to manual review, but no unanchored number reaches a customer.
 */
export function gateVendorPrice(price: ExtractedValue<number>): PriceGate {
  if (price.value === null) {
    return {
      trusted: false,
      unanchoredPriceUsd: null,
      locatorDriftDetected: false,
      reason: "no_price",
    };
  }

  if (price.source === "selector") {
    return {
      trusted: true,
      unanchoredPriceUsd: null,
      locatorDriftDetected: false,
      reason: "anchored",
    };
  }

  return {
    trusted: false,
    unanchoredPriceUsd: price.value,
    locatorDriftDetected: true,
    reason: "unanchored_price",
  };
}

/**
 * Lead time inherits the price's trust decision.
 *
 * Lead time is not money, but it is quoted to customers alongside the price and
 * is recovered by the same whole-page scan. Publishing an unanchored lead time
 * next to a withheld price would present a guess as the trustworthy half of the
 * quote.
 */
export function gateLeadTime(
  leadTime: ExtractedValue<number>,
  priceGate: PriceGate,
): number | null {
  if (leadTime.value === null) {
    return null;
  }

  if (leadTime.source !== "selector") {
    return null;
  }

  return priceGate.trusted ? leadTime.value : null;
}

/**
 * Provenance fields to merge into a vendor result's raw payload so internal
 * tooling can see, and alert on, a drifted adapter without any of it being
 * mistaken for quote data.
 */
export function priceGateEvidence(gate: PriceGate): Record<string, unknown> {
  return {
    priceTrusted: gate.trusted,
    priceGateReason: gate.reason,
    locatorDriftDetected: gate.locatorDriftDetected,
    unanchoredPriceObservedUsd: gate.unanchoredPriceUsd,
  };
}

/** Note surfaced on results whose price was withheld because the adapter drifted. */
export const UNANCHORED_PRICE_NOTE =
  "Price locators did not match the current vendor page, so no automated price was accepted. The lane needs manual review and the adapter needs re-anchoring.";
