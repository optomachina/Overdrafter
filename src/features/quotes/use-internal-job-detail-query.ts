import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import {
  fetchJobAggregate,
  getQuoteRunReadiness,
} from "@/features/quotes/api";
import {
  buildInternalJobCadPreviewSources,
  buildInternalJobOptionKindsByOfferId,
  buildInternalJobPartViewModels,
  getInternalJobCompareQuantities,
  getInternalJobLatestPackage,
  getInternalJobLatestQuoteRun,
  getInternalJobQuoteRows,
  getInternalJobRefetchInterval,
  getInternalJobVisibleQuoteRows,
  mergeInternalJobDraftState,
  type InternalJobPartViewModel,
} from "@/features/quotes/internal-job-detail";
import {
  formatRequestedQuoteQuantitiesInput,
  parseRequestedQuoteQuantitiesInput,
} from "@/features/quotes/request-intake";
import {
  normalizeApprovedRequirementDraft,
  resolveRequestedQuantitySelection,
  type RequestedQuantityFilterValue,
} from "@/features/quotes/request-scenarios";
import type {
  AppMembership,
  ApprovedPartRequirement,
  JobAggregate,
  QuoteRunAggregate,
  QuoteRunReadiness,
  PublishedPackageAggregate,
  VendorQuoteAggregate,
} from "@/features/quotes/types";

type UseInternalJobDetailQueryInput = {
  jobId: string;
  user: User | null;
  activeMembership: AppMembership | null;
};

export type UseInternalJobDetailQueryResult = {
  jobQuery: UseQueryResult<JobAggregate, Error>;
  readinessQuery: UseQueryResult<QuoteRunReadiness, Error>;
  job: JobAggregate | null;
  partViewModels: InternalJobPartViewModel[];
  latestQuoteRun: QuoteRunAggregate | null;
  latestPackage: PublishedPackageAggregate | null;
  optionKindsByOfferId: Map<string, string[]>;
  quoteRows: VendorQuoteAggregate[];
  compareQuantities: number[];
  visibleQuoteRows: VendorQuoteAggregate[];
  normalizedApprovedDrafts: ApprovedPartRequirement[];
  clientSummary: string;
  activeCompareRequestedQuantity: RequestedQuantityFilterValue | null;
  updateDraft: (
    partId: string,
    updater: (current: ApprovedPartRequirement) => ApprovedPartRequirement,
  ) => void;
  setQuoteQuantityInput: (partId: string, value: string) => void;
  commitQuoteQuantityInput: (partId: string) => void;
  setClientSummary: (value: string) => void;
  setActiveCompareRequestedQuantity: (
    value: RequestedQuantityFilterValue | null,
  ) => void;
};

export function useInternalJobDetailQuery({
  jobId,
  user,
  activeMembership,
}: UseInternalJobDetailQueryInput): UseInternalJobDetailQueryResult {
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

  const jobQuery = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => fetchJobAggregate(jobId),
    enabled: Boolean(jobId && user && activeMembership && activeMembership.role !== "client"),
    refetchInterval: (query) => getInternalJobRefetchInterval(query.state.data),
  });

  const latestQuoteRun = useMemo(
    () => getInternalJobLatestQuoteRun(jobQuery.data),
    [jobQuery.data],
  );
  const latestPackage = useMemo(
    () => getInternalJobLatestPackage(jobQuery.data),
    [jobQuery.data],
  );
  const readinessQuery = useQuery({
    queryKey: ["quote-readiness", latestQuoteRun?.id],
    queryFn: () => getQuoteRunReadiness(latestQuoteRun!.id),
    enabled: Boolean(latestQuoteRun?.id),
  });
  const cadPreviewSources = useMemo(
    () => buildInternalJobCadPreviewSources(jobQuery.data?.parts),
    [jobQuery.data?.parts],
  );
  const optionKindsByOfferId = useMemo(
    () => buildInternalJobOptionKindsByOfferId(latestPackage),
    [latestPackage],
  );
  const quoteRows = useMemo(
    () => getInternalJobQuoteRows(latestQuoteRun),
    [latestQuoteRun],
  );
  const compareQuantities = useMemo(
    () =>
      getInternalJobCompareQuantities({
        quoteRows,
        drafts,
        job: jobQuery.data,
      }),
    [drafts, jobQuery.data, quoteRows],
  );
  const visibleQuoteRows = useMemo(
    () =>
      getInternalJobVisibleQuoteRows({
        quoteRows,
        activeCompareRequestedQuantity,
      }),
    [activeCompareRequestedQuantity, quoteRows],
  );
  const partViewModels = useMemo(
    () =>
      jobQuery.data
        ? buildInternalJobPartViewModels({
            parts: jobQuery.data.parts,
            drafts,
            quoteQuantityInputs,
            job: jobQuery.data.job,
            cadPreviewSources,
          })
        : [],
    [cadPreviewSources, drafts, jobQuery.data, quoteQuantityInputs],
  );
  const normalizedApprovedDrafts = useMemo(
    () => Object.values(drafts).map((draft) => normalizeApprovedRequirementDraft(draft)),
    [drafts],
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
    if (!jobQuery.data) {
      return;
    }

    const nextDraftState = mergeInternalJobDraftState({
      parts: jobQuery.data.parts,
      currentDrafts: draftStateRef.current.drafts,
      currentQuoteQuantityInputs: draftStateRef.current.quoteQuantityInputs,
      job: jobQuery.data.job,
    });

    setDrafts(nextDraftState.drafts);
    setQuoteQuantityInputs(nextDraftState.quoteQuantityInputs);
    setClientSummary((current) =>
      current ||
      latestPackage?.client_summary ||
      `Curated CNC quote package for ${jobQuery.data.job.title}.`,
    );
  }, [jobQuery.data, latestPackage?.client_summary]);

  const updateDraft = (
    partId: string,
    updater: (current: ApprovedPartRequirement) => ApprovedPartRequirement,
  ) => {
    const fallbackDraft = partViewModels.find((part) => part.part.id === partId)?.draft;

    setDrafts((current) => {
      const existingDraft = current[partId] ?? fallbackDraft;

      if (!existingDraft) {
        return current;
      }

      return {
        ...current,
        [partId]: updater(existingDraft),
      };
    });
  };

  const setPartQuoteQuantityInput = (partId: string, value: string) => {
    setQuoteQuantityInputs((current) => ({
      ...current,
      [partId]: value,
    }));
  };

  const commitQuoteQuantityInput = (partId: string) => {
    const partViewModel = partViewModels.find((part) => part.part.id === partId);

    if (!partViewModel) {
      return;
    }

    const nextDraft = normalizeApprovedRequirementDraft({
      ...partViewModel.draft,
      quoteQuantities: parseRequestedQuoteQuantitiesInput(
        partViewModel.quoteQuantityInput,
        partViewModel.draft.quantity,
      ),
    });

    setQuoteQuantityInputs((current) => ({
      ...current,
      [partId]: formatRequestedQuoteQuantitiesInput(nextDraft.quoteQuantities),
    }));
    updateDraft(partId, () => nextDraft);
  };

  return {
    jobQuery,
    readinessQuery,
    job: jobQuery.data ?? null,
    partViewModels,
    latestQuoteRun,
    latestPackage,
    optionKindsByOfferId,
    quoteRows,
    compareQuantities,
    visibleQuoteRows,
    normalizedApprovedDrafts,
    clientSummary,
    activeCompareRequestedQuantity,
    updateDraft,
    setQuoteQuantityInput: setPartQuoteQuantityInput,
    commitQuoteQuantityInput,
    setClientSummary,
    setActiveCompareRequestedQuantity,
  };
}
