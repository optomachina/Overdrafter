import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PartViewerRow } from "./PartViewerRow";

vi.mock("@/components/quotes/ClientQuoteAssetPanels", () => ({
  ClientCadPreviewPanel: ({ cadFile }: {
    cadFile: { original_name?: string } | null;
  }) => (
    <div data-testid="cad-panel">
      {cadFile ? cadFile.original_name : "No CAD"}
    </div>
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
  itemKey: "job-1",
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
  it("shows CAD first and lets the user switch to the drawing", () => {
    render(
      <PartViewerRow
        {...baseProps}
        cadFile={{ id: "c1", job_id: "j1", organization_id: "org-1", storage_bucket: "b", storage_path: "p", original_name: "part.step", normalized_name: "part.step", file_kind: "cad", mime_type: "application/step", created_at: "", uploaded_by: "user-1", blob_id: null, content_sha256: null, matched_part_key: null, size_bytes: null }}
        drawingFile={{ id: "f1", job_id: "j1", organization_id: "org-1", storage_bucket: "b", storage_path: "p", original_name: "part.pdf", normalized_name: "part.pdf", file_kind: "drawing", mime_type: "application/pdf", created_at: "", uploaded_by: "user-1", blob_id: null, content_sha256: null, matched_part_key: null, size_bytes: null }}
        drawingPdfUrl="blob:test-pdf"
      />,
    );

    expect(screen.queryByText("CAD model")).not.toBeInTheDocument();
    expect(screen.queryByText("PDF drawing")).not.toBeInTheDocument();

    const cadPanel = screen.getByTestId("cad-panel");
    expect(cadPanel).toBeInTheDocument();
    expect(screen.queryByTitle("part.pdf PDF preview")).not.toBeInTheDocument();

    const drawingTab = screen.getByRole("tab", { name: /drawing/i });
    fireEvent.pointerDown(drawingTab, { button: 0, ctrlKey: false });
    fireEvent.mouseDown(drawingTab, { button: 0, ctrlKey: false });
    fireEvent.click(drawingTab);

    expect(screen.getByTitle("part.pdf PDF preview")).toHaveAttribute("src", "blob:test-pdf");
    expect(screen.queryByTestId("cad-panel")).not.toBeInTheDocument();
  });

  it("shows CAD when it is the only previewable artifact", () => {
    render(
      <PartViewerRow
        {...baseProps}
        cadFile={{ id: "c1", job_id: "j1", organization_id: "org-1", storage_bucket: "b", storage_path: "p", original_name: "part.stp", normalized_name: "part.stp", file_kind: "cad", mime_type: "application/step", created_at: "", uploaded_by: "user-1", blob_id: null, content_sha256: null, matched_part_key: null, size_bytes: null }}
      />,
    );

    expect(screen.getByTestId("cad-panel")).toHaveTextContent("part.stp");
    expect(screen.getByRole("tab", { name: /drawing/i })).toBeDisabled();
  });

  it("falls back to the drawing when the CAD file cannot be previewed", () => {
    render(
      <PartViewerRow
        {...baseProps}
        cadFile={{ id: "c1", job_id: "j1", organization_id: "org-1", storage_bucket: "b", storage_path: "p", original_name: "part.sldprt", normalized_name: "part.sldprt", file_kind: "cad", mime_type: "application/octet-stream", created_at: "", uploaded_by: "user-1", blob_id: null, content_sha256: null, matched_part_key: null, size_bytes: null }}
        drawingFile={{ id: "f1", job_id: "j1", organization_id: "org-1", storage_bucket: "b", storage_path: "p", original_name: "part.pdf", normalized_name: "part.pdf", file_kind: "drawing", mime_type: "application/pdf", created_at: "", uploaded_by: "user-1", blob_id: null, content_sha256: null, matched_part_key: null, size_bytes: null }}
        drawingPdfUrl="blob:test-pdf"
      />,
    );

    expect(screen.getByTitle("part.pdf PDF preview")).toBeInTheDocument();
    const cadTab = screen.getByRole("tab", { name: /cad/i });
    expect(cadTab).toBeEnabled();
    expect(screen.getByRole("tab", { name: /drawing/i })).toHaveAttribute("aria-selected", "true");

    fireEvent.pointerDown(cadTab, { button: 0, ctrlKey: false });
    fireEvent.mouseDown(cadTab, { button: 0, ctrlKey: false });
    fireEvent.click(cadTab);

    expect(screen.getByTestId("cad-panel")).toHaveTextContent("part.sldprt");
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
