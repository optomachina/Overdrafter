import { ClientCadPreviewPanel, ClientDrawingPreviewPanel } from "@/components/quotes/ClientQuoteAssetPanels";
import { ClientArtifactWorkspace } from "@/components/quotes/ClientArtifactWorkspace";
import type { DrawingPreviewPage, DrawingPreviewState } from "@/components/quotes/ClientQuoteAssetPanels";
import type { DrawingPreviewData, JobFileRecord } from "@/features/quotes/types";
import { isStepPreviewableFile } from "@/lib/cad-preview";
import type { StoredFileViewerMode } from "@/lib/file-viewer";

type PartViewerRowProps = {
  readonly itemKey: string;
  readonly cadFile: JobFileRecord | null | undefined;
  readonly drawingFile: JobFileRecord | null | undefined;
  readonly drawingPreview: DrawingPreviewData | null | undefined;
  readonly drawingPdfUrl: string | null;
  readonly drawingPreviewPageUrls: DrawingPreviewPage[];
  readonly drawingViewerMode: StoredFileViewerMode;
  readonly drawingPreviewState: DrawingPreviewState;
  readonly drawingPreviewStatusMessage: string | null;
  readonly isLoading: boolean;
  readonly onOpenDialog?: () => void;
};

export function PartViewerRow({
  itemKey,
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
  const hasCadPreview = Boolean(cadFile && isStepPreviewableFile(cadFile.original_name));

  return (
    <ClientArtifactWorkspace
      itemKey={itemKey}
      hasCad={Boolean(cadFile)}
      hasCadPreview={hasCadPreview}
      hasDrawing={Boolean(drawingFile)}
      cadPanel={(
        <ClientCadPreviewPanel
          cadFile={cadFile ?? null}
          className="rounded-[8px] border-0 bg-transparent p-0"
        />
      )}
      drawingPanel={<ClientDrawingPreviewPanel
        drawingFile={drawingFile ?? null}
        drawingPreview={drawingPreview ?? { pageCount: 0, thumbnail: null, pages: [] }}
        viewerMode={drawingViewerMode}
        pdfUrl={drawingPdfUrl}
        pages={drawingPreviewPageUrls.length > 0 ? drawingPreviewPageUrls : undefined}
        state={drawingPreviewState}
        statusMessage={drawingPreviewStatusMessage}
        isLoading={isLoading}
        onOpenDialog={onOpenDialog}
        className="rounded-[8px] border-0 bg-transparent p-0"
      />}
    />
  );
}
