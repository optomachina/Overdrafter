import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { requestExtraction } from "@/features/quotes/api/extraction-api";
import {
  declareJobExportStatus,
  fetchJobExportControlStatus,
  requestExportMarkingRescan,
} from "@/features/quotes/api/export-control-api";
import {
  exportControlStatusRefetchInterval,
  getExportControlNoticeCopy,
} from "@/features/quotes/export-control-notice";
import { EXPORT_CONTROL_HELP_PATH, requestExportControlAnswer } from "@/features/quotes/export-control";
import { cn } from "@/lib/utils";

type ExportControlStatusNoticeProps = {
  jobId: string;
  className?: string;
};

/**
 * OVD-723 client notice on the part page. Explains why quotes are held and
 * lets the owner declare an existing part without uploading a file, or
 * recheck files that are still waiting for an export-control scan. A status
 * that cannot be read shows nothing here; the server still holds the part.
 */
export function ExportControlStatusNotice({ jobId, className }: ExportControlStatusNoticeProps) {
  const queryClient = useQueryClient();
  const queryKey = ["job-export-control-status", jobId] as const;
  const statusQuery = useQuery({
    queryKey,
    queryFn: () => fetchJobExportControlStatus(jobId),
    enabled: Boolean(jobId),
    retry: false,
    refetchInterval: (query) => exportControlStatusRefetchInterval(query.state.data),
  });
  const declareMutation = useMutation({
    mutationFn: async () => {
      const answer = await requestExportControlAnswer("declare");
      if (!answer) return false;
      await declareJobExportStatus(jobId, answer);
      if (answer === "not_controlled") {
        // The clean declaration itself queues a scan only rescan on the
        // server for files with no clean scan of their bytes (parts extracted
        // before OVD-723 included). Extraction is still requested for parts
        // that were never extracted; it is best effort here because the
        // answer itself is already saved.
        try {
          await requestExtraction(jobId);
        } catch {
          toast.error("Your answer was saved, but the files could not be rechecked yet. Refresh the part to try again.");
        }
      }
      return true;
    },
    onSuccess: async (recorded) => {
      if (recorded) await queryClient.invalidateQueries({ queryKey });
    },
    onError: () => {
      toast.error("Your export-control answer could not be saved. Try again.");
    },
  });

  // A file whose rescan failed for good is never checked again on its own;
  // the owner requeues it here (the server only queues scan only rescans).
  const rescanMutation = useMutation({
    mutationFn: () => requestExportMarkingRescan(jobId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: () => {
      toast.error("The files could not be rechecked. Try again.");
    },
  });

  const copy = statusQuery.data ? getExportControlNoticeCopy(statusQuery.data) : null;
  const actionPending = declareMutation.isPending || rescanMutation.isPending;
  if (!copy) {
    return null;
  }

  return (
    <div
      role="status"
      aria-label="Export control"
      className={cn("border-l-2 border-amber-500 bg-muted px-3 py-2", className)}
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{copy.title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {copy.detail}{" "}
            <a className="underline" href={EXPORT_CONTROL_HELP_PATH}>
              Beta terms
            </a>
          </p>
          {copy.action ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-2"
              disabled={actionPending}
              onClick={() => (copy.actionKind === "rescan" ? rescanMutation.mutate() : declareMutation.mutate())}
            >
              {copy.action}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
