export const DEFAULT_QUANTITY_PRICING_LADDER = [1, 10, 100, 1000] as const;

function appendQuantity(target: number[], seen: Set<number>, value: unknown) {
  let parsed: number | null = null;

  if (typeof value === "number") {
    parsed = Math.trunc(value);
  } else if (typeof value === "string" && value.trim().length > 0) {
    const candidate = Number(value.trim());
    if (Number.isFinite(candidate)) {
      parsed = Math.trunc(candidate);
    }
  }

  if (parsed === null || !Number.isFinite(parsed) || parsed <= 0 || seen.has(parsed)) {
    return;
  }

  seen.add(parsed);
  target.push(parsed);
}

function collectInputValues(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    return [...input];
  }

  if (typeof input === "string") {
    return input
      .split(/[/,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (typeof input === "number") {
    return [input];
  }

  return [];
}

export function normalizePricingLadder(input: unknown, fallbackQuantity?: number | null): number[] {
  const values = collectInputValues(input);

  if (values.length === 0 && fallbackQuantity !== null && fallbackQuantity !== undefined) {
    values.push(fallbackQuantity);
  }

  const normalized: number[] = [];
  const seen = new Set<number>();

  values.forEach((value) => appendQuantity(normalized, seen, value));

  return normalized.sort((left, right) => left - right);
}
