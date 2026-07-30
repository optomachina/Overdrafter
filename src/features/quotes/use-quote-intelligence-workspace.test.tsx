import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useQuoteIntelligenceWorkspace } from "@/features/quotes/use-quote-intelligence-workspace";
import { createWorkspaceAccessScope } from "@/features/quotes/workspace-navigation";

const { fetchClientQuoteWorkspaceByJobIds } = vi.hoisted(() => ({
  fetchClientQuoteWorkspaceByJobIds: vi.fn(),
}));

vi.mock("@/features/quotes/api/workspace-access", () => ({
  fetchClientQuoteWorkspaceByJobIds,
}));

const ACCESS_SCOPE = createWorkspaceAccessScope({
  userId: "user-1",
  organizationId: "org-1",
  role: "client",
});

function QueryProvider({ children }: PropsWithChildren) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useQuoteIntelligenceWorkspace", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("falls back from blank requirement metadata to approved values", async () => {
    fetchClientQuoteWorkspaceByJobIds.mockResolvedValue([
      {
        job: { id: "job-1" },
        files: [{ original_name: "bracket.step" }],
        part: {
          clientRequirement: {
            material: " ",
            finish: "",
            process: "\t",
            threads: "",
            tightestToleranceInch: null,
          },
          approvedRequirement: {
            material: "Aluminum 6061",
            finish: "Black anodize",
            tightest_tolerance_inch: 0.002,
            spec_snapshot: {
              process: "CNC milling",
              threads: "1/4-20 UNC",
            },
          },
          vendorQuotes: [],
        },
        latestQuoteRequest: null,
      },
    ]);

    const { result } = renderHook(
      () => useQuoteIntelligenceWorkspace(["job-1"], true, ACCESS_SCOPE),
      { wrapper: QueryProvider },
    );

    await waitFor(() => {
      expect(result.current.workspaceQuery.isSuccess).toBe(true);
    });

    expect(result.current.metadataByJobId.get("job-1")).toEqual({
      material: "Aluminum 6061",
      finish: "Black anodize",
      process: "CNC milling",
      threads: "1/4-20 UNC",
      tightestToleranceInch: 0.002,
      fileNames: ["bracket.step"],
    });
  });
});
