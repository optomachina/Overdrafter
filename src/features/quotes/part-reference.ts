import type { JobPartSummary } from "@/features/quotes/types";

export function parsePartReference(
  value: string | null | undefined,
): Pick<JobPartSummary, "partNumber" | "revision"> | null {
  if (!value) {
    return null;
  }

  const normalizedValue = value.trim();

  const fileMatch = normalizedValue.match(/^(\d{4}-\d{5})(?:[-_\s]?([A-Za-z0-9]+))?$/);
  if (fileMatch) {
    return {
      partNumber: fileMatch[1] ?? null,
      revision: fileMatch[2] ?? null,
    };
  }

  const titleMatch = normalizedValue.match(/^(\d{4}-\d{5})(?:\s+rev(?:ision)?\s+([A-Za-z0-9]+))?/i);
  if (titleMatch) {
    return {
      partNumber: titleMatch[1] ?? null,
      revision: titleMatch[2] ?? null,
    };
  }

  return null;
}

export function normalizeImportedPartNumber(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  return parsePartReference(trimmed)?.partNumber ?? trimmed;
}
