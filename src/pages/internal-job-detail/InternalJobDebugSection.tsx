import { ExtractionLabCard } from "@/components/quotes/ExtractionLabCard";
import { ManualQuoteIntakeCard } from "@/components/quotes/ManualQuoteIntakeCard";
import { XometryDebugCard } from "@/components/quotes/XometryDebugCard";
import type { JobAggregate, QuoteRunAggregate } from "@/features/quotes/types";

type InternalJobDebugSectionProps = {
  disabled: boolean;
  job: JobAggregate;
  jobId: string;
  latestQuoteRun: QuoteRunAggregate | null;
  showDebugTools: boolean;
};

export function InternalJobDebugSection({
  disabled,
  job,
  jobId,
  latestQuoteRun,
  showDebugTools,
}: InternalJobDebugSectionProps) {
  return (
    <>
      <ManualQuoteIntakeCard jobId={jobId} parts={job.parts} disabled={disabled} />

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
