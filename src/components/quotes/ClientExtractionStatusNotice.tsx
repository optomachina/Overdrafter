import { AlertTriangle, CheckCircle2, Clock3, FileSearch, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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

  switch (diagnostics.lifecycle) {
    case "queued":
    case "extracting":
      return (
        <div className={cn("rounded-2xl border border-sky-400/20 bg-sky-500/10 p-4", className)}>
          <div className="flex items-start gap-3">
            <Clock3 className="mt-0.5 h-5 w-5 text-sky-200" />
            <div className="space-y-2">
              <p className="text-sm font-medium text-white">Drawing extraction in progress</p>
              <p className="text-sm text-sky-100/85">
                Uploaded drawing metadata is still being processed. Available fields will populate automatically when extraction finishes.
              </p>
            </div>
          </div>
        </div>
      );
    case "failed":
      return (
        <div className={cn("rounded-2xl border border-rose-400/20 bg-rose-500/10 p-4", className)}>
          <div className="flex items-start gap-3">
            <XCircle className="mt-0.5 h-5 w-5 text-rose-200" />
            <div className="space-y-2">
              <p className="text-sm font-medium text-white">Drawing extraction failed</p>
              <p className="text-sm text-rose-100/85">
                {diagnostics.lastFailureMessage ??
                  "The drawing PDF could not be processed yet. Review the upload and try again if needed."}
              </p>
              {diagnostics.lastFailureCode ? (
                <Badge className="border border-rose-300/20 bg-rose-400/10 text-rose-100">
                  {diagnostics.lastFailureCode}
                </Badge>
              ) : null}
            </div>
          </div>
        </div>
      );
    case "partial":
      return (
        <div className={cn("rounded-2xl border border-amber-400/20 bg-amber-500/10 p-4", className)}>
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-200" />
            <div className="space-y-2">
              <p className="text-sm font-medium text-white">Partial drawing metadata found</p>
              <p className="text-sm text-amber-100/85">
                Available fields were populated, but some drawing data still needs review before relying on it.
              </p>
              <div className="flex flex-wrap gap-2">
                {diagnostics.warningCount > 0 ? (
                  <Badge className="border border-amber-300/20 bg-amber-400/10 text-amber-100">
                    {diagnostics.warningCount} warning{diagnostics.warningCount === 1 ? "" : "s"}
                  </Badge>
                ) : null}
                {missingLabel ? (
                  <Badge className="border border-amber-300/20 bg-amber-400/10 text-amber-100">
                    Missing: {missingLabel}
                  </Badge>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      );
    case "succeeded":
      return (
        <div className={cn("rounded-2xl border border-emerald-400/20 bg-emerald-500/10 p-4", className)}>
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-200" />
            <div className="space-y-2">
              <p className="text-sm font-medium text-white">Drawing metadata extracted</p>
              <p className="text-sm text-emerald-100/85">
                Drawing-derived fields were applied to this request and are ready for review.
              </p>
            </div>
          </div>
        </div>
      );
    case "uploaded":
    default:
      return (
        <div className={cn("rounded-2xl border border-white/10 bg-white/5 p-4", className)}>
          <div className="flex items-start gap-3">
            <FileSearch className="mt-0.5 h-5 w-5 text-white/70" />
            <div className="space-y-2">
              <p className="text-sm font-medium text-white">Waiting for drawing metadata</p>
              <p className="text-sm text-white/70">
                A drawing PDF has not produced extracted metadata yet. Upload a PDF drawing or wait for processing to begin.
              </p>
            </div>
          </div>
        </div>
      );
  }
}
