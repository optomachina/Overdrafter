import type { VendorQuoteAdapterOffer, VendorQuoteAdapterOutput } from "../types.js";
import type { SupplierPauseSwitch } from "./pause.js";
import { checkQuote, type SanityInput, type SanityOffer, type SanityVerdict } from "./sanity.js";
import type { SanityHistoryReader } from "./sanityHistory.js";

/**
 * OVD-813: the sanity gate both live persist paths call before the result is
 * written: the generic pipeline (`deps.sanity`, between validate and persist)
 * and the Xometry path in `handleVendorQuoteTask` (before
 * `finalizeVendorQuoteResult` and before routing scores).
 *
 * A held result is persisted as `manual_review_pending` with no prices and no
 * offers, so nothing reaches `vendor_quote_offers` (the publishable table) and
 * the customer sees a pending quote, never the number. The offers are kept in
 * `raw_payload.fixtureSanity.withheldOffers` (`vendor_quote_results` is
 * internal-only under RLS) for admin review and certification.
 *
 * Internal test quotes (see `isInternalTestQuote`) are always held this way
 * too and carry `raw_payload.fixtureHeal.internal = true`. Withholding their
 * offers is the worker-side guarantee that a test quote cannot be published or
 * selected; the SQL guards on `api_publish_quote_package` and
 * `api_select_quote_option` are the fixture-heal-a draft (OVD-796 S4).
 */

export const FIXTURE_SANITY_HOLD_NOTE = "Price pending verification";
const PRICED_STATUSES: ReadonlySet<string> = new Set(["instant_quote_received", "official_quote_received"]);

export type FixtureSanityContext = {
  provider: string;
  vendorQuoteResultId: string;
  quoteRunId: string;
  requestedQuantity: number;
  requirement: { material: string | null; spec_snapshot?: unknown } | null;
  /** sha256 package identity of the disclosed files, or null when none could be derived. */
  packageId: string | null;
  internalTestQuote: boolean;
};

export type FixtureSanityGateResult = {
  output: VendorQuoteAdapterOutput;
  held: boolean;
  verdict: SanityVerdict;
  /** True when this check paused the supplier. */
  paused: boolean;
};

export type FixtureSanityGate = (
  output: VendorQuoteAdapterOutput,
  context: FixtureSanityContext,
) => Promise<FixtureSanityGateResult>;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const finiteNumber = (value: unknown): number | null => {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
};

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/** Requested sheet thickness in inches, when the approved spec states one. */
function requestedThicknessIn(spec: unknown): number | null {
  const fields = record(spec);
  if (!fields) return null;
  return finiteNumber(fields.thicknessIn) ?? finiteNumber(fields.thickness_in) ?? finiteNumber(fields.thicknessInch);
}

/**
 * What the supplier echoed back. Adapters report it as
 * `rawPayload.supplierEcho = { material, thicknessIn, quantity }`; Xometry's
 * saved-requirement readback (OVD-777) is `rawPayload.selectedMaterial`.
 */
function supplierEcho(rawPayload: Record<string, unknown>): SanityInput["echo"] {
  const echo = record(rawPayload.supplierEcho) ?? {};
  return {
    material: text(echo.material) ?? text(rawPayload.selectedMaterial),
    thicknessIn: finiteNumber(echo.thicknessIn),
    quantity: finiteNumber(echo.quantity),
  };
}

function sanityOffers(output: VendorQuoteAdapterOutput, requestedQuantity: number): SanityOffer[] {
  if (Array.isArray(output.offers) && output.offers.length > 0) {
    return output.offers.map((offer: VendorQuoteAdapterOffer) => {
      // Kept raw: a blank cell is a missing price, so it must not be trimmed away.
      const priceText = record(offer.rawPayload)?.priceText;
      return {
        unitPriceUsd: offer.unitPriceUsd,
        totalPriceUsd: offer.totalPriceUsd,
        quantity: offer.quantity ?? null,
        priceText: typeof priceText === "string" ? priceText : null,
      };
    });
  }
  if (output.unitPriceUsd === null && output.totalPriceUsd === null) return [];
  return [{ unitPriceUsd: output.unitPriceUsd, totalPriceUsd: output.totalPriceUsd, quantity: requestedQuantity }];
}

