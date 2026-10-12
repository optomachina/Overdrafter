import {
  projectDeliveredCostAndArrival,
  type CostComponentKey,
  type IsoCalendarDate,
} from "../../../shared/delivered-cost-arrival";
import { toProviderDeliveryObservation } from "@/features/quotes/delivered-cost-arrival-input";
import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import type { QuoteRequestStatus, VendorName, VendorStatus } from "@/integrations/supabase/types";

/**
 * OVD-571: delivered-date comparison model for the existing quote chart/table.
 *
 * Each option is projected through the OVD-569 contract at one hypothetical
 * order instant. Unknown arrival or out-the-door (OTD) cost is never coerced to
 * zero; lower bounds (a ship date without transit, a known subtotal without
 * shipping/tax/fees) stay labeled as such so the UI can render them distinctly.
 */

export type DeliveredComparisonMode = "cheapest" | "fastest";
export type DeadlineStatus = "on_time" | "late" | "unconfirmed" | "no_deadline";

export type DeliveredArrival =
  | { kind: "arrival"; date: IsoCalendarDate; provenance: "confirmed" | "estimated" }
  /** Ship date is known but transit is not, so arrival is strictly after `shipDate`. */
  | { kind: "ships_by"; shipDate: IsoCalendarDate }
  | { kind: "unknown" };

export type DeliveredOtd =
  | { kind: "complete"; amountUsd: number; provenance: "confirmed" | "estimated" }
  /** Sum of the known components; the listed components are still unknown. */
  | { kind: "partial"; knownAmountUsd: number; unknownComponents: readonly CostComponentKey[] }
  | { kind: "unknown" };

export type DeliveredComparisonRow = {
  key: string;
  option: ClientQuoteSelectionOption;
  arrival: DeliveredArrival;
  otd: DeliveredOtd;
  /** Plot coordinates (x = civil epoch day, y = USD) or null when an axis value is unknown. */
  plot: { x: number; y: number; exact: boolean } | null;
  notPlottedReason: "arrival_unknown" | "otd_unknown" | null;
};

export type DeliveredComparisonModel = {
  orderLocalDate: IsoCalendarDate;
  rows: DeliveredComparisonRow[];
};

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isoDateToEpochDay(value: IsoCalendarDate): number | null {
  const match = ISO_DATE.exec(value);
  if (!match) {
    return null;
  }
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? ms / DAY_MS : null;
}

export function epochDayToIsoDate(epochDay: number): IsoCalendarDate {
  return new Date(Math.round(epochDay) * DAY_MS).toISOString().slice(0, 10);
}

/** Formats a civil date without shifting it through the host time zone. */
export function formatCivilDate(value: IsoCalendarDate): string {
  const day = isoDateToEpochDay(value);
  if (day === null) {
    return value;
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(day * DAY_MS));
}

export function buildDeliveredComparisonModel(
  options: readonly ClientQuoteSelectionOption[],
  input: { now: Date; timeZone: string },
): DeliveredComparisonModel {
  const orderAt = input.now.toISOString();
  let orderLocalDate = orderAt.slice(0, 10);

  const rows = options.map((option): DeliveredComparisonRow => {
    const projection = projectDeliveredCostAndArrival(
      toProviderDeliveryObservation(option, { referenceDate: input.now }),
      { orderAt, calendar: { timeZone: input.timeZone } },
    );
    orderLocalDate = projection.orderLocalDate;
    // No provider shipping options exist yet, so the projection has exactly one scenario.
    const scenario = projection.scenarios[0];
    const arrival = toArrival(scenario.arrival);
    const otd = toOtd(scenario.cost.total);
    const x = arrivalPlotDay(arrival);
    const y = otdPlotAmount(otd);
    let notPlottedReason: DeliveredComparisonRow["notPlottedReason"] = null;
    if (x === null) {
      notPlottedReason = "arrival_unknown";
    } else if (y === null) {
      notPlottedReason = "otd_unknown";
    }

    return {
      key: option.key,
      option,
      arrival,
      otd,
      plot: x === null || y === null
        ? null
        : {
            x,
            y,
            exact: arrival.kind === "arrival"
              && arrival.provenance === "confirmed"
              && otd.kind === "complete"
              && otd.provenance === "confirmed",
          },
      notPlottedReason,
    };
  });

  return { orderLocalDate, rows };
}

