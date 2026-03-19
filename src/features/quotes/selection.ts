import { addBusinessDays, format, isValid, parse, parseISO, startOfDay } from "date-fns";
import type { VendorName, Json } from "@/integrations/supabase/types";
import type { VendorQuoteAggregate } from "@/features/quotes/types";
import { formatVendorName, getImportedVendorOffers } from "@/features/quotes/utils";

export type QuotePreset = "cheapest" | "fastest" | "domestic";

export type DomesticStatus = "domestic" | "foreign" | "unknown";

export type ClientQuoteSelectionOption = {
  key: string;
  offerId: string;
  persistedOfferId: string | null;
  vendorKey: VendorName;
  vendorQuoteResultId: string;
  vendorLabel: string;
  supplier: string;
  requestedQuantity: number;
  unitPriceUsd: number;
  totalPriceUsd: number;
  leadTimeBusinessDays: number | null;
  resolvedDeliveryDate: string | null;
  domesticStatus: DomesticStatus;
  excluded: boolean;
  dueDateEligible: boolean;
  eligible: boolean;
  isSelectable: boolean;
  expedite: boolean;
  shipReceiveBy: string | null;
  dueDate: string | null;
  quoteDateIso: string | null;
  sourcing: string | null;
  tier: string | null;
  laneLabel: string | null;
  process: string | null;
  material: string | null;
  finish: string | null;
  tightestTolerance: string | null;
  notes: string | null;
  rawPayload: Json | null;
};

export type BulkSelectionChange = {
  jobId: string;
  previousOfferId: string | null;
  appliedOfferId: string;
};

export type BulkPresetSelectionResult = {
  nextSelectedOfferIdsByJobId: Record<string, string | null>;
  changes: BulkSelectionChange[];
  unavailableJobIds: string[];
};

export type BulkPresetRevertResult = {
  nextSelectedOfferIdsByJobId: Record<string, string | null>;
  restoredJobIds: string[];
};

export type QuoteSelectionSummary = {
  totalPriceUsd: number;
  selectedCount: number;
  domesticCount: number;
  foreignCount: number;
  unknownCount: number;
};

type NormalizedOfferInput = {
  quote: VendorQuoteAggregate;
  requestedByDate: string | null;
  excludedVendorKeys: Set<VendorName>;
  vendorLabels: Map<VendorName, string>;
  now: Date;
};

const DOMESTIC_PATTERNS = [
  /\bdomestic\b/i,
  /\busa\b/i,
  /\bu\.s\.a\.?\b/i,
  /\bunited states\b/i,
  /\bus-only\b/i,
  /\bstateside\b/i,
];

const FOREIGN_PATTERNS = [
  /\bforeign\b/i,
  /\binternational\b/i,
  /\boverseas\b/i,
  /\bchina\b/i,
  /\bindia\b/i,
  /\bvietnam\b/i,
  /\bimport\b/i,
];

const EXPEDITE_PATTERNS = [/\bexped/i, /\brush\b/i, /\bpriority\b/i, /\bfast\b/i];

const DATE_FORMATS = [
  "yyyy-MM-dd",
  "yyyy/M/d",
  "M/d/yyyy",
  "M/d/yy",
  "MM/dd/yyyy",
  "MM/dd/yy",
  "MMM d yyyy",
  "MMM d, yyyy",
  "MMMM d yyyy",
  "MMMM d, yyyy",
  "MMM d",
  "MMMM d",
] as const;

function stringifyJson(value: Json | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value).toLowerCase();
  } catch {
    return "";
  }
}

function parseLooseDate(value: string | null | undefined, now: Date): Date | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const parsed = parseISO(trimmed.slice(0, 10));
    return isValid(parsed) ? startOfDay(parsed) : null;
  }

  for (const formatString of DATE_FORMATS) {
    const parsed = parse(trimmed, formatString, now);

    if (!isValid(parsed)) {
      continue;
    }

    if (formatString === "MMM d" || formatString === "MMMM d") {
      const withCurrentYear = startOfDay(parsed);
      if (withCurrentYear < startOfDay(now)) {
        return startOfDay(
          parse(`${trimmed} ${now.getFullYear() + 1}`, `${formatString} yyyy`, now),
        );
      }
    }

    return startOfDay(parsed);
  }

  return null;
}

function formatDateValue(value: Date | null): string | null {
  return value ? format(value, "yyyy-MM-dd") : null;
}

