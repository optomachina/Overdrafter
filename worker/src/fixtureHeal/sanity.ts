/**
 * OVD-813 (OVD-796 slice 1): the sanity check every live quote passes before
 * it can be shown. Pure: no I/O, no clock. `checkQuote` sees the normalized
 * result, what the supplier echoed back, and the price history the caller
 * read (`sanityHistory.ts`), and returns a verdict. The gate (`gate.ts`)
 * decides what to persist and whether to pause the supplier (`pause.ts`).
 *
 * The rule list is closed and every rule fails closed. Codes and bands follow
 * §3.2 of the fixture self-healing design; the Release sign-off on OVD-796
 * replaced "pause on the second outlier" with "pause on the first".
 */

export const FIXTURE_SANITY_VERSION = 1;

export type SanityCodeClass = "hard" | "outlier" | "unavailable" | "info";

export const SANITY_CODES = {
  price_missing: "hard",
  price_zero: "hard",
  price_floor: "hard",
  arithmetic: "hard",
  qty_echo: "hard",
  material_echo: "hard",
  thickness_echo: "hard",
  history_outlier: "outlier",
  peer_outlier: "outlier",
  /** The history read failed, so outliers cannot be ruled out: hold, but this is not supplier drift. */
  history_unavailable: "unavailable",
  /** The adapter reported no echo for a priced field. Recorded only in slice 1 (slice 3 makes it hard per pack). */
  echo_unavailable: "info",
} as const satisfies Record<string, SanityCodeClass>;

export type SanityCode = keyof typeof SANITY_CODES;

/** Unit price below this is never a real sheet or CNC quote (T1 evidence floor was $8.22/unit). */
export const SANITY_PRICE_FLOOR_USD = 1;
/** Accepted band around the median of this supplier's own accepted quotes (ESTIMATED; retune after 30 days). */
export const HISTORY_BAND = { low: 0.67, high: 1.5 } as const;
/** Accepted band around the median of other suppliers' cheapest offers (T1 measured ratios 0.39 to 1.90). */
export const PEER_BAND = { low: 0.25, high: 4 } as const;
export const PEER_MIN_SUPPLIERS = 2;
export const THICKNESS_TOLERANCE_IN = 0.001;

/** A dash or blank price cell, as OSHCut shows before material and thickness are set. */
const DASH_PRICE_TEXT = /^\s*[-–—]?\s*$/;

export type SanityOffer = {
  unitPriceUsd: number | null | undefined;
  totalPriceUsd: number | null | undefined;
  quantity?: number | null;
  /** The raw price text the page showed, when the adapter kept it. */
  priceText?: string | null;
};

export type SanityInput = {
  provider: string;
  requestedQuantity: number;
  /** Only priced results are checked: a priced status, or any price or offer whatever the status. */
  priced: boolean;
  /** Every purchasable offer; a summary-only result is passed as one offer. */
  offers: readonly SanityOffer[];
  requested: { material: string | null; thicknessIn: number | null };
  /** What the supplier page echoed back after configuration; null when the adapter reports no echo. */
  echo: { material: string | null; thicknessIn: number | null; quantity: number | null };
};

export type PriceHistory =
  | {
      available: true;
      /** Unit prices of this supplier's accepted quotes for the same package and quantity (90 days). */
      history: readonly number[];
      /** Cheapest unit price per other supplier for the same package and quantity (30 days). */
      peers: readonly number[];
    }
  | { available: false; reason: string };

export type SanityFinding = { code: SanityCode; class: SanityCodeClass; detail?: string };

export type SanityVerdict = {
  v: typeof FIXTURE_SANITY_VERSION;
  verdict: "pass" | "hold" | "skip";
  findings: SanityFinding[];
  /** Cheapest-offer unit price over the history or peer median; kept so the bands can be retuned. */
  ratios: { history: number | null; peer: number | null };
  /** True when a finding is supplier drift (hard or outlier): the supplier must be paused. */
  pause: boolean;
};

function finding(code: SanityCode, detail?: string): SanityFinding {
  return detail ? { code, class: SANITY_CODES[code], detail } : { code, class: SANITY_CODES[code] };
}

