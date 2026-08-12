import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ClientExtractionDiagnostics } from "@/features/quotes/types";
import { ClientExtractionStatusNotice } from "./ClientExtractionStatusNotice";

const partialDiagnostics: ClientExtractionDiagnostics = {
  lifecycle: "partial",
  warningCount: 2,
  warnings: ["missing", "review"],
  missingFields: ["partNumber"],
  reviewFields: ["tightestToleranceInch"],
  lastFailureCode: null,
  lastFailureMessage: null,
  extractedAt: "2026-08-04T00:00:00.000Z",
  failedAt: null,
  updatedAt: "2026-08-04T00:00:00.000Z",
  pageCount: 1,
  hasCadFile: true,
  hasDrawingFile: true,
};

describe("ClientExtractionStatusNotice", () => {
  it("turns a partial extraction into one compact, explicit next action", () => {
    render(<ClientExtractionStatusNotice diagnostics={partialDiagnostics} />);

    expect(screen.getByText("Review 2 drawing fields")).toBeInTheDocument();
    expect(
      screen.getByText(
        /add part number; verify tightest tolerance; then save/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/warning/i)).not.toBeInTheDocument();
  });

  it("does not occupy inspector space after extraction succeeds", () => {
    const { container } = render(
      <ClientExtractionStatusNotice
        diagnostics={{ ...partialDiagnostics, lifecycle: "succeeded" }}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
