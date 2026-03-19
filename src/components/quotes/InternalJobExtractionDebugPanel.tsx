import { ExtractionLabCard } from "@/components/quotes/ExtractionLabCard";
import { ManualQuoteIntakeCard } from "@/components/quotes/ManualQuoteIntakeCard";
import { XometryDebugCard } from "@/components/quotes/XometryDebugCard";
import type { JobAggregate, QuoteRunAggregate } from "@/features/quotes/types";

type InternalJobExtractionDebugPanelProps = {
  jobId: string;
  parts: JobAggregate["parts"];
  latestQuoteRun: QuoteRunAggregate | null;
  workQueue: JobAggregate["workQueue"];
  debugExtractionRuns: JobAggregate["debugExtractionRuns"];
  drawingPreviewAssets: JobAggregate["drawingPreviewAssets"];
  disabled: boolean;
  showDebugTools: boolean;
};

export function InternalJobExtractionDebugPanel({
  jobId,
  parts,
  latestQuoteRun,
  workQueue,
  debugExtractionRuns,
  drawingPreviewAssets,
  disabled,
  showDebugTools,
}: InternalJobExtractionDebugPanelProps) {
  return (
    <div className="space-y-6">
      <ManualQuoteIntakeCard jobId={jobId} parts={parts} disabled={disabled} />

      {showDebugTools ? (
        <ExtractionLabCard
          jobId={jobId}
          parts={parts}
          debugExtractionRuns={debugExtractionRuns ?? []}
          drawingPreviewAssets={drawingPreviewAssets ?? []}
          disabled={disabled}
        />
      ) : null}

      {showDebugTools ? (
        <XometryDebugCard
          jobId={jobId}
          latestQuoteRun={latestQuoteRun}
          parts={parts}
          workQueue={workQueue}
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}
