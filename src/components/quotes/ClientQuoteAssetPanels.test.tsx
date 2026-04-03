import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClientCadPreviewPanel, ClientDrawingPreviewPanel } from "./ClientQuoteAssetPanels";
import type { DrawingPreviewData, JobFileRecord } from "@/features/quotes/types";
import { downloadStoredFileBlob } from "@/lib/stored-file";

vi.mock("@/components/CadModelThumbnail", () => ({
  CadModelThumbnail: ({
    fallbackActionLabel,
    onFallbackAction,
  }: {
    fallbackActionLabel?: string;
    onFallbackAction?: () => void;
  }) => (
    <div>
      <div>CAD Preview</div>
      {onFallbackAction ? (
        <button type="button" onClick={onFallbackAction}>
          {fallbackActionLabel ?? "Download CAD file"}
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock("@/lib/stored-file", () => ({
  downloadStoredFileBlob: vi.fn(),
  loadStoredDrawingPreviewPages: vi.fn(),
}));

const drawingFile = {
  storage_bucket: "job-files",
  storage_path: "org/drawing.pdf",
  original_name: "drawing.pdf",
} as unknown as JobFileRecord;

const emptyPreview = {
  pageCount: 0,
  thumbnail: null,
  pages: [],
} satisfies DrawingPreviewData;

describe("ClientDrawingPreviewPanel", () => {
  it("shows an explicit pending message when preview generation has not finished", () => {
    render(
      <ClientDrawingPreviewPanel
        drawingFile={drawingFile}
        drawingPreview={emptyPreview}
        state="pending"
        statusMessage="Drawing preview is still processing. The original PDF can still be downloaded."
      />,
    );

    expect(screen.getByText(/still processing/i)).toBeInTheDocument();
  });

  it("shows an explicit failed message when extraction failed", () => {
    render(
      <ClientDrawingPreviewPanel
        drawingFile={drawingFile}
        drawingPreview={emptyPreview}
        state="failed"
      />,
    );

    expect(screen.getByText(/generation failed/i)).toBeInTheDocument();
  });

  it("shows the preview load error when assets are unavailable", () => {
    render(
      <ClientDrawingPreviewPanel
        drawingFile={drawingFile}
        drawingPreview={emptyPreview}
        state="unavailable"
        statusMessage="Storage policy denied access."
      />,
    );

    expect(screen.getAllByText("Storage policy denied access.")).toHaveLength(2);
  });

  it("renders preview imagery when pages are available", () => {
    render(
      <ClientDrawingPreviewPanel
        drawingFile={drawingFile}
        drawingPreview={{
          pageCount: 1,
          thumbnail: null,
          pages: [
            {
              pageNumber: 1,
              storageBucket: "quote-artifacts",
              storagePath: "preview/page-1.png",
              width: 100,
              height: 100,
            },
          ],
        }}
        pages={[{ pageNumber: 1, url: "blob:preview" }]}
        state="ready"
      />,
    );

    expect(screen.getByRole("img", { name: /drawing\.pdf page 1/i })).toBeInTheDocument();
  });

  it("renders the original PDF when a pdfUrl is provided", () => {
    render(
      <ClientDrawingPreviewPanel
        drawingFile={drawingFile}
        drawingPreview={emptyPreview}
        viewerMode="pdf"
        pdfUrl="blob:drawing-pdf"
        state="ready"
      />,
    );

    expect(screen.getByTitle("drawing.pdf PDF preview")).toBeInTheDocument();
  });

  it("never renders raw PDF header text when PDF mode is selected", () => {
    render(
      <ClientDrawingPreviewPanel
        drawingFile={drawingFile}
        drawingPreview={emptyPreview}
        viewerMode="pdf"
        pdfUrl="blob:drawing-pdf"
        state="ready"
      />,
    );

    expect(screen.queryByText("PDF-1.4")).not.toBeInTheDocument();
    expect(screen.queryByText(/xref/i)).not.toBeInTheDocument();
  });
});

describe("ClientCadPreviewPanel", () => {
  it("wires thumbnail fallback download action to CAD download", async () => {
    vi.mocked(downloadStoredFileBlob).mockImplementation(() => new Promise(() => {}));

    const cadFile = {
      id: "cad-1",
      storage_bucket: "job-files",
      storage_path: "org/model.step",
      original_name: "model.step",
    } as unknown as JobFileRecord;

    render(<ClientCadPreviewPanel cadFile={cadFile} />);

    fireEvent.click(screen.getByRole("button", { name: /download model\.step/i }));

    expect(downloadStoredFileBlob).toHaveBeenCalledWith(cadFile);
  });
});
