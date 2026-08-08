import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Box, Download, Expand, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { CadModelThumbnail } from "@/components/CadModelThumbnail";
import { GeometryProjectionView } from "@/components/workspace/GeometryProjectionView";
import { Button } from "@/components/ui/button";
import type { DrawingExtractionData, DrawingPreviewData, JobFileRecord } from "@/features/quotes/types";
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

type DrawingViewportProps = Readonly<{
  activePage: DrawingPreviewPage | null;
  drawingName: string;
  emptyState: string;
  fittedPdfUrl: string | null;
  isLoading: boolean;
  state: DrawingPreviewState;
  statusMessage: string | null | undefined;
  viewerMode: StoredFileViewerMode;
}>;

function DrawingViewport({
  activePage,
  drawingName,
  emptyState,
  fittedPdfUrl,
  isLoading,
  state,
  statusMessage,
  viewerMode,
}: DrawingViewportProps) {
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (activePage) {
    return (
      <img
        src={activePage.url}
        alt={`${drawingName} page ${activePage.pageNumber}`}
        className="h-full w-full object-contain p-2"
      />
    );
  }

  if (fittedPdfUrl && viewerMode === "pdf") {
    return (
      <iframe
        src={fittedPdfUrl}
        title={`${drawingName} PDF preview`}
        className="h-full w-full border-0 bg-background"
      />
    );
  }

  const showErrorIcon = state === "failed" || state === "unavailable";
  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
      {showErrorIcon ? <AlertCircle className="h-6 w-6 text-muted-foreground" /> : null}
      <div>{emptyState}</div>
      {state === "unavailable" && statusMessage ? (
        <div className="text-xs text-muted-foreground">{statusMessage}</div>
      ) : null}
    </div>
  );
}

