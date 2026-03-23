import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ApprovedPartRequirement,
  ApprovedPartRequirementRecord,
  DrawingExtractionRecord,
  PartAggregate,
} from "@/features/quotes/types";
import { InternalJobPartRequirementCard } from "./InternalJobPartRequirementCard";

vi.mock("@/components/CadModelThumbnail", () => ({
  CadModelThumbnail: () => <div>CAD Preview</div>,
}));

vi.mock("@/components/quotes/RfqLineItemMetadataFields", () => ({
  RfqLineItemMetadataFields: () => <div>RFQ metadata</div>,
}));

vi.mock("@/components/quotes/RequestServiceIntentFields", () => ({
  RequestServiceIntentFields: () => <div>Request service intent</div>,
}));

vi.mock("@/components/quotes/RequestSummaryBadges", () => ({
  RequestSummaryBadges: () => <div>Request summary badges</div>,
}));

function makeDraft(): ApprovedPartRequirement {
  return {
    partId: "part-1",
    requestedServiceKinds: ["manufacturing_quote"],
    primaryServiceKind: "manufacturing_quote",
    serviceNotes: null,
    description: "Bracket",
    partNumber: "BRKT-001",
    revision: "A",
    material: "6061-T6",
    finish: null,
    tightestToleranceInch: 0.005,
    process: null,
    notes: null,
    quantity: 10,
    quoteQuantities: [10],
    requestedByDate: null,
    shipping: {
      requestedByDateOverride: null,
      packagingNotes: null,
      shippingNotes: null,
    },
    certifications: {
      requiredCertifications: [],
      materialCertificationRequired: null,
      certificateOfConformanceRequired: null,
      inspectionLevel: null,
      notes: null,
    },
    sourcing: {
      regionPreferenceOverride: null,
      preferredSuppliers: [],
      materialProvisioning: null,
      notes: null,
    },
    release: {
      releaseStatus: null,
      reviewDisposition: null,
      quoteBlockedUntilRelease: null,
      notes: null,
    },
    applicableVendors: ["xometry"],
  };
}

function makeApprovedRequirementRecord(): ApprovedPartRequirementRecord {
  return {
    id: "req-1",
    part_id: "part-1",
    organization_id: "org-1",
    approved_by: "user-1",
    description: "Bracket",
    part_number: "BRKT-001",
    revision: "A",
    material: "6061-T6",
    finish: null,
    tightest_tolerance_inch: 0.005,
    quantity: 10,
    quote_quantities: [10],
    requested_by_date: null,
    applicable_vendors: ["xometry"],
    spec_snapshot: {},
    approved_at: "2026-03-15T00:00:00.000Z",
    created_at: "2026-03-15T00:00:00.000Z",
    updated_at: "2026-03-15T00:00:00.000Z",
  };
}

function makeExtractionRecord(selectedBy: "parser" | "model" | "review"): DrawingExtractionRecord {
  return {
    id: "extract-1",
    part_id: "part-1",
    organization_id: "org-1",
    extractor_version: "test-extractor",
    extraction: {
      description: "Bracket",
      partNumber: "BRKT-001",
      revision: "A",
      extractedDescriptionRaw: {
        value: "Bracket",
        confidence: 1,
        reviewNeeded: false,
        reasons: [],
        sourceRegion: null,
      },
      extractedPartNumberRaw: {
        value: "BRKT-001",
        confidence: 1,
        reviewNeeded: false,
        reasons: [],
        sourceRegion: null,
      },
      extractedRevisionRaw: {
        value: "A",
        confidence: 1,
        reviewNeeded: false,
        reasons: [],
        sourceRegion: null,
      },
      material: {
        raw: "6061-T6",
        normalized: "6061-T6",
        confidence: 1,
      },
      finish: {
        raw: "As machined",
        normalized: null,
        confidence: 1,
      },
      tolerances: {
        tightest: "0.005",
      },
      fieldSelections: {
        description: selectedBy,
        partNumber: "parser",
        revision: "parser",
        material: "parser",
        finish: "parser",
        process: "parser",
      },
    },
    warnings: [],
    evidence: [],
    confidence: 1,
    status: "approved",
    created_at: "2026-03-15T00:00:00.000Z",
    updated_at: "2026-03-15T00:00:00.000Z",
  };
}

function makePart(selectedBy: "parser" | "model" | "review"): PartAggregate {
  return {
    id: "part-1",
    job_id: "job-1",
    organization_id: "org-1",
    name: "Bracket",
    normalized_key: "bracket",
    cad_file_id: "cad-1",
    drawing_file_id: "drawing-1",
    quantity: 10,
    created_at: "2026-03-15T00:00:00.000Z",
    updated_at: "2026-03-15T00:00:00.000Z",
    cadFile: {
      id: "cad-1",
      job_id: "job-1",
      organization_id: "org-1",
      file_kind: "cad",
      blob_id: "blob-1",
      storage_bucket: "job-files",
      storage_path: "cad.step",
      normalized_name: "cad.step",
      original_name: "cad.step",
      size_bytes: 123,
      mime_type: "application/step",
      content_sha256: "hash",
      matched_part_key: null,
      uploaded_by: "user-1",
      created_at: "2026-03-15T00:00:00.000Z",
    },
    drawingFile: {
      id: "drawing-1",
      job_id: "job-1",
      organization_id: "org-1",
      file_kind: "drawing",
      blob_id: "blob-2",
      storage_bucket: "job-files",
      storage_path: "drawing.pdf",
      normalized_name: "drawing.pdf",
      original_name: "drawing.pdf",
      size_bytes: 456,
      mime_type: "application/pdf",
      content_sha256: "hash-2",
      matched_part_key: null,
      uploaded_by: "user-1",
      created_at: "2026-03-15T00:00:00.000Z",
    },
    extraction: makeExtractionRecord(selectedBy),
    approvedRequirement: makeApprovedRequirementRecord(),
    vendorQuotes: [],
  };
}

describe("InternalJobPartRequirementCard", () => {
  it("adds an AI-assisted label for model-selected extraction provenance", () => {
    render(
      <InternalJobPartRequirementCard
        cadPreviewSource={null}
        disabled={false}
        draft={makeDraft()}
        onDraftChange={() => undefined}
        onDraftQuantityChange={() => undefined}
        onQuoteQuantityInputChange={() => undefined}
        onQuoteQuantityInputCommit={() => undefined}
        part={makePart("model")}
        quoteQuantityInput="10"
      />,
    );

    const provenance = screen.getByText("AI-assisted");

    expect(provenance).toHaveAttribute("aria-label", "AI-assisted");
  });

  it("does not add the AI-assisted label for parser-selected provenance", () => {
    render(
      <InternalJobPartRequirementCard
        cadPreviewSource={null}
        disabled={false}
        draft={makeDraft()}
        onDraftChange={() => undefined}
        onDraftQuantityChange={() => undefined}
        onQuoteQuantityInputChange={() => undefined}
        onQuoteQuantityInputCommit={() => undefined}
        part={makePart("parser")}
        quoteQuantityInput="10"
      />,
    );

    expect(screen.queryByLabelText("AI-assisted")).not.toBeInTheDocument();
    expect(screen.getAllByText(/source: parser/i).length).toBeGreaterThan(0);
  });
});
