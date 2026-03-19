import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ExtractionLabCard } from "@/components/quotes/ExtractionLabCard";
import type {
  DebugExtractionRunRecord,
  DrawingPreviewAssetRecord,
  PartAggregate,
  WorkerReadinessSnapshot,
} from "@/features/quotes/types";

const apiMock = vi.hoisted(() => ({
  fetchWorkerReadiness: vi.fn<() => Promise<WorkerReadinessSnapshot>>(),
  requestDebugExtraction: vi.fn(),
}));

const storedFileMock = vi.hoisted(() => ({
  downloadStoredFileBlob: vi.fn(),
}));

vi.mock("@/features/quotes/api", () => ({
  fetchWorkerReadiness: apiMock.fetchWorkerReadiness,
  requestDebugExtraction: apiMock.requestDebugExtraction,
}));
vi.mock("@/features/quotes/api/internal-review", () => ({
  fetchWorkerReadiness: apiMock.fetchWorkerReadiness,
  requestDebugExtraction: apiMock.requestDebugExtraction,
}));

vi.mock("@/lib/stored-file", () => ({
  downloadStoredFileBlob: storedFileMock.downloadStoredFileBlob,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

function makePart(overrides: Partial<PartAggregate> = {}): PartAggregate {
  return {
    id: "part-1",
    job_id: "job-1",
    organization_id: "org-1",
    name: "Bracket",
    normalized_key: "bracket",
    cad_file_id: null,
    drawing_file_id: "drawing-1",
    quantity: 10,
    created_at: "2026-03-17T10:00:00.000Z",
    updated_at: "2026-03-17T10:00:00.000Z",
    cadFile: null,
    drawingFile: {
      id: "drawing-1",
      job_id: "job-1",
      organization_id: "org-1",
      uploaded_by: "user-1",
      blob_id: null,
      storage_bucket: "job-files",
      storage_path: "jobs/job-1/bracket.pdf",
      original_name: "bracket.pdf",
      normalized_name: "bracket",
      file_kind: "drawing",
      mime_type: "application/pdf",
      size_bytes: 1234,
      content_sha256: null,
      matched_part_key: "bracket",
      created_at: "2026-03-17T10:00:00.000Z",
    },
    extraction: {
      id: "extract-1",
      part_id: "part-1",
      organization_id: "org-1",
      extractor_version: "worker-pdf-v3",
      extraction: {
        workerBuildVersion: "build-canonical",
        partNumber: "1093-05589",
        revision: "02",
        description: "ROUND, CARBON FIBER END ATTACHMENTS BONDED",
        quoteDescription: "BONDED, CARBON FIBER END ATTACHMENT",
        extractedDescriptionRaw: {
          value: "ROUND, CARBON FIBER END ATTACHMENTS BONDED",
          confidence: 0.98,
          reviewNeeded: false,
          reasons: ["label_match"],
        },
        extractedPartNumberRaw: {
          value: "1093-05589",
          confidence: 0.99,
          reviewNeeded: false,
          reasons: ["label_match"],
        },
        extractedRevisionRaw: {
          value: "02",
          confidence: 0.97,
          reviewNeeded: false,
          reasons: ["label_match"],
        },
        extractedFinishRaw: {
          value: "ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2",
          confidence: 0.96,
          reviewNeeded: false,
          reasons: ["label_match"],
        },
        material: {
          raw: "6061 Alloy",
          normalized: "6061 Alloy",
          confidence: 0.9,
          reviewNeeded: false,
          reasons: [],
        },
        finish: {
          raw: "ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2",
          normalized: "Black Anodize, Type II",
          confidence: 0.96,
          reviewNeeded: false,
          reasons: [],
        },
        tolerances: {
          tightest: "0.005",
          valueInch: 0.005,
          confidence: 0.85,
        },
        reviewFields: [],
      },
      confidence: 0.96,
      warnings: [],
      evidence: [],
      status: "approved",
      created_at: "2026-03-17T10:00:00.000Z",
      updated_at: "2026-03-17T10:00:00.000Z",
    },
    approvedRequirement: null,
    vendorQuotes: [],
    ...overrides,
  };
}

function makeDebugRun(overrides: Partial<DebugExtractionRunRecord> = {}): DebugExtractionRunRecord {
  return {
    id: "debug-run-1",
    organization_id: "org-1",
    job_id: "job-1",
    part_id: "part-1",
    requested_by: "user-1",
    status: "completed",
    requested_model: "gpt-5.4-mini",
    effective_model: "gpt-5.4-mini",
    worker_build_version: "build-debug",
    extractor_version: "worker-pdf-v3",
    model_fallback_used: true,
    model_prompt_version: "2026-03-16.v1",
    result: {
      status: "approved",
      warnings: [],
      evidence: [],
      extraction: {
        workerBuildVersion: "build-debug",
        partNumber: "1093-05589",
        revision: "02",
        description: "ROUND, CARBON FIBER END ATTACHMENTS BONDED",
        quoteDescription: "BONDED, CARBON FIBER END ATTACHMENT",
        extractedDescriptionRaw: {
          value: "ROUND, CARBON FIBER END ATTACHMENTS BONDED",
          confidence: 0.99,
          reviewNeeded: false,
          reasons: ["model_fallback"],
        },
        extractedPartNumberRaw: {
          value: "1093-05589",
          confidence: 0.99,
          reviewNeeded: false,
          reasons: ["model_fallback"],
        },
        extractedRevisionRaw: {
          value: "02",
          confidence: 0.98,
          reviewNeeded: false,
          reasons: ["model_fallback"],
        },
        extractedFinishRaw: {
          value: "ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2",
          confidence: 0.95,
          reviewNeeded: false,
          reasons: ["model_fallback"],
        },
        material: {
          raw: "6061 Alloy",
          normalized: "6061 Alloy",
          confidence: 0.9,
          reviewNeeded: false,
          reasons: [],
        },
        finish: {
          raw: "ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2",
          normalized: "Black Anodize, Type II",
          confidence: 0.95,
          reviewNeeded: false,
          reasons: [],
        },
        tolerances: {
          tightest: "0.005",
          valueInch: 0.005,
          confidence: 0.85,
        },
        reviewFields: [],
      },
    },
    error: null,
    started_at: "2026-03-17T10:01:00.000Z",
    completed_at: "2026-03-17T10:02:00.000Z",
    created_at: "2026-03-17T10:00:30.000Z",
    updated_at: "2026-03-17T10:02:00.000Z",
    ...overrides,
  };
}

function makePreviewAsset(
  overrides: Partial<DrawingPreviewAssetRecord> = {},
): DrawingPreviewAssetRecord {
  return {
    id: "preview-1",
    part_id: "part-1",
    organization_id: "org-1",
    page_number: 1,
    kind: "page",
    storage_bucket: "quote-artifacts",
    storage_path: "org-1/drawing-previews/job-1/part-1/page-1.png",
    width: 800,
    height: 1200,
    created_at: "2026-03-17T10:00:00.000Z",
    ...overrides,
  };
}

function renderCard(
  overrides: Partial<ComponentProps<typeof ExtractionLabCard>> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ExtractionLabCard
        jobId="job-1"
        parts={[makePart()]}
        debugExtractionRuns={[]}
        drawingPreviewAssets={[]}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

describe("ExtractionLabCard", () => {
  it("queues a preview-only debug extraction with the selected model", async () => {
    apiMock.fetchWorkerReadiness.mockResolvedValue({
      reachable: true,
      ready: true,
      workerName: "worker-1",
      workerBuildVersion: "build-live",
      workerMode: "live",
      drawingExtractionModel: "gpt-5.4-mini",
      drawingExtractionDebugAllowedModels: ["gpt-5.4-mini", "gpt-5.4"],
      drawingExtractionModelFallbackEnabled: true,
      status: "running",
      readinessIssues: [],
      message: null,
      url: "https://worker.example.com/readyz",
    });
    apiMock.requestDebugExtraction.mockResolvedValue("debug-run-queued");

    renderCard();

    await screen.findByText("Extraction Lab");
    expect(screen.getByText("Latest debug run: None")).toHaveClass("text-white/70");
    await waitFor(() => {
      expect(screen.getByRole("combobox")).toHaveTextContent("gpt-5.4-mini");
    });
    fireEvent.click(screen.getByRole("button", { name: /run debug extraction/i }));

    await waitFor(() => {
      expect(apiMock.requestDebugExtraction).toHaveBeenCalledWith("part-1", "gpt-5.4-mini");
    });
  });

  it("shows canonical and debug extraction data side by side", async () => {
    apiMock.fetchWorkerReadiness.mockResolvedValue({
      reachable: true,
      ready: true,
      workerName: "worker-1",
      workerBuildVersion: "build-live",
      workerMode: "live",
      drawingExtractionModel: "gpt-5.4",
      drawingExtractionDebugAllowedModels: ["gpt-5.4"],
      drawingExtractionModelFallbackEnabled: true,
      status: "running",
      readinessIssues: [],
      message: null,
      url: "https://worker.example.com/readyz",
    });
    storedFileMock.downloadStoredFileBlob.mockResolvedValue(new Blob(["preview"]));

    renderCard({
      debugExtractionRuns: [makeDebugRun()],
      drawingPreviewAssets: [makePreviewAsset()],
    });

    fireEvent.click(await screen.findByRole("button", { name: /inspect latest/i }));

    expect(await screen.findByText("Canonical extraction")).toBeInTheDocument();
    expect(screen.getByText("Debug run")).toBeInTheDocument();
    expect(screen.getAllByText("1093-05589").length).toBeGreaterThan(0);
    expect(screen.getAllByText((content) => content.includes("build-debug")).length).toBeGreaterThan(0);
    expect(screen.getByText("Preview image used for debugging")).toBeInTheDocument();
    await waitFor(() => {
      expect(storedFileMock.downloadStoredFileBlob).toHaveBeenCalled();
    });
  });
});
