import { ExtractionLabCard } from "@/components/quotes/ExtractionLabCard";
import {
  ManualQuoteIntakeCard,
  type ManualQuoteCompletionTarget,
} from "@/components/quotes/ManualQuoteIntakeCard";
import { XometryDebugCard } from "@/components/quotes/XometryDebugCard";
import type { JobAggregate, QuoteRunAggregate } from "@/features/quotes/types";

type InternalJobDebugSectionProps = {
  disabled: boolean;
  completionTarget?: ManualQuoteCompletionTarget | null;
  job: JobAggregate;
  jobId: string;
  latestQuoteRun: QuoteRunAggregate | null;
  manualQuoteDisabled: boolean;
  showDebugTools: boolean;
};

export function InternalJobDebugSection({
  disabled,
  completionTarget = null,
  job,
  jobId,
  latestQuoteRun,
  manualQuoteDisabled,
  showDebugTools,
}: InternalJobDebugSectionProps) {
  return (
    <>
      <ManualQuoteIntakeCard
        jobId={jobId}
        parts={job.parts}
        disabled={manualQuoteDisabled}
        completionTarget={completionTarget}
      />

      {showDebugTools ? (
        <ExtractionLabCard
          jobId={jobId}
          parts={job.parts}
          debugExtractionRuns={job.debugExtractionRuns ?? []}
          drawingPreviewAssets={job.drawingPreviewAssets ?? []}
          disabled={disabled}
        />
      ) : null}

      {showDebugTools ? (
        <XometryDebugCard
          jobId={jobId}
          latestQuoteRun={latestQuoteRun}
          parts={job.parts}
          workQueue={job.workQueue}
          disabled={disabled}
        />
      ) : null}
    </>
  );
}
