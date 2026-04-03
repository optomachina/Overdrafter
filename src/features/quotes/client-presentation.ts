import { parsePartReference } from "@/features/quotes/part-reference";
import type { JobPartSummary, JobRecord } from "@/features/quotes/types";

/**
 * Match a client-visible job against a free-text search term.
 *
 * @param job The job record being evaluated.
 * @param searchTerm The raw user-entered search term.
 * @returns `true` when the term is empty or matches the title, description, or tags.
 */
export function matchesClientJobSearch(job: JobRecord, searchTerm: string) {
  const normalizedSearch = searchTerm.trim().toLowerCase();

  if (!normalizedSearch) {
    return true;
  }

  return [job.title, job.description ?? "", job.tags.join(" ")]
    .join(" ")
    .toLowerCase()
    .includes(normalizedSearch);
}

/**
 * Parse a part number and optional revision from a client-visible job title.
 *
 * @param title The raw job title shown in the client workspace.
 * @returns The parsed part reference when recognizable, otherwise `null`.
 */
export function parsePartReferenceFromTitle(
  title: string,
): Pick<JobPartSummary, "partNumber" | "revision"> | null {
  return parsePartReference(title);
}

/**
 * Build the normalized display label for a part.
 *
 * @param partNumber The canonical part number, when known.
 * @param revision The explicit revision, when known.
 * @param fallbackTitle The original title to keep when no structured part number is available.
 * @returns A display title that prefers structured part metadata over the raw title.
 */
export function formatPartLabel(
  partNumber: string | null,
  revision: string | null,
  fallbackTitle: string,
) {
  if (!partNumber) {
    return fallbackTitle;
  }

  return `${partNumber}${revision ? ` rev ${revision}` : ""}`;
}

/**
 * Resolve the client-facing title and description for a job row or detail view.
 *
 * @param job The backing job record.
 * @param partSummary Optional structured part metadata associated with the job.
 * @returns The normalized presentation fields used by client workspace surfaces.
 */
export function getClientItemPresentation(
  job: JobRecord,
  partSummary?: JobPartSummary | null,
): {
  title: string;
  description: string;
  quantity: number | null;
  originalTitle: string | null;
  partNumber: string | null;
} {
  const titleReference = parsePartReferenceFromTitle(job.title);
  const partNumber = partSummary?.partNumber ?? titleReference?.partNumber ?? null;
  const revision = partSummary?.revision ?? null;
  const title = formatPartLabel(partNumber, revision, job.title);
  const description = partSummary?.description ?? job.description ?? "No description provided.";

  return {
    title,
    description,
    quantity: partSummary?.quantity ?? null,
    originalTitle: title === job.title ? null : job.title,
    partNumber,
  };
}
