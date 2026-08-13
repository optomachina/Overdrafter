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
  const reviewCount = new Set([
    ...diagnostics.missingFields,
    ...(diagnostics.reviewFields ?? []),
  ]).size || diagnostics.warningCount;

  switch (diagnostics.lifecycle) {
    case "queued":
    case "extracting":
      return (
        <div className={cn("border-l-2 border-sky-500 bg-muted px-3 py-2", className)}>
          <div className="flex items-start gap-2">
            <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
            <div>
              <p className="text-sm font-medium text-foreground">Drawing extraction in progress</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Fields will update automatically when processing finishes.
              </p>
            </div>
          </div>
        </div>
      );
    case "failed":
      return (
        <div className={cn("border-l-2 border-rose-500 bg-muted px-3 py-2", className)}>
          <div className="flex items-start gap-2">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
            <div>
              <p className="text-sm font-medium text-foreground">Drawing extraction failed</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {diagnostics.lastFailureMessage ??
                  "The drawing could not be processed. Check the file and upload a replacement if needed."}
              </p>
              {diagnostics.lastFailureCode ? (
                <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                  {diagnostics.lastFailureCode}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      );
    case "partial":
      return (
        <div className={cn("border-l-2 border-amber-500 bg-muted px-3 py-2", className)}>
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                Review {reviewCount} drawing field{reviewCount === 1 ? "" : "s"}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {[missingLabel ? `Missing: ${missingLabel}` : null, reviewLabel ? `Verify: ${reviewLabel}` : null]
                  .filter(Boolean)
                  .join(" · ")}
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
        <div className={cn("border-l-2 border-border bg-muted px-3 py-2", className)}>
          <div className="flex items-start gap-2">
            <FileSearch className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground">Waiting for drawing metadata</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Upload a PDF drawing or wait for processing to begin.
              </p>
            </div>
          </div>
        </div>
      );
  }
}