function toArrival(arrival: {
  arrivalDate: string | null;
  shipDate: string | null;
  provenance: "confirmed" | "estimated" | "unknown";
  fixedDatePassed: boolean;
}): DeliveredArrival {
  // A provider date already in the past is stale, not an arrival to plot or rank first.
  if (arrival.fixedDatePassed) {
    return { kind: "unknown" };
  }
  if (arrival.arrivalDate && arrival.provenance !== "unknown") {
    return { kind: "arrival", date: arrival.arrivalDate, provenance: arrival.provenance };
  }
  if (arrival.shipDate) {
    return { kind: "ships_by", shipDate: arrival.shipDate };
  }
  return { kind: "unknown" };
}

function toOtd(total: {
  provenance: "confirmed" | "estimated" | "unknown";
  amountUsd: number | null;
  knownAmountUsd: number;
  unknownComponents: readonly CostComponentKey[];
}): DeliveredOtd {
  if (total.amountUsd !== null && total.provenance !== "unknown") {
    return { kind: "complete", amountUsd: total.amountUsd, provenance: total.provenance };
  }
  if (total.knownAmountUsd > 0) {
    return { kind: "partial", knownAmountUsd: total.knownAmountUsd, unknownComponents: total.unknownComponents };
  }
  return { kind: "unknown" };
}

function arrivalPlotDay(arrival: DeliveredArrival): number | null {
  if (arrival.kind === "arrival") {
    return isoDateToEpochDay(arrival.date);
  }
  if (arrival.kind === "ships_by") {
    return isoDateToEpochDay(arrival.shipDate);
  }
  return null;
}

function otdPlotAmount(otd: DeliveredOtd): number | null {
  if (otd.kind === "complete") {
    return otd.amountUsd;
  }
  if (otd.kind === "partial") {
    return otd.knownAmountUsd;
  }
  return null;
}

const UNKNOWN_COMPONENT_DISPLAY_ORDER: readonly CostComponentKey[] = ["shipping", "tax", "fees", "parts"];

/** Human order for the still-unknown OTD components, e.g. "shipping, tax, fees". */
export function formatUnknownCostComponents(components: readonly CostComponentKey[]): string {
  return UNKNOWN_COMPONENT_DISPLAY_ORDER.filter((key) => components.includes(key)).join(", ");
}

/**
 * On time only when a projected arrival is on or before the deadline. A ship
 * date after the deadline is provably late; every other missing value stays
 * unconfirmed rather than being guessed either way.
 */
export function getDeadlineStatus(
  row: Pick<DeliveredComparisonRow, "arrival">,
  deadline: IsoCalendarDate | null,
): DeadlineStatus {
  if (!deadline) {
    return "no_deadline";
  }
  if (row.arrival.kind === "arrival") {
    return row.arrival.date <= deadline ? "on_time" : "late";
  }
  if (row.arrival.kind === "ships_by") {
    return row.arrival.shipDate > deadline ? "late" : "unconfirmed";
  }
  return "unconfirmed";
}

const DEADLINE_GROUP_RANK: Record<DeadlineStatus, number> = {
  on_time: 0,
  no_deadline: 0,
  unconfirmed: 1,
  late: 2,
};

function otdSortValue(otd: DeliveredOtd): number {
  if (otd.kind === "complete") return otd.amountUsd;
  if (otd.kind === "partial") return otd.knownAmountUsd;
  return Number.POSITIVE_INFINITY;
}

function arrivalSortValue(arrival: DeliveredArrival): number {
  const day = arrivalPlotDay(arrival);
  if (day === null) {
    return Number.POSITIVE_INFINITY;
  }
  // A ship date is only a lower bound, so it sorts after an arrival on the same day.
  return arrival.kind === "ships_by" ? day + 0.5 : day;
}

