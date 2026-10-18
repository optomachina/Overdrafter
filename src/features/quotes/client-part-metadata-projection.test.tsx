import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClientExtractionStatusNotice } from "@/components/quotes/ClientExtractionStatusNotice";
import { shouldPollClientWorkspaceState } from "@/features/quotes/client-workspace-polling";
import { normalizeClientPartMetadata } from "@/features/quotes/utils";
import type { Json } from "@/integrations/supabase/types";
import { buildStoredExtractionPayload } from "../../../worker/src/extraction/sharedResult";
import type { DrawingExtractionPayload } from "../../../worker/src/types";
import fixture from "./client-part-metadata-projection.fixture.json";

// OVD-978 end-to-end guard: worker payload -> api_list_client_part_metadata ->
// normalizeClientPartMetadata -> what the client shows. The fixture's
// expected.draft / expected.liveOvd670 rows are what the SQL returns for the
// fixture inputs (docs/migration-drafts/ovd-978.sql and
// 20261011170000_fix_no_drawing_lifecycle.sql respectively); a PGlite harness
// inserts the real buildStoredExtractionPayload output and proves the rows match.

type FixturePart = (typeof fixture.parts)[number];

const partByKey = (key: string): FixturePart => {
  const part = fixture.parts.find((candidate) => candidate.key === key);
  if (!part) throw new Error(`fixture part ${key} missing`);
  return part;
};

const projectedRow = (rows: unknown[], key: string) => {
  const row = rows.find((candidate) => (candidate as { partId?: string }).partId === partByKey(key).partId);
  if (!row) throw new Error(`projection row ${key} missing`);
  return row as Json;
};

const userView = (rows: unknown[], key: string) => {
  const normalized = normalizeClientPartMetadata(projectedRow(rows, key));
  if (!normalized) throw new Error(`normalizer dropped ${key}`);
  return normalized;
};

const keepsPolling = (lifecycle: string) =>
  shouldPollClientWorkspaceState({ extractionLifecycle: lifecycle, quoteRequestStatus: null });

describe("worker extraction payload (OVD-978)", () => {
  it("never stores missingFields or warnings inside the extraction payload", () => {
    for (const part of fixture.parts.filter((candidate) => candidate.extraction)) {
      const { workerInput, pageCount, workerBuildVersion } = part.extraction!;
      const stored = buildStoredExtractionPayload(
        workerInput as unknown as DrawingExtractionPayload,
        pageCount,
        workerBuildVersion,
      );

      expect(stored).not.toHaveProperty("missingFields");
      expect(stored).not.toHaveProperty("warnings");
      expect(stored.pageCount).toBe(pageCount);
    }
  });

  it("writes material and finish as objects even when nothing was found", () => {
    const { workerInput, pageCount, workerBuildVersion } = partByKey("noDrawing").extraction!;
    const stored = buildStoredExtractionPayload(
      workerInput as unknown as DrawingExtractionPayload,
      pageCount,
      workerBuildVersion,
    );

    expect(stored.material).toMatchObject({ raw: null, normalized: null });
    expect(stored.finish).toMatchObject({ raw: null, normalized: null });
  });
});

