import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClientCadPreviewPanel, ClientDrawingPreviewPanel } from "./ClientQuoteAssetPanels";
import type { DrawingPreviewData, JobFileRecord } from "@/features/quotes/types";
import { downloadStoredFileBlob } from "@/lib/stored-file";

const toastMock = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("sonner", () => ({ toast: toastMock }));

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

const cadFile = {
  id: "cad-1",
  storage_bucket: "job-files",
  storage_path: "org/model.step",
  original_name: "model.step",
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

    const previewImage = screen.getByRole("img", { name: /drawing\.pdf page 1/i });
    expect(previewImage).toHaveClass("h-full", "w-full", "object-contain");
    expect(previewImage.parentElement).toHaveClass("h-[clamp(360px,58vh,680px)]");
  });

  it("prefers fitted preview imagery over the embedded PDF viewer", () => {
    render(
      <ClientDrawingPreviewPanel
        drawingFile={drawingFile}
        drawingPreview={emptyPreview}
        viewerMode="pdf"
        pdfUrl="blob:drawing-pdf"
        pages={[{ pageNumber: 1, url: "blob:preview" }]}
        state="ready"
      />,
    );

    expect(screen.getByRole("img", { name: /drawing\.pdf page 1/i })).toBeInTheDocument();
    expect(screen.queryByTitle("drawing.pdf PDF preview")).not.toBeInTheDocument();
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

    expect(screen.getByTitle("drawing.pdf PDF preview")).toHaveAttribute(
      "src",
      "blob:drawing-pdf#view=FitH&zoom=page-fit",
    );
  });

  it("keeps drawing actions compact and downloads from the icon action", () => {
    vi.mocked(downloadStoredFileBlob).mockImplementation(() => new Promise(() => {}));

    render(
      <ClientDrawingPreviewPanel
        drawingFile={drawingFile}
        drawingPreview={emptyPreview}
        state="ready"
        onOpenDialog={vi.fn()}
      />,
    );

    const actionRow = screen.getByRole("button", { name: "Expand" }).parentElement;
    expect(actionRow).toHaveClass("flex-wrap", "sm:flex-nowrap");
    const downloadButton = screen.getByRole("button", { name: "Download drawing" });
    expect(downloadButton).toHaveAttribute("title", "Download drawing.pdf");
    expect(downloadButton).toHaveClass("rounded-[2px]");
    expect(downloadButton).not.toHaveTextContent(/download/i);
    fireEvent.click(downloadButton);
    expect(downloadStoredFileBlob).toHaveBeenCalledWith(drawingFile);
    expect(screen.queryByText(/drawing remains the source of truth/i)).not.toBeInTheDocument();
  });

  it("reports drawing download failures from the icon action", async () => {
    const downloadError = new Error("storage unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    toastMock.error.mockClear();
    vi.mocked(downloadStoredFileBlob).mockRejectedValueOnce(downloadError);

    render(
      <ClientDrawingPreviewPanel
        drawingFile={drawingFile}
        drawingPreview={emptyPreview}
        state="ready"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download drawing" }));

    try {
      await waitFor(() => {
        expect(toastMock.error).toHaveBeenCalledWith("Failed to download drawing file.");
      });
      expect(consoleError).toHaveBeenCalledWith("Failed to download drawing file", downloadError);
    } finally {
      consoleError.mockRestore();
    }
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
  it("wires the icon and thumbnail fallback actions to CAD download", async () => {
    vi.mocked(downloadStoredFileBlob).mockImplementation(() => new Promise(() => {}));

    render(<ClientCadPreviewPanel cadFile={cadFile} />);

    expect(screen.queryByText("CAD / isometric")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manufacturing view" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "CAD preview" })).not.toBeInTheDocument();
    const downloadButton = screen.getByRole("button", { name: "Download CAD file" });
    expect(downloadButton).toHaveAttribute("title", "Download model.step");
    expect(downloadButton).toHaveClass("rounded-[2px]");
    const controlRow = downloadButton.parentElement;
    expect(controlRow).toHaveClass("flex", "items-center", "justify-between");
    expect(controlRow).toContainElement(screen.getByText("CAD preview"));
    fireEvent.click(downloadButton);
    expect(downloadStoredFileBlob).toHaveBeenCalledWith(cadFile);

    vi.mocked(downloadStoredFileBlob).mockClear();
    fireEvent.click(screen.getByRole("button", { name: /download model\.step/i }));

    expect(downloadStoredFileBlob).toHaveBeenCalledWith(cadFile);
  });

  it("reports CAD download failures from the icon action", async () => {
    const downloadError = new Error("storage unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    toastMock.error.mockClear();
    vi.mocked(downloadStoredFileBlob).mockRejectedValueOnce(downloadError);

    render(<ClientCadPreviewPanel cadFile={cadFile} />);
    fireEvent.click(screen.getByRole("button", { name: "Download CAD file" }));

    try {
      await waitFor(() => {
        expect(toastMock.error).toHaveBeenCalledWith("Failed to download CAD file.");
      });
      expect(consoleError).toHaveBeenCalledWith("Failed to download CAD file", downloadError);
    } finally {
      consoleError.mockRestore();
    }
  });
});
