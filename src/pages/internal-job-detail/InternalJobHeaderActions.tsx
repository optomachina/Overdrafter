import { CheckCircle2, Loader2, PlayCircle, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";

type InternalJobHeaderActionsProps = {
  onRequestExtraction: () => void;
  onSaveRequirements: () => void;
  onStartQuoteRun: () => void;
  requestExtractionPending: boolean;
  saveRequirementsPending: boolean;
  startQuoteRunPending: boolean;
  writeActionsDisabled: boolean;
};

export function InternalJobHeaderActions({
  onRequestExtraction,
  onSaveRequirements,
  onStartQuoteRun,
  requestExtractionPending,
  saveRequirementsPending,
  startQuoteRunPending,
  writeActionsDisabled,
}: InternalJobHeaderActionsProps) {
  return (
    <>
      <Button
        variant="outline"
        className="border-white/10 bg-white/5"
        onClick={onRequestExtraction}
        disabled={writeActionsDisabled || requestExtractionPending}
      >
        {requestExtractionPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <ScanSearch className="mr-2 h-4 w-4" />
        )}
        Queue extraction
      </Button>
      <Button
        variant="outline"
        className="border-white/10 bg-white/5"
        onClick={onSaveRequirements}
        disabled={writeActionsDisabled || saveRequirementsPending}
      >
        {saveRequirementsPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <CheckCircle2 className="mr-2 h-4 w-4" />
        )}
        Save approved requirements
      </Button>
      <Button
        className="rounded-full"
        onClick={onStartQuoteRun}
        disabled={writeActionsDisabled || startQuoteRunPending}
      >
        {startQuoteRunPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <PlayCircle className="mr-2 h-4 w-4" />
        )}
        Start quote run
      </Button>
    </>
  );
}