function fitPdfPreviewToViewport(url: string) {
  const separator = url.includes("#") ? "&" : "#";
  return `${url}${separator}view=FitH&zoom=page-fit`;
}

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
  const fittedPdfUrl = hasPdfPreview ? fitPdfPreviewToViewport(pdfUrl) : null;
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
    <section className={cn("rounded-[26px] border border-border bg-ws-card p-5", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Drawing</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Drawing remains the source of truth for the quoteable part definition.
          </p>
        </div>
        {drawingFile ? (
          <div className="flex flex-wrap gap-2 sm:shrink-0 sm:flex-nowrap">
            {onOpenDialog && resolvedState !== "missing" ? (
              <Button
                type="button"
                variant="outline"
                className="rounded-full border-border bg-transparent text-foreground hover:bg-accent"
                onClick={onOpenDialog}
              >
                <Expand className="mr-2 h-4 w-4" />
                Expand
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              className="rounded-full border-border bg-transparent text-foreground hover:bg-accent"
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

      <div className="mt-4 overflow-hidden rounded-[22px] border border-border bg-muted">
        <div className="h-[clamp(360px,58vh,680px)] bg-background">
          <DrawingViewport
            activePage={activePage}
            drawingName={drawingFile?.original_name ?? "Drawing"}
            emptyState={emptyState}
            fittedPdfUrl={fittedPdfUrl}
            isLoading={resolvedLoading}
            state={resolvedState}
            statusMessage={statusMessage}
            viewerMode={resolvedViewerMode}
          />
        </div>

        {resolvedPages.length > 1 ? (
          <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
            {resolvedPages.map((page) => (
              <button
                key={page.pageNumber}
                type="button"
                onClick={() => setActivePageNumber(page.pageNumber)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition",
                  activePageNumber === page.pageNumber
                    ? "border-border bg-primary text-primary-foreground"
                    : "border-border bg-transparent text-foreground/80 hover:bg-accent",
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
  geometryProjection = null,
  selectedFeatureIds = [],
  onSelectFeature,
  overlayEnabled = false,
  className,
}: {
  cadFile: JobFileRecord | null;
  geometryProjection?: DrawingExtractionData["geometryProjection"];
  selectedFeatureIds?: string[];
  onSelectFeature?: (featureId: string) => void;
  overlayEnabled?: boolean;
  className?: string;
}) {
  const [tab, setTab] = useState<"cad" | "manufacturing">("cad");
  const previewSource = useMemo(
    () => (cadFile ? createCadPreviewSourceFromJobFile(cadFile) : null),
    [cadFile],
  );
  const previewable = cadFile ? isStepPreviewableFile(cadFile.original_name) : false;

  return (
    <section className={cn("rounded-[26px] border border-border bg-ws-card p-5", className)}>
      <div className="flex items-start justify-end">
        {cadFile ? (
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label="Download CAD file"
            title={`Download ${cadFile.original_name}`}
            className="h-9 w-9 rounded-[2px] border-border bg-transparent text-foreground hover:bg-accent"
            onClick={() => {
              void downloadStoredFile(cadFile).catch((error) => {
                console.error("Failed to download CAD file", error);
                toast.error("Failed to download CAD file.");
              });
            }}
          >
            <Download className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setTab("cad")}
          className={cn(
            "rounded-full border px-3 py-1 text-xs transition",
            tab === "cad" ? "border-border bg-accent text-foreground" : "border-border text-muted-foreground",
          )}
        >
          CAD preview
        </button>
        <button
          type="button"
          onClick={() => setTab("manufacturing")}
          className={cn(
            "rounded-full border px-3 py-1 text-xs transition",
            tab === "manufacturing" ? "border-border bg-accent text-foreground" : "border-border text-muted-foreground",
          )}
        >
          Manufacturing view
        </button>
      </div>

      <div className="mt-4 overflow-hidden rounded-[22px] border border-border bg-muted">
        {tab === "manufacturing" ? (
          geometryProjection ? (
            <GeometryProjectionView
              projection={geometryProjection}
              highlightedFeatureIds={selectedFeatureIds}
              onSelectFeature={onSelectFeature}
              overlayEnabled={overlayEnabled}
            />
          ) : (
            <div className="flex min-h-[320px] flex-col items-center justify-center px-6 text-center">
              <div className="rounded-full border border-border bg-accent p-3 text-foreground/80">
                <FileText className="h-6 w-6" />
              </div>
              <p className="mt-4 text-sm font-medium text-foreground">Manufacturing view unavailable</p>
              <p className="mt-2 max-w-[22rem] text-sm text-muted-foreground">
                Geometry projection data has not been generated for this part yet.
              </p>
            </div>
          )
        ) : !cadFile ? (
          <div className="flex min-h-[320px] flex-col items-center justify-center px-6 text-center">
            <div className="rounded-full border border-border bg-accent p-3 text-foreground/80">
              <Box className="h-6 w-6" />
            </div>
            <p className="mt-4 text-sm font-medium text-foreground">CAD missing</p>
            <p className="mt-2 max-w-[18rem] text-sm text-muted-foreground">
              Upload a STEP or native CAD file to review geometry beside the drawing.
            </p>
          </div>
        ) : previewable && previewSource ? (
          <CadModelThumbnail
            source={previewSource}
            className="h-[320px] w-full"
            fallbackActionLabel={`Download ${cadFile.original_name}`}
            onFallbackAction={() => {
              void downloadStoredFile(cadFile).catch((error) => {
                console.error("Failed to download CAD file", error);
                toast.error("Failed to download CAD file.");
              });
            }}
          />
        ) : (
          <div className="flex min-h-[320px] flex-col items-center justify-center px-6 text-center">
            <div className="rounded-full border border-border bg-accent p-3 text-foreground/80">
              <FileText className="h-6 w-6" />
            </div>
            <p className="mt-4 text-sm font-medium text-foreground">{cadFile.original_name}</p>
            <p className="mt-2 max-w-[18rem] text-sm text-muted-foreground">
              Interactive preview currently supports `.step` and `.stp`. Other CAD formats remain downloadable.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
