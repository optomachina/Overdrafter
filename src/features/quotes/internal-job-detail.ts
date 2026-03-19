import {
  createCadPreviewSourceFromJobFile,
  isStepPreviewableFile,
  type CadPreviewSource,
} from "@/lib/cad-preview";
import { formatRequestedQuoteQuantitiesInput } from "@/features/quotes/request-intake";
import {
  collectRequestedQuantities,
  type RequestedQuantityFilterValue,
} from "@/features/quotes/request-scenarios";
import { requestedServicesSupportQuoteFields } from "@/features/quotes/service-intent";
import type {
  ApprovedPartRequirement,
  DrawingExtractionData,
  JobAggregate,
  JobRecord,
  PartAggregate,
  PublishedPackageAggregate,
  QuoteRunAggregate,
  RequirementFieldDisplaySource,
  RequirementFieldResolution,
  VendorQuoteAggregate,
} from "@/features/quotes/types";
import {
  buildRequirementDraft,
  getLatestPublishedPackage,
  getLatestQuoteRun,
  mergeRequirementDraftState,
  normalizeDrawingExtraction,
  optionLabelForKind,
  resolveRequirementField,
} from "@/features/quotes/utils";

export const INTERNAL_JOB_VENDORS = ["xometry", "fictiv", "protolabs", "sendcutsend"] as const;

export type InternalJobPartViewModel = {
  part: PartAggregate;
  draft: ApprovedPartRequirement;
  extraction: DrawingExtractionData;
  cadPreviewSource: CadPreviewSource | null;
  cadPreviewable: boolean;
  quoteQuantityInput: string;
  showQuoteFields: boolean;
  descriptionResolution: RequirementFieldResolution;
  partNumberResolution: RequirementFieldResolution;
  revisionResolution: RequirementFieldResolution;
  finishResolution: RequirementFieldResolution;
  descriptionSelectedBy: "parser" | "model" | "review";
  partNumberSelectedBy: "parser" | "model" | "review";
  revisionSelectedBy: "parser" | "model" | "review";
  materialSelectedBy: "parser" | "model" | "review";
  finishSelectedBy: "parser" | "model" | "review";
  extractedFinishRaw: string | null;
  finishReviewNeeded: boolean;
  finishConfidence: number;
};

type InternalJobDraftState = {
  drafts: Record<string, ApprovedPartRequirement>;
  quoteQuantityInputs: Record<string, string>;
};

type InternalJobDraftMergeInput = {
  parts: PartAggregate[];
  currentDrafts: Record<string, ApprovedPartRequirement>;
  currentQuoteQuantityInputs: Record<string, string>;
  job: JobRecord;
};

type InternalJobPartViewModelInput = {
  parts: PartAggregate[];
  drafts: Record<string, ApprovedPartRequirement>;
  quoteQuantityInputs: Record<string, string>;
  job: JobRecord;
  cadPreviewSources: Map<string, CadPreviewSource>;
};

export function getInternalJobRefetchInterval(job: JobAggregate | undefined): number | false {
  if (!job) {
    return false;
  }

  const hasInFlightDebugRun = (job.debugExtractionRuns ?? []).some(
    (run) => run.status === "queued" || run.status === "running",
  );
  const hasInFlightDebugTask = job.workQueue.some(
    (task) =>
      task.task_type === "debug_extract_part" &&
      (task.status === "queued" || task.status === "running"),
  );

  return hasInFlightDebugRun || hasInFlightDebugTask ? 2500 : false;
}

export function buildInternalJobCadPreviewSources(
  parts: PartAggregate[] | undefined,
): Map<string, CadPreviewSource> {
  return new Map(
    (parts ?? [])
      .filter((part) => Boolean(part.cadFile))
      .map((part) => [part.id, createCadPreviewSourceFromJobFile(part.cadFile!)]),
  );
}

export function buildInternalJobOptionKindsByOfferId(
  latestPackage: PublishedPackageAggregate | null,
): Map<string, string[]> {
  const mapping = new Map<string, string[]>();

  latestPackage?.options.forEach((option) => {
    if (!option.source_vendor_quote_offer_id) {
      return;
    }

    const current = mapping.get(option.source_vendor_quote_offer_id) ?? [];
    current.push(optionLabelForKind(option.option_kind));
    mapping.set(option.source_vendor_quote_offer_id, current);
  });

  return mapping;
}

export function getInternalJobQuoteRows(
  latestQuoteRun: QuoteRunAggregate | null,
): VendorQuoteAggregate[] {
  return latestQuoteRun?.vendorQuotes ?? [];
}

export function getInternalJobCompareQuantities(input: {
  quoteRows: VendorQuoteAggregate[];
  drafts: Record<string, ApprovedPartRequirement>;
  job: JobAggregate | undefined;
}): number[] {
  return collectRequestedQuantities(
    [
      input.quoteRows.map((quote) => quote.requested_quantity),
      Object.values(input.drafts).flatMap((draft) => draft.quoteQuantities),
      input.job?.job.requested_quote_quantities,
    ],
    input.job?.parts[0]?.quantity ?? null,
  );
}