function resolveOfferDeliveryDate(input: {
  shipReceiveBy: string | null;
  dueDate: string | null;
  quoteDateIso: string | null;
  leadTimeBusinessDays: number | null;
  now?: Date;
}): string | null {
  const now = input.now ?? new Date();
  const shipReceiveBy = parseLooseDate(input.shipReceiveBy, now);

  if (shipReceiveBy) {
    return formatDateValue(shipReceiveBy);
  }

  const dueDate = parseLooseDate(input.dueDate, now);

  if (dueDate) {
    return formatDateValue(dueDate);
  }

  if (input.leadTimeBusinessDays === null || input.leadTimeBusinessDays === undefined) {
    return null;
  }

  const leadTimeBusinessDays = Math.max(0, Math.trunc(input.leadTimeBusinessDays));
  const quoteDate = parseLooseDate(input.quoteDateIso, now) ?? startOfDay(now);

  return formatDateValue(addBusinessDays(quoteDate, leadTimeBusinessDays));
}

export function resolveDomesticStatus(input: {
  sourcing: string | null;
  rawPayload: Json | null | undefined;
}): DomesticStatus {
  const rawPayload = input.rawPayload;
  const payloadBlob = stringifyJson(rawPayload);
  const sourcing = input.sourcing?.toLowerCase() ?? "";
  const blob = `${sourcing} ${payloadBlob}`;

  if (
    typeof rawPayload === "object" &&
    rawPayload !== null &&
    !Array.isArray(rawPayload) &&
    ("domestic" in rawPayload || "isDomestic" in rawPayload)
  ) {
    const domesticValue = (rawPayload as { domestic?: unknown; isDomestic?: unknown }).domestic ??
      (rawPayload as { domestic?: unknown; isDomestic?: unknown }).isDomestic;

    if (domesticValue === true || domesticValue === "true") {
      return "domestic";
    }

    if (domesticValue === false || domesticValue === "false") {
      return "foreign";
    }
  }

  if (DOMESTIC_PATTERNS.some((pattern) => pattern.test(blob))) {
    return "domestic";
  }

  if (FOREIGN_PATTERNS.some((pattern) => pattern.test(blob))) {
    return "foreign";
  }

  return "unknown";
}

function resolveExpedite(input: {
  laneLabel: string | null;
  tier: string | null;
  notes: string | null;
}): boolean {
  const blob = [input.laneLabel, input.tier, input.notes].filter(Boolean).join(" ");
  return EXPEDITE_PATTERNS.some((pattern) => pattern.test(blob));
}

function compareDateString(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return left.localeCompare(right);
}

function compareNumber(left: number | null, right: number | null): number {
  if (left === right) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return left - right;
}

function defaultDisplayComparator(
  left: ClientQuoteSelectionOption,
  right: ClientQuoteSelectionOption,
): number {
  if (left.excluded !== right.excluded) {
    return left.excluded ? 1 : -1;
  }

  if (left.eligible !== right.eligible) {
    return left.eligible ? -1 : 1;
  }

  if (left.totalPriceUsd !== right.totalPriceUsd) {
    return left.totalPriceUsd - right.totalPriceUsd;
  }

  const leadTimeComparison = compareNumber(left.leadTimeBusinessDays, right.leadTimeBusinessDays);
  if (leadTimeComparison !== 0) {
    return leadTimeComparison;
  }

  return left.vendorLabel.localeCompare(right.vendorLabel);
}

function fastestComparator(
  left: ClientQuoteSelectionOption,
  right: ClientQuoteSelectionOption,
): number {
  const deliveryComparison = compareDateString(left.resolvedDeliveryDate, right.resolvedDeliveryDate);

  if (deliveryComparison !== 0) {
    return deliveryComparison;
  }

  const leadTimeComparison = compareNumber(left.leadTimeBusinessDays, right.leadTimeBusinessDays);

  if (leadTimeComparison !== 0) {
    return leadTimeComparison;
  }

  if (left.totalPriceUsd !== right.totalPriceUsd) {
    return left.totalPriceUsd - right.totalPriceUsd;
  }

  return left.vendorLabel.localeCompare(right.vendorLabel);
}

function cheapestComparator(
  left: ClientQuoteSelectionOption,
  right: ClientQuoteSelectionOption,
): number {
  if (left.totalPriceUsd !== right.totalPriceUsd) {
    return left.totalPriceUsd - right.totalPriceUsd;
  }

  const leadTimeComparison = compareNumber(left.leadTimeBusinessDays, right.leadTimeBusinessDays);

  if (leadTimeComparison !== 0) {
    return leadTimeComparison;
  }

  return left.vendorLabel.localeCompare(right.vendorLabel);
}

function domesticComparator(
  left: ClientQuoteSelectionOption,
  right: ClientQuoteSelectionOption,
): number {
  const domesticRank = (value: DomesticStatus) => {
    switch (value) {
      case "domestic":
        return 0;
      case "unknown":
        return 1;
      case "foreign":
      default:
        return 2;
    }
  };

  const rankComparison = domesticRank(left.domesticStatus) - domesticRank(right.domesticStatus);

  if (rankComparison !== 0) {
    return rankComparison;
  }

  return cheapestComparator(left, right);
}