describe("client part metadata projection (OVD-978 draft)", () => {
  const rows = fixture.expected.draft;

  it("returns the extraction state at the top level the normalizer reads", () => {
    expect(rows).toHaveLength(fixture.parts.length);
    for (const row of rows) {
      expect(row).not.toHaveProperty("clientExtraction");
      expect(row).toHaveProperty("lifecycle");
    }
  });

  it("shows a partial extraction with its warnings, missing fields and page count", () => {
    const view = userView(rows, "partial");

    expect(view.extraction).toMatchObject({
      lifecycle: "partial",
      warningCount: 2,
      warnings: ["Revision not found in the title block.", "No tolerance callout was found."],
      missingFields: ["revision", "tightestToleranceInch"],
      reviewFields: ["finish"],
      pageCount: 2,
      hasCadFile: true,
      hasDrawingFile: true,
    });
    expect(view.requirement).toMatchObject({
      description: "Mounting bracket",
      partNumber: "1093-05589",
      revision: null,
      material: "Aluminum 6061-T6",
      finish: "Black anodize",
      threads: "1/4-20 UNC",
      tightestToleranceInch: null,
      quantity: 5,
      quoteQuantities: [5, 10],
      requestedByDate: "2026-11-20",
    });

    render(<ClientExtractionStatusNotice diagnostics={view.extraction} />);
    expect(screen.getByText("Review 3 drawing fields")).toBeInTheDocument();
    expect(screen.getByText("Missing: Revision, Tightest tolerance · Verify: Finish")).toBeInTheDocument();
    expect(keepsPolling(view.extraction.lifecycle)).toBe(false);
  });

  it("shows a complete extraction as settled with every property filled", () => {
    const view = userView(rows, "complete");

    expect(view.extraction).toMatchObject({
      lifecycle: "succeeded",
      warningCount: 0,
      warnings: [],
      missingFields: [],
      reviewFields: [],
      pageCount: 1,
    });
    expect(view.requirement).toMatchObject({
      description: "Spacer",
      partNumber: "SP-100",
      revision: "C",
      material: "304 Stainless Steel",
      finish: "Passivate",
      tightestToleranceInch: 0.0005,
      quantity: 3,
      quoteQuantities: [3],
    });

    const { container } = render(<ClientExtractionStatusNotice diagnostics={view.extraction} />);
    expect(container).toBeEmptyDOMElement();
    expect(keepsPolling(view.extraction.lifecycle)).toBe(false);
  });

  it("keeps OVD-670's terminal state for a part with no drawing, without leaking payload objects", () => {
    const view = userView(rows, "noDrawing");

    expect(view.extraction).toMatchObject({
      lifecycle: "succeeded",
      hasCadFile: true,
      hasDrawingFile: false,
      pageCount: 0,
      warnings: ["No PDF drawing was attached. Material, finish, and tolerance values require review."],
      missingFields: ["revision", "material", "finish", "tightestToleranceInch"],
    });
    expect(view.requirement.material).toBe("");
    expect(view.requirement.finish).toBeNull();
    expect(view.requirement.material).not.toContain("{");

    const { container } = render(<ClientExtractionStatusNotice diagnostics={view.extraction} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/waiting for drawing metadata/i)).not.toBeInTheDocument();
    expect(keepsPolling(view.extraction.lifecycle)).toBe(false);
  });

  it("shows queued and failed extractions", () => {
    const queued = userView(rows, "queued");
    expect(queued.extraction.lifecycle).toBe("queued");
    expect(keepsPolling(queued.extraction.lifecycle)).toBe(true);
    const queuedNotice = render(<ClientExtractionStatusNotice diagnostics={queued.extraction} />);
    expect(screen.getByText("Drawing extraction in progress")).toBeInTheDocument();
    queuedNotice.unmount();

    const failed = userView(rows, "failed");
    expect(failed.extraction).toMatchObject({
      lifecycle: "failed",
      lastFailureCode: "pdf_parse_failed",
      lastFailureMessage: "The PDF could not be parsed.",
      failedAt: "2026-10-18T10:51:00+00:00",
    });
    render(<ClientExtractionStatusNotice diagnostics={failed.extraction} />);
    expect(screen.getByText("Drawing extraction failed")).toBeInTheDocument();
    expect(screen.getByText("The PDF could not be parsed.")).toBeInTheDocument();
    expect(keepsPolling(failed.extraction.lifecycle)).toBe(false);
  });
});

describe("client part metadata projection (live OVD-670 body, the regression)", () => {
  const rows = fixture.expected.liveOvd670;

  it("hides every extraction state from the client: all parts read as uploaded and keep polling", () => {
    for (const part of fixture.parts) {
      const view = userView(rows, part.key);

      expect(view.extraction.lifecycle).toBe("uploaded");
      expect(view.extraction.warnings).toEqual([]);
      expect(view.extraction.missingFields).toEqual([]);
      expect(view.extraction.pageCount).toBe(0);
      expect(keepsPolling(view.extraction.lifecycle)).toBe(true);
    }

    render(<ClientExtractionStatusNotice diagnostics={userView(rows, "partial").extraction} />);
    expect(screen.getByText("Waiting for drawing metadata")).toBeInTheDocument();
  });
});
