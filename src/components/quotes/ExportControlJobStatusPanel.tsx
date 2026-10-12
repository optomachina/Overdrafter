import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  declareExistingJobExportStatus,
  getJobExportControlStatus,
  isJobExportDispatchHeld,
  requestExportControlRescan,
  type JobExportControlStatus,
} from "@/features/quotes/api/export-control-api";
import {
  EXPORT_CONTROL_ANSWER_OPTIONS,
  EXPORT_CONTROL_HELP_PATH,
  getExportControlBlockMessage,
  type ExportControlAnswer,
} from "@/features/quotes/export-control";

const ANSWER_LABELS: Record<JobExportControlStatus["latestAnswer"], string> = {
  missing: "Not answered",
  not_controlled: "Not export-controlled",
  controlled: "Export-controlled",
  unsure: "Not sure",
};

export function jobExportControlStatusQueryKey(jobId: string) {
  return ["job-export-control-status", jobId] as const;
}

type ExportControlJobStatusPanelProps = {
  jobId: string;
  /** Org members with edit rights declare; platform admins can only rescan. */
  canDeclare: boolean;
  className?: string;
};

/**
 * OVD-723 existing-job panel. Shown while the server would deny dispatch:
 * no clean declaration, a marking review, or parts without a scan of record.
 * The answer has no default, and controlled or unsure keeps the job held.
 */
export function ExportControlJobStatusPanel({ jobId, canDeclare, className }: ExportControlJobStatusPanelProps) {
  const queryClient = useQueryClient();
  const [answer, setAnswer] = useState<ExportControlAnswer | null>(null);
  const statusQuery = useQuery({
    queryKey: jobExportControlStatusQueryKey(jobId),
    queryFn: () => getJobExportControlStatus(jobId),
    enabled: jobId.length > 0,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: jobExportControlStatusQueryKey(jobId) });
  const declareMutation = useMutation({
    mutationFn: (value: ExportControlAnswer) => declareExistingJobExportStatus(jobId, value),
    onSuccess: () => {
      setAnswer(null);
      return refresh();
    },
  });
  const rescanMutation = useMutation({
    mutationFn: () => requestExportControlRescan(jobId),
    onSuccess: refresh,
  });

  if (!jobId || statusQuery.isLoading) return null;

  if (statusQuery.isError || !statusQuery.data) {
    return (
      <section aria-label="Export control" className={cn("space-y-2 border-t border-border pt-4 text-sm", className)}>
        <p role="alert" className="text-destructive">
          Export-control status could not be loaded. Quoting stays on hold until it can be checked.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => void statusQuery.refetch()}>
          Try again
        </Button>
      </section>
    );
  }

  const status = statusQuery.data;
  if (!isJobExportDispatchHeld(status)) return null;

  const needsDeclaration = status.latestAnswer !== "not_controlled";
  const blockedAnswer = answer === "controlled" || answer === "unsure";

  return (
    <section
      aria-labelledby="export-control-heading"
      className={cn("space-y-3 border-t border-border pt-4 text-sm", className)}
    >
      <h2 id="export-control-heading" className="font-medium">
        Export control
      </h2>
      <p className="text-muted-foreground">
        Quoting is on hold for this part request. Answer: {ANSWER_LABELS[status.latestAnswer]}.
      </p>

      {status.reviewState !== "clear" ? (
        <p role="status">{getExportControlBlockMessage("export_review_pending")}</p>
      ) : null}

      {needsDeclaration && canDeclare ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (answer) declareMutation.mutate(answer);
          }}
        >
          <fieldset className="space-y-2">
            <legend className="mb-1">Are these files export-controlled?</legend>
            {EXPORT_CONTROL_ANSWER_OPTIONS.map((option) => (
              <label
                key={option.value}
                className={cn(
                  "flex cursor-pointer gap-3 rounded-md border border-paper-hairline p-3",
                  answer === option.value && "border-foreground",
                )}
              >
                <input
                  type="radio"
                  name={`export-control-answer-${jobId}`}
                  value={option.value}
                  checked={answer === option.value}
                  onChange={() => setAnswer(option.value)}
                  className="mt-1"
                />
                <span>
                  <span className="block font-medium">{option.label}</span>
                  <span className="block text-paper-muted">{option.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {blockedAnswer ? (
            <p role="alert" className="text-destructive">
              The OverDrafter beta can't quote ITAR, EAR-controlled (other than EAR99), CUI, or unconfirmed
              files. This part request stays on hold.
            </p>
          ) : null}
          {declareMutation.isError ? (
            <p role="alert" className="text-destructive">
              The answer wasn't saved. Quoting stays on hold.
            </p>
          ) : null}
          <p className="text-xs text-paper-muted">
            <a className="underline" href={EXPORT_CONTROL_HELP_PATH}>
              Beta terms
            </a>
          </p>
          <Button type="submit" size="sm" disabled={answer === null || declareMutation.isPending}>
            Save answer
          </Button>
        </form>
      ) : null}

      {status.partsMissingScan > 0 ? (
        <div className="space-y-2">
          <p>
            {status.partsMissingScan === 1
              ? "1 part has no export-marking scan of its files yet."
              : `${status.partsMissingScan} parts have no export-marking scan of their files yet.`}{" "}
            A rescan reads the drawing and STEP header again. It doesn't re-run extraction.
          </p>
          {rescanMutation.isError ? (
            <p role="alert" className="text-destructive">
              The rescan wasn't queued. Quoting stays on hold.
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={status.rescansPending > 0 || rescanMutation.isPending}
            onClick={() => rescanMutation.mutate()}
          >
            {status.rescansPending > 0 ? "Rescan running" : "Rescan files"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
