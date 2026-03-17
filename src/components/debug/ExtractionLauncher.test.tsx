import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExtractionLauncher } from "@/components/debug/ExtractionLauncher";
import { shouldShowExtractionLauncher } from "@/components/debug/extraction-launcher-visibility";
import type {
  JobAggregate,
  PartAggregate,
  PartDetailAggregate,
  WorkerReadinessSnapshot,
} from "@/features/quotes/types";

const apiMock = vi.hoisted(() => ({
  fetchJobAggregate: vi.fn<() => Promise<JobAggregate>>(),
  fetchPartDetailByJobId: vi.fn<() => Promise<PartDetailAggregate>>(),
  fetchWorkerReadiness: vi.fn<() => Promise<WorkerReadinessSnapshot>>(),
  requestDebugExtraction: vi.fn<() => Promise<string>>(),
  requestExtraction: vi.fn<() => Promise<number>>(),
  resolveClientPartDetailRoute: vi.fn(),
}));

const appSessionMock = vi.hoisted(() => ({
  useAppSession: vi.fn(),
}));

const diagnosticsMock = vi.hoisted(() => ({
  useDiagnosticsSnapshot: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/features/quotes/api", () => ({
  fetchJobAggregate: apiMock.fetchJobAggregate,
  fetchPartDetailByJobId: apiMock.fetchPartDetailByJobId,
  fetchWorkerReadiness: apiMock.fetchWorkerReadiness,
  requestDebugExtraction: apiMock.requestDebugExtraction,
  requestExtraction: apiMock.requestExtraction,
  resolveClientPartDetailRoute: apiMock.resolveClientPartDetailRoute,
}));

vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: () => appSessionMock.useAppSession(),
}));

vi.mock("@/lib/diagnostics", async () => {
  const actual = await vi.importActual<typeof import("@/lib/diagnostics")>("@/lib/diagnostics");
  return {
    ...actual,
    useDiagnosticsSnapshot: () => diagnosticsMock.useDiagnosticsSnapshot(),
  };
});

vi.mock("sonner", () => ({
  toast: toastMock,
}));

function makePart(overrides: Partial<PartAggregate> = {}): PartAggregate {
  return {
    id: "part-1",
    job_id: "job-1",
    organization_id: "org-1",
    name: "Bracket",
    normalized_key: "bracket",
    cad_file_id: null,
    drawing_file_id: null,
    quantity: 10,
    created_at: "2026-03-17T10:00:00.000Z",
    updated_at: "2026-03-17T10:00:00.000Z",
    cadFile: null,
    drawingFile: null,
    extraction: null,
    approvedRequirement: null,
    vendorQuotes: [],
    ...overrides,
  };
}

function makeJobAggregate(): JobAggregate {
  return {
    job: {
      id: "job-1",
      organization_id: "org-1",
      project_id: null,
      created_by: "user-1",
      title: "Bracket",
      description: null,
      status: "internal_review",
      source: "client_home",
      active_pricing_policy_id: null,
      tags: [],
      requested_quote_quantities: [10],
      requested_by_date: null,
      archived_at: null,
      created_at: "2026-03-17T10:00:00.000Z",
      updated_at: "2026-03-17T10:00:00.000Z",
      selected_vendor_quote_offer_id: null,
      requested_service_kinds: [],
      primary_service_kind: null,
      service_notes: null,
    },
    files: [],
    parts: [makePart()],
    quoteRuns: [],
    packages: [],
    pricingPolicy: null,
    workQueue: [],
    drawingPreviewAssets: [],
    debugExtractionRuns: [],
  };
}

function makePartDetail(): PartDetailAggregate {
  return {
    job: makeJobAggregate().job,
    files: [],
    summary: null,
    packages: [],
    part: makePart(),
    projectIds: [],
    drawingPreview: { pageCount: 0, thumbnail: null, pages: [] },
    latestQuoteRequest: null,
    latestQuoteRun: null,
    revisionSiblings: [],
  };
}

function LocationEcho() {
  const location = useLocation();
  return <div data-testid="location-path">{location.pathname}</div>;
}

