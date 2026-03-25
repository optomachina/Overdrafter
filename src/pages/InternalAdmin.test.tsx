import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceNotificationsController } from "@/features/notifications/use-workspace-notifications";
import type { AppMembership } from "@/features/quotes/types";
import InternalAdmin from "./InternalAdmin";

const fetchAdminOrganizationsMock = vi.fn();
const fetchAdminAllUsersMock = vi.fn();
const fetchAdminAllJobsMock = vi.fn();
const fetchAdminAllProjectsMock = vi.fn();
const useWorkspaceNotificationsMock = vi.fn();
const useClientWorkspaceDataMock = vi.fn();
const useAppSessionMock = vi.fn();
const signOutMock = vi.fn();

vi.mock("@/features/quotes/api/shared/schema-runtime", () => ({
  isProjectCollaborationSchemaUnavailable: () => false,
}));
vi.mock("@/features/quotes/api/workspace-access", () => ({
  fetchAdminOrganizations: (...args: unknown[]) => fetchAdminOrganizationsMock(...args),
  fetchAdminAllUsers: (...args: unknown[]) => fetchAdminAllUsersMock(...args),
  fetchAdminAllJobs: (...args: unknown[]) => fetchAdminAllJobsMock(...args),
  fetchAdminAllProjects: (...args: unknown[]) => fetchAdminAllProjectsMock(...args),
}));
vi.mock("@/features/notifications/use-workspace-notifications", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/notifications/use-workspace-notifications")>();

  return {
    ...actual,
    useWorkspaceNotifications: (...args: unknown[]) => useWorkspaceNotificationsMock(...args),
  };
});
vi.mock("@/features/quotes/use-client-workspace-data", () => ({
  useClientWorkspaceData: (...args: unknown[]) => useClientWorkspaceDataMock(...args),
}));
vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: () => useAppSessionMock(),
}));

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    app_metadata: { provider: "google" },
    user_metadata: {},
    aud: "authenticated",
    confirmation_sent_at: null,
    recovery_sent_at: null,
    email_change_sent_at: null,
    new_email: null,
    new_phone: null,
    invited_at: null,
    action_link: null,
    email: "blaine@example.com",
    phone: "",
    created_at: "2026-03-07T00:00:00.000Z",
    confirmed_at: null,
    email_confirmed_at: null,
    phone_confirmed_at: null,
    last_sign_in_at: null,
    role: "authenticated",
    updated_at: "2026-03-07T00:00:00.000Z",
    identities: [],
    is_anonymous: false,
    factors: null,
    ...overrides,
  } as unknown as User;
}

function makeMembership(role: AppMembership["role"]): AppMembership {
  return {
    id: `membership-${role}`,
    role,
    organizationId: "org-1",
    organizationName: "Wilson Works",
    organizationSlug: "wilson-works",
  };
}

function makeNotificationCenter(): WorkspaceNotificationsController {
  return {
    allItems: [],
    browserPermission: "unsupported",
    isLoading: false,
    isRequestingPermission: false,
    items: [],
    markAllSeen: vi.fn(),
    requestBrowserPermission: vi.fn().mockResolvedValue(undefined),
    setChannelEnabled: vi.fn(),
    setItemSeen: vi.fn(),
    supportedTypes: [],
    typeDefinitions: {},
    typePreferences: {},
    unseenCount: 0,
  } as unknown as WorkspaceNotificationsController;
}

function renderInternalAdmin() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/internal/admin"]}>
        <InternalAdmin />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("InternalAdmin", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    const localStorageMock = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    };

    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("localStorage", localStorageMock);
    Object.defineProperty(window, "localStorage", {
      value: localStorageMock,
      writable: true,
    });
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });

    fetchAdminOrganizationsMock.mockResolvedValue([
      {
        id: "org-1",
        name: "Wilson Works",
        slug: "wilson-works",
        memberCount: 4,
        activeJobCount: 7,
        createdAt: "2026-03-01T00:00:00.000Z",
      },
    ]);
    fetchAdminAllUsersMock.mockResolvedValue([
      {
        id: "membership-1",
        userId: "user-1",
        email: "blaine@example.com",
        organizationId: "org-1",
        organizationName: "Wilson Works",
        organizationSlug: "wilson-works",
        role: "internal_admin",
        createdAt: "2026-03-02T00:00:00.000Z",
      },
    ]);
    fetchAdminAllJobsMock.mockResolvedValue([
      {
        id: "job-1",
        organizationId: "org-1",
        organizationName: "Wilson Works",
        title: "Widget Block",
        status: "internal_review",
        partCount: 3,
        createdAt: "2026-03-03T00:00:00.000Z",
      },
    ]);
    fetchAdminAllProjectsMock.mockResolvedValue([
      {
        id: "project-1",
        organizationId: "org-1",
        organizationName: "Wilson Works",
        name: "Rush Customer",
        ownerEmail: "owner@example.com",
        memberCount: 2,
        jobCount: 1,
        createdAt: "2026-03-04T00:00:00.000Z",
      },
    ]);
    useWorkspaceNotificationsMock.mockReturnValue(makeNotificationCenter());
    useClientWorkspaceDataMock.mockReturnValue({
      accessibleJobsQuery: { data: [{ id: "job-1" }], isLoading: false },
      archivedProjectsQuery: { data: [], isLoading: false },
      archivedJobsQuery: { data: [], isLoading: false },
    });
    signOutMock.mockReset();
    signOutMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders cross-org tables for platform admins", async () => {
    useAppSessionMock.mockReturnValue({
      user: makeUser(),
      activeMembership: makeMembership("internal_admin"),
      isPlatformAdmin: true,
      isAuthInitializing: false,
      signOut: signOutMock,
    });

    renderInternalAdmin();

    expect(await screen.findByText("Platform Admin God Mode")).toBeInTheDocument();
    expect(screen.getByText("Organizations")).toBeInTheDocument();
    expect(screen.getByText("Users")).toBeInTheDocument();
    expect(screen.getByText("Jobs / Parts")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "God Mode" }).length).toBeGreaterThan(0);
    expect(await screen.findByRole("link", { name: "Widget Block" })).toHaveAttribute(
      "href",
      "/internal/jobs/job-1",
    );
  });

  it("shows a not-authorized card for non-platform-admin users", async () => {
    useAppSessionMock.mockReturnValue({
      user: makeUser(),
      activeMembership: makeMembership("internal_admin"),
      isPlatformAdmin: false,
      isAuthInitializing: false,
      signOut: signOutMock,
    });

    renderInternalAdmin();

    expect(await screen.findByText("Not authorized")).toBeInTheDocument();
    expect(screen.queryByText("Organizations")).not.toBeInTheDocument();
  });
});
