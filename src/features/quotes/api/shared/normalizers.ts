import { normalizeUploadStem } from "@/features/quotes/upload-groups";
import type {
  ClientPartMetadataRecord,
  JobFileRecord,
  JobRecord,
  PartAggregate,
  QuoteDataStatus,
  VendorQuoteArtifactRecord,
} from "@/features/quotes/types";
import type {
  QuoteRunRecord,
  VendorQuoteAggregate,
  VendorQuoteOfferRecord,
  VendorQuoteResultRecord,
} from "@/features/quotes/types";
import type { Json } from "@/integrations/supabase/types";

export type ClientQuoteWorkspaceProjection = {
  jobId: string;
  latestQuoteRun: QuoteRunRecord | null;
  selectedOffer: VendorQuoteOfferRecord | null;
  vendorQuotes: VendorQuoteAggregate[];
  quoteDataStatus: QuoteDataStatus;
  quoteDataMessage: string | null;
};

export function asObject(value: Json | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function normalizeQuoteRunRecord(value: unknown): QuoteRunRecord | null {
  const record = asObject(value as Json);
  return typeof record.id === "string" ? (record as unknown as QuoteRunRecord) : null;
}

export function normalizeVendorQuoteOfferRecord(value: unknown): VendorQuoteOfferRecord | null {
  const record = asObject(value as Json);
  return typeof record.id === "string" ? (record as unknown as VendorQuoteOfferRecord) : null;
}

export function normalizeVendorQuoteArtifactRecord(value: unknown): VendorQuoteArtifactRecord | null {
  const record = asObject(value as Json);

  if (
    typeof record.id !== "string" ||
    typeof record.vendor_quote_result_id !== "string" ||
    typeof record.organization_id !== "string" ||
    typeof record.artifact_type !== "string" ||
    typeof record.storage_bucket !== "string" ||
    typeof record.storage_path !== "string" ||
    typeof record.created_at !== "string"
  ) {
    return null;
  }

  return record as unknown as VendorQuoteArtifactRecord;
}

export function normalizeVendorQuoteAggregate(value: unknown): VendorQuoteAggregate | null {
  const record = asObject(value as Json);

  if (
    typeof record.id !== "string" ||
    typeof record.quote_run_id !== "string" ||
    typeof record.part_id !== "string" ||
    typeof record.organization_id !== "string" ||
    typeof record.vendor !== "string" ||
    typeof record.status !== "string" ||
    typeof record.created_at !== "string" ||
    typeof record.updated_at !== "string" ||
    typeof record.requested_quantity !== "number" ||
    !Array.isArray(record.offers) ||
    !Array.isArray(record.artifacts)
  ) {
    return null;
  }

  return {
    ...(record as unknown as VendorQuoteResultRecord),
    offers: record.offers
      .map((offer) => normalizeVendorQuoteOfferRecord(offer))
      .filter((offer): offer is VendorQuoteOfferRecord => Boolean(offer)),
    artifacts: record.artifacts
      .map((artifact) => normalizeVendorQuoteArtifactRecord(artifact))
      .filter((artifact): artifact is VendorQuoteArtifactRecord => Boolean(artifact)),
  };
}

export function normalizeClientQuoteWorkspaceProjection(value: Json): ClientQuoteWorkspaceProjection | null {
  const record = asObject(value);

  if (typeof record.jobId !== "string") {
    return null;
  }

  return {
    jobId: record.jobId,
    latestQuoteRun: normalizeQuoteRunRecord(record.latestQuoteRun),
    selectedOffer: normalizeVendorQuoteOfferRecord(record.selectedOffer),
    vendorQuotes: asArray<unknown>(record.vendorQuotes)
      .map((quote) => normalizeVendorQuoteAggregate(quote))
      .filter((quote): quote is VendorQuoteAggregate => Boolean(quote)),
    quoteDataStatus:
      record.quoteDataStatus === "schema_unavailable" || record.quoteDataStatus === "invalid_for_plotting"
        ? record.quoteDataStatus
        : "available",
    quoteDataMessage: typeof record.quoteDataMessage === "string" ? record.quoteDataMessage : null,
  };
}

export function buildClientPartAggregateFromMetadata(input: {
  job: JobRecord;
  metadata: ClientPartMetadataRecord;
  files: JobFileRecord[];
  vendorQuotes: VendorQuoteAggregate[];
}): PartAggregate {
  const cadFile = input.files.find((file) => file.file_kind === "cad") ?? null;
  const drawingFile = input.files.find((file) => file.file_kind === "drawing") ?? null;
  const normalizedKeySource =
    cadFile?.normalized_name ??
    drawingFile?.normalized_name ??
    input.metadata.requirement.partNumber ??
    input.job.title;

  return {
    id: input.metadata.partId,
    job_id: input.job.id,
    organization_id: input.job.organization_id,
    name:
      input.metadata.requirement.description ??
      input.metadata.requirement.partNumber ??
      input.job.title,
    normalized_key: normalizeUploadStem(normalizedKeySource),
    cad_file_id: cadFile?.id ?? null,
    drawing_file_id: drawingFile?.id ?? null,
    quantity: input.metadata.requirement.quantity,
    created_at: input.job.created_at,
    updated_at: input.metadata.extraction.updatedAt ?? input.job.updated_at,
    cadFile,
    drawingFile,
    extraction: null,
    approvedRequirement: null,
    clientRequirement: input.metadata.requirement,
    clientExtraction: input.metadata.extraction,
    vendorQuotes: input.vendorQuotes.filter((quote) => quote.part_id === input.metadata.partId),
  };
}
