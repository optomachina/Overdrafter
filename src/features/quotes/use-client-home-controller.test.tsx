import "@testing-library/jest-dom/vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSessionData } from "@/features/quotes/types";
import { MISSING_WORKSPACE_MEMBERSHIP_ERROR_MESSAGE } from "@/hooks/workspace-readiness";
import type { Session } from "@supabase/supabase-js";
import { createClientDraft } from "@/features/quotes/api/jobs-api";
import { parseRequestIntake } from "@/features/quotes/request-intake";
import { useClientHomeController } from "./use-client-home-controller";

const fetchAppSessionDataMock = vi.fn<() => Promise<AppSessionData>>();
const createSelfServiceOrganizationMock = vi.fn();
const createJobsFromUploadFilesMock = vi.fn();
const invalidateClientWorkspaceQueriesMock = vi.fn();
const onAuthStateChangeMock = vi.fn();
const getSessionMock = vi.fn();
const adminSignOutMock = vi.fn();
const getUserMock = vi.fn();
const useClientWorkspaceDataMock = vi.fn();
const useWarmClientWorkspaceNavigationMock = vi.fn();
let authStateChangeCallbacks: Array<(event: string, session: Session | null) => void> = [];

function deferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
      getSession: (...args: unknown[]) => getSessionMock(...args),
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
  useClientWorkspaceData: (...args: unknown[]) => useClientWorkspaceDataMock(...args),
  useWarmClientWorkspaceNavigation: (...args: unknown[]) => useWarmClientWorkspaceNavigationMock(...args),
}));

function createWorkspaceDataResult() {
  return {
    accessibleJobs: [],
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
  };
}

