import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ChevronLeft, ChevronRight, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DrawingPreviewState } from "@/components/quotes/ClientQuoteAssetPanels";
import type { StoredFileViewerMode } from "@/lib/file-viewer";
import { resolveStoredFileViewerMode } from "@/lib/file-viewer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type DrawingPreviewDialogPage = {
  pageNumber: number;
  url: string;
};

type DrawingPreviewDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileName: string;
  pageCount: number;
  viewerMode?: StoredFileViewerMode;
  pdfUrl?: string | null;
  pages: DrawingPreviewDialogPage[];
  isLoading: boolean;
  state?: DrawingPreviewState;
  statusMessage?: string | null;
  onDownload: () => void;
};

export function DrawingPreviewDialog({
  open,
  onOpenChange,
  fileName,
  pageCount,
  viewerMode,
  pdfUrl = null,
  pages,
  isLoading,
  state = "pending",
  statusMessage = null,
  onDownload,
}: DrawingPreviewDialogProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const pageMap = useMemo(() => new Map(pages.map((page) => [page.pageNumber, page.url])), [pages]);
  const currentPageUrl = pageMap.get(currentPage) ?? null;
  const hasPdfPreview = typeof pdfUrl === "string" && pdfUrl.length > 0;
  const resolvedViewerMode = viewerMode ?? resolveStoredFileViewerMode({ original_name: fileName });
  const hasMultiplePages = pageCount > 1;
  const emptyStateMessage =
    state === "failed"
      ? "Drawing preview generation failed. Download the original PDF while this is investigated."
      : state === "unavailable"
        ? statusMessage ?? "Drawing preview could not be loaded. Download the original PDF instead."
        : state === "pending"
          ? "Drawing preview is still processing. Download the original PDF while it finishes."
          : state === "missing"
            ? "Drawing PDF is missing for this part."
            : "Preview unavailable for this page.";

  useEffect(() => {
    if (open) {
      setCurrentPage(1);
    }
  }, [fileName, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
        return;
      }

      if (!hasMultiplePages) {
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setCurrentPage((page) => Math.max(page - 1, 1));
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        setCurrentPage((page) => Math.min(page + 1, pageCount));
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [hasMultiplePages, onOpenChange, open, pageCount]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[80vh] w-[80vw] max-w-[min(80vw,1100px)] border-white/10 bg-[#1f1f1f] p-0 text-white">
        <DialogHeader className="gap-3 border-b border-white/8 px-6 py-5 pr-20">
          <DialogTitle>{fileName}</DialogTitle>
          <DialogDescription className="text-white/55">
            Review the uploaded drawing PDF and download the original file.
          </DialogDescription>
        </DialogHeader>

        <div className="absolute right-16 top-4">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="rounded-full text-white/75 hover:bg-white/10 hover:text-white"
            onClick={onDownload}
            aria-label="Download PDF"
          >
            <Download className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-3">
          <div className="mb-3 flex items-center justify-between px-2">
            <div className="text-sm text-white/55">
              {hasPdfPreview && resolvedViewerMode === "pdf"
                ? "Original PDF"
                : pageCount > 0
                  ? `Page ${currentPage} of ${pageCount}`
                  : "Preview unavailable"}
            </div>
            {hasMultiplePages && !(hasPdfPreview && resolvedViewerMode === "pdf") ? (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="rounded-full border-white/10 bg-white/5 text-white hover:bg-white/10"
                  onClick={() => setCurrentPage((page) => Math.max(page - 1, 1))}
                  disabled={currentPage <= 1}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="rounded-full border-white/10 bg-white/5 text-white hover:bg-white/10"
                  onClick={() => setCurrentPage((page) => Math.min(page + 1, pageCount))}
                  disabled={currentPage >= pageCount}
                  aria-label="Next page"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            ) : null}
          </div>

          <div className="relative min-h-0 flex-1 overflow-hidden rounded-[24px] border border-white/8 bg-[#0d0d0d]">
            {isLoading ? (
              <div className="flex h-full items-center justify-center text-white/55">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : hasPdfPreview && resolvedViewerMode === "pdf" ? (
              <iframe
                src={pdfUrl}
                title={`${fileName} PDF preview`}
                className="h-full w-full border-0 bg-white"
              />
            ) : currentPageUrl ? (
              <img
                src={currentPageUrl}
                alt={`${fileName} page ${currentPage}`}
                className="h-full w-full object-contain"
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-white/45">
                {state === "failed" || state === "unavailable" ? (
                  <AlertCircle className="h-6 w-6 text-white/40" />
                ) : null}
                <div>{emptyStateMessage}</div>
                {state === "unavailable" && statusMessage ? (
                  <div className="max-w-md text-xs text-white/35">{statusMessage}</div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
