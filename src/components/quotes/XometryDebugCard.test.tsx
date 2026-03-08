import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { XometryDebugCard } from "@/components/quotes/XometryDebugCard";
import type {
  PartAggregate,
  QuoteRunAggregate,
  VendorQuoteAggregate,
  WorkerReadinessSnapshot,
  WorkQueueRecord,
} from "@/features/quotes/types";

const apiMock = vi.hoisted(() => ({
  enqueueDebugVendorQuote: vi.fn(),
  fetchWorkerReadiness: vi.fn<() => Promise<WorkerReadinessSnapshot>>(),
}));

const supabaseMock = vi.hoisted(() => ({
  download: vi.fn(),
  storageFrom: vi.fn(() => ({
    download: supabaseMock.download,
  })),
}));

vi.mock("@/features/quotes/api", () => ({
  enqueueDebugVendorQuote: apiMock.enqueueDebugVendorQuote,
  fetchWorkerReadiness: apiMock.fetchWorkerReadiness,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    storage: {
      from: supabaseMock.storageFrom,
    },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function makeQuote(overrides: Partial<VendorQuoteAggregate> = {}): VendorQuoteAggregate {
  return {
    id: "quote-1",
    quote_run_id: "run-1",
    part_id: "part-1",
    organization_id: "org-1",
    vendor: "xometry",
    requested_quantity: 10,
    status: "failed",
    unit_price_usd: null,
    total_price_usd: null,
    lead_time_business_days: null,
    quote_url: null,
    dfm_issues: [],
    notes: ["Selector drift encountered."],
    raw_payload: {
      failureCode: "selector_failure",
      detectedFlow: "configuration_complete",
      selectedMaterial: "6061-T6",
      selectedFinish: "Type II",
      priceSource: "none",
      leadTimeSource: "none",
      attemptedSelectors: ["[data-testid*=quantity] input"],
      bodyExcerpt: "Xometry quantity input was not found.",
      retryCount: 1,
      retryScheduledFor: "2026-03-07T18:00:00.000Z",
      url: "https://www.xometry.com/quoting/home/",
    },
    created_at: "2026-03-07T17:00:00.000Z",
    updated_at: "2026-03-07T17:30:00.000Z",
    offers: [],
    artifacts: [
      {
        id: "artifact-1",
        vendor_quote_result_id: "quote-1",
        organization_id: "org-1",
        artifact_type: "screenshot",
        storage_bucket: "quote-artifacts",
        storage_path: "org-1/run-1/part-1/xometry/result.png",
        metadata: {
          label: "result-screenshot",
        },
        created_at: "2026-03-07T17:29:00.000Z",
      },
    ],
    ...overrides,
  };
}

function makePart(overrides: Partial<PartAggregate> = {}): PartAggregate {
  return {
    id: "part-1",
    job_id: "job-1",
    organization_id: "org-1",
    name: "Bracket",
    normalized_key: "bracket",
    cad_file_id: "cad-1",
    drawing_file_id: null,
    quantity: 10,
    created_at: "2026-03-07T16:00:00.000Z",
    updated_at: "2026-03-07T16:00:00.000Z",
    cadFile: null,
    drawingFile: null,
    extraction: null,
    approvedRequirement: {
      id: "req-1",
      part_id: "part-1",
      organization_id: "org-1",
      approved_by: "user-1",
      description: "Bracket",
      part_number: "1093-0001",
      revision: "A",
      material: "6061 aluminum",
      finish: "Type II black anodize",
      tightest_tolerance_inch: 0.005,
      quantity: 10,
      quote_quantities: [10],
      requested_by_date: null,
      applicable_vendors: ["xometry"],
      spec_snapshot: {},
      created_at: "2026-03-07T15:00:00.000Z",
      updated_at: "2026-03-07T15:00:00.000Z",
    },
    vendorQuotes: [],
    ...overrides,
  };
}

function makeQuoteRun(overrides: Partial<QuoteRunAggregate> = {}): QuoteRunAggregate {
  return {
    id: "run-1",
    job_id: "job-1",
    organization_id: "org-1",
    initiated_by: "user-1",
    status: "running",
    requested_auto_publish: false,
    created_at: "2026-03-07T17:00:00.000Z",
    updated_at: "2026-03-07T17:00:00.000Z",
    vendorQuotes: [makeQuote()],
    ...overrides,
  };
}

function makeWorkQueue(overrides: Partial<WorkQueueRecord> = {}): WorkQueueRecord {
  return {
    id: "task-1",
    organization_id: "org-1",
    job_id: "job-1",
    part_id: "part-1",
    quote_run_id: "run-1",
    package_id: null,
    task_type: "run_vendor_quote",
    status: "queued",
    payload: {
      vendor: "xometry",
      requestedQuantity: 10,
    },
    attempts: 1,
    available_at: "2026-03-07T17:00:00.000Z",
    locked_at: null,
    locked_by: null,
    last_error: null,
    created_at: "2026-03-07T17:00:00.000Z",
    updated_at: "2026-03-07T17:00:00.000Z",
    ...overrides,
  };
}

function renderCard(
  overrides: Partial<React.ComponentProps<typeof XometryDebugCard>> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
      mutations: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <XometryDebugCard
        jobId="job-1"
        latestQuoteRun={makeQuoteRun()}
        parts={[makePart()]}
        workQueue={[]}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

describe("XometryDebugCard", () => {
  it("disables submit when no latest quote run exists", async () => {
    apiMock.fetchWorkerReadiness.mockResolvedValue({
      reachable: true,
      ready: true,
      workerName: "worker-1",
      workerMode: "live",
      status: "running",
      readinessIssues: [],
      message: null,
      url: "https://worker.example.com/readyz",
    });

    renderCard({
      latestQuoteRun: null,
    });

    await waitFor(() => {
      expect(screen.getByText("Blocked: start quote run")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /quote in xometry/i })).toBeDisabled();
  });

  it("disables submit while a matching task is queued and renders diagnostics", async () => {
    apiMock.fetchWorkerReadiness.mockResolvedValue({
      reachable: true,
      ready: true,
      workerName: "worker-1",
      workerMode: "live",
      status: "running",
      readinessIssues: [],
      message: null,
      url: "https://worker.example.com/readyz",
    });

    renderCard({
      workQueue: [makeWorkQueue()],
    });

    await waitFor(() => {
      expect(screen.getByText("Retry scheduled")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /quote in xometry/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /expanded diagnostics/i }));

    expect(await screen.findByText("selector_failure")).toBeInTheDocument();
    expect(screen.getByText("configuration_complete")).toBeInTheDocument();
    expect(screen.getByText(/result-screenshot/i)).toBeInTheDocument();
  });

  it("submits the selected lane when ready", async () => {
    apiMock.fetchWorkerReadiness.mockResolvedValue({
      reachable: true,
      ready: true,
      workerName: "worker-1",
      workerMode: "live",
      status: "running",
      readinessIssues: [],
      message: null,
      url: "https://worker.example.com/readyz",
    });
    apiMock.enqueueDebugVendorQuote.mockResolvedValue("task-2");

    renderCard({
      latestQuoteRun: makeQuoteRun({
        vendorQuotes: [
          makeQuote({
            status: "instant_quote_received",
            raw_payload: {
              retryCount: 0,
            },
          }),
        ],
      }),
    });

    await waitFor(() => {
      expect(screen.getByText("Ready")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /quote in xometry/i }));

    await waitFor(() => {
      expect(apiMock.enqueueDebugVendorQuote).toHaveBeenCalledWith({
        jobId: "job-1",
        quoteRunId: "run-1",
        partId: "part-1",
        vendor: "xometry",
        requestedQuantity: 10,
      });
    });
  });
});
