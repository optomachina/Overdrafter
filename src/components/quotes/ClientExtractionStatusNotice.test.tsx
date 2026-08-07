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
  it("turns a partial extraction into explicit review and save instructions", () => {
    render(<ClientExtractionStatusNotice diagnostics={partialDiagnostics} />);

    expect(screen.getByText("Review drawing details before sourcing")).toBeInTheDocument();
    expect(screen.getByText(/complete anything marked missing/i)).toBeInTheDocument();
    expect(screen.getByText("Missing: Part number")).toBeInTheDocument();
    expect(screen.getByText("Review: Tightest tolerance")).toBeInTheDocument();
    expect(screen.getByText(/select save request details/i)).toBeInTheDocument();
  });
});
