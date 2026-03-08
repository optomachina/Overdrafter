import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DrawingPreviewDialog } from "./DrawingPreviewDialog";

describe("DrawingPreviewDialog", () => {
  it("hides page arrows for single-page previews", () => {
    render(
      <DrawingPreviewDialog
        open
        onOpenChange={() => undefined}
        fileName="drawing.pdf"
        pageCount={1}
        pages={[{ pageNumber: 1, url: "/page-1.png" }]}
        isLoading={false}
        onDownload={() => undefined}
      />,
    );

    expect(screen.queryByRole("button", { name: "Previous page" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
  });

  it("navigates between pages and disables arrows at the bounds", () => {
    render(
      <DrawingPreviewDialog
        open
        onOpenChange={() => undefined}
        fileName="drawing.pdf"
        pageCount={3}
        pages={[
          { pageNumber: 1, url: "/page-1.png" },
          { pageNumber: 2, url: "/page-2.png" },
          { pageNumber: 3, url: "/page-3.png" },
        ]}
        isLoading={false}
        onDownload={() => undefined}
      />,
    );

    const previousButton = screen.getByRole("button", { name: "Previous page" });
    const nextButton = screen.getByRole("button", { name: "Next page" });

    expect(previousButton).toBeDisabled();
    expect(nextButton).not.toBeDisabled();

    fireEvent.click(nextButton);
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();

    fireEvent.click(nextButton);
    expect(screen.getByText("Page 3 of 3")).toBeInTheDocument();
    expect(nextButton).toBeDisabled();
  });

  it("supports keyboard navigation, download, and resets to the first page when reopened", () => {
    const onDownload = vi.fn();
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <DrawingPreviewDialog
        open
        onOpenChange={onOpenChange}
        fileName="drawing.pdf"
        pageCount={2}
        pages={[
          { pageNumber: 1, url: "/page-1.png" },
          { pageNumber: 2, url: "/page-2.png" },
        ]}
        isLoading={false}
        onDownload={onDownload}
      />,
    );

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    expect(onDownload).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);

    rerender(
      <DrawingPreviewDialog
        open={false}
        onOpenChange={onOpenChange}
        fileName="drawing.pdf"
        pageCount={2}
        pages={[
          { pageNumber: 1, url: "/page-1.png" },
          { pageNumber: 2, url: "/page-2.png" },
        ]}
        isLoading={false}
        onDownload={onDownload}
      />,
    );

    rerender(
      <DrawingPreviewDialog
        open
        onOpenChange={onOpenChange}
        fileName="drawing.pdf"
        pageCount={2}
        pages={[
          { pageNumber: 1, url: "/page-1.png" },
          { pageNumber: 2, url: "/page-2.png" },
        ]}
        isLoading={false}
        onDownload={onDownload}
      />,
    );

    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
  });
});
