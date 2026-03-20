import "@testing-library/jest-dom/vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSessionData } from "@/features/quotes/types";
import { MISSING_WORKSPACE_MEMBERSHIP_ERROR_MESSAGE } from "@/hooks/workspace-readiness";
import type { Session } from "@supabase/supabase-js";
import { useClientHomeController } from "./use-client-home-controller";

const fetchAppSessionDataMock = vi.fn<() => Promise<AppSessionData>>();
const createSelfServiceOrganizationMock = vi.fn();
const createJobsFromUploadFilesMock = vi.fn();
const invalidateClientWorkspaceQueriesMock = vi.fn();
const onAuthStateChangeMock = vi.fn();
const adminSignOutMock = vi.fn();
const getUserMock = vi.fn();
let authStateChangeCallbacks: Array<(event: string, session: Session | null) => void> = [];

vi.mock("@/features/quotes/api/session-access", () => ({
  fetchAppSessionData: () => fetchAppSessionDataMock(),
  createSelfServiceOrganization: (...args: unknown[]) => createSelfServiceOrganizationMock(...args),
  resendSignupConfirmation: vi.fn(),
}));

vi.mock("@/features/quotes/api/archive-api", () => ({
  archiveJob: vi.fn(),
  deleteArchivedJobs: vi.fn(),
  isArchivedDeleteCapabilityError: vi.fn(() => false),
  unarchiveJob: vi.fn(),
}));

vi.mock("@/features/quotes/api/compatibility-api", () => ({
  checkClientIntakeCompatibility: vi.fn(async () => "available"),
}));

vi.mock("@/features/quotes/api/jobs-api", () => ({
  createClientDraft: vi.fn(),
}));

vi.mock("@/features/quotes/api/projects-api", () => ({
  archiveProject: vi.fn(),
  assignJobToProject: vi.fn(),
  createProject: vi.fn(),
  dissolveProject: vi.fn(),
  pinJob: vi.fn(),
  pinProject: vi.fn(),
  removeJobFromProject: vi.fn(),
  unarchiveProject: vi.fn(),
  unpinJob: vi.fn(),
  unpinProject: vi.fn(),
  updateProject: vi.fn(),
}));

vi.mock("@/features/quotes/api/shared/schema-runtime", () => ({
  isProjectCollaborationSchemaUnavailable: vi.fn(() => false),
}));

vi.mock("@/features/quotes/api/uploads-api", () => ({
  createJobsFromUploadFiles: (...args: unknown[]) => createJobsFromUploadFilesMock(...args),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: (...args: unknown[]) => getUserMock(...args),
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

function emitSignedInAuthEvent() {
  act(() => {
    authStateChangeCallbacks.forEach((callback) =>
      callback("SIGNED_IN", {
        access_token: "token-1",
        refresh_token: "refresh-token-1",
        expires_in: 3600,
        token_type: "bearer",
        user: {
          id: "user-1",
          email: "client@example.com",
          app_metadata: {},
          user_metadata: {},
          aud: "authenticated",
          created_at: "2026-03-11T00:00:00.000Z",
        },
      } as Session),
    );
  });
}

describe("useClientHomeController membership recovery", () => {
  beforeEach(() => {
    authStateChangeCallbacks = [];
    getUserMock.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
          email: "client@example.com",
          app_metadata: {},
          user_metadata: {},
          aud: "authenticated",
          created_at: "2026-03-11T00:00:00.000Z",
        },
      },
      error: null,
    });
    onAuthStateChangeMock.mockImplementation((callback: (event: string, session: Session | null) => void) => {
      authStateChangeCallbacks.push(callback);

      return {
        data: {
          subscription: {
            unsubscribe: vi.fn(),
          },
        },
      };
    });
    createJobsFromUploadFilesMock.mockResolvedValue({
      projectId: null,
      jobIds: ["job-1"],
    });
    invalidateClientWorkspaceQueriesMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
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
      {
        user: null,
        memberships: [],
        isVerifiedAuth: false,
        authState: "anonymous" as const,
      },
      createSessionData({ memberships: [] }),
      recoveredSession,
    ];
    fetchAppSessionDataMock.mockImplementation(async () => {
      return sessionResponses.shift() ?? recoveredSession;
    });
    createSelfServiceOrganizationMock.mockRejectedValueOnce(
      new Error("Your account already has an organization membership."),
    );

    const { result, unmount } = renderHook(() => useClientHomeController(), {
      wrapper: createWrapper(),
    });

    emitSignedInAuthEvent();

    await waitFor(() => {
      expect(["provisioning", "ready"]).toContain(result.current.workspaceReadiness.status);
    });

    const submitPromise = result.current.handleComposerSubmit({
      prompt: "Upload these parts",
      files: [new File(["solid"], "part.step")],
      clear: vi.fn(),
    });

    await waitFor(() => {
      expect(createJobsFromUploadFilesMock).toHaveBeenCalledTimes(1);
    });

    await submitPromise;

    await waitFor(() => {
      expect(result.current.workspaceReadiness.status).toBe("ready");
    });

    expect(createJobsFromUploadFilesMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("fails fast with a precise error when membership recovery exhausts", async () => {
    const sessionResponses = [
      {
        user: null,
        memberships: [],
        isVerifiedAuth: false,
        authState: "anonymous" as const,
      },
      createSessionData({ memberships: [] }),
    ];
    fetchAppSessionDataMock.mockImplementation(async () => {
      return sessionResponses.shift() ?? createSessionData({ memberships: [] });
    });
    createSelfServiceOrganizationMock.mockRejectedValueOnce(
      new Error("Your account already has an organization membership."),
    );

    const { result, unmount } = renderHook(() => useClientHomeController(), {
      wrapper: createWrapper(),
    });

    emitSignedInAuthEvent();

    await waitFor(() => {
      expect(["provisioning", "provisioning_failed"]).toContain(result.current.workspaceReadiness.status);
    });

    const submitPromise = result.current.handleComposerSubmit({
      prompt: "Upload these parts",
      files: [new File(["solid"], "part.step")],
      clear: vi.fn(),
    });

    await expect(submitPromise).rejects.toMatchObject({
      message: MISSING_WORKSPACE_MEMBERSHIP_ERROR_MESSAGE,
    });
    await waitFor(() => {
      expect(result.current.workspaceReadiness.status).toBe("provisioning_failed");
    });
    expect(createJobsFromUploadFilesMock).not.toHaveBeenCalled();
    unmount();
  }, 10_000);
});
