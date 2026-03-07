import { normalizeRequestedQuoteQuantities } from "@/features/quotes/request-intake";
import type { ApprovedPartRequirement, JobPartSummary } from "@/features/quotes/types";

export type RequestedQuantityFilterValue = number | "all";

type RequestedQuantitySource = readonly (number | null | undefined)[] | number | null | undefined;

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

    flattened.push(source);
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
): { requestedQuoteQuantities: number[]; requestedByDate: string | null } | null {
  if (summaries.length === 0 || summaries.some((summary) => !summary)) {
    return null;
  }

  const normalized = summaries.map((summary) => ({
    requestedQuoteQuantities: normalizeRequestedQuoteQuantities(
      summary!.requestedQuoteQuantities,
      summary!.quantity,
    ),
    requestedByDate: summary!.requestedByDate ?? null,
  }));

  const first = normalized[0];
  const matches = normalized.every(
    (summary) =>
      summary.requestedByDate === first.requestedByDate &&
      summary.requestedQuoteQuantities.length === first.requestedQuoteQuantities.length &&
      summary.requestedQuoteQuantities.every((quantity, index) => quantity === first.requestedQuoteQuantities[index]),
  );

  if (!matches) {
    return null;
  }

  return first.requestedQuoteQuantities.length > 0 || first.requestedByDate
    ? first
    : null;
}
