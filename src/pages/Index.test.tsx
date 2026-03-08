import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobPartSummary, JobRecord } from "@/features/quotes/types";
import Index from "./Index";

const mockUseAppSession = vi.fn();
const mockFetchAccessibleProjects = vi.fn();
const mockFetchAccessibleJobs = vi.fn();
const mockFetchUngroupedParts = vi.fn();
const mockFetchJobPartSummariesByJobIds = vi.fn();
const mockFetchProjectJobMembershipsByJobIds = vi.fn();

vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: () => mockUseAppSession(),
}));

vi.mock("@/components/SignInDialog", () => ({
  SignInDialog: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: PropsWithChildren) => <>{children}</>,
  Tooltip: ({ children }: PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
  TooltipContent: () => null,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: vi.fn(),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  },
}));

vi.mock("@/features/quotes/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/quotes/api")>();

  return {
    ...actual,
    createSelfServiceOrganization: vi.fn(),
    fetchAccessibleProjects: (...args: unknown[]) => mockFetchAccessibleProjects(...args),
    fetchAccessibleJobs: (...args: unknown[]) => mockFetchAccessibleJobs(...args),
    fetchUngroupedParts: (...args: unknown[]) => mockFetchUngroupedParts(...args),
    fetchJobPartSummariesByJobIds: (...args: unknown[]) => mockFetchJobPartSummariesByJobIds(...args),
    fetchProjectJobMembershipsByJobIds: (...args: unknown[]) => mockFetchProjectJobMembershipsByJobIds(...args),
  };
});

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    organization_id: "org-dmrifles",
    project_id: null,
    created_by: "user-1",
    title: "Sample job",
    description: null,
    status: "uploaded",
    source: "client_home",
    tags: [],
    active_pricing_policy_id: null,
    created_at: "2026-03-03T19:00:00Z",
    updated_at: "2026-03-03T19:00:00Z",
    ...overrides,
  } as JobRecord;
}

function makeSummary(overrides: Partial<JobPartSummary> = {}): JobPartSummary {
  return {
    jobId: "job-1",
    partNumber: "1093-03242",
    revision: "3",
    description: "Imported part",
    quantity: 1,
    importedBatch: "QB00001",
    ...overrides,
  };
}

function buildDmriflesFixtures() {
  const qb00001 = [
    "1093-03242",
    "1093-03247",
    "1093-03258",
    "1093-03266",
    "1093-03292",
    "1093-03548",
    "1093-05974",
    "1093-06156",
    "1093-10569",
    "1093-10570",
  ];
  const qb00002 = ["1093-05589"];
  const qb00003 = ["1093-05907", "1093-10435"];
  const jobs: JobRecord[] = [];
  const summaries: JobPartSummary[] = [];
  let index = 0;

  const pushBatch = (
    batch: string,
    partNumbers: string[],
    statusResolver: (partNumber: string) => JobRecord["status"],
  ) => {
    partNumbers.forEach((partNumber) => {
      index += 1;
      const revision =
        partNumber === "1093-05589"
          ? "2"
          : partNumber === "1093-03258" || partNumber === "1093-10569" || partNumber === "1093-10570" || partNumber === "1093-10435"
            ? "A"
            : "1";
      const jobId = `job-${index}`;

      jobs.push(
        makeJob({
          id: jobId,
          title: partNumber === "1093-05589" ? "Test" : `${partNumber} rev ${revision}`,
          description: partNumber === "1093-05589" ? "Imported spreadsheet quote" : `Description ${partNumber}`,
          status: statusResolver(partNumber),
          source:
            partNumber === "1093-05589"
              ? "client_home"
              : `spreadsheet_import:${batch.toLowerCase()}:${partNumber.toLowerCase()}:${revision.toLowerCase()}`,
          created_at: `2026-03-03T19:${String(index).padStart(2, "0")}:00Z`,
        }),
      );
      summaries.push(
        makeSummary({
          jobId,
          partNumber,
          revision,
          description: `Description ${partNumber}`,
          importedBatch: batch,
        }),
      );
    });
  };

  pushBatch("QB00001", qb00001, () => "published");
  pushBatch("QB00002", qb00002, () => "published");
  pushBatch("QB00003", qb00003, (partNumber) => (partNumber === "1093-05907" ? "published" : "quoting"));

  return { jobs, summaries };
}

function renderIndex() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Index />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Index client home", () => {
  beforeEach(() => {
    mockFetchAccessibleProjects.mockResolvedValue([]);
    mockFetchAccessibleJobs.mockResolvedValue([]);
    mockFetchUngroupedParts.mockResolvedValue([]);
    mockFetchJobPartSummariesByJobIds.mockResolvedValue([]);
    mockFetchProjectJobMembershipsByJobIds.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the guest ChatGPT-style landing shell", async () => {
    mockUseAppSession.mockReturnValue({
      user: null,
      activeMembership: null,
      isLoading: false,
      isVerifiedAuth: false,
      signOut: vi.fn(),
    });

    renderIndex();

    expect(screen.getAllByRole("button", { name: /^log in$/i }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("button", { name: /sign up for free/i })).toBeInTheDocument();
    expect(screen.getByText("What are you working on?")).toBeInTheDocument();
    expect(screen.getByText("Get quotes tailored to you")).toBeInTheDocument();
    expect(
      screen.getByText(/Log in to get quotes based on price and lead time, plus upload files\./i),
    ).toBeInTheDocument();
  });

  it("renders DMRifles seeded projects on the new client home", async () => {
    const { jobs, summaries } = buildDmriflesFixtures();

    mockUseAppSession.mockReturnValue({
      user: { id: "user-1", email: "dmrifles@gmail.com" },
      activeMembership: {
        id: "membership-1",
        role: "client",
        organizationId: "org-dmrifles",
        organizationName: "DMRifles",
        organizationSlug: "dmrifles",
      },
      isLoading: false,
      isVerifiedAuth: true,
      signOut: vi.fn(),
    });
    mockFetchAccessibleProjects.mockResolvedValue([]);
    mockFetchAccessibleJobs.mockResolvedValue(jobs);
    mockFetchUngroupedParts.mockResolvedValue([]);
    mockFetchJobPartSummariesByJobIds.mockResolvedValue(summaries);

    renderIndex();

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /qb00001/i }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole("button", { name: /qb00002/i }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole("button", { name: /qb00003/i }).length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole("button", { name: /new project/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open account menu/i })).toBeInTheDocument();
  });

  it("does not render an intermediate loading page while app session hydrates", () => {
    mockUseAppSession.mockReturnValue({
      user: { id: "user-1", email: "client@example.com" },
      activeMembership: null,
      isLoading: true,
      isVerifiedAuth: true,
      signOut: vi.fn(),
    });

    renderIndex();

    expect(screen.queryByText("Loading workspace…")).not.toBeInTheDocument();
    expect(screen.getByText("What are you working on?")).toBeInTheDocument();
  });
});
