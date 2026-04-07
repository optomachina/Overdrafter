import { ClientCadPreviewPanel, ClientDrawingPreviewPanel } from "@/components/quotes/ClientQuoteAssetPanels";
import type { DrawingPreviewPage, DrawingPreviewState } from "@/components/quotes/ClientQuoteAssetPanels";
import type { DrawingPreviewData, JobFileRecord } from "@/features/quotes/types";
import type { StoredFileViewerMode } from "@/lib/file-viewer";

type PartViewerRowProps = {
  cadFile: JobFileRecord | null | undefined;
  drawingFile: JobFileRecord | null | undefined;
  drawingPreview: DrawingPreviewData | null | undefined;
  drawingPdfUrl: string | null;
  drawingPreviewPageUrls: DrawingPreviewPage[];
  drawingViewerMode: StoredFileViewerMode;
  drawingPreviewState: DrawingPreviewState;
  drawingPreviewStatusMessage: string | null;
  isLoading: boolean;
  onOpenDialog?: (() => void) | undefined;
};

export function PartViewerRow({
  cadFile,
  drawingFile,
  drawingPreview,
  drawingPdfUrl,
  drawingPreviewPageUrls,
  drawingViewerMode,
  drawingPreviewState,
  drawingPreviewStatusMessage,
  isLoading,
  onOpenDialog,
}: PartViewerRowProps) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div>
        <p className="mb-[6px] text-[9px] font-bold uppercase tracking-[0.14em] text-white/20">CAD model</p>
        <ClientCadPreviewPanel cadFile={cadFile ?? null} />
      </div>
      <div>
        <p className="mb-[6px] text-[9px] font-bold uppercase tracking-[0.14em] text-white/20">PDF drawing</p>
        <ClientDrawingPreviewPanel
          drawingFile={drawingFile ?? null}
          drawingPreview={drawingPreview ?? { pageCount: 0, thumbnail: null, pages: [] }}
          viewerMode={drawingViewerMode}
          pdfUrl={drawingPdfUrl}
          pages={drawingPreviewPageUrls.length > 0 ? drawingPreviewPageUrls : undefined}
          state={drawingPreviewState}
          statusMessage={drawingPreviewStatusMessage}
          isLoading={isLoading}
          onOpenDialog={onOpenDialog}
        />
      </div>
    </div>
  );
}
