import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PartInfoPanel } from "./PartInfoPanel";

vi.mock("@/components/quotes/ClientPartRequestEditor", () => ({
  ClientPartRequestEditor: () => <div>Request editor</div>,
}));

function renderPartInfoPanel(overrides: Partial<ComponentProps<typeof PartInfoPanel>> = {}) {
  render(
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
  });
});