function renderLauncher(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <ExtractionLauncher />
        <LocationEcho />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ExtractionLauncher", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    appSessionMock.useAppSession.mockReturnValue({
      activeMembership: { organizationId: "org-1", role: "admin" },
    });
    diagnosticsMock.useDiagnosticsSnapshot.mockReturnValue({
      enabled: false,
    });
    apiMock.fetchWorkerReadiness.mockResolvedValue({
      reachable: true,
      ready: true,
      workerName: "worker",
      workerBuildVersion: "build-local",
      workerMode: "development",
      drawingExtractionModel: "gpt-5.4",
      drawingExtractionDebugAllowedModels: ["gpt-5.4-mini", "gpt-5.4"],
      drawingExtractionModelFallbackEnabled: true,
      status: "ok",
      readinessIssues: [],
      message: null,
      url: "http://127.0.0.1:8081/readyz",
    });
    apiMock.fetchJobAggregate.mockResolvedValue(makeJobAggregate());
    apiMock.fetchPartDetailByJobId.mockResolvedValue(makePartDetail());
    apiMock.resolveClientPartDetailRoute.mockResolvedValue({
      routeId: "part-1",
      jobId: "job-1",
      source: "part",
    });
    apiMock.requestExtraction.mockResolvedValue(1);
    apiMock.requestDebugExtraction.mockResolvedValue("debug-run-1");
  });

  it("evaluates launcher visibility rules", () => {
    expect(
      shouldShowExtractionLauncher({
        membershipRole: "client",
        diagnosticsEnabled: false,
        isDev: false,
      }),
    ).toBe(false);
    expect(
      shouldShowExtractionLauncher({
        membershipRole: null,
        diagnosticsEnabled: false,
        isDev: false,
      }),
    ).toBe(false);
    expect(
      shouldShowExtractionLauncher({
        membershipRole: "admin",
        diagnosticsEnabled: false,
        isDev: false,
      }),
    ).toBe(true);
    expect(
      shouldShowExtractionLauncher({
        membershipRole: "client",
        diagnosticsEnabled: true,
        isDev: false,
      }),
    ).toBe(true);
  });

  it("queues canonical extraction from an internal job route", async () => {
    renderLauncher("/internal/jobs/job-1");

    fireEvent.click(screen.getByRole("button", { name: /extraction/i }));

    await screen.findByText(/internal job job-1/i);
    fireEvent.click(screen.getByRole("button", { name: /queue extraction/i }));

    await waitFor(() => {
      expect(apiMock.requestExtraction).toHaveBeenCalledWith("job-1");
    });
  });

  it("runs preview-only debug extraction from a client part route using the resolved job context", async () => {
    renderLauncher("/parts/part-1");

    fireEvent.click(screen.getByRole("button", { name: /extraction/i }));

    await screen.findByText(/resolved to job job-1/i);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run debug extraction/i })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: /run debug extraction/i }));

    await waitFor(() => {
      expect(apiMock.resolveClientPartDetailRoute).toHaveBeenCalledWith("part-1");
      expect(apiMock.fetchPartDetailByJobId).toHaveBeenCalledWith("job-1");
      expect(apiMock.requestDebugExtraction).toHaveBeenCalledWith("part-1", "gpt-5.4-mini");
    });
  });

  it("shows a disabled no-context state and can navigate to an internal job from manual input", async () => {
    apiMock.resolveClientPartDetailRoute.mockResolvedValueOnce({
      routeId: "manual-part",
      jobId: "job-9",
      source: "part",
    });

    renderLauncher("/");

    fireEvent.click(screen.getByRole("button", { name: /extraction/i }));

    expect(
      screen.getByText(/this route does not map to an extractable job automatically/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /queue extraction/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/job or part id/i), {
      target: { value: "manual-part" },
    });
    fireEvent.click(screen.getByRole("button", { name: /open internal job/i }));

    await waitFor(() => {
      expect(screen.getByTestId("location-path")).toHaveTextContent("/internal/jobs/job-9");
    });
  });
});