function isPresetCandidate(option: ClientQuoteSelectionOption, preset: QuotePreset): boolean {
  if (!option.eligible || !option.isSelectable) {
    return false;
  }

  if (preset === "domestic") {
    return option.domesticStatus === "domestic";
  }

  return true;
}

function buildOptionRecords(input: NormalizedOfferInput): ClientQuoteSelectionOption[] {
  const { quote, requestedByDate, excludedVendorKeys, vendorLabels, now } = input;
  const rawOfferRecords = quote.offers.length > 0 ? quote.offers : null;

  const importedOffers =
    rawOfferRecords === null
      ? getImportedVendorOffers(quote)
      : rawOfferRecords.map((offer) => ({
          id: offer.id,
          offerId: offer.offer_key,
          requestedQuantity: quote.requested_quantity,
          supplier: offer.supplier,
          laneLabel: offer.lane_label,
          sourcing: offer.sourcing,
          tier: offer.tier,
          quoteRef: offer.quote_ref,
          quoteDateIso: offer.quote_date,
          totalPriceUsd: Number(offer.total_price_usd ?? Number.NaN),
          unitPriceUsd: Number(offer.unit_price_usd ?? Number.NaN),
          leadTimeBusinessDays: offer.lead_time_business_days,
          shipReceiveBy: offer.ship_receive_by,
          dueDate: offer.due_date,
          process: offer.process,
          material: offer.material,
          finish: offer.finish,
          tightestTolerance: offer.tightest_tolerance,
          toleranceSource: offer.tolerance_source,
          threadCallouts: offer.thread_callouts,
          threadMatchNotes: offer.thread_match_notes,
          notes: offer.notes,
        }));

  return importedOffers
    .filter((offer) => Number.isFinite(offer.totalPriceUsd) && Number.isFinite(offer.unitPriceUsd))
    .map((offer) => {
      const rawPayload =
        rawOfferRecords?.find((record) => record.id === offer.id)?.raw_payload ?? quote.raw_payload;
      const resolvedDeliveryDate = resolveOfferDeliveryDate({
        shipReceiveBy: offer.shipReceiveBy,
        dueDate: offer.dueDate,
        quoteDateIso: offer.quoteDateIso,
        leadTimeBusinessDays: offer.leadTimeBusinessDays,
        now,
      });
      const dueDateEligible =
        requestedByDate === null
          ? true
          : resolvedDeliveryDate !== null && resolvedDeliveryDate <= requestedByDate;
      const isSelectable = Boolean(offer.id);

      return {
        key: offer.id ?? `${quote.id}:${offer.offerId}`,
        offerId: offer.offerId,
        persistedOfferId: offer.id,
        vendorKey: quote.vendor,
        vendorQuoteResultId: quote.id,
        vendorLabel: vendorLabels.get(quote.vendor) ?? "Vendor",
        supplier: offer.supplier,
        requestedQuantity: offer.requestedQuantity,
        unitPriceUsd: offer.unitPriceUsd,
        totalPriceUsd: offer.totalPriceUsd,
        leadTimeBusinessDays: offer.leadTimeBusinessDays,
        resolvedDeliveryDate,
        domesticStatus: resolveDomesticStatus({
          sourcing: offer.sourcing,
          rawPayload,
        }),
        excluded: excludedVendorKeys.has(quote.vendor),
        dueDateEligible,
        eligible: dueDateEligible && !excludedVendorKeys.has(quote.vendor) && isSelectable,
        isSelectable,
        expedite: resolveExpedite({
          laneLabel: offer.laneLabel,
          tier: offer.tier,
          notes: offer.notes,
        }),
        shipReceiveBy: offer.shipReceiveBy,
        dueDate: offer.dueDate,
        quoteDateIso: offer.quoteDateIso,
        sourcing: offer.sourcing,
        tier: offer.tier,
        laneLabel: offer.laneLabel,
        process: offer.process,
        material: offer.material,
        finish: offer.finish,
        tightestTolerance: offer.tightestTolerance,
        notes: offer.notes,
        rawPayload,
      } satisfies ClientQuoteSelectionOption;
    })
    .sort(defaultDisplayComparator);
}

export function buildVendorLabelMap(vendorKeys: readonly VendorName[]): Map<VendorName, string> {
  const sortedKeys = [...new Set(vendorKeys)].sort();

  return new Map(
    sortedKeys.map((vendorKey) => [vendorKey, formatVendorName(vendorKey)] as const),
  );
}

