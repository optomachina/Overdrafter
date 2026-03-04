import type { JobPartSummary, JobRecord } from "@/features/quotes/types";

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

export function parsePartReferenceFromTitle(
  title: string,
): Pick<JobPartSummary, "partNumber" | "revision"> | null {
  const match = title.trim().match(/^(\d{4}-\d{5})(?:\s+rev(?:ision)?\s+([A-Za-z0-9]+))?/i);

  if (!match) {
    return null;
  }

  return {
    partNumber: match[1] ?? null,
    revision: match[2] ?? null,
  };
}

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
  const revision = partSummary?.revision ?? titleReference?.revision ?? null;
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