export function getInternalJobVisibleQuoteRows(input: {
  quoteRows: VendorQuoteAggregate[];
  activeCompareRequestedQuantity: RequestedQuantityFilterValue | null;
}): VendorQuoteAggregate[] {
  const nextRows =
    input.activeCompareRequestedQuantity === "all" || input.activeCompareRequestedQuantity === null
      ? input.quoteRows
      : input.quoteRows.filter(
          (quote) => quote.requested_quantity === input.activeCompareRequestedQuantity,
        );

  return [...nextRows].sort((left, right) => {
    if (left.requested_quantity !== right.requested_quantity) {
      return left.requested_quantity - right.requested_quantity;
    }

    if (left.part_id !== right.part_id) {
      return left.part_id.localeCompare(right.part_id);
    }

    return left.vendor.localeCompare(right.vendor);
  });
}

export function getInternalJobExtractionSourceLabel(
  selectedBy: "parser" | "model" | "review",
): string {
  switch (selectedBy) {
    case "model":
      return "model fallback";
    case "review":
      return "manual review";
    default:
      return "parser";
  }
}

export function getInternalJobDraftSourceLabel(
  source: RequirementFieldDisplaySource,
): string {
  switch (source) {
    case "client":
      return "client request";
    case "approved_user":
      return "approved user value";
    case "approved_auto":
      return "approved auto value";
    default:
      return "fresher extraction";
  }
}

export function mergeInternalJobDraftState(
  input: InternalJobDraftMergeInput,
): InternalJobDraftState {
  return mergeRequirementDraftState({
    parts: input.parts,
    currentDrafts: input.currentDrafts,
    currentQuoteQuantityInputs: input.currentQuoteQuantityInputs,
    jobRequest: {
      requested_service_kinds: input.job.requested_service_kinds ?? [],
      primary_service_kind: input.job.primary_service_kind ?? null,
      service_notes: input.job.service_notes ?? null,
      requested_quote_quantities: input.job.requested_quote_quantities ?? [],
      requested_by_date: input.job.requested_by_date ?? null,
    },
  });
}

export function buildInternalJobPartViewModels(
  input: InternalJobPartViewModelInput,
): InternalJobPartViewModel[] {
  return input.parts.map((part) => {
    const extraction = normalizeDrawingExtraction(part.extraction, part.id);
    const draft =
      input.drafts[part.id] ??
      buildRequirementDraft(part, {
        requested_service_kinds: input.job.requested_service_kinds ?? [],
        primary_service_kind: input.job.primary_service_kind ?? null,
        service_notes: input.job.service_notes ?? null,
        requested_quote_quantities: input.job.requested_quote_quantities ?? [],
        requested_by_date: input.job.requested_by_date ?? null,
      });
    const cadPreviewSource = input.cadPreviewSources.get(part.id) ?? null;
    const cadPreviewable = part.cadFile
      ? isStepPreviewableFile(part.cadFile.original_name)
      : false;
    const quoteQuantityInput =
      input.quoteQuantityInputs[part.id] ??
      formatRequestedQuoteQuantitiesInput(draft.quoteQuantities);
    const descriptionResolution = resolveRequirementField(part, "description", extraction);
    const partNumberResolution = resolveRequirementField(part, "partNumber", extraction);
    const revisionResolution = resolveRequirementField(part, "revision", extraction);
    const finishResolution = resolveRequirementField(part, "finish", extraction);
    const descriptionSelectedBy = extraction.fieldSelections?.description ?? "parser";
    const partNumberSelectedBy = extraction.fieldSelections?.partNumber ?? "parser";
    const revisionSelectedBy = extraction.fieldSelections?.revision ?? "parser";
    const materialSelectedBy = extraction.fieldSelections?.material ?? "parser";
    const finishSelectedBy = extraction.fieldSelections?.finish ?? "parser";
    const extractedFinishRaw = extraction.rawFields.finish.raw ?? extraction.finish.raw ?? null;
    const finishUsesRawField = Boolean(extraction.rawFields.finish.raw);
    const finishReviewNeeded = finishUsesRawField
      ? extraction.rawFields.finish.reviewNeeded
      : extraction.finish.reviewNeeded;
    const finishConfidence = finishUsesRawField
      ? extraction.rawFields.finish.confidence
      : extraction.finish.confidence;

    return {
      part,
      draft,
      extraction,
      cadPreviewSource,
      cadPreviewable,
      quoteQuantityInput,
      showQuoteFields: requestedServicesSupportQuoteFields(draft.requestedServiceKinds),
      descriptionResolution,
      partNumberResolution,
      revisionResolution,
      finishResolution,
      descriptionSelectedBy,
      partNumberSelectedBy,
      revisionSelectedBy,
      materialSelectedBy,
      finishSelectedBy,
      extractedFinishRaw,
      finishReviewNeeded,
      finishConfidence,
    };
  });
}

export function getInternalJobLatestQuoteRun(
  job: JobAggregate | undefined,
): QuoteRunAggregate | null {
  return job ? getLatestQuoteRun(job) : null;
}

export function getInternalJobLatestPackage(
  job: JobAggregate | undefined,
): PublishedPackageAggregate | null {
  return job ? getLatestPublishedPackage(job) : null;
}
