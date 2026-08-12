import { ExtractionLabCard } from "@/components/quotes/ExtractionLabCard";
import {
  ManualQuoteIntakeCard,
  type ManualQuoteCompletionTarget,
} from "@/components/quotes/ManualQuoteIntakeCard";
import { XometryDebugCard } from "@/components/quotes/XometryDebugCard";
import { AdminQuoteOfferInvalidationCard } from "@/components/admin/AdminQuoteOfferInvalidationCard";
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
  const quoteOffers = job.quoteRuns.flatMap((run) =>
    run.vendorQuotes.flatMap((quote) => quote.offers),
  );

  return (
    <>
      <ManualQuoteIntakeCard
        jobId={jobId}
        parts={job.parts}
        disabled={manualQuoteDisabled}
        completionTarget={completionTarget}
      />

      <AdminQuoteOfferInvalidationCard jobId={jobId} offers={quoteOffers} />

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
