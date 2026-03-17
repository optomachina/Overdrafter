import type {
  ApprovedPartRequirement,
  ClientExtractionDiagnostics,
  ClientPartMetadataRecord,
  ClientPartRequirementView,
  DebugExtractionRunRecord,
  DebugExtractionRunSummary,
  DrawingExtractionData,
  DrawingExtractionRecord,
  DrawingPreviewAssetRecord,
  DrawingPreviewData,
  JobAggregate,
  JobSummaryMetrics,
  PartAggregate,
  VendorQuoteAggregate,
  VendorQuoteOfferRecord,
  VendorQuoteResultRecord,
  PublishedPackageAggregate,
  QuoteRunAggregate,
  RequirementFieldName,
  RequirementFieldOwnership,
  RequirementFieldResolution,
} from "@/features/quotes/types";
import type { ClientOptionKind, Json, VendorName } from "@/integrations/supabase/types";
import { readRfqLineItemExtendedMetadata } from "@/features/quotes/rfq-metadata";
import {
  formatRequestedQuoteQuantitiesInput,
  normalizeRequestedQuoteQuantities,
} from "@/features/quotes/request-intake";
import {
  normalizeRequestedServiceIntent,
  requestedServicesRequireMaterial,
  requestedServicesSupportQuoteFields,
} from "@/features/quotes/service-intent";

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

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readSpecSnapshotString(
  specSnapshot: Json | null | undefined,
  key: string,
): string | null {
  const value = asObject(specSnapshot)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readSpecSnapshotStringArray(
  specSnapshot: Json | null | undefined,
  key: string,
): string[] {
  const value = asObject(specSnapshot)[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function readSpecSnapshotBoolean(
  specSnapshot: Json | null | undefined,
  parentKey: string,
  key: string,
): boolean | null {
  const parent = asObject(asObject(specSnapshot)[parentKey]);
  const value = parent[key];
  return typeof value === "boolean" ? value : null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asStringArray(value: unknown): string[] {
  return asArray<unknown>(value)
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function normalizeEvidence(extraction: DrawingExtractionRecord | null): DrawingExtractionData["evidence"] {
  return asArray<Record<string, unknown>>(extraction?.evidence).map((item) => ({
    field: String(item.field ?? "unknown"),
    page: Number(item.page ?? 0),
    snippet: String(item.snippet ?? ""),
    confidence: Number(item.confidence ?? 0),
    reasons: asStringArray(item.reasons),
  }));
}

function hasExplicitReviewFlag(field: Record<string, unknown>) {
  return typeof field.reviewNeeded === "boolean";
}

function normalizeComparableString(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toUpperCase() : null;
}

function isExtractionNewerThanApproved(
  extraction: DrawingExtractionRecord | null | undefined,
  approved: PartAggregate["approvedRequirement"] | null | undefined,
) {
  const extractionTimestamp = extraction?.updated_at ? Date.parse(extraction.updated_at) : Number.NaN;
  const approvedTimestamp = approved?.updated_at ? Date.parse(approved.updated_at) : Number.NaN;

  if (!Number.isFinite(extractionTimestamp)) {
    return false;
  }

  if (!Number.isFinite(approvedTimestamp)) {
    return true;
  }

  return extractionTimestamp > approvedTimestamp;
}

function getApprovedFieldValue(
  approved: PartAggregate["approvedRequirement"] | null | undefined,
  field: RequirementFieldName,
) {
  switch (field) {
    case "description":
      return readSpecSnapshotString(approved?.spec_snapshot, "quoteDescription") ?? approved?.description ?? null;
    case "partNumber":
      return approved?.part_number ?? null;
    case "revision":
      return approved?.revision ?? null;
    case "finish":
      return readSpecSnapshotString(approved?.spec_snapshot, "quoteFinish") ?? approved?.finish ?? null;
  }
}

function getExtractionFieldValue(extraction: DrawingExtractionData, field: RequirementFieldName) {
  switch (field) {
    case "description":
      return extraction.quoteDescription ?? extraction.description ?? null;
    case "partNumber":
      return extraction.partNumber ?? null;
    case "revision":
      return extraction.revision ?? null;
    case "finish":
      return extraction.quoteFinish ?? extraction.finish.normalized ?? extraction.finish.raw ?? null;
  }
}

function isExtractionFieldReviewBlocked(extraction: DrawingExtractionData, field: RequirementFieldName) {
  switch (field) {
    case "description":
      return extraction.rawFields.description.reviewNeeded;
    case "partNumber":
      return extraction.rawFields.partNumber.reviewNeeded;
    case "revision":
      return extraction.rawFields.revision.reviewNeeded;
    case "finish":
      return extraction.rawFields.finish.reviewNeeded || extraction.finish.reviewNeeded;
  }
}

function getApprovedFieldOwnership(
  approved: PartAggregate["approvedRequirement"] | null | undefined,
  field: RequirementFieldName,
): RequirementFieldOwnership | null {
  if (!approved) {
    return null;
  }

  const hasExplicitOverride = readSpecSnapshotBoolean(approved.spec_snapshot, "fieldOverrides", field);

  if (hasExplicitOverride === true) {
    return "user";
  }

  const fieldSources = asObject(asObject(approved.spec_snapshot).fieldSources);
  const rawSource = fieldSources[field];
  const normalizedSource = typeof rawSource === "string" ? rawSource.trim().toLowerCase() : "";

  if (normalizedSource.length === 0 || normalizedSource === "auto") {
    return "auto";
  }

  return "user";
}

function getClientFieldValue(
  clientRequirement: PartAggregate["clientRequirement"] | null | undefined,
  field: RequirementFieldName,
) {
  switch (field) {
    case "description":
      return clientRequirement?.quoteDescription ?? clientRequirement?.description ?? null;
    case "partNumber":
      return clientRequirement?.partNumber ?? null;
    case "revision":
      return clientRequirement?.revision ?? null;
    case "finish":
      return clientRequirement?.quoteFinish ?? clientRequirement?.finish ?? null;
  }
}

export function resolveRequirementField(
  part: PartAggregate,
  field: RequirementFieldName,
  extraction: DrawingExtractionData = normalizeDrawingExtraction(part.extraction, part.id),
): RequirementFieldResolution {
  const clientValue = getClientFieldValue(part.clientRequirement ?? null, field);

  if (clientValue) {
    return {
      value: clientValue,
      source: "client",
      approvedSource: getApprovedFieldOwnership(part.approvedRequirement, field),
      staleAuto: false,
      extractionNewer: isExtractionNewerThanApproved(part.extraction, part.approvedRequirement),
      reviewBlocked: isExtractionFieldReviewBlocked(extraction, field),
      approvedValue: getApprovedFieldValue(part.approvedRequirement, field),
      extractionValue: getExtractionFieldValue(extraction, field),
    };
  }

  const approvedValue = getApprovedFieldValue(part.approvedRequirement, field);
  const extractionValue = getExtractionFieldValue(extraction, field);
  const approvedSource = getApprovedFieldOwnership(part.approvedRequirement, field);
  const extractionNewer = isExtractionNewerThanApproved(part.extraction, part.approvedRequirement);
  const reviewBlocked = isExtractionFieldReviewBlocked(extraction, field);
  const valuesDiffer =
    normalizeComparableString(approvedValue) !== null &&
    normalizeComparableString(extractionValue) !== null &&
    normalizeComparableString(approvedValue) !== normalizeComparableString(extractionValue);
  const staleAuto =
    approvedSource === "auto" &&
    Boolean(approvedValue) &&
    Boolean(extractionValue) &&
    extractionNewer &&
    !reviewBlocked &&
    valuesDiffer;

  if (staleAuto || (approvedSource !== "user" && !approvedValue && extractionValue && !reviewBlocked)) {
    return {
      value: extractionValue,
      source: "extraction",
      approvedSource,
      staleAuto,
      extractionNewer,
      reviewBlocked,
      approvedValue,
      extractionValue,
    };
  }

  if (!approvedValue && reviewBlocked) {
    return {
      value: null,
      source: "extraction",
      approvedSource,
      staleAuto: false,
      extractionNewer,
      reviewBlocked,
      approvedValue,
      extractionValue,
    };
  }

  if (!approvedValue && approvedSource === "user") {
    return {
      value: null,
      source: "approved_user",
      approvedSource,
      staleAuto: false,
      extractionNewer,
      reviewBlocked,
      approvedValue,
      extractionValue,
    };
  }

  if (approvedValue) {
    return {
      value: approvedValue,
      source: approvedSource === "user" ? "approved_user" : "approved_auto",
      approvedSource,
      staleAuto: false,
      extractionNewer,
      reviewBlocked,
      approvedValue,
      extractionValue,
    };
  }

  return {
    value: extractionValue,
    source: "extraction",
    approvedSource,
    staleAuto: false,
    extractionNewer,
    reviewBlocked,
    approvedValue,
    extractionValue,
  };
}

export function listStaleAutoRequirementFields(part: PartAggregate) {
  const extraction = normalizeDrawingExtraction(part.extraction, part.id);

  return (["description", "partNumber", "revision", "finish"] as const).filter(
    (field) => resolveRequirementField(part, field, extraction).staleAuto,
  );
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
  const extractedDescriptionRaw = asObject(payload.extractedDescriptionRaw);
  const extractedPartNumberRaw = asObject(payload.extractedPartNumberRaw);
  const extractedRevisionRaw = asObject(payload.extractedRevisionRaw);
  const extractedFinishRaw = asObject(payload.extractedFinishRaw);
  const material = asObject(payload.material);
  const finish = asObject(payload.finish);
  const tolerances = asObject(payload.tolerances);
  const warnings = asArray<string>(extraction?.warnings).map(String);
  const storedReviewFields = asStringArray(payload.reviewFields);
  const fieldSelections = asObject(payload.fieldSelections);
  const isLegacyNeedsReviewRecord =
    extraction?.status === "needs_review" &&
    storedReviewFields.length === 0 &&
    !hasExplicitReviewFlag(extractedDescriptionRaw) &&
    !hasExplicitReviewFlag(extractedPartNumberRaw) &&
    !hasExplicitReviewFlag(extractedRevisionRaw) &&
    !hasExplicitReviewFlag(extractedFinishRaw);
  const reviewFields = isLegacyNeedsReviewRecord
    ? ["description", "partNumber", "revision", "material", "finish"]
    : storedReviewFields;
  const descriptionReviewNeeded =
    typeof extractedDescriptionRaw.reviewNeeded === "boolean"
      ? Boolean(extractedDescriptionRaw.reviewNeeded)
      : reviewFields.includes("description");
  const partNumberReviewNeeded =
    typeof extractedPartNumberRaw.reviewNeeded === "boolean"
      ? Boolean(extractedPartNumberRaw.reviewNeeded)
      : reviewFields.includes("partNumber");
  const revisionReviewNeeded =
    typeof extractedRevisionRaw.reviewNeeded === "boolean"
      ? Boolean(extractedRevisionRaw.reviewNeeded)
      : reviewFields.includes("revision");
  const finishReviewNeeded =
    typeof extractedFinishRaw.reviewNeeded === "boolean"
      ? Boolean(extractedFinishRaw.reviewNeeded)
      : reviewFields.includes("finish");
  const materialReviewNeeded =
    typeof material.reviewNeeded === "boolean" ? Boolean(material.reviewNeeded) : reviewFields.includes("material");

  return {
    partId,
    description: (payload.description ?? payload.desc ?? null) as string | null,
    partNumber: (payload.partNumber ?? payload.pn ?? null) as string | null,
    revision: (payload.revision ?? payload.rev ?? null) as string | null,
    workerBuildVersion: typeof payload.workerBuildVersion === "string" ? payload.workerBuildVersion : null,
    extractorVersion: extraction?.extractor_version ?? null,
    quoteDescription: (payload.quoteDescription ?? payload.description ?? payload.desc ?? null) as string | null,
    quoteFinish:
      (payload.quoteFinish ?? finish.normalized ?? finish.raw ?? payload.finish ?? null) as string | null,
    model: {
      fallbackUsed: Boolean(payload.modelFallbackUsed),
      name: typeof payload.modelName === "string" ? payload.modelName : null,
      promptVersion: typeof payload.modelPromptVersion === "string" ? payload.modelPromptVersion : null,
    },
    fieldSelections: {
      description:
        typeof fieldSelections.description === "string" ? (fieldSelections.description as "parser" | "model" | "review") : undefined,
      partNumber:
        typeof fieldSelections.partNumber === "string" ? (fieldSelections.partNumber as "parser" | "model" | "review") : undefined,
      revision:
        typeof fieldSelections.revision === "string" ? (fieldSelections.revision as "parser" | "model" | "review") : undefined,
      material:
        typeof fieldSelections.material === "string" ? (fieldSelections.material as "parser" | "model" | "review") : undefined,
      finish:
        typeof fieldSelections.finish === "string" ? (fieldSelections.finish as "parser" | "model" | "review") : undefined,
      process:
        typeof fieldSelections.process === "string" ? (fieldSelections.process as "parser" | "model" | "review") : undefined,
    },
    rawFields: {
      description: {
        raw: (extractedDescriptionRaw.value ?? payload.description ?? payload.desc ?? null) as string | null,
        confidence: Number(extractedDescriptionRaw.confidence ?? extraction?.confidence ?? 0),
        reviewNeeded: descriptionReviewNeeded,
        reasons: asStringArray(extractedDescriptionRaw.reasons),
      },
      partNumber: {
        raw: (extractedPartNumberRaw.value ?? payload.partNumber ?? payload.pn ?? null) as string | null,
        confidence: Number(extractedPartNumberRaw.confidence ?? extraction?.confidence ?? 0),
        reviewNeeded: partNumberReviewNeeded,
        reasons: asStringArray(extractedPartNumberRaw.reasons),
      },
      revision: {
        raw: (extractedRevisionRaw.value ?? payload.revision ?? payload.rev ?? null) as string | null,
        confidence: Number(extractedRevisionRaw.confidence ?? extraction?.confidence ?? 0),
        reviewNeeded: revisionReviewNeeded,
        reasons: asStringArray(extractedRevisionRaw.reasons),
      },
      finish: {
        raw: (extractedFinishRaw.value ?? finish.raw ?? finish.raw_text ?? payload.finish ?? null) as string | null,
        confidence: Number(extractedFinishRaw.confidence ?? extraction?.confidence ?? 0),
        reviewNeeded: finishReviewNeeded,
        reasons: asStringArray(extractedFinishRaw.reasons),
      },
    },
    material: {
      raw: (material.raw ?? material.raw_text ?? null) as string | null,
      normalized: (material.normalized ?? null) as string | null,
      confidence: Number(material.confidence ?? extraction?.confidence ?? 0),
      reviewNeeded: materialReviewNeeded,
      reasons: asStringArray(material.reasons),
    },
    finish: {
      raw: (finish.raw ?? finish.raw_text ?? null) as string | null,
      normalized: (finish.normalized ?? null) as string | null,
      confidence: Number(finish.confidence ?? extraction?.confidence ?? 0),
      reviewNeeded: Boolean(finish.reviewNeeded),
      reasons: asStringArray(finish.reasons),
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
    reviewFields,
    status: extraction?.status ?? "needs_review",
  };
}

export function normalizeDebugExtractionRun(
  run: DebugExtractionRunRecord | null,
  partId: string,
): {
  summary: DebugExtractionRunSummary | null;
  extraction: DrawingExtractionData | null;
} {
  if (!run) {
    return {
      summary: null,
      extraction: null,
    };
  }

  const result = asObject(run.result);
  const extractionPayload = asObject(result.extraction);
  const extractionRecord: DrawingExtractionRecord | null =
    Object.keys(extractionPayload).length > 0
      ? ({
          id: run.id,
          part_id: run.part_id,
          organization_id: run.organization_id,
          extractor_version: run.extractor_version ?? "debug",
          extraction: extractionPayload as Json,
          confidence: null,
          warnings: (result.warnings ?? []) as Json,
          evidence: (result.evidence ?? []) as Json,
          status: result.status === "approved" ? "approved" : "needs_review",
          created_at: run.created_at,
          updated_at: run.updated_at,
        } as DrawingExtractionRecord)
      : null;

  return {
    summary: {
      id: run.id,
      jobId: run.job_id,
      partId: run.part_id,
      requestedModel: run.requested_model,
      effectiveModel: run.effective_model,
      workerBuildVersion: run.worker_build_version,
      extractorVersion: run.extractor_version,
      modelFallbackUsed: run.model_fallback_used,
      modelPromptVersion: run.model_prompt_version,
      status: run.status,
      error: run.error,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      result: run.result,
    },
    extraction: extractionRecord ? normalizeDrawingExtraction(extractionRecord, partId) : null,
  };
}

export function normalizeDrawingPreview(
  extraction: DrawingExtractionRecord | ClientExtractionDiagnostics | null,
  previewAssets: DrawingPreviewAssetRecord[],
): DrawingPreviewData {
  const extractedPageCount =
    extraction && "pageCount" in extraction
      ? Number(extraction.pageCount ?? 0)
      : (() => {
          const payload =
            extraction && "extraction" in extraction ? asObject(extraction.extraction) : {};
          const rawPageCount = payload.pageCount;
          return typeof rawPageCount === "number" ? rawPageCount : Number(rawPageCount ?? 0);
        })();
  const pageAssets = previewAssets
    .filter((asset) => asset.kind === "page")
    .sort((left, right) => left.page_number - right.page_number)
    .map((asset) => ({
      pageNumber: asset.page_number,
      storageBucket: asset.storage_bucket,
      storagePath: asset.storage_path,
      width: asset.width,
      height: asset.height,
    }));
  const thumbnailAsset = previewAssets.find((asset) => asset.kind === "thumbnail") ?? null;
  const assetPageCount = pageAssets.reduce((maxPage, asset) => Math.max(maxPage, asset.pageNumber), 0);

  return {
    pageCount: Math.max(extractedPageCount, assetPageCount, 0),
    thumbnail: thumbnailAsset
      ? {
          pageNumber: thumbnailAsset.page_number,
          storageBucket: thumbnailAsset.storage_bucket,
          storagePath: thumbnailAsset.storage_path,
          width: thumbnailAsset.width,
          height: thumbnailAsset.height,
        }
      : null,
    pages: pageAssets,
  };
}

export function normalizeClientPartMetadata(
  value: Json | null | undefined,
): ClientPartMetadataRecord | null {
  const payload = asObject(value);
  const partId = typeof payload.partId === "string" ? payload.partId : null;
  const jobId = typeof payload.jobId === "string" ? payload.jobId : null;
  const organizationId = typeof payload.organizationId === "string" ? payload.organizationId : null;

  if (!partId || !jobId || !organizationId) {
    return null;
  }

  const quantityCandidate = Number(payload.quantity ?? 1);
  const warningCountCandidate = Number(payload.warningCount ?? 0);
  const pageCountCandidate = Number(payload.pageCount ?? 0);

  return {
    partId,
    jobId,
    organizationId,
    requirement: {
      description: typeof payload.description === "string" ? payload.description : null,
      partNumber: typeof payload.partNumber === "string" ? payload.partNumber : null,
      revision: typeof payload.revision === "string" ? payload.revision : null,
      quoteDescription: typeof payload.quoteDescription === "string" ? payload.quoteDescription : null,
      material: typeof payload.material === "string" ? payload.material : "",
      finish: typeof payload.finish === "string" ? payload.finish : null,
      quoteFinish: typeof payload.quoteFinish === "string" ? payload.quoteFinish : null,
      tightestToleranceInch:
        typeof payload.tightestToleranceInch === "number"
          ? payload.tightestToleranceInch
          : Number.isFinite(Number(payload.tightestToleranceInch))
            ? Number(payload.tightestToleranceInch)
            : null,
      process: typeof payload.process === "string" ? payload.process : null,
      notes: typeof payload.notes === "string" ? payload.notes : null,
      quantity:
        Number.isFinite(quantityCandidate) && quantityCandidate > 0
          ? Math.max(1, Math.trunc(quantityCandidate))
          : 1,
      quoteQuantities: normalizeRequestedQuoteQuantities(asArray<number>(payload.quoteQuantities), quantityCandidate),
      requestedByDate: typeof payload.requestedByDate === "string" ? payload.requestedByDate : null,
    },
    extraction: {
      lifecycle:
        payload.lifecycle === "queued" ||
        payload.lifecycle === "extracting" ||
        payload.lifecycle === "succeeded" ||
        payload.lifecycle === "partial" ||
        payload.lifecycle === "failed"
          ? payload.lifecycle
          : "uploaded",
      warningCount:
        Number.isFinite(warningCountCandidate) && warningCountCandidate >= 0
          ? warningCountCandidate
          : 0,
      warnings: asStringArray(payload.warnings),
      missingFields: asStringArray(payload.missingFields),
      reviewFields: asStringArray(payload.reviewFields),
      lastFailureCode: typeof payload.lastFailureCode === "string" ? payload.lastFailureCode : null,
      lastFailureMessage: typeof payload.lastFailureMessage === "string" ? payload.lastFailureMessage : null,
      extractedAt: typeof payload.extractedAt === "string" ? payload.extractedAt : null,
      failedAt: typeof payload.failedAt === "string" ? payload.failedAt : null,
      updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : null,
      pageCount:
        Number.isFinite(pageCountCandidate) && pageCountCandidate >= 0 ? Math.trunc(pageCountCandidate) : 0,
      hasCadFile: Boolean(payload.hasCadFile),
      hasDrawingFile: Boolean(payload.hasDrawingFile),
    },
  };
}

export function countPartExtractionWarnings(part: PartAggregate | null | undefined): number {
  if (!part) {
    return 0;
  }

  if (part.clientExtraction) {
    return part.clientExtraction.warningCount;
  }

  return normalizeDrawingExtraction(part.extraction, part.id).warnings.length;
}

type RequirementDraftSeedInput = {
  parts: PartAggregate[];
  currentDrafts: Record<string, ApprovedPartRequirement>;
  currentQuoteQuantityInputs: Record<string, string>;
  jobRequest?: {
    requested_quote_quantities: number[];
    requested_by_date: string | null;
    requested_service_kinds?: string[] | null;
    primary_service_kind?: string | null;
    service_notes?: string | null;
  } | null;
};

export function mergeRequirementDraftState(input: RequirementDraftSeedInput) {
  const drafts = Object.fromEntries(
    input.parts.map((part) => [
      part.id,
      input.currentDrafts[part.id] ?? buildRequirementDraft(part, input.jobRequest),
    ]),
  );
  const quoteQuantityInputs = Object.fromEntries(
    input.parts.map((part) => [
      part.id,
      input.currentQuoteQuantityInputs[part.id] ??
        formatRequestedQuoteQuantitiesInput(drafts[part.id].quoteQuantities),
    ]),
  );

  return {
    drafts,
    quoteQuantityInputs,
  };
}

export function buildRequirementDraft(
  part: PartAggregate,
  jobRequest?: {
    requested_quote_quantities: number[];
    requested_by_date: string | null;
    requested_service_kinds?: string[] | null;
    primary_service_kind?: string | null;
    service_notes?: string | null;
  } | null,
): ApprovedPartRequirement {
  const normalizedExtraction = normalizeDrawingExtraction(part.extraction, part.id);
  const approved = part.approvedRequirement;
  const clientRequirement = part.clientRequirement ?? null;
  const descriptionResolution = resolveRequirementField(part, "description", normalizedExtraction);
  const partNumberResolution = resolveRequirementField(part, "partNumber", normalizedExtraction);
  const revisionResolution = resolveRequirementField(part, "revision", normalizedExtraction);
  const finishResolution = resolveRequirementField(part, "finish", normalizedExtraction);
  const serviceIntent = normalizeRequestedServiceIntent({
    requestedServiceKinds: readSpecSnapshotStringArray(approved?.spec_snapshot, "requestedServiceKinds")
      .concat(jobRequest?.requested_service_kinds ?? []),
    primaryServiceKind:
      readSpecSnapshotString(approved?.spec_snapshot, "primaryServiceKind") ??
      jobRequest?.primary_service_kind ??
      null,
    serviceNotes:
      readSpecSnapshotString(approved?.spec_snapshot, "serviceNotes") ??
      jobRequest?.service_notes ??
      null,
  });
  const process = readSpecSnapshotString(approved?.spec_snapshot, "process");
  const notes = readSpecSnapshotString(approved?.spec_snapshot, "notes");
  const metadata = readRfqLineItemExtendedMetadata(approved?.spec_snapshot);
  const showQuoteFields = requestedServicesSupportQuoteFields(serviceIntent.requestedServiceKinds);
  const materialRequired = requestedServicesRequireMaterial(serviceIntent.requestedServiceKinds);
  const quantity =
    clientRequirement?.quantity ??
    approved?.quantity ??
    part.quantity ??
    jobRequest?.requested_quote_quantities?.[0] ??
    1;
  const quoteQuantities = normalizeRequestedQuoteQuantities(
    clientRequirement?.quoteQuantities ??
      approved?.quote_quantities ??
      jobRequest?.requested_quote_quantities ??
      [],
    quantity,
  );

  return {
    partId: part.id,
    requestedServiceKinds: serviceIntent.requestedServiceKinds,
    primaryServiceKind: serviceIntent.primaryServiceKind,
    serviceNotes: serviceIntent.serviceNotes,
    description: descriptionResolution.value,
    partNumber: partNumberResolution.value,
    revision: revisionResolution.value,
    material:
      clientRequirement?.material ??
      approved?.material ??
      normalizedExtraction.material.normalized ??
      normalizedExtraction.material.raw ??
      (materialRequired ? "Unknown material" : ""),
    finish: finishResolution.value,
    tightestToleranceInch:
      clientRequirement?.tightestToleranceInch ??
      approved?.tightest_tolerance_inch ??
      normalizedExtraction.tightestTolerance.valueInch,
    process: clientRequirement?.process ?? process,
    notes: clientRequirement?.notes ?? notes,
    quantity,
    quoteQuantities,
    requestedByDate:
      clientRequirement?.requestedByDate ??
      approved?.requested_by_date ??
      jobRequest?.requested_by_date ??
      null,
    shipping: metadata.shipping,
    certifications: metadata.certifications,
    sourcing: metadata.sourcing,
    release: metadata.release,
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
  requestedQuantity: number;
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

function mapOfferRecord(offer: VendorQuoteOfferRecord, requestedQuantity: number): ImportedVendorOffer {
  return {
    id: offer.id,
    offerId: offer.offer_key,
    requestedQuantity,
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
  const quoteRequestedQuantityCandidate =
    "requested_quantity" in quote && typeof quote.requested_quantity === "number"
      ? quote.requested_quantity
      : Number(asObject(quote.raw_payload).requestedQuantity ?? 1);
  const quoteRequestedQuantity =
    Number.isFinite(quoteRequestedQuantityCandidate) && quoteRequestedQuantityCandidate > 0
      ? Math.max(1, Math.trunc(quoteRequestedQuantityCandidate))
      : 1;

  if ("offers" in quote && Array.isArray(quote.offers) && quote.offers.length > 0) {
    return [...quote.offers]
      .sort((left, right) => {
        if (left.sort_rank !== right.sort_rank) {
          return left.sort_rank - right.sort_rank;
        }

        return (left.total_price_usd ?? Number.MAX_SAFE_INTEGER) - (right.total_price_usd ?? Number.MAX_SAFE_INTEGER);
      })
      .map((offer) => mapOfferRecord(offer, quoteRequestedQuantity));
  }

  const payload = asObject(quote.raw_payload);
  const offers = asArray<Record<string, unknown>>(payload.offers as Json | undefined);

  return offers
    .map((offer) => ({
      id: null,
      offerId: String(offer.offerId ?? ""),
      requestedQuantity:
        Number.isFinite(Number(offer.requestedQuantity))
          ? Number(offer.requestedQuantity)
          : quoteRequestedQuantity,
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
