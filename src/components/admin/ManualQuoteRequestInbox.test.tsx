import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AdminManualQuoteRequest,
  AdminManualQuoteRequestPage,
  ManualQuoteOperatorAccess,
} from "@/features/quotes/api/manual-quote-admin-api";
import { ManualQuoteRequestInbox } from "./ManualQuoteRequestInbox";

const apiMock = vi.hoisted(() => ({
  fetchAdminManualQuoteRequests:
    vi.fn<(input?: { cursor?: string | null; limit?: number }) => Promise<AdminManualQuoteRequestPage>>(),
  fetchManualQuoteOperatorAccess:
    vi.fn<() => Promise<ManualQuoteOperatorAccess>>(),
}));

vi.mock("@/features/quotes/api/manual-quote-admin-api", () => ({
  fetchAdminManualQuoteRequests: apiMock.fetchAdminManualQuoteRequests,
  fetchManualQuoteOperatorAccess: apiMock.fetchManualQuoteOperatorAccess,
}));

function makeRequest(
  overrides: Partial<AdminManualQuoteRequest> = {},
): AdminManualQuoteRequest {
  return {
    requestId: "request-1",
    organizationId: "org-1",
    organizationName: "Wilson Works",
    projectId: "project-1",
    projectName: "Launch Fixture",
    jobId: "job-1",
    jobTitle: "Bracket",
    jobStatus: "awaiting_vendor_manual_review",
    quoteRunId: "run-1",
    quoteRunStatus: "running",
    requestStatus: "queued",
    requestedByUserId: "user-1",
    requestedByEmail: "buyer@example.com",
    partCount: 1,
    partIds: ["part-1"],
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
    requestAgeSeconds: 7_200,
    isStale: false,
    staleReason: null,
    ...overrides,
  };
}

function renderInbox() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ManualQuoteRequestInbox />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ManualQuoteRequestInbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.fetchManualQuoteOperatorAccess.mockResolvedValue({
      hasCapability: true,
      hasAal2: true,
    });
    apiMock.fetchAdminManualQuoteRequests.mockResolvedValue({
      items: [],
      nextCursor: null,
    });
  });

  it("shows a loading state while authorization is pending", () => {
    apiMock.fetchManualQuoteOperatorAccess.mockReturnValue(new Promise(() => undefined));

    renderInbox();

    expect(
      screen.getByLabelText("Loading manual quote requests"),
    ).toBeInTheDocument();
  });

  it("shows an explicit authorization error", async () => {
    apiMock.fetchManualQuoteOperatorAccess.mockRejectedValue(
      new Error("authorization unavailable"),
    );

    renderInbox();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Manual-request authorization could not be checked",
    );
    expect(apiMock.fetchAdminManualQuoteRequests).not.toHaveBeenCalled();
  });

  it("does not load requests for an unauthorized operator", async () => {
    apiMock.fetchManualQuoteOperatorAccess.mockResolvedValue({
      hasCapability: false,
      hasAal2: false,
    });

    renderInbox();

    expect(await screen.findByText("Not authorized")).toBeInTheDocument();
    expect(apiMock.fetchAdminManualQuoteRequests).not.toHaveBeenCalled();
  });

  it("shows the empty state for an authorized queue with no active requests", async () => {
    renderInbox();

    expect(await screen.findByText("No active manual requests")).toBeInTheDocument();
    expect(apiMock.fetchAdminManualQuoteRequests).toHaveBeenCalledWith({
      cursor: null,
      limit: 25,
    });
  });

  it("shows a request-load failure and supports retry", async () => {
    apiMock.fetchAdminManualQuoteRequests
      .mockRejectedValueOnce(new Error("Manual queue is unavailable."))
      .mockResolvedValueOnce({ items: [], nextCursor: null });

    renderInbox();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Manual queue is unavailable.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("No active manual requests")).toBeInTheDocument();
    expect(apiMock.fetchAdminManualQuoteRequests).toHaveBeenCalledTimes(2);
  });

  it("labels stale requests and preserves the exact request/run/job link", async () => {
    apiMock.fetchAdminManualQuoteRequests.mockResolvedValue({
      items: [
        makeRequest({
          isStale: true,
          staleReason: "The linked quote run has already completed.",
        }),
      ],
      nextCursor: null,
    });

    renderInbox();

    const mobileList = await screen.findByRole("list", {
      name: "Manual quote requests",
    });
    const mobileRequest = within(mobileList);

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(mobileRequest.getByText("Wilson Works")).toBeInTheDocument();
    expect(mobileRequest.getByText("buyer@example.com")).toBeInTheDocument();
    expect(mobileRequest.getByText("Launch Fixture")).toBeInTheDocument();
    expect(mobileRequest.getByText("Bracket")).toBeInTheDocument();
    expect(
      mobileRequest.getByText(
        (_, element) => element?.textContent === "Request age: 2h",
      ),
    ).toBeInTheDocument();
    expect(mobileRequest.getByText("Request Queued")).toBeInTheDocument();
    expect(mobileRequest.getByText("Run Running")).toBeInTheDocument();
    expect(
      mobileRequest.getByText("Job Awaiting Vendor Manual Review"),
    ).toBeInTheDocument();
    expect(mobileRequest.getByText("Stale")).toBeInTheDocument();
    expect(
      mobileRequest.getByText("The linked quote run has already completed."),
    ).toBeInTheDocument();
    expect(mobileRequest.getByRole("link", { name: "Inspect" })).toHaveAttribute(
      "href",
      "/internal/jobs/job-1?quoteRequestId=request-1&quoteRunId=run-1",
    );
  });

  it("passes the opaque cursor unchanged when moving to the next page", async () => {
    apiMock.fetchAdminManualQuoteRequests
      .mockResolvedValueOnce({
        items: [makeRequest()],
        nextCursor: "opaque-next-token",
      })
      .mockResolvedValueOnce({
        items: [
          makeRequest({
            requestId: "request-2",
            jobId: "job-2",
            jobTitle: "Second bracket",
            quoteRunId: "run-2",
          }),
        ],
        nextCursor: null,
      });

    renderInbox();

    await screen.findAllByText("Bracket");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(apiMock.fetchAdminManualQuoteRequests).toHaveBeenLastCalledWith({
        cursor: "opaque-next-token",
        limit: 25,
      });
    });
    expect(await screen.findAllByText("Second bracket")).not.toHaveLength(0);
    expect(screen.getByText("Page 2")).toBeInTheDocument();
  });
});
