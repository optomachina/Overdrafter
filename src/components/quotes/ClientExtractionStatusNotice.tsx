import { AlertTriangle, Clock3, FileSearch, XCircle } from "lucide-react";
import type { ClientExtractionDiagnostics } from "@/features/quotes/types";
import { cn } from "@/lib/utils";

type ClientExtractionStatusNoticeProps = {
  diagnostics: ClientExtractionDiagnostics | null | undefined;
  className?: string;
};

function sentenceCaseField(field: string) {
  switch (field) {
    case "partNumber":
      return "Part number";
    case "tightestToleranceInch":
      return "Tightest tolerance";
    default:
      return field.charAt(0).toUpperCase() + field.slice(1);
  }
}

export function ClientExtractionStatusNotice({
  diagnostics,
  className,
}: ClientExtractionStatusNoticeProps) {
  if (!diagnostics) {
    return null;
  }

  const missingLabel =
    diagnostics.missingFields.length > 0
      ? diagnostics.missingFields.map(sentenceCaseField).join(", ")
      : null;
  const reviewLabel =
    diagnostics.reviewFields && diagnostics.reviewFields.length > 0
      ? diagnostics.reviewFields.map(sentenceCaseField).join(", ")
      : null;
  const reviewFieldCount =
    diagnostics.missingFields.length + (diagnostics.reviewFields?.length ?? 0);
  const partialActions: string[] = [];

  if (missingLabel) {
    partialActions.push(`add ${missingLabel.toLowerCase()}`);
  }

  if (reviewLabel) {
    partialActions.push(`verify ${reviewLabel.toLowerCase()}`);
  }

  partialActions.push("then save request details");

  switch (diagnostics.lifecycle) {
    case "queued":
    case "extracting":
      return (
        <div
          className={cn("border-l-2 border-sky-400/60 py-1.5 pl-3", className)}
        >
          <div className="flex items-start gap-2.5">
            <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                Drawing extraction in progress
              </p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Drawing fields will populate automatically when processing
                finishes.
              </p>
            </div>
          </div>
        </div>
      );
    case "failed":
      return (
        <div
          className={cn("border-l-2 border-rose-400/60 py-1.5 pl-3", className)}
        >
          <div className="flex items-start gap-2.5">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                Drawing extraction failed
              </p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {diagnostics.lastFailureMessage ??
                  "The drawing PDF could not be processed yet. Review the upload and try again if needed."}
              </p>
            </div>
          </div>
        </div>
      );
    case "partial":
      return (
        <div
          className={cn(
            "border-l-2 border-amber-400/60 py-1.5 pl-3",
            className,
          )}
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                Review {reviewFieldCount || diagnostics.warningCount} drawing{" "}
                {reviewFieldCount === 1 ? "field" : "fields"}
              </p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {partialActions.join("; ")}.
              </p>
            </div>
          </div>
        </div>
      );
    case "succeeded":
      return null;
    case "uploaded":
    default:
      return (
        <div className={cn("border-l-2 border-border py-1.5 pl-3", className)}>
          <div className="flex items-start gap-2.5">
            <FileSearch className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                Waiting for drawing metadata
              </p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Upload a PDF drawing or wait for processing to begin.
              </p>
            </div>
          </div>
        </div>
      );
  }
}
