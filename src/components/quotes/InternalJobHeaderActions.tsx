import { CheckCircle2, Loader2, PlayCircle, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";

type InternalJobHeaderActionsProps = {
  disabled: boolean;
  isQueueingExtraction: boolean;
  isSavingRequirements: boolean;
  isStartingQuoteRun: boolean;
  onQueueExtraction: () => void;
  onSaveApprovedRequirements: () => void;
  onStartQuoteRun: () => void;
};

export function InternalJobHeaderActions({
  disabled,
  isQueueingExtraction,
  isSavingRequirements,
  isStartingQuoteRun,
  onQueueExtraction,
  onSaveApprovedRequirements,
  onStartQuoteRun,
}: InternalJobHeaderActionsProps) {
  return (
    <>
      <Button
        variant="outline"
        className="border-white/10 bg-white/5"
        onClick={onQueueExtraction}
        disabled={disabled || isQueueingExtraction}
      >
        {isQueueingExtraction ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <ScanSearch className="mr-2 h-4 w-4" />
        )}
        Queue extraction
      </Button>
      <Button
        variant="outline"
        className="border-white/10 bg-white/5"
        onClick={onSaveApprovedRequirements}
        disabled={disabled || isSavingRequirements}
      >
        {isSavingRequirements ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <CheckCircle2 className="mr-2 h-4 w-4" />
        )}
        Save approved requirements
      </Button>
      <Button
        className="rounded-full"
        onClick={onStartQuoteRun}
        disabled={disabled || isStartingQuoteRun}
      >
        {isStartingQuoteRun ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <PlayCircle className="mr-2 h-4 w-4" />
        )}
        Start quote run
      </Button>
    </>
  );
}
