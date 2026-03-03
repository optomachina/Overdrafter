import type {
  ApprovedPartRequirement,
  DrawingExtractionData,
  DrawingExtractionRecord,
  JobAggregate,
  JobSummaryMetrics,
  PartAggregate,
  VendorQuoteAggregate,
  VendorQuoteOfferRecord,
  VendorQuoteResultRecord,
  PublishedPackageAggregate,
  QuoteRunAggregate,
} from "@/features/quotes/types";
import type { ClientOptionKind, Json, VendorName } from "@/integrations/supabase/types";

export const DEFAULT_APPLICABLE_VENDORS: VendorName[] = [
  "xometry",
  "fictiv",
  "protolabs",
  "sendcutsend",
];

export const MANUAL_IMPORT_VENDORS: VendorName[] = ["partsbadger", "fastdms"];

export function isManualImportVendor(vendor: VendorName): boolean {
  return MANUAL_IMPORT_VENDORS.includes(vendor);
}

export function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "N/A";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatLeadTime(days: number | null | undefined): string {
  if (!days && days !== 0) {
    return "Pending";
  }

  return `${days} business day${days === 1 ? "" : "s"}`;
}

export function formatStatusLabel(value: string): string {
  return value
    .split("_")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function formatVendorName(vendor: VendorName): string {
  switch (vendor) {
    case "sendcutsend":
      return "SendCutSend";
    case "protolabs":
      return "Protolabs";
    case "partsbadger":
      return "PartsBadger";
    case "fastdms":
      return "FastDMS";
    default:
      return vendor.charAt(0).toUpperCase() + vendor.slice(1);
  }
}

function asObject(value: Json | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray<T>(value: Json | null | undefined): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeEvidence(extraction: DrawingExtractionRecord | null): DrawingExtractionData["evidence"] {
  return asArray<Record<string, unknown>>(extraction?.evidence).map((item) => ({
    field: String(item.field ?? "unknown"),
    page: Number(item.page ?? 0),
    snippet: String(item.snippet ?? ""),
    confidence: Number(item.confidence ?? 0),
  }));
}

function parseToleranceValue(raw: string | null | undefined): number | null {
  if (!raw) {
    return null;
  }

  const cleaned = raw.replace(/[^0-9.-]/g, "");
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? Math.abs(parsed) : null;
}

export function normalizeDrawingExtraction(
  extraction: DrawingExtractionRecord | null,
  partId: string,
): DrawingExtractionData {
  const payload = asObject(extraction?.extraction);
  const material = asObject(payload.material);
  const finish = asObject(payload.finish);
  const tolerances = asObject(payload.tolerances);
  const warnings = asArray<string>(extraction?.warnings).map(String);

  return {
    partId,
    description: (payload.description ?? payload.desc ?? null) as string | null,
    partNumber: (payload.partNumber ?? payload.pn ?? null) as string | null,
    revision: (payload.revision ?? payload.rev ?? null) as string | null,
    material: {
      raw: (material.raw ?? material.raw_text ?? null) as string | null,
      normalized: (material.normalized ?? null) as string | null,
      confidence: Number(material.confidence ?? extraction?.confidence ?? 0),
    },
    finish: {
      raw: (finish.raw ?? finish.raw_text ?? null) as string | null,
      normalized: (finish.normalized ?? null) as string | null,
      confidence: Number(finish.confidence ?? extraction?.confidence ?? 0),
    },
    tightestTolerance: {
      raw: (tolerances.tightest ?? null) as string | null,
      valueInch:
        (typeof tolerances.valueInch === "number" ? tolerances.valueInch : null) ??
        parseToleranceValue((tolerances.tightest ?? null) as string | null),
      confidence: Number(tolerances.confidence ?? extraction?.confidence ?? 0),
    },
    evidence: normalizeEvidence(extraction),
    warnings,
    status: extraction?.status ?? "needs_review",
  };
}

export function buildRequirementDraft(part: PartAggregate): ApprovedPartRequirement {
  const normalizedExtraction = normalizeDrawingExtraction(part.extraction, part.id);
  const approved = part.approvedRequirement;

  return {
    partId: part.id,
    description: approved?.description ?? normalizedExtraction.description,
    partNumber: approved?.part_number ?? normalizedExtraction.partNumber,
    revision: approved?.revision ?? normalizedExtraction.revision,
    material:
      approved?.material ??
      normalizedExtraction.material.normalized ??
      normalizedExtraction.material.raw ??
      "Unknown material",
    finish:
      approved?.finish ??
      normalizedExtraction.finish.normalized ??
      normalizedExtraction.finish.raw ??
      null,
    tightestToleranceInch:
      approved?.tightest_tolerance_inch ?? normalizedExtraction.tightestTolerance.valueInch,
    quantity: approved?.quantity ?? part.quantity ?? 1,
    applicableVendors:
      approved?.applicable_vendors?.length
        ? approved.applicable_vendors
        : DEFAULT_APPLICABLE_VENDORS.filter((vendor) =>
            vendor === "sendcutsend"
              ? (normalizedExtraction.tightestTolerance.valueInch ?? 0.005) >= 0.005
              : true,
          ),
  };
}

export function getLatestQuoteRun(job: JobAggregate): QuoteRunAggregate | null {
  return job.quoteRuns[0] ?? null;
}

export function getLatestPublishedPackage(job: JobAggregate): PublishedPackageAggregate | null {
  return job.packages[0] ?? null;
}

export function hasManualQuoteIntakeSource(quote: VendorQuoteAggregate | VendorQuoteResultRecord): boolean {
  const payload = asObject(quote.raw_payload);
  return payload.source === "manual-quote-intake";
}

export function getJobSummaryMetrics(jobList: { status: string }[]): JobSummaryMetrics {
  return {
    totalJobs: jobList.length,
    needsReview: jobList.filter((job) => job.status === "needs_spec_review" || job.status === "internal_review").length,
    published: jobList.filter((job) => job.status === "published").length,
    quoted: jobList.filter((job) => job.status === "quoting").length,
  };
}

export function optionLabelForKind(kind: ClientOptionKind): string {
  switch (kind) {
    case "lowest_cost":
      return "Lowest Cost";
    case "fastest_delivery":
      return "Fastest Delivery";
    case "balanced":
    default:
      return "Balanced";
  }
}

export function projectedClientPrice(rawTotal: number | null | undefined): number | null {
  if (rawTotal === null || rawTotal === undefined) {
    return null;
  }

  return Math.ceil(rawTotal * 1.2 * 100) / 100;
}

export type ImportedVendorOffer = {
  id: string | null;
  offerId: string;
  supplier: string;
  laneLabel: string | null;
  sourcing: string | null;
  tier: string | null;
  quoteRef: string | null;
  quoteDateIso: string | null;
  totalPriceUsd: number;
  unitPriceUsd: number;
  leadTimeBusinessDays: number | null;
  shipReceiveBy: string | null;
  dueDate: string | null;
  process: string | null;
  material: string | null;
  finish: string | null;
  tightestTolerance: string | null;
  toleranceSource: string | null;
  threadCallouts: string | null;
  threadMatchNotes: string | null;
  notes: string | null;
};

function mapOfferRecord(offer: VendorQuoteOfferRecord): ImportedVendorOffer {
  return {
    id: offer.id,
    offerId: offer.offer_key,
    supplier: offer.supplier,
    laneLabel: offer.lane_label,
    sourcing: offer.sourcing,
    tier: offer.tier,
    quoteRef: offer.quote_ref,
    quoteDateIso: offer.quote_date,
    totalPriceUsd: offer.total_price_usd ?? Number.NaN,
    unitPriceUsd: offer.unit_price_usd ?? Number.NaN,
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
  };
}

export function getImportedVendorOffers(
  quote: VendorQuoteAggregate | VendorQuoteResultRecord,
): ImportedVendorOffer[] {
  if ("offers" in quote && Array.isArray(quote.offers) && quote.offers.length > 0) {
    return [...quote.offers]
      .sort((left, right) => {
        if (left.sort_rank !== right.sort_rank) {
          return left.sort_rank - right.sort_rank;
        }

        return (left.total_price_usd ?? Number.MAX_SAFE_INTEGER) - (right.total_price_usd ?? Number.MAX_SAFE_INTEGER);
      })
      .map(mapOfferRecord);
  }

  const payload = asObject(quote.raw_payload);
  const offers = asArray<Record<string, unknown>>(payload.offers as Json | undefined);

  return offers
    .map((offer) => ({
      id: null,
      offerId: String(offer.offerId ?? ""),
      supplier: String(offer.supplier ?? ""),
      laneLabel: offer.laneLabel ? String(offer.laneLabel) : null,
      sourcing: offer.sourcing ? String(offer.sourcing) : null,
      tier: offer.tier ? String(offer.tier) : null,
      quoteRef: offer.quoteRef ? String(offer.quoteRef) : null,
      quoteDateIso: offer.quoteDateIso ? String(offer.quoteDateIso) : null,
      totalPriceUsd: Number(offer.totalPriceUsd ?? Number.NaN),
      unitPriceUsd: Number(offer.unitPriceUsd ?? Number.NaN),
      leadTimeBusinessDays:
        offer.leadTimeBusinessDays === null || offer.leadTimeBusinessDays === undefined
          ? null
          : Number(offer.leadTimeBusinessDays),
      shipReceiveBy: offer.shipReceiveBy ? String(offer.shipReceiveBy) : null,
      dueDate: offer.dueDate ? String(offer.dueDate) : null,
      process: offer.process ? String(offer.process) : null,
      material: offer.material ? String(offer.material) : null,
      finish: offer.finish ? String(offer.finish) : null,
      tightestTolerance: offer.tightestTolerance ? String(offer.tightestTolerance) : null,
      toleranceSource: offer.toleranceSource ? String(offer.toleranceSource) : null,
      threadCallouts: offer.threadCallouts ? String(offer.threadCallouts) : null,
      threadMatchNotes: offer.threadMatchNotes ? String(offer.threadMatchNotes) : null,
      notes: offer.notes ? String(offer.notes) : null,
    }))
    .filter((offer) => Number.isFinite(offer.totalPriceUsd))
    .sort((left, right) => left.totalPriceUsd - right.totalPriceUsd);
}
