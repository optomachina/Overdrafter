import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, act } from "@testing-library/react";
import { type PropsWithChildren } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useInternalJobDetailMutations } from "@/features/quotes/use-internal-job-detail-mutations";

const {
  approveJobRequirementsMock,
  publishQuotePackageMock,
  requestExtractionMock,
  resendSignupConfirmationMock,
  startQuoteRunMock,
  toastErrorMock,
  toastSuccessMock,
} = vi.hoisted(() => ({
  approveJobRequirementsMock: vi.fn(),
  publishQuotePackageMock: vi.fn(),
  requestExtractionMock: vi.fn(),
  resendSignupConfirmationMock: vi.fn(),
  startQuoteRunMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock("@/features/quotes/api", () => ({
  approveJobRequirements: (...args: unknown[]) => approveJobRequirementsMock(...args),
  publishQuotePackage: (...args: unknown[]) => publishQuotePackageMock(...args),
  requestExtraction: (...args: unknown[]) => requestExtractionMock(...args),
  resendSignupConfirmation: (...args: unknown[]) => resendSignupConfirmationMock(...args),
  startQuoteRun: (...args: unknown[]) => startQuoteRunMock(...args),
}));

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

function Wrapper({ children }: PropsWithChildren) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

describe("useInternalJobDetailMutations", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("guards publish when latestQuoteRunId is missing", async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(
      () =>
        useInternalJobDetailMutations({
          jobId: "job-1",
          normalizedApprovedDrafts: [],
          latestQuoteRunId: null,
          clientSummary: "",
          readinessReady: true,
          userEmail: "reviewer@example.com",
          signOut,
        }),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.publishPackage();
    });

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "A latest quote run is required before publishing a quote package.",
      ),
    );
    expect(publishQuotePackageMock).not.toHaveBeenCalled();
  });
});
