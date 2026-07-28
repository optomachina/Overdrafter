import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchClientQuoteWorkspaceByJobIds } from "@/features/quotes/api/workspace-access";
import type {
  QuoteIntelligenceFacts,
  QuoteIntelligenceMetadata,
} from "@/features/quotes/quote-intelligence-view-model";
import {
  stableJobIds,
  type WorkspaceAccessScope,
  workspaceQueryKeys,
  WORKSPACE_DETAIL_STALE_TIME_MS,
  WORKSPACE_GC_TIME_MS,
} from "@/features/quotes/workspace-navigation";

function firstNonBlank(
  ...values: readonly (string | null | undefined)[]
): string | null {
  return (
    values.find(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    ) ?? null
  );
}

export function useQuoteIntelligenceWorkspace(
  jobIds: readonly string[],
  enabled: boolean,
  accessScope: WorkspaceAccessScope,
) {
  const stableIds = useMemo(() => stableJobIds([...jobIds]), [jobIds]);
  const workspaceQuery = useQuery({
    queryKey: workspaceQueryKeys.clientQuoteWorkspace(stableIds, accessScope),
    queryFn: () => fetchClientQuoteWorkspaceByJobIds(stableIds),
    enabled: enabled && stableIds.length > 0,
    staleTime: WORKSPACE_DETAIL_STALE_TIME_MS,
    gcTime: WORKSPACE_GC_TIME_MS,
  });
  const metadataByJobId = useMemo(() => {
    const metadata = new Map<string, QuoteIntelligenceMetadata>();

    (workspaceQuery.data ?? []).forEach((item) => {
      const requirement = item.part?.clientRequirement ?? null;
      const approved = item.part?.approvedRequirement ?? null;
      const approvedSnapshot =
        approved?.spec_snapshot &&
        typeof approved.spec_snapshot === "object" &&
        !Array.isArray(approved.spec_snapshot)
          ? (approved.spec_snapshot as Record<string, unknown>)
          : null;
      const snapshotProcess =
        typeof approvedSnapshot?.process === "string" ? approvedSnapshot.process : null;
      const snapshotThreads =
        typeof approvedSnapshot?.threads === "string" ? approvedSnapshot.threads : null;

      metadata.set(item.job.id, {
        material: firstNonBlank(requirement?.material, approved?.material),
        finish: firstNonBlank(requirement?.finish, approved?.finish),
        process: firstNonBlank(requirement?.process, snapshotProcess),
        threads: firstNonBlank(requirement?.threads, snapshotThreads),
        tightestToleranceInch:
          requirement?.tightestToleranceInch ??
          approved?.tightest_tolerance_inch ??
          null,
        fileNames: item.files.map((file) => file.original_name),
      });
    });

    return metadata;
  }, [workspaceQuery.data]);
  const factsByJobId = useMemo(() => {
    const facts = new Map<string, QuoteIntelligenceFacts>();

    (workspaceQuery.data ?? []).forEach((item) => {
      const offerIds = new Set(
        (item.part?.vendorQuotes ?? []).flatMap((quote) =>
          quote.offers.map((offer) => offer.id),
        ),
      );

      facts.set(item.job.id, {
        offerCount: offerIds.size,
        requestedAt: item.latestQuoteRequest?.created_at ?? null,
      });
    });

    return facts;
  }, [workspaceQuery.data]);

  return {
    factsByJobId,
    metadataByJobId,
    workspaceQuery,
  };
}
