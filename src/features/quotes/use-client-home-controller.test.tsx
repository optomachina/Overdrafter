import "@testing-library/jest-dom/vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSessionData } from "@/features/quotes/types";
import { MISSING_WORKSPACE_MEMBERSHIP_ERROR_MESSAGE } from "@/hooks/workspace-readiness";
import { useClientHomeController } from "./use-client-home-controller";

const fetchAppSessionDataMock = vi.fn<() => Promise<AppSessionData>>();
const createSelfServiceOrganizationMock = vi.fn();
const createJobsFromUploadFilesMock = vi.fn();
const invalidateClientWorkspaceQueriesMock = vi.fn();
const onAuthStateChangeMock = vi.fn();
const adminSignOutMock = vi.fn();

vi.mock("@/features/quotes/api", () => ({
  archiveJob: vi.fn(),
  archiveProject: vi.fn(),
  assignJobToProject: vi.fn(),
  checkClientIntakeCompatibility: vi.fn(async () => "available"),
  createClientDraft: vi.fn(),
  createJobsFromUploadFiles: (...args: unknown[]) => createJobsFromUploadFilesMock(...args),
  createProject: vi.fn(),
  createSelfServiceOrganization: (...args: unknown[]) => createSelfServiceOrganizationMock(...args),
  deleteArchivedJobs: vi.fn(),
  dissolveProject: vi.fn(),
  fetchAppSessionData: () => fetchAppSessionDataMock(),
  isArchivedDeleteCapabilityError: vi.fn(() => false),
  isProjectCollaborationSchemaUnavailable: vi.fn(() => false),
  pinJob: vi.fn(),
  pinProject: vi.fn(),
  removeJobFromProject: vi.fn(),
  resendSignupConfirmation: vi.fn(),
  unarchiveJob: vi.fn(),
  unarchiveProject: vi.fn(),
  unpinJob: vi.fn(),
  unpinProject: vi.fn(),
  updateProject: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: vi.fn(),
      onAuthStateChange: (...args: unknown[]) => onAuthStateChangeMock(...args),
      admin: {
        signOut: (...args: unknown[]) => adminSignOutMock(...args),
      },
    },
  },
}));

vi.mock("@/features/quotes/archive-undo", () => ({
  useArchiveUndo: () => vi.fn(),
}));

vi.mock("@/features/quotes/client-presentation", () => ({
  getClientItemPresentation: vi.fn(() => ({ title: "Mock Part" })),
}));

vi.mock("@/features/quotes/client-workspace", () => ({
  PROJECT_STORAGE_PREFIX: "test-project-storage",
  buildSidebarProjectIdsByJobId: vi.fn(() => new Map()),
  buildSidebarProjects: vi.fn(() => ({ remoteProjects: [], sidebarProjects: [] })),
  resolveWorkspaceProjectIdsForJob: vi.fn(() => []),
}));

vi.mock("@/features/quotes/archive-delete-errors", () => ({
  logArchivedDeleteFailure: vi.fn(),
  toArchivedDeleteError: vi.fn((error: Error) => error),
  withArchivedDeleteReporting: vi.fn((error: Error) => error),
}));

vi.mock("@/features/quotes/use-client-workspace-data", () => ({
  invalidateClientWorkspaceQueries: (...args: unknown[]) => invalidateClientWorkspaceQueriesMock(...args),
  useClientWorkspaceData: vi.fn(() => ({
    accessibleProjectsQuery: { data: [], isLoading: false },
    accessibleJobsQuery: { data: [], isLoading: false },
    accessibleJobIds: [],
    accessibleJobsById: new Map(),
    partSummariesQuery: { data: [], isLoading: false },
    projectJobMembershipsQuery: { data: [], isLoading: false },
    sidebarPinsQuery: { data: { projectIds: [], jobIds: [] }, isLoading: false },
    archivedProjectsQuery: { data: [], isLoading: false },
    archivedJobsQuery: { data: [], isLoading: false },
    summariesByJobId: new Map(),
  })),
  useWarmClientWorkspaceNavigation: vi.fn(),
}));

vi.mock("@/features/quotes/workspace-navigation", () => ({
  WORKSPACE_SHARED_STALE_TIME_MS: 30_000,
  prefetchPartPage: vi.fn(),
  prefetchProjectPage: vi.fn(),
}));

vi.mock("@/features/quotes/request-intake", () => ({
  parseRequestIntake: vi.fn(() => ({
    requestedQuoteQuantities: [],
    requestedByDate: null,
  })),
}));

vi.mock("@/features/quotes/upload-groups", () => ({
  buildProjectNameFromLabels: vi.fn(() => "Recovered Project"),
}));