vi.mock("@/features/quotes/workspace-navigation", () => ({
  WORKSPACE_SHARED_STALE_TIME_MS: 30_000,
  createWorkspaceAccessScope: ({
    userId,
    organizationId,
    role,
  }: {
    userId?: string | null;
    organizationId?: string | null;
    role?: string | null;
  }) => JSON.stringify([userId ?? null, organizationId ?? null, role ?? null]),
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

function createSessionData(input: {
  memberships?: AppSessionData["memberships"];
  authState?: AppSessionData["authState"];
  isVerifiedAuth?: boolean;
  isPlatformAdmin?: boolean;
  membershipError?: string;
}): AppSessionData {
  return {
    user: {
      id: "user-1",
      email: "client@example.com",
    } as AppSessionData["user"],
    memberships: input.memberships ?? [],
    isVerifiedAuth: input.isVerifiedAuth ?? true,
    isPlatformAdmin: input.isPlatformAdmin ?? false,
    authState: input.authState ?? "authenticated",
    membershipError: input.membershipError,
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
    useClientWorkspaceDataMock.mockImplementation(() => createWorkspaceDataResult());
    useWarmClientWorkspaceNavigationMock.mockImplementation(() => undefined);
    getSessionMock.mockResolvedValue({
      data: {
        session: {
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
        },
      },
      error: null,
    });
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

  it("bootstraps a clean verified zero-membership session exactly once", async () => {
    const emptySession = createSessionData({
      memberships: [],
    });
    const bootstrappedSession = createSessionData({
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
      emptySession,
      bootstrappedSession,
    ];

    fetchAppSessionDataMock.mockImplementation(async () => {
      return sessionResponses.shift() ?? bootstrappedSession;
    });
    createSelfServiceOrganizationMock.mockResolvedValueOnce("org-1");

    const { result, unmount } = renderHook(() => useClientHomeController(), {
      wrapper: createWrapper(),
    });

    emitSignedInAuthEvent();

    await waitFor(() => {
      expect(result.current.user?.id).toBe("user-1");
      expect(result.current.isAuthInitializing).toBe(false);
    });

    await waitFor(() => {
      expect(createSelfServiceOrganizationMock).toHaveBeenCalledTimes(1);
    });

    expect(createSelfServiceOrganizationMock).toHaveBeenCalledWith("Client");
    expect(fetchAppSessionDataMock).toHaveBeenCalledTimes(3);
    unmount();
  });

  it("does not bootstrap when the session is not yet stable", async () => {
    fetchAppSessionDataMock.mockResolvedValue(
      createSessionData({
        memberships: [],
        authState: "session_error",
      }),
    );

    const { unmount } = renderHook(() => useClientHomeController(), {
      wrapper: createWrapper(),
    });

    emitSignedInAuthEvent();

    await waitFor(() => {
      expect(fetchAppSessionDataMock).toHaveBeenCalled();
    });

    expect(createSelfServiceOrganizationMock).not.toHaveBeenCalled();
    unmount();
  });

  it("does not bootstrap from the auth-event seed before the network session resolves", async () => {
    const deferredSession = deferredPromise<AppSessionData>();
    fetchAppSessionDataMock
      .mockResolvedValueOnce({
        user: null,
        memberships: [],
        isVerifiedAuth: false,
        authState: "anonymous",
      })
      .mockReturnValueOnce(deferredSession.promise);

    const { result, unmount } = renderHook(() => useClientHomeController(), {
      wrapper: createWrapper(),
    });

    emitSignedInAuthEvent();

    await waitFor(() => {
      expect(result.current.user?.id).toBe("user-1");
    });

    expect(createSelfServiceOrganizationMock).not.toHaveBeenCalled();

    await act(async () => {
      deferredSession.resolve(
        createSessionData({
          memberships: [
            {
              id: "membership-1",
              role: "client",
              organizationId: "org-1",
              organizationName: "Client Org",
              organizationSlug: "client-org",
            },
          ],
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.activeMembership?.organizationId).toBe("org-1");
    });

    expect(createSelfServiceOrganizationMock).not.toHaveBeenCalled();
    unmount();
  });

  it("does not bootstrap when membership resolution is degraded", async () => {
    fetchAppSessionDataMock.mockResolvedValue(
      createSessionData({
        memberships: [],
        membershipError: "temporary membership lookup failure",
      }),
    );

    const { unmount } = renderHook(() => useClientHomeController(), {
      wrapper: createWrapper(),
    });

    emitSignedInAuthEvent();

    await waitFor(() => {
      expect(fetchAppSessionDataMock).toHaveBeenCalled();
    });

    expect(createSelfServiceOrganizationMock).not.toHaveBeenCalled();
    unmount();
  });

  it("does not bootstrap a zero-membership platform admin", async () => {
    fetchAppSessionDataMock.mockResolvedValue(
      createSessionData({
        memberships: [],
        isPlatformAdmin: true,
      }),
    );

    const { unmount } = renderHook(() => useClientHomeController(), {
      wrapper: createWrapper(),
    });

    emitSignedInAuthEvent();

    await waitFor(() => {
      expect(fetchAppSessionDataMock).toHaveBeenCalled();
    });

    expect(createSelfServiceOrganizationMock).not.toHaveBeenCalled();
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

  it("keeps workspace queries enabled while a signed-in session is retried through session_error", async () => {
    const localSession = createSessionData({
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

    fetchAppSessionDataMock
      .mockResolvedValueOnce({
        user: null,
        memberships: [],
        isVerifiedAuth: false,
        authState: "anonymous",
      })
      .mockResolvedValueOnce({
        user: null,
        memberships: [],
        isVerifiedAuth: false,
        authState: "session_error",
      })
      .mockResolvedValueOnce(localSession);

    const { unmount } = renderHook(() => useClientHomeController(), {
      wrapper: createWrapper(),
    });

    emitSignedInAuthEvent();

    await waitFor(() => {
      expect(useClientWorkspaceDataMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          accessScope: JSON.stringify(["user-1", "org-1", "client"]),
          enabled: true,
        }),
      );
    });

    expect(useWarmClientWorkspaceNavigationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
      }),
    );

    await waitFor(() => {
      expect(useWarmClientWorkspaceNavigationMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          enabled: true,
        }),
      );
    });

    unmount();
  });

  // OVD-992: a need-by date typed in the prompt is a display filter only. The draft created without
  // files must not carry it, because the approved requirement copies it and every controlled
  // dispatch denies the request. The real parser runs here (the module is mocked for the other
  // tests), so each prompt below really yields a date for the call site to drop.
  describe("prompt without files (OVD-992)", () => {
    const FIXED_NOW = new Date("2026-10-19T12:00:00.000Z");
    const readyMembership = createSessionData({
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

    it.each([
      {
        label: "relative weekday",
        prompt: "Please quote 25 of these, need by next Friday",
        parsedDate: "2026-10-23",
        quantities: [25],
      },
      {
        label: "slash date",
        prompt: "Need 50 of these, needed by 11/20",
        parsedDate: "2026-11-20",
        quantities: [50],
      },
      {
        label: "month name",
        prompt: "Quote qty 10/50/100, deliver by Dec 5",
        parsedDate: "2026-12-05",
        quantities: [10, 50, 100],
      },
    ])("does not save a $label need-by date but keeps the quantities", async ({ prompt, parsedDate, quantities }) => {
      const actualIntake = await vi.importActual<typeof import("@/features/quotes/request-intake")>(
        "@/features/quotes/request-intake",
      );
      expect(actualIntake.parseRequestIntake(prompt, FIXED_NOW).requestedByDate).toBe(parsedDate);
      vi.mocked(parseRequestIntake).mockImplementationOnce((value) =>
        actualIntake.parseRequestIntake(value, FIXED_NOW),
      );
      fetchAppSessionDataMock.mockResolvedValue(readyMembership);
      vi.mocked(createClientDraft).mockResolvedValue("job-9");

      const { result, unmount } = renderHook(() => useClientHomeController(), {
        wrapper: createWrapper(),
      });
      emitSignedInAuthEvent();
      await waitFor(() => {
        expect(result.current.workspaceReadiness.status).toBe("ready");
      });

      await act(async () => {
        await result.current.handleComposerSubmit({ prompt, files: [], clear: vi.fn() });
      });

      expect(createClientDraft).toHaveBeenCalledTimes(1);
      const draft = vi.mocked(createClientDraft).mock.calls[0]?.[0];
      expect(draft).toEqual({
        title: prompt,
        description: prompt,
        tags: [],
        requestedQuoteQuantities: quantities,
      });
      expect(draft?.requestedByDate ?? null).toBeNull();
      unmount();
    });
  });
});