function compareNumbers(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Cheapest (default): with a deadline, on-time options first by OTD, then
 * unconfirmed, then late ones; without a deadline, by OTD. Fastest: by
 * projected arrival. Ties resolve deterministically so arrivals never shuffle
 * existing rows.
 */
export function sortDeliveredComparisonRows(
  rows: readonly DeliveredComparisonRow[],
  mode: DeliveredComparisonMode,
  deadline: IsoCalendarDate | null,
): DeliveredComparisonRow[] {
  const byOtd = (left: DeliveredComparisonRow, right: DeliveredComparisonRow) =>
    compareNumbers(otdSortValue(left.otd), otdSortValue(right.otd));
  const byArrival = (left: DeliveredComparisonRow, right: DeliveredComparisonRow) =>
    compareNumbers(arrivalSortValue(left.arrival), arrivalSortValue(right.arrival));
  const byIdentity = (left: DeliveredComparisonRow, right: DeliveredComparisonRow) =>
    left.option.vendorLabel.localeCompare(right.option.vendorLabel) || left.key.localeCompare(right.key);

  return [...rows].sort((left, right) => {
    if (mode === "fastest") {
      return byArrival(left, right) || byOtd(left, right) || byIdentity(left, right);
    }
    const groupComparison = compareNumbers(
      DEADLINE_GROUP_RANK[getDeadlineStatus(left, deadline)],
      DEADLINE_GROUP_RANK[getDeadlineStatus(right, deadline)],
    );
    return groupComparison || byOtd(left, right) || byArrival(left, right) || byIdentity(left, right);
  });
}

export type QuoteRequestCompletionInput = {
  request: { id: string; status: QuoteRequestStatus; requestedVendors: readonly VendorName[] } | null;
  run: { id: string; quoteRequestId: string | null } | null;
  vendorResults: readonly { id: string; vendor: VendorName; quoteRunId: string; status: VendorStatus }[];
};

export type QuoteRequestCompletionNotice = {
  requestId: string;
  optionCount: number;
  providerWithOptionsCount: number;
  noQuoteProviderCount: number;
};

const TERMINAL_PROVIDER_STATUSES = new Set<VendorStatus>([
  "instant_quote_received",
  "official_quote_received",
  "failed",
]);

/**
 * The active request is complete only when the request itself is terminal
 * (received or failed, never canceled) and every requested provider has a
 * terminal result on the request's run. Counts use only the options the
 * caller can show, so concealed overseas or unverified-origin results are
 * never counted or hinted at.
 */
export function resolveQuoteRequestCompletion(
  input: QuoteRequestCompletionInput,
  visibleOptions: readonly ClientQuoteSelectionOption[],
): QuoteRequestCompletionNotice | null {
  const { request, run } = input;
  if (!request || run?.quoteRequestId !== request.id) {
    return null;
  }
  if (request.status !== "received" && request.status !== "failed") {
    return null;
  }
  const requestedVendors = [...new Set(request.requestedVendors)];
  if (requestedVendors.length === 0) {
    return null;
  }
  const runResults = input.vendorResults.filter((result) => result.quoteRunId === run.id);
  const resultByVendor = new Map(runResults.map((result) => [result.vendor, result] as const));
  const allTerminal = requestedVendors.every((vendor) => {
    const result = resultByVendor.get(vendor);
    return result !== undefined && TERMINAL_PROVIDER_STATUSES.has(result.status);
  });
  if (!allTerminal) {
    return null;
  }

  const runResultIds = new Set(runResults.map((result) => result.id));
  const runOptions = visibleOptions.filter((option) => runResultIds.has(option.vendorQuoteResultId));
  const providersWithOptions = new Set(runOptions.map((option) => option.vendorKey));

  return {
    requestId: request.id,
    optionCount: runOptions.length,
    providerWithOptionsCount: providersWithOptions.size,
    noQuoteProviderCount: requestedVendors.filter(
      (vendor) => resultByVendor.get(vendor)?.status === "failed",
    ).length,
  };
}