export function buildClientQuoteSelectionOptions(input: {
  vendorQuotes: VendorQuoteAggregate[];
  requestedByDate?: string | null;
  excludedVendorKeys?: readonly VendorName[];
  vendorLabels?: Map<VendorName, string>;
  now?: Date;
}): ClientQuoteSelectionOption[] {
  const vendorLabels =
    input.vendorLabels ?? buildVendorLabelMap(input.vendorQuotes.map((quote) => quote.vendor));
  const excludedVendorKeys = new Set(input.excludedVendorKeys ?? []);
  const now = input.now ?? new Date();

  return input.vendorQuotes
    .flatMap((quote) =>
      buildOptionRecords({
        quote,
        requestedByDate: input.requestedByDate ?? null,
        excludedVendorKeys,
        vendorLabels,
        now,
      }),
    )
    .sort(defaultDisplayComparator);
}

export function sortQuoteOptionsForPreset(
  options: readonly ClientQuoteSelectionOption[],
  preset: QuotePreset,
): ClientQuoteSelectionOption[] {
  const comparator =
    preset === "fastest"
      ? fastestComparator
      : preset === "domestic"
        ? domesticComparator
        : cheapestComparator;

  const candidates = options.filter((option) => isPresetCandidate(option, preset)).sort(comparator);
  const fallbacks = options.filter((option) => !isPresetCandidate(option, preset)).sort(defaultDisplayComparator);

  return [...candidates, ...fallbacks];
}

export function pickPresetOption(
  options: readonly ClientQuoteSelectionOption[],
  preset: QuotePreset,
): ClientQuoteSelectionOption | null {
  return sortQuoteOptionsForPreset(options, preset).find((option) => isPresetCandidate(option, preset)) ?? null;
}

export function applyBulkPresetSelection(input: {
  optionsByJobId: Record<string, readonly ClientQuoteSelectionOption[]>;
  currentSelectedOfferIdsByJobId: Record<string, string | null>;
  preset: QuotePreset;
}): BulkPresetSelectionResult {
  const nextSelectedOfferIdsByJobId = { ...input.currentSelectedOfferIdsByJobId };
  const unavailableJobIds: string[] = [];
  const changes: BulkSelectionChange[] = [];

  Object.entries(input.optionsByJobId).forEach(([jobId, options]) => {
    const nextOption = pickPresetOption(options, input.preset);

    if (!nextOption?.persistedOfferId) {
      unavailableJobIds.push(jobId);
      return;
    }

    const previousOfferId = input.currentSelectedOfferIdsByJobId[jobId] ?? null;

    if (previousOfferId === nextOption.persistedOfferId) {
      nextSelectedOfferIdsByJobId[jobId] = previousOfferId;
      return;
    }

    nextSelectedOfferIdsByJobId[jobId] = nextOption.persistedOfferId;
    changes.push({
      jobId,
      previousOfferId,
      appliedOfferId: nextOption.persistedOfferId,
    });
  });

  return {
    nextSelectedOfferIdsByJobId,
    changes,
    unavailableJobIds,
  };
}

export function revertBulkPresetSelection(input: {
  currentSelectedOfferIdsByJobId: Record<string, string | null>;
  lastBulkAction: readonly BulkSelectionChange[];
}): BulkPresetRevertResult {
  const nextSelectedOfferIdsByJobId = { ...input.currentSelectedOfferIdsByJobId };
  const restoredJobIds: string[] = [];

  input.lastBulkAction.forEach((change) => {
    if (nextSelectedOfferIdsByJobId[change.jobId] !== change.appliedOfferId) {
      return;
    }

    nextSelectedOfferIdsByJobId[change.jobId] = change.previousOfferId;
    restoredJobIds.push(change.jobId);
  });

  return {
    nextSelectedOfferIdsByJobId,
    restoredJobIds,
  };
}

export function summarizeSelectedQuoteOptions(
  options: readonly (ClientQuoteSelectionOption | null | undefined)[],
): QuoteSelectionSummary {
  return options.reduce<QuoteSelectionSummary>(
    (summary, option) => {
      if (!option) {
        return summary;
      }

      summary.totalPriceUsd += option.totalPriceUsd;
      summary.selectedCount += 1;

      if (option.domesticStatus === "domestic") {
        summary.domesticCount += 1;
      } else if (option.domesticStatus === "foreign") {
        summary.foreignCount += 1;
      } else {
        summary.unknownCount += 1;
      }

      return summary;
    },
    {
      totalPriceUsd: 0,
      selectedCount: 0,
      domesticCount: 0,
      foreignCount: 0,
      unknownCount: 0,
    },
  );
}

export function getSelectedOption(
  options: readonly ClientQuoteSelectionOption[],
  selectedOfferId: string | null | undefined,
): ClientQuoteSelectionOption | null {
  if (!selectedOfferId) {
    return null;
  }

  return options.find((option) => option.persistedOfferId === selectedOfferId) ?? null;
}
