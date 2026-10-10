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
  it("turns a partial extraction into a compact field review summary", () => {
    render(<ClientExtractionStatusNotice diagnostics={partialDiagnostics} />);

    expect(screen.getByText("Review 2 drawing fields")).toBeInTheDocument();
    expect(screen.getByText(/Missing: Part number.*Verify: Tightest tolerance/i)).toBeInTheDocument();
    expect(screen.queryByText(/select save request details/i)).not.toBeInTheDocument();
  });

  it("suppresses the redundant success notice", () => {
    const { container } = render(
      <ClientExtractionStatusNotice diagnostics={{ ...partialDiagnostics, lifecycle: "succeeded" }} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("does not show waiting state for parts with no drawing file", () => {
    const noDrawingDiagnostics: ClientExtractionDiagnostics = {
      lifecycle: "succeeded",
      warningCount: 0,
      warnings: [],
      missingFields: [],
      reviewFields: [],
      lastFailureCode: null,
      lastFailureMessage: null,
      extractedAt: null,
      failedAt: null,
      updatedAt: null,
      pageCount: 0,
      hasCadFile: true,
      hasDrawingFile: false,
    };

    const { container } = render(<ClientExtractionStatusNotice diagnostics={noDrawingDiagnostics} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/waiting for drawing metadata/i)).not.toBeInTheDocument();
  });
});