const isPrice = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function median(values: readonly number[]): number | null {
  const sorted = values.filter((value) => isPrice(value) && value > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Lowercase alphanumerics only, so "6061-T6", "6061 t6" and "6061T6" compare equal. */
export function normalizeMaterial(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Alloy or grade designators (three or more digits): 6061, 5052, 304, 174 for
 * 17-4. Temper suffixes right after the alloy digits (T651, T7351, H32) are
 * dropped first, so a temper is never read as an alloy number.
 */
function alloyTokens(normalized: string): Set<string> {
  return new Set(normalized.replace(/(?<=\d)[th]\d+/g, "").match(/\d{3,}/g) ?? []);
}

/**
 * True when the echoed material is not the requested one. One label
 * containing the other is a match ("6061-T6" in "Aluminum 6061-T6"). Without
 * containment, the requested alloy designators must all appear in the echo;
 * when either side has none, the labels are not comparable and nothing is
 * claimed (the echo stays recorded on the verdict input).
 */
export function materialEchoMismatch(requested: string, echoed: string): boolean {
  const want = normalizeMaterial(requested);
  const got = normalizeMaterial(echoed);
  if (!want || !got) return false;
  if (want.includes(got) || got.includes(want)) return false;
  const wantTokens = alloyTokens(want);
  const gotTokens = alloyTokens(got);
  if (wantTokens.size === 0 || gotTokens.size === 0) return false;
  return [...wantTokens].some((token) => !gotTokens.has(token));
}

function priceFindings(input: SanityInput): SanityFinding[] {
  const findings: SanityFinding[] = [];
  if (input.offers.length === 0) return [finding("price_missing", "no_offer")];
  for (const offer of input.offers) {
    const dash = typeof offer.priceText === "string" && DASH_PRICE_TEXT.test(offer.priceText);
    if (dash || !isPrice(offer.unitPriceUsd) || !isPrice(offer.totalPriceUsd)) {
      findings.push(finding("price_missing", dash ? "dash_price_text" : "non_finite_price"));
      continue;
    }
    const unit = offer.unitPriceUsd;
    const total = offer.totalPriceUsd;
    if (unit <= 0 || total <= 0) {
      findings.push(finding("price_zero"));
      continue;
    }
    if (unit < SANITY_PRICE_FLOOR_USD) findings.push(finding("price_floor"));
    const quantity = offer.quantity ?? input.requestedQuantity;
    if (quantity !== input.requestedQuantity) findings.push(finding("qty_echo", "offer_quantity"));
    const tolerance = Math.max(0.01 * quantity, 0.005 * total);
    if (Math.abs(total - unit * quantity) > tolerance) findings.push(finding("arithmetic"));
  }
  return findings;
}

function echoFindings(input: SanityInput): SanityFinding[] {
  const findings: SanityFinding[] = [];
  const { requested, echo } = input;
  if (echo.quantity !== null && echo.quantity !== input.requestedQuantity) {
    findings.push(finding("qty_echo", "echoed_quantity"));
  }
  if (requested.material) {
    if (echo.material === null) findings.push(finding("echo_unavailable", "material"));
    else if (materialEchoMismatch(requested.material, echo.material)) findings.push(finding("material_echo"));
  }
  if (requested.thicknessIn !== null) {
    if (echo.thicknessIn === null) findings.push(finding("echo_unavailable", "thickness"));
    else if (Math.abs(echo.thicknessIn - requested.thicknessIn) > THICKNESS_TOLERANCE_IN) {
      findings.push(finding("thickness_echo"));
    }
  }
  return findings;
}

function cheapestUnitPrice(offers: readonly SanityOffer[]): number | null {
  const units = offers.map((offer) => offer.unitPriceUsd).filter((unit): unit is number => isPrice(unit) && unit > 0);
  return units.length > 0 ? Math.min(...units) : null;
}

function ratio(value: number, base: number | null): number | null {
  return base === null ? null : Math.round((value / base) * 10_000) / 10_000;
}

/** Runs every rule; the verdict holds on any hard, outlier or unavailable finding. */
export function checkQuote(input: SanityInput, history: PriceHistory): SanityVerdict {
  const ratios: SanityVerdict["ratios"] = { history: null, peer: null };
  if (!input.priced) return { v: FIXTURE_SANITY_VERSION, verdict: "skip", findings: [], ratios, pause: false };

  const findings = [...priceFindings(input), ...echoFindings(input)];
  const cheapest = cheapestUnitPrice(input.offers);
  if (!history.available) {
    findings.push(finding("history_unavailable", history.reason));
  } else if (cheapest !== null) {
    ratios.history = ratio(cheapest, median(history.history));
    ratios.peer = history.peers.length >= PEER_MIN_SUPPLIERS ? ratio(cheapest, median(history.peers)) : null;
    if (ratios.history !== null && (ratios.history < HISTORY_BAND.low || ratios.history > HISTORY_BAND.high)) {
      findings.push(finding("history_outlier"));
    }
    if (ratios.peer !== null && (ratios.peer < PEER_BAND.low || ratios.peer > PEER_BAND.high)) {
      findings.push(finding("peer_outlier"));
    }
  }

  const holds = findings.some((entry) => entry.class !== "info");
  const pause = findings.some((entry) => entry.class === "hard" || entry.class === "outlier");
  return { v: FIXTURE_SANITY_VERSION, verdict: holds ? "hold" : "pass", findings, ratios, pause };
}
