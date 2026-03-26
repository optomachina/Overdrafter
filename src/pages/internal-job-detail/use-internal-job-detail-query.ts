import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJobAggregate } from "@/features/quotes/api/jobs-api";
import { getQuoteRunReadiness } from "@/features/quotes/api/quote-requests-api";
import type { AppMembership } from "@/features/quotes/types";
import { getLatestQuoteRun } from "@/features/quotes/utils";
import { useDiagnosticsSnapshot } from "@/lib/diagnostics";

type UseInternalJobDetailQueryOptions = {
  activeMembership: AppMembership | null;
  hasUser: boolean;
  isPlatformAdmin: boolean;
  jobId: string;
};

export function useInternalJobDetailQuery({
  activeMembership,
  hasUser,
  isPlatformAdmin,
  jobId,
}: UseInternalJobDetailQueryOptions) {
  const diagnostics = useDiagnosticsSnapshot();
  const allowDiagnosticReadOnly = Boolean(
    activeMembership?.role === "client" && (diagnostics.enabled || import.meta.env.DEV),
  );
  const enabled = Boolean(
    jobId && hasUser && activeMembership && (activeMembership.role !== "client" || allowDiagnosticReadOnly),
  );

  const jobQuery = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => fetchJobAggregate(jobId),
    enabled,
    refetchInterval: (query) => {
      const current = query.state.data;

      if (!current) {
        return false;
      }

      const hasInFlightDebugRun = (current.debugExtractionRuns ?? []).some(
        (run) => run.status === "queued" || run.status === "running",
      );
      const hasInFlightDebugTask = current.workQueue.some(
        (task) =>
          task.task_type === "debug_extract_part" &&
          (task.status === "queued" || task.status === "running"),
      );

      return hasInFlightDebugRun || hasInFlightDebugTask ? 2500 : false;
    },
  });

  const job = jobQuery.data ?? null;
  const latestQuoteRun = useMemo(() => (job ? getLatestQuoteRun(job) : null), [job]);
  const isCrossOrgReadOnlyView = Boolean(
    isPlatformAdmin &&
      activeMembership?.organizationId &&
      job?.job.organization_id &&
      activeMembership.organizationId !== job.job.organization_id,
  );

  const readinessQuery = useQuery({
    queryKey: ["quote-readiness", latestQuoteRun?.id],
    queryFn: () => getQuoteRunReadiness(latestQuoteRun!.id),
    enabled: Boolean(latestQuoteRun?.id) && !isCrossOrgReadOnlyView && !allowDiagnosticReadOnly,
  });

  return {
    allowDiagnosticReadOnly,
    enabled,
    job,
    jobQuery,
    latestQuoteRun,
    readinessQuery,
    showDebugTools: diagnostics.enabled || import.meta.env.DEV,
  };
}
