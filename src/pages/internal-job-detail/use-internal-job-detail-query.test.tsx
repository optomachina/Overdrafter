import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppMembership } from "@/features/quotes/types";
import { useInternalJobDetailQuery } from "./use-internal-job-detail-query";

const fetchJobAggregateMock = vi.fn();
const getQuoteRunReadinessMock = vi.fn();
const diagnosticsSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("@/features/quotes/api/jobs-api", () => ({
  fetchJobAggregate: (...args: unknown[]) => fetchJobAggregateMock(...args),
}));

vi.mock("@/features/quotes/api/quote-requests-api", () => ({
  getQuoteRunReadiness: (...args: unknown[]) => getQuoteRunReadinessMock(...args),
}));

vi.mock("@/lib/diagnostics", () => ({
  useDiagnosticsSnapshot: () => diagnosticsSnapshotMock(),
}));

function makeMembership(organizationId: string): AppMembership {
  return {
    id: `membership-${organizationId}`,
    role: "internal_admin",
    organizationId,
    organizationName: "Wilson Works",
    organizationSlug: "wilson-works",
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useInternalJobDetailQuery", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps internal access unchanged when diagnostics are enabled", async () => {
    diagnosticsSnapshotMock.mockReturnValue({ enabled: true });
    fetchJobAggregateMock.mockResolvedValue({
      job: {
        id: "job-1",
        organization_id: "org-1",
      },
      quoteRuns: [{ id: "quote-run-1" }],
      debugExtractionRuns: [],
      workQueue: [],
    });
    getQuoteRunReadinessMock.mockResolvedValue({
      ready: true,
      reasons: [],
    });

    const { result } = renderHook(
      () =>
        useInternalJobDetailQuery({
          activeMembership: makeMembership("org-1"),
          hasUser: true,
          isPlatformAdmin: false,
          jobId: "job-1",
        }),
      {
        wrapper: createWrapper(),
      },
    );

    await waitFor(() => {
      expect(result.current.job?.job.id).toBe("job-1");
    });

    expect(result.current.allowDiagnosticReadOnly).toBe(false);
    await waitFor(() => {
      expect(getQuoteRunReadinessMock).toHaveBeenCalledWith("quote-run-1");
    });
  });

  it("does not fetch quote readiness for cross-org platform admin inspection", async () => {
    diagnosticsSnapshotMock.mockReturnValue({ enabled: false });
    fetchJobAggregateMock.mockResolvedValue({
      job: {
        id: "job-1",
        organization_id: "org-2",
      },
      quoteRuns: [{ id: "quote-run-1" }],
      debugExtractionRuns: [],
      workQueue: [],
    });

    const { result } = renderHook(
      () =>
        useInternalJobDetailQuery({
          activeMembership: makeMembership("org-1"),
          hasUser: true,
          isPlatformAdmin: true,
          jobId: "job-1",
        }),
      {
        wrapper: createWrapper(),
      },
    );

    await waitFor(() => {
      expect(result.current.job?.job.organization_id).toBe("org-2");
    });

    expect(getQuoteRunReadinessMock).not.toHaveBeenCalled();
    expect(result.current.readinessQuery.fetchStatus).toBe("idle");
  });

  it("fetches quote readiness for same-org platform admin inspection", async () => {
    diagnosticsSnapshotMock.mockReturnValue({ enabled: false });
    fetchJobAggregateMock.mockResolvedValue({
      job: {
        id: "job-1",
        organization_id: "org-1",
      },
      quoteRuns: [{ id: "quote-run-1" }],
      debugExtractionRuns: [],
      workQueue: [],
    });
    getQuoteRunReadinessMock.mockResolvedValue({
      ready: true,
      reasons: [],
    });

    const { result } = renderHook(
      () =>
        useInternalJobDetailQuery({
          activeMembership: makeMembership("org-1"),
          hasUser: true,
          isPlatformAdmin: true,
          jobId: "job-1",
        }),
      {
        wrapper: createWrapper(),
      },
    );

    await waitFor(() => {
      expect(getQuoteRunReadinessMock).toHaveBeenCalledWith("quote-run-1");
    });

    expect(result.current.readinessQuery.data).toEqual({
      ready: true,
      reasons: [],
    });
  });

  it("allows client diagnostics read-only access and skips quote readiness", async () => {
    diagnosticsSnapshotMock.mockReturnValue({ enabled: true });
    fetchJobAggregateMock.mockResolvedValue({
      job: {
        id: "job-1",
        organization_id: "org-1",
      },
      quoteRuns: [{ id: "quote-run-1" }],
      debugExtractionRuns: [],
      workQueue: [],
    });

    const { result } = renderHook(
      () =>
        useInternalJobDetailQuery({
          activeMembership: {
            id: "membership-client",
            role: "client",
            organizationId: "org-1",
            organizationName: "Wilson Works",
            organizationSlug: "wilson-works",
          },
          hasUser: true,
          isPlatformAdmin: false,
          jobId: "job-1",
        }),
      {
        wrapper: createWrapper(),
      },
    );

    await waitFor(() => {
      expect(result.current.job?.job.id).toBe("job-1");
    });

    expect(result.current.allowDiagnosticReadOnly).toBe(true);
    expect(getQuoteRunReadinessMock).not.toHaveBeenCalled();
    expect(result.current.readinessQuery.fetchStatus).toBe("idle");
  });
});
