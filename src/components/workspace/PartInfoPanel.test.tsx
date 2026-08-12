import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PartInfoPanel } from "./PartInfoPanel";

vi.mock("@/components/quotes/ClientPartRequestEditor", () => ({
  ClientPartRequestEditor: () => <div>Request editor</div>,
}));

function renderPartInfoPanel(
  overrides: Partial<ComponentProps<typeof PartInfoPanel>> = {},
) {
  return render(
    <PartInfoPanel
      effectiveRequestDraft={null}
      quoteQuantityInput=""
      onQuoteQuantityInputChange={vi.fn()}
      onDraftChange={vi.fn()}
      onSave={vi.fn()}
      onUploadRevision={vi.fn()}
      {...overrides}
    />,
  );
}

describe("PartInfoPanel", () => {
  it("renders as a flat primary-workspace section", () => {
    const { container } = renderPartInfoPanel();

    expect(
      screen.getByRole("heading", { name: "Part requirements" }),
    ).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass(
      "border-t",
      "border-paper-hairline",
    );
    expect(container.firstElementChild).not.toHaveClass("rounded-[12px]");
  });

  it("renders the request editor when a draft is provided", () => {
    renderPartInfoPanel({
      effectiveRequestDraft: {
        requestedQuoteQuantities: [],
      } as ComponentProps<typeof PartInfoPanel>["effectiveRequestDraft"],
    });

    expect(screen.getByText("Request editor")).toBeInTheDocument();
  });

  it("shows a loading message when no draft is available", () => {
    renderPartInfoPanel({ effectiveRequestDraft: null });

    expect(screen.getByText("Part details are still loading.")).toBeInTheDocument();
  });

  it("renders statusContent above the editor", () => {
    renderPartInfoPanel({
      effectiveRequestDraft: {
        requestedQuoteQuantities: [],
      } as ComponentProps<typeof PartInfoPanel>["effectiveRequestDraft"],
      statusContent: <div>Status notice</div>,
    });

    expect(screen.getByText("Status notice")).toBeInTheDocument();
    expect(screen.getByText("Request editor")).toBeInTheDocument();
    expect(screen.getByTestId("part-status-content")).toHaveClass(
      "grid",
      "lg:grid-cols-2",
    );
  });
});
