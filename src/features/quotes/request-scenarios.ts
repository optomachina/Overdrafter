import { normalizeRequestedQuoteQuantities } from "@/features/quotes/request-intake";
import { normalizeRfqLineItemExtendedMetadata } from "@/features/quotes/rfq-metadata";
import { normalizeRequestedServiceIntent } from "@/features/quotes/service-intent";
import type { ApprovedPartRequirement, JobPartSummary, ServiceRequestLineItemRecord } from "@/features/quotes/types";

export type ServiceAwareProjectSummary = {
  serviceTypes: string[];
  distinctServiceCount: number;
  allQuoteCompatible: boolean;
  requestedByDate: string | null;
  requestedQuoteQuantities: number[];
  lineItemCount: number;
};

const QUOTE_COMPATIBLE_SERVICE_TYPES = new Set([
  "manufacturing_quote",
]);

export function getServiceAwareProjectSummary(
  lineItemsByJobId: Map<string, ServiceRequestLineItemRecord[]>,
  summariesByJobId: Map<string, JobPartSummary>,
  jobIds: string[],
): ServiceAwareProjectSummary | null {
  if (jobIds.length === 0) {
    return null;
  }

  const allLineItems: ServiceRequestLineItemRecord[] = [];

  for (const jobId of jobIds) {
    const items = lineItemsByJobId.get(jobId);
    if (!items) {
      continue;
    }
    allLineItems.push(...items);
  }

  if (allLineItems.length === 0) {
    return null;
  }

  const serviceTypeSet = new Set<string>();
  let allQuoteCompatible = true;
  let requestedByDate: string | null = null;
  const allQuoteQuantities: number[] = [];

  for (const item of allLineItems) {
    serviceTypeSet.add(item.service_type);

    if (!QUOTE_COMPATIBLE_SERVICE_TYPES.has(item.service_type)) {
      allQuoteCompatible = false;
    }

    const detail = item.service_detail as Record<string, unknown> | null;
    if (detail) {
      const itemDate = (detail.requestedByDate as string) ?? null;
      if (itemDate && (!requestedByDate || itemDate < requestedByDate)) {
        requestedByDate = itemDate;
      }
      const itemQuantities = detail.requestedQuoteQuantities as number[] | undefined;
      if (itemQuantities && Array.isArray(itemQuantities)) {
        for (const q of itemQuantities) {
          if (!allQuoteQuantities.includes(q)) {
            allQuoteQuantities.push(q);
          }
        }
      }
    }
  }

  if (!requestedByDate) {
    for (const jobId of jobIds) {
      const summary = summariesByJobId.get(jobId);
      if (summary?.requestedByDate && (!requestedByDate || summary.requestedByDate < requestedByDate)) {
        requestedByDate = summary.requestedByDate;
      }
    }
  }

  const normalizedQuantities = allQuoteQuantities.length > 0
    ? normalizeRequestedQuoteQuantities(allQuoteQuantities)
    : [];

  return {
    serviceTypes: Array.from(serviceTypeSet).sort(),
    distinctServiceCount: serviceTypeSet.size,
    allQuoteCompatible,
    requestedByDate,
    requestedQuoteQuantities: normalizedQuantities,
    lineItemCount: allLineItems.length,
  };
}

export type RequestedQuantityFilterValue = number | "all";

type RequestedQuantitySource = ReadonlyArray<number | null | undefined> | number | null | undefined;

export function collectRequestedQuantities(
  sources: RequestedQuantitySource[],
  fallbackQuantity?: number | null,
): number[] {
  const flattened: Array<number | null | undefined> = [];

  sources.forEach((source) => {
    if (Array.isArray(source)) {
      flattened.push(...source);
      return;
    }

    if (typeof source === "number" || source === null || source === undefined) {
      flattened.push(source as number | null | undefined);
    }
  });

  return normalizeRequestedQuoteQuantities(flattened, fallbackQuantity);
}

export function normalizeApprovedRequirementDraft(
  requirement: ApprovedPartRequirement,
): ApprovedPartRequirement {
  const quantity =
    Number.isFinite(requirement.quantity) && requirement.quantity > 0
      ? Math.trunc(requirement.quantity)
      : 1;

  return {
    ...requirement,
    ...normalizeRequestedServiceIntent(requirement),
    ...normalizeRfqLineItemExtendedMetadata(requirement),
    quantity,
    quoteQuantities: normalizeRequestedQuoteQuantities(
      [quantity, ...requirement.quoteQuantities],
      quantity,
    ),
    requestedByDate: requirement.requestedByDate || null,
  };
}

export function resolveRequestedQuantitySelection(input: {
  availableQuantities: readonly number[];
  currentSelection?: RequestedQuantityFilterValue | null;
  preferredQuantity?: number | null;
  allowAll?: boolean;
}): RequestedQuantityFilterValue | null {
  const { availableQuantities, currentSelection = null, preferredQuantity = null, allowAll = false } = input;

  if (allowAll && currentSelection === "all" && availableQuantities.length > 0) {
    return "all";
  }

  if (typeof currentSelection === "number" && availableQuantities.includes(currentSelection)) {
    return currentSelection;
  }

  if (preferredQuantity && availableQuantities.includes(preferredQuantity)) {
    return preferredQuantity;
  }

  return availableQuantities[0] ?? null;
}

export function groupByRequestedQuantity<T extends { requestedQuantity: number }>(
  items: readonly T[],
): Array<{ requestedQuantity: number; items: T[] }> {
  const order: number[] = [];
  const groups = new Map<number, T[]>();

  items.forEach((item) => {
    const quantity = Math.max(1, Math.trunc(item.requestedQuantity || 1));

    if (!groups.has(quantity)) {
      order.push(quantity);
      groups.set(quantity, []);
    }

    groups.get(quantity)!.push(item);
  });

  return order.map((requestedQuantity) => ({
    requestedQuantity,
    items: groups.get(requestedQuantity) ?? [],
  }));
}

export function getSharedRequestMetadata(
  summaries: Array<JobPartSummary | null | undefined>,
): {
  requestedServiceKinds: ApprovedPartRequirement["requestedServiceKinds"];
  primaryServiceKind: ApprovedPartRequirement["primaryServiceKind"];
  serviceNotes: string | null;
  requestedQuoteQuantities: number[];
  requestedByDate: string | null;
} | null {
  if (summaries.length === 0 || summaries.some((summary) => !summary)) {
    return null;
  }

  const normalized = summaries.map((summary) => ({
    ...normalizeRequestedServiceIntent(summary!),
    requestedQuoteQuantities: normalizeRequestedQuoteQuantities(
      summary!.requestedQuoteQuantities,
      summary!.quantity,
    ),
    requestedByDate: summary!.requestedByDate ?? null,
  }));

  const first = normalized[0];
  const matches = normalized.every(
    (summary) =>
      summary.primaryServiceKind === first.primaryServiceKind &&
      summary.serviceNotes === first.serviceNotes &&
      summary.requestedServiceKinds.length === first.requestedServiceKinds.length &&
      summary.requestedServiceKinds.every((serviceKind, index) => serviceKind === first.requestedServiceKinds[index]) &&
      summary.requestedByDate === first.requestedByDate &&
      summary.requestedQuoteQuantities.length === first.requestedQuoteQuantities.length &&
      summary.requestedQuoteQuantities.every((quantity, index) => quantity === first.requestedQuoteQuantities[index]),
  );

  if (!matches) {
    return null;
  }

  return first.requestedServiceKinds.length > 0 || first.requestedQuoteQuantities.length > 0 || first.requestedByDate
    ? first
    : null;
}
