import { useEffect, useMemo, useRef, useState } from "react";
import { createCadPreviewSourceFromJobFile } from "@/lib/cad-preview";
import type {
  ApprovedPartRequirement,
  JobAggregate,
  PartAggregate,
  PublishedPackageAggregate,
  QuoteRunAggregate,
  VendorQuoteAggregate,
} from "@/features/quotes/types";
import {
  collectRequestedQuantities,
  normalizeApprovedRequirementDraft,
  resolveRequestedQuantitySelection,
  type RequestedQuantityFilterValue,
} from "@/features/quotes/request-scenarios";
import {
  buildRequirementDraft,
  getLatestPublishedPackage,
  mergeRequirementDraftState,
  optionLabelForKind,
} from "@/features/quotes/utils";
import {
  formatRequestedQuoteQuantitiesInput,
  parseRequestedQuoteQuantitiesInput,
} from "@/features/quotes/request-intake";

export const INTERNAL_JOB_DETAIL_VENDORS = ["xometry", "fictiv", "protolabs", "sendcutsend"] as const;

export function buildOptionKindsByOfferId(latestPackage: PublishedPackageAggregate | null) {
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

export function buildVisibleQuoteRows(
  quoteRows: VendorQuoteAggregate[],
  activeCompareRequestedQuantity: RequestedQuantityFilterValue | null,
) {
  const filteredRows =
    activeCompareRequestedQuantity === "all" || activeCompareRequestedQuantity === null
      ? quoteRows
      : quoteRows.filter((quote) => quote.requested_quantity === activeCompareRequestedQuantity);

  return [...filteredRows].sort((left, right) => {
    if (left.requested_quantity !== right.requested_quantity) {
      return left.requested_quantity - right.requested_quantity;
    }

    if (left.part_id !== right.part_id) {
      return left.part_id.localeCompare(right.part_id);
    }

    return left.vendor.localeCompare(right.vendor);
  });
}

function buildJobRequestDefaults(job: JobAggregate | null) {
  return {
    requested_service_kinds: job?.job.requested_service_kinds ?? [],
    primary_service_kind: job?.job.primary_service_kind ?? null,
    service_notes: job?.job.service_notes ?? null,
    requested_quote_quantities: job?.job.requested_quote_quantities ?? [],
    requested_by_date: job?.job.requested_by_date ?? null,
  };
}

export function resolveClientSummary({
  current,
  didJobChange,
  jobTitle,
  latestPackageSummary,
}: {
  current: string;
  didJobChange: boolean;
  jobTitle: string;
  latestPackageSummary: string | null | undefined;
}) {
  const nextSummary = latestPackageSummary || `Curated CNC quote package for ${jobTitle}.`;

  if (didJobChange) {
    return nextSummary;
  }

  return current || nextSummary;
}

type UseInternalJobDetailViewModelOptions = {
  job: JobAggregate | null;
  latestQuoteRun: QuoteRunAggregate | null;
};

export function useInternalJobDetailViewModel({
  job,
  latestQuoteRun,
}: UseInternalJobDetailViewModelOptions) {
  const [drafts, setDrafts] = useState<Record<string, ApprovedPartRequirement>>({});
  const [quoteQuantityInputs, setQuoteQuantityInputs] = useState<Record<string, string>>({});
  const [clientSummary, setClientSummary] = useState("");
  const [activeCompareRequestedQuantity, setActiveCompareRequestedQuantity] =
    useState<RequestedQuantityFilterValue | null>(null);
  const draftStateRef = useRef<{
    drafts: Record<string, ApprovedPartRequirement>;
    quoteQuantityInputs: Record<string, string>;
  }>({
    drafts: {},
    quoteQuantityInputs: {},
  });
  const previousJobIdRef = useRef<string | null>(null);

  const jobRequestDefaults = useMemo(() => buildJobRequestDefaults(job), [job]);
  const latestPackage = useMemo(() => (job ? getLatestPublishedPackage(job) : null), [job]);
  const cadPreviewSources = useMemo(
    () =>
      new Map(
        (job?.parts ?? [])
          .filter((part) => Boolean(part.cadFile))
          .map((part) => [part.id, createCadPreviewSourceFromJobFile(part.cadFile!)]),
      ),
    [job?.parts],
  );
  const quoteRows = useMemo(() => latestQuoteRun?.vendorQuotes ?? [], [latestQuoteRun?.vendorQuotes]);
  const optionKindsByOfferId = useMemo(() => buildOptionKindsByOfferId(latestPackage), [latestPackage]);
  const compareQuantities = useMemo(
    () =>
      collectRequestedQuantities(
        [
          quoteRows.map((quote) => quote.requested_quantity),
          Object.values(drafts).flatMap((draft) => draft.quoteQuantities),
          job?.job.requested_quote_quantities,
        ],
        job?.parts[0]?.quantity ?? null,
      ),
    [drafts, job?.job.requested_quote_quantities, job?.parts, quoteRows],
  );
  const visibleQuoteRows = useMemo(
    () => buildVisibleQuoteRows(quoteRows, activeCompareRequestedQuantity),
    [activeCompareRequestedQuantity, quoteRows],
  );

  useEffect(() => {
    setActiveCompareRequestedQuantity((current) =>
      resolveRequestedQuantitySelection({
        availableQuantities: compareQuantities,
        currentSelection: current,
        preferredQuantity: compareQuantities[0] ?? null,
        allowAll: true,
      }),
    );
  }, [compareQuantities]);

  useEffect(() => {
    draftStateRef.current = {
      drafts,
      quoteQuantityInputs,
    };
  }, [drafts, quoteQuantityInputs]);

  useEffect(() => {
    if (!job) {
      return;
    }

    const didJobChange = previousJobIdRef.current !== job.job.id;

    const nextDraftState = mergeRequirementDraftState({
      parts: job.parts,
      currentDrafts: draftStateRef.current.drafts,
      currentQuoteQuantityInputs: draftStateRef.current.quoteQuantityInputs,
      jobRequest: jobRequestDefaults,
    });

    setDrafts(nextDraftState.drafts);
    setQuoteQuantityInputs(nextDraftState.quoteQuantityInputs);
    setClientSummary((current) =>
      resolveClientSummary({
        current,
        didJobChange,
        jobTitle: job.job.title,
        latestPackageSummary: latestPackage?.client_summary,
      }),
    );
    previousJobIdRef.current = job.job.id;
  }, [job, jobRequestDefaults, latestPackage?.client_summary]);

  const updateDraft = (
    partId: string,
    updater: (current: ApprovedPartRequirement) => ApprovedPartRequirement,
  ) => {
    setDrafts((current) => ({
      ...current,
      [partId]: updater(current[partId]),
    }));
  };

  const getDraftForPart = (part: PartAggregate) =>
    drafts[part.id] ?? buildRequirementDraft(part, jobRequestDefaults);

  const getQuoteQuantityInput = (partId: string, draft: ApprovedPartRequirement) =>
    quoteQuantityInputs[partId] ?? formatRequestedQuoteQuantitiesInput(draft.quoteQuantities);

  const setDraftQuantity = (partId: string, draft: ApprovedPartRequirement, quantity: number) => {
    const nextDraft = normalizeApprovedRequirementDraft({
      ...draft,
      quantity,
    });

    setQuoteQuantityInputs((current) => ({
      ...current,
      [partId]: formatRequestedQuoteQuantitiesInput(nextDraft.quoteQuantities),
    }));
    updateDraft(partId, () => nextDraft);
  };

  const commitQuoteQuantityInput = (partId: string, draft: ApprovedPartRequirement) => {
    const nextDraft = normalizeApprovedRequirementDraft({
      ...draft,
      quoteQuantities: parseRequestedQuoteQuantitiesInput(quoteQuantityInputs[partId] ?? "", draft.quantity),
    });

    setQuoteQuantityInputs((current) => ({
      ...current,
      [partId]: formatRequestedQuoteQuantitiesInput(nextDraft.quoteQuantities),
    }));
    updateDraft(partId, () => nextDraft);
  };

  return {
    activeCompareRequestedQuantity,
    cadPreviewSources,
    clientSummary,
    compareQuantities,
    drafts,
    getDraftForPart,
    getQuoteQuantityInput,
    jobRequestDefaults,
    latestPackage,
    optionKindsByOfferId,
    quoteQuantityInputs,
    quoteRows,
    setActiveCompareRequestedQuantity,
    setClientSummary,
    setDraftQuantity,
    setQuoteQuantityInputs,
    updateDraft,
    commitQuoteQuantityInput,
    visibleQuoteRows,
  };
}
