import type { JobPartSummary } from "@/features/quotes/types";

const FILE_REFERENCE_PATTERN = /^(\d{4}-\d{5})(?:[-_\s]?([A-Za-z0-9]+))?$/;
const TITLE_REFERENCE_PATTERN = /^(\d{4}-\d{5})(?:\s+rev(?:ision)?\s+([a-z0-9]+))?/i;

/**
 * Parse an imported part reference into an explicit part number and optional revision.
 *
 * Supports bare filename-like references such as `1093-05589-A` and title-style
 * revision tokens such as `1093-05589 rev A`, matching the revision token
 * case-insensitively.
 *
 * @param value The raw part reference string, or `null`/`undefined` when no value is available.
 * @returns The parsed part number and revision when the input matches a supported pattern;
 * otherwise `null` for empty or unrecognized values.
 */
export function parsePartReference(
  value: string | null | undefined,
): Pick<JobPartSummary, "partNumber" | "revision"> | null {
  if (!value) {
    return null;
  }

  const normalizedValue = value.trim();

  const fileMatch = FILE_REFERENCE_PATTERN.exec(normalizedValue);
  if (fileMatch) {
    return {
      partNumber: fileMatch[1] ?? null,
      revision: fileMatch[2] ?? null,
    };
  }

  const titleMatch = TITLE_REFERENCE_PATTERN.exec(normalizedValue);
  if (titleMatch) {
    return {
      partNumber: titleMatch[1] ?? null,
      revision: titleMatch[2] ?? null,
    };
  }

  return null;
}

/**
 * Normalize imported part-number text for metadata storage.
 *
 * @param value The raw imported part-number string, or `null`/`undefined` when absent.
 * @returns The parsed base part number when detectable, otherwise the trimmed original
 * string, or `null` when the input is empty.
 */
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
