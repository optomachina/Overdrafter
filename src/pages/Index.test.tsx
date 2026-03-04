import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobPartSummary, JobRecord } from "@/features/quotes/types";
import { PROJECT_STORAGE_PREFIX } from "@/features/quotes/client-workspace";
import Index from "./Index";

const mockUseAppSession = vi.fn();
const mockFetchJobsByOrganization = vi.fn();
const mockFetchPublishedPackagesByOrganization = vi.fn();
const mockFetchJobPartSummariesByOrganization = vi.fn();
const localStorageState = new Map<string, string>();

vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: () => mockUseAppSession(),
}));

vi.mock("@/features/quotes/api", () => ({
  createSelfServiceOrganization: vi.fn(),
  fetchJobPartSummariesByOrganization: (...args: unknown[]) =>
    mockFetchJobPartSummariesByOrganization(...args),
  fetchJobsByOrganization: (...args: unknown[]) => mockFetchJobsByOrganization(...args),
  fetchOrganizationMemberships: vi.fn(),
  fetchPublishedPackagesByOrganization: (...args: unknown[]) =>
    mockFetchPublishedPackagesByOrganization(...args),
  resendSignupConfirmation: vi.fn(),
  updateOrganizationMembershipRole: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: vi.fn(),
    },
  },
}));

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    organization_id: "org-dmrifles",
    created_by: null,
    title: "Sample job",
    description: null,
    status: "uploaded",
    source: "client",
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
              ? "client"
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
      <MemoryRouter>
        <Index />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Index DMRifles workspace", () => {
  beforeEach(() => {
    const storage = {
      getItem: (key: string) => localStorageState.get(key) ?? null,
      setItem: (key: string, value: string) => {
        localStorageState.set(key, value);
      },
      removeItem: (key: string) => {
        localStorageState.delete(key);
      },
      clear: () => {
        localStorageState.clear();
      },
    };

    Object.defineProperty(window, "localStorage", {
      value: storage,
      configurable: true,
    });

    const { jobs, summaries } = buildDmriflesFixtures();

    mockUseAppSession.mockReturnValue({
      user: { email: "dmrifles@gmail.com" },
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
    mockFetchJobsByOrganization.mockResolvedValue(jobs);
    mockFetchPublishedPackagesByOrganization.mockResolvedValue([]);
    mockFetchJobPartSummariesByOrganization.mockResolvedValue(summaries);
    window.localStorage.setItem(
      `${PROJECT_STORAGE_PREFIX}:org-dmrifles:dmrifles@gmail.com`,
      JSON.stringify([
        {
          id: "project-stale",
          name: "Stale folder",
          jobIds: jobs.map((job) => job.id),
          createdAt: "2026-03-03T00:00:00Z",
        },
      ]),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorageState.clear();
  });

  it("renders system QB folders, ignores stale storage, and keeps project mutation disabled", async () => {
    renderIndex();

    expect(await screen.findByRole("button", { name: /qb00001/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /qb00002/i })).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: /qb00003/i })).toHaveTextContent("2");
    expect(screen.queryByText("Stale folder")).not.toBeInTheDocument();

    const newProjectButtons = screen.getAllByRole("button", { name: /new project/i });
    expect(newProjectButtons).toHaveLength(2);
    newProjectButtons.forEach((button) => expect(button).toBeDisabled());
    expect(screen.getByRole("button", { name: /^rename$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeDisabled();
    expect(screen.getAllByText(/qb folders are system-managed from imported quote batches/i).length).toBeGreaterThan(0);
  });

  it("filters, searches, and exposes selection mode in the DMRifles workspace", async () => {
    renderIndex();

    await screen.findByRole("button", { name: /qb00003/i });

    fireEvent.click(screen.getByRole("button", { name: /qb00003/i }));
    fireEvent.click(screen.getByRole("button", { name: /^published/i }));

    await waitFor(() => {
      expect(screen.getAllByText("1093-05907 rev 1").length).toBeGreaterThan(0);
      expect(screen.queryByText("1093-10435 rev A")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /^all jobs/i }));
    fireEvent.change(screen.getByPlaceholderText(/search parts, descriptions, or tags/i), {
      target: { value: "10435" },
    });

    await waitFor(() => {
      expect(screen.getAllByText("1093-10435 rev A").length).toBeGreaterThan(0);
      expect(screen.queryAllByText("1093-05907 rev 1")).toHaveLength(0);
    });

    fireEvent.click(screen.getByRole("button", { name: /select parts/i }));

    expect(await screen.findAllByRole("checkbox")).not.toHaveLength(0);
  });
});