function createSessionData(input: { memberships?: AppSessionData["memberships"] }): AppSessionData {
  return {
    user: {
      id: "user-1",
      email: "client@example.com",
    } as AppSessionData["user"],
    memberships: input.memberships ?? [],
    isVerifiedAuth: true,
    authState: "authenticated",
  };
}

function createWrapper() {
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

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/"]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advanceTimers(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function settleSessionLoad() {
  await advanceTimers(1);
  await flushMicrotasks();
  await advanceTimers(1);
  await flushMicrotasks();
}

async function waitForCondition(
  predicate: () => boolean,
  {
    attempts = 20,
    errorMessage = "Timed out waiting for condition.",
  }: { attempts?: number; errorMessage?: string } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) {
      return;
    }
    await settleSessionLoad();
  }

  throw new Error(errorMessage);
}

describe("useClientHomeController membership recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    onAuthStateChangeMock.mockImplementation(() => ({
      data: {
        subscription: {
          unsubscribe: vi.fn(),
        },
      },
    }));
    createJobsFromUploadFilesMock.mockResolvedValue({
      projectId: null,
      jobIds: ["job-1"],
    });
    invalidateClientWorkspaceQueriesMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("allows uploads after delayed membership recovery for an existing user", async () => {
    const recoveredSession = createSessionData({
      memberships: [
        {
          id: "membership-1",
          role: "client",
          organizationId: "org-1",
          organizationName: "Client Org",
          organizationSlug: "client-org",
        },
      ],
    });
    const sessionResponses = [
      createSessionData({ memberships: [] }),
      createSessionData({ memberships: [] }),
      recoveredSession,
    ];
    fetchAppSessionDataMock.mockImplementation(async () => {
      return sessionResponses.shift() ?? recoveredSession;
    });
    createSelfServiceOrganizationMock.mockRejectedValueOnce(
      new Error("Your account already has an organization membership."),
    );

    const { result } = renderHook(() => useClientHomeController(), {
      wrapper: createWrapper(),
    });

    await waitForCondition(
      () =>
        result.current.workspaceReadiness.status === "provisioning" &&
        createSelfServiceOrganizationMock.mock.calls.length === 1,
      {
        errorMessage: "Expected membership recovery to enter provisioning for the existing user.",
      },
    );
    expect(result.current.workspaceReadiness.status).toBe("provisioning");
    expect(createSelfServiceOrganizationMock).toHaveBeenCalledTimes(1);

    const submitPromise = result.current.handleComposerSubmit({
      prompt: "Upload these parts",
      files: [new File(["solid"], "part.step")],
      clear: vi.fn(),
    });

    await flushMicrotasks();
    await advanceTimers(0);
    await advanceTimers(300);
    await advanceTimers(900);
    await flushMicrotasks();

    await submitPromise;

    expect(createJobsFromUploadFilesMock).toHaveBeenCalledTimes(1);
    expect(createSelfServiceOrganizationMock).toHaveBeenCalledTimes(1);
  });

  it("fails fast with a precise error when membership recovery exhausts", async () => {
    fetchAppSessionDataMock.mockImplementation(async () => createSessionData({ memberships: [] }));
    createSelfServiceOrganizationMock.mockRejectedValueOnce(
      new Error("Your account already has an organization membership."),
    );

    const { result } = renderHook(() => useClientHomeController(), {
      wrapper: createWrapper(),
    });

    await waitForCondition(
      () =>
        result.current.workspaceReadiness.status === "provisioning" &&
        createSelfServiceOrganizationMock.mock.calls.length === 1,
      {
        errorMessage: "Expected missing-membership recovery to enter provisioning before exhausting.",
      },
    );
    expect(result.current.workspaceReadiness.status).toBe("provisioning");
    expect(createSelfServiceOrganizationMock).toHaveBeenCalledTimes(1);

    const submitPromise = result.current.handleComposerSubmit({
      prompt: "Upload these parts",
      files: [new File(["solid"], "part.step")],
      clear: vi.fn(),
    });
    const handledRejection = submitPromise.catch((error: unknown) => error);

    await flushMicrotasks();
    await advanceTimers(0);
    await advanceTimers(300);
    await advanceTimers(900);
    await advanceTimers(1_800);
    await flushMicrotasks();

    const rejection = await handledRejection;
    expect(rejection).toMatchObject({
      message: MISSING_WORKSPACE_MEMBERSHIP_ERROR_MESSAGE,
    });
    expect(createJobsFromUploadFilesMock).not.toHaveBeenCalled();
  });
});
