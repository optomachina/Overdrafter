import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Box, Download, Expand, FileText, Loader2 } from "lucide-react";
import { CadModelThumbnail } from "@/components/CadModelThumbnail";
import { Button } from "@/components/ui/button";
import type { DrawingPreviewData, JobFileRecord } from "@/features/quotes/types";
import { createCadPreviewSourceFromJobFile, isStepPreviewableFile } from "@/lib/cad-preview";
import type { StoredFileViewerMode } from "@/lib/file-viewer";
import { resolveStoredFileViewerMode } from "@/lib/file-viewer";
import { downloadStoredFileBlob, loadStoredDrawingPreviewPages } from "@/lib/stored-file";
import { cn } from "@/lib/utils";

type DownloadableFile = Pick<JobFileRecord, "storage_bucket" | "storage_path" | "original_name">;
export type DrawingPreviewPage = {
  pageNumber: number;
  url: string;
};

export type DrawingPreviewState = "missing" | "ready" | "pending" | "failed" | "unavailable";

async function downloadStoredFile(file: DownloadableFile) {
  const blob = await downloadStoredFileBlob(file);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.original_name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function ClientDrawingPreviewPanel({
  drawingFile,
  drawingPreview,
  viewerMode,
  pdfUrl,
  pages,
  state,
  statusMessage,
  isLoading = false,
  onOpenDialog,
  className,
}: {
  drawingFile: JobFileRecord | null;
  drawingPreview: DrawingPreviewData;
  viewerMode?: StoredFileViewerMode;
  pdfUrl?: string | null;
  pages?: DrawingPreviewPage[];
  state?: DrawingPreviewState;
  statusMessage?: string | null;
  isLoading?: boolean;
  onOpenDialog?: () => void;
  className?: string;
}) {
  const [activePageNumber, setActivePageNumber] = useState<number | null>(null);
  const [localPages, setLocalPages] = useState<DrawingPreviewPage[]>([]);
  const [isLocalLoading, setIsLocalLoading] = useState(false);
  const resolvedState: DrawingPreviewState =
    state ?? (!drawingFile ? "missing" : drawingPreview.pages.length > 0 ? "ready" : "pending");
  const resolvedPages = pages ?? localPages;
  const resolvedLoading = pages ? isLoading : isLocalLoading;
  const hasPdfPreview = typeof pdfUrl === "string" && pdfUrl.length > 0;
  const resolvedViewerMode = viewerMode ?? resolveStoredFileViewerMode(drawingFile);

  useEffect(() => {
    if (pages) {
      return;
    }

    let isActive = true;
    let objectUrls: string[] = [];

    if (!drawingFile || drawingPreview.pages.length === 0) {
      setLocalPages([]);
      setIsLocalLoading(false);
      return;
    }

    setIsLocalLoading(true);

    void loadStoredDrawingPreviewPages(drawingFile, drawingPreview.pages)
      .then((nextPages) => {
        objectUrls = nextPages.map((page) => page.url);

        if (!isActive) {
          objectUrls.forEach((url) => URL.revokeObjectURL(url));
          return;
        }

        setLocalPages(nextPages);
      })
      .catch(() => {
        if (!isActive) {
          return;
        }

        setLocalPages([]);
      })
      .finally(() => {
        if (isActive) {
          setIsLocalLoading(false);
        }
      });

    return () => {
      isActive = false;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [drawingFile, drawingPreview.pages, pages]);

  useEffect(() => {
    setActivePageNumber((current) =>
      current !== null && resolvedPages.some((page) => page.pageNumber === current)
        ? current
        : resolvedPages[0]?.pageNumber ?? null,
    );
  }, [resolvedPages]);

  const activePage =
    resolvedPages.find((page) => page.pageNumber === activePageNumber) ?? resolvedPages[0] ?? null;

  const emptyState = useMemo(() => {
    switch (resolvedState) {
      case "missing":
        return "PDF drawing missing. Upload a drawing file to validate extracted dimensions and notes.";
      case "pending":
        return "Drawing preview is still processing. The original PDF can still be downloaded.";
      case "failed":
        return "Drawing preview generation failed. Download the original PDF while this is investigated.";
      case "unavailable":
        return statusMessage ?? "Drawing preview could not be loaded. The original PDF can still be downloaded.";
      default:
        return resolvedViewerMode === "text"
          ? "Text previews are not available in the drawing pane. Download the original file instead."
          : "Preview not available yet. The original PDF can still be downloaded.";
    }
  }, [resolvedState, resolvedViewerMode, statusMessage]);

  return (
    <section className={cn("rounded-[26px] border border-white/8 bg-[#262626] p-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-white/35">Drawing</p>
          <p className="mt-2 text-sm text-white/55">
            Drawing remains the source of truth for the quoteable part definition.
          </p>
        </div>
        {drawingFile ? (
          <div className="flex shrink-0 gap-2">
            {onOpenDialog && resolvedState !== "missing" ? (
              <Button
                type="button"
                variant="outline"
                className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                onClick={onOpenDialog}
              >
                <Expand className="mr-2 h-4 w-4" />
                Expand
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
              onClick={() => {
                void downloadStoredFile(drawingFile);
              }}
            >
              <Download className="mr-2 h-4 w-4" />
              Download
            </Button>
          </div>
        ) : null}
      </div>

      <div className="mt-4 overflow-hidden rounded-[22px] border border-white/8 bg-black/20">
        <div className="bg-white">
          {resolvedLoading ? (
            <div className="flex min-h-[320px] items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
            </div>
          ) : hasPdfPreview && resolvedViewerMode === "pdf" ? (
            <iframe
              src={pdfUrl}
              title={`${drawingFile?.original_name ?? "Drawing"} PDF preview`}
              className="h-[85vh] w-full border-0 bg-white"
            />
          ) : activePage ? (
            <img
              src={activePage.url}
              alt={`${drawingFile.original_name} page ${activePage.pageNumber}`}
              className="w-full object-contain"
            />
          ) : (
            <div className="mx-auto flex min-h-[320px] max-w-md flex-col items-center justify-center gap-3 px-6 text-center text-sm text-zinc-500">
              {resolvedState === "failed" || resolvedState === "unavailable" ? (
                <AlertCircle className="h-6 w-6 text-zinc-400" />
              ) : null}
              <div>
                {emptyState}
              </div>
              {resolvedState === "unavailable" && statusMessage ? (
                <div className="text-xs text-zinc-400">{statusMessage}</div>
              ) : null}
            </div>
          )}
        </div>

        {resolvedPages.length > 1 ? (
          <div className="flex flex-wrap gap-2 border-t border-white/8 px-4 py-3">
            {resolvedPages.map((page) => (
              <button
                key={page.pageNumber}
                type="button"
                onClick={() => setActivePageNumber(page.pageNumber)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition",
                  activePageNumber === page.pageNumber
                    ? "border-white/20 bg-white text-black"
                    : "border-white/10 bg-transparent text-white/70 hover:bg-white/6",
                )}
              >
                Page {page.pageNumber}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function ClientCadPreviewPanel({
  cadFile,
  className,
}: {
  cadFile: JobFileRecord | null;
  className?: string;
}) {
  const previewSource = useMemo(
    () => (cadFile ? createCadPreviewSourceFromJobFile(cadFile) : null),
    [cadFile],
  );
  const previewable = cadFile ? isStepPreviewableFile(cadFile.original_name) : false;

  return (
    <section className={cn("rounded-[26px] border border-white/8 bg-[#262626] p-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-white/35">CAD / isometric</p>
          <p className="mt-2 text-sm text-white/55">
            Static MVP preview with room for deeper 3D controls later.
          </p>
        </div>
        {cadFile ? (
          <Button
            type="button"
            variant="outline"
            className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
            onClick={() => {
              void downloadStoredFile(cadFile);
            }}
          >
            <Download className="mr-2 h-4 w-4" />
            Download
          </Button>
        ) : null}
      </div>

      <div className="mt-4 overflow-hidden rounded-[22px] border border-white/8 bg-black/20">
        {!cadFile ? (
          <div className="flex min-h-[320px] flex-col items-center justify-center px-6 text-center">
            <div className="rounded-full border border-white/10 bg-white/6 p-3 text-white/70">
              <Box className="h-6 w-6" />
            </div>
            <p className="mt-4 text-sm font-medium text-white">CAD missing</p>
            <p className="mt-2 max-w-[18rem] text-sm text-white/45">
              Upload a STEP or native CAD file to review geometry beside the drawing.
            </p>
          </div>
        ) : previewable && previewSource ? (
          <CadModelThumbnail source={previewSource} className="h-[320px] w-full" />
        ) : (
          <div className="flex min-h-[320px] flex-col items-center justify-center px-6 text-center">
            <div className="rounded-full border border-white/10 bg-white/6 p-3 text-white/70">
              <FileText className="h-6 w-6" />
            </div>
            <p className="mt-4 text-sm font-medium text-white">{cadFile.original_name}</p>
            <p className="mt-2 max-w-[18rem] text-sm text-white/45">
              Interactive preview currently supports `.step` and `.stp`. Other CAD formats remain downloadable.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