/**
 * A result is checked when it has a priced status or carries any price at all:
 * a `manual_review_pending` result with a price still becomes an offer row
 * (`normalizedAdapterOffers`), so it must not skip the gate.
 */
function carriesPrice(output: VendorQuoteAdapterOutput): boolean {
  return (
    PRICED_STATUSES.has(output.status) ||
    finiteNumber(output.unitPriceUsd) !== null ||
    finiteNumber(output.totalPriceUsd) !== null ||
    (Array.isArray(output.offers) && output.offers.length > 0)
  );
}

export function sanityInputFromOutput(output: VendorQuoteAdapterOutput, context: FixtureSanityContext): SanityInput {
  const rawPayload = record(output.rawPayload) ?? {};
  return {
    provider: context.provider,
    requestedQuantity: context.requestedQuantity,
    priced: carriesPrice(output),
    offers: sanityOffers(output, context.requestedQuantity),
    requested: {
      material: text(context.requirement?.material),
      thicknessIn: requestedThicknessIn(context.requirement?.spec_snapshot),
    },
    echo: supplierEcho(rawPayload),
  };
}

/** The result as persisted: unchanged plus the verdict on a pass; prices and offers withheld on a hold. */
export function applySanityVerdict(
  output: VendorQuoteAdapterOutput,
  verdict: SanityVerdict,
  context: FixtureSanityContext,
  checkedAt: string,
): { output: VendorQuoteAdapterOutput; held: boolean } {
  const held = verdict.verdict === "hold" || context.internalTestQuote;
  const fixtureSanity = {
    ...verdict,
    packageId: context.packageId,
    checkedAt,
    held,
    holdReason: verdict.verdict === "hold" ? "sanity" : context.internalTestQuote ? "internal_test_quote" : null,
  };
  const fixtureHeal = context.internalTestQuote ? { fixtureHeal: { v: 1, internal: true } } : {};
  if (!held) {
    return { output: { ...output, rawPayload: { ...output.rawPayload, fixtureSanity, ...fixtureHeal } }, held };
  }
  const { offers: _rawOffers, ...rawPayload } = output.rawPayload ?? {};
  return {
    held,
    output: {
      ...output,
      status: "manual_review_pending",
      unitPriceUsd: null,
      totalPriceUsd: null,
      offers: [],
      notes: [...(output.notes ?? []), FIXTURE_SANITY_HOLD_NOTE],
      rawPayload: {
        ...rawPayload,
        ...fixtureHeal,
        fixtureSanity: {
          ...fixtureSanity,
          withheldStatus: output.status,
          withheldResult: { unitPriceUsd: output.unitPriceUsd, totalPriceUsd: output.totalPriceUsd },
          withheldOffers: output.offers ?? [],
        },
      },
    },
  };
}

export function createFixtureSanityGate(deps: {
  history: SanityHistoryReader;
  pause: SupplierPauseSwitch;
  now?: () => number;
}): FixtureSanityGate {
  const now = deps.now ?? (() => Date.now());
  return async (output, context) => {
    const input = sanityInputFromOutput(output, context);
    const nowMs = now();
    const history = input.priced
      ? await deps
          .history({
            provider: context.provider,
            packageId: context.packageId,
            requestedQuantity: context.requestedQuantity,
            excludeResultId: context.vendorQuoteResultId,
            nowMs,
          })
          .catch(() => ({ available: false as const, reason: "history_read_failed" }))
      : { available: true as const, history: [], peers: [] };
    const verdict = checkQuote(input, history);
    if (verdict.pause) {
      deps.pause.pause({
        provider: context.provider,
        codes: verdict.findings.filter((entry) => entry.class === "hard" || entry.class === "outlier").map((entry) => entry.code),
        runId: context.quoteRunId,
        vendorQuoteResultId: context.vendorQuoteResultId,
        nowMs,
      });
    }
    const applied = applySanityVerdict(output, verdict, context, new Date(nowMs).toISOString());
    return { ...applied, verdict, paused: verdict.pause };
  };
}
