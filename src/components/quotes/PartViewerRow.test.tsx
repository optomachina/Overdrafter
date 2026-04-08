import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PartViewerRow } from "./PartViewerRow";

vi.mock("@/components/quotes/ClientQuoteAssetPanels", () => ({
  ClientCadPreviewPanel: ({ cadFile }: { cadFile: { original_name?: string } | null }) => (
    <div data-testid="cad-panel">{cadFile ? cadFile.original_name : "No CAD"}</div>
  ),
  ClientDrawingPreviewPanel: ({
    pdfUrl,
    drawingFile,
  }: {
    pdfUrl?: string | null;
    drawingFile?: { original_name?: string | null } | null;
  }) =>
    pdfUrl ? (
      <iframe title={`${drawingFile?.original_name ?? "Drawing"} PDF preview`} src={pdfUrl} />
    ) : (
      <div data-testid="drawing-panel">No PDF</div>
    ),
}));

const baseProps = {
  cadFile: null,
  drawingFile: null,
  drawingPreview: null,
  drawingPdfUrl: null,
  drawingPreviewPageUrls: [],
  drawingViewerMode: "pdf" as const,
  drawingPreviewState: "missing" as const,
  drawingPreviewStatusMessage: null,
  isLoading: false,
};

describe("PartViewerRow", () => {
  it("renders CAD then drawing panels without redundant section labels", () => {
    render(<PartViewerRow {...baseProps} />);

    expect(screen.queryByText("CAD model")).not.toBeInTheDocument();
    expect(screen.queryByText("PDF drawing")).not.toBeInTheDocument();

    const cadPanel = screen.getByTestId("cad-panel");
    const drawingPanel = screen.getByTestId("drawing-panel");
    expect(cadPanel).toBeInTheDocument();
    expect(drawingPanel).toBeInTheDocument();
    expect(cadPanel.compareDocumentPosition(drawingPanel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders a PDF iframe when a pdfUrl is provided", () => {
    render(
      <PartViewerRow
        {...baseProps}
        drawingFile={{ id: "f1", job_id: "j1", organization_id: "org-1", storage_bucket: "b", storage_path: "p", original_name: "part.pdf", normalized_name: "part.pdf", file_kind: "drawing", mime_type: "application/pdf", created_at: "", uploaded_by: "user-1", blob_id: null, content_sha256: null, matched_part_key: null, size_bytes: null }}
        drawingPdfUrl="blob:test-pdf"
      />,
    );

    expect(screen.getByTitle("part.pdf PDF preview")).toHaveAttribute("src", "blob:test-pdf");
  });
});
