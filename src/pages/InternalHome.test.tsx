import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceNotificationsController } from "@/features/notifications/use-workspace-notifications";
import type { AppMembership } from "@/features/quotes/types";
import InternalHome from "./InternalHome";

const fetchJobsByOrganizationMock = vi.fn();
const fetchOrganizationMembershipsMock = vi.fn();
const fetchPublishedPackagesByOrganizationMock = vi.fn();
const updateOrganizationMembershipRoleMock = vi.fn();
const useWorkspaceNotificationsMock = vi.fn();
const useClientWorkspaceDataMock = vi.fn();
const useAppSessionMock = vi.fn();
const signOutMock = vi.fn();

vi.mock("@/components/app/AppShell", () => ({
  AppShell: () => {
    throw new Error("InternalHome should not render AppShell.");
  },
}));

vi.mock("@/features/quotes/api", () => ({
  fetchJobsByOrganization: (...args: unknown[]) => fetchJobsByOrganizationMock(...args),
  fetchOrganizationMemberships: (...args: unknown[]) => fetchOrganizationMembershipsMock(...args),
  fetchPublishedPackagesByOrganization: (...args: unknown[]) =>
    fetchPublishedPackagesByOrganizationMock(...args),
  isProjectCollaborationSchemaUnavailable: () => false,
  resendSignupConfirmation: vi.fn(),
  updateOrganizationMembershipRole: (...args: unknown[]) =>
    updateOrganizationMembershipRoleMock(...args),
}));
vi.mock("@/features/quotes/api/organizations-api", () => ({
  fetchOrganizationMemberships: (...args: unknown[]) => fetchOrganizationMembershipsMock(...args),
}));
vi.mock("@/features/quotes/api/session-access", () => ({
  resendSignupConfirmation: vi.fn(),
  updateOrganizationMembershipRole: (...args: unknown[]) => updateOrganizationMembershipRoleMock(...args),
}));
vi.mock("@/features/quotes/api/shared/schema-runtime", () => ({
  isProjectCollaborationSchemaUnavailable: () => false,
}));
vi.mock("@/features/quotes/api/workspace-access", () => ({
  fetchJobsByOrganization: (...args: unknown[]) => fetchJobsByOrganizationMock(...args),
  fetchPublishedPackagesByOrganization: (...args: unknown[]) =>
    fetchPublishedPackagesByOrganizationMock(...args),
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
    user_metadata: {
      given_name: "Blaine",
      family_name: "Wilson",
    },
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
    typeDefinitions: {
      "client.quote_package_ready": {
        label: "Quote package ready",
        description: "Notify me when curated quote options are published to a project or part I can access.",
      },
      "internal.extraction_attention_required": {
        label: "Extraction needs attention",
        description: "Notify me when file extraction stalls and internal review needs to intervene.",
      },
      "internal.quote_responses_ready": {
        label: "Quote responses ready",
        description: "Notify me when vendor responses are ready for internal review.",
      },
      "internal.quote_follow_up_required": {
        label: "Vendor follow-up required",
        description: "Notify me when quote collection still needs manual vendor follow-up.",
      },
      "internal.quote_collection_failed": {
        label: "Quote collection failed",
        description: "Notify me when quote collection ends without a publishable result.",
      },
      "internal.client_selection_received": {
        label: "Client selection received",
        description: "Notify me when a client records a quote-package selection that changes downstream work.",
      },
    },
    typePreferences: {
      "client.quote_package_ready": { inApp: true, browser: false },
      "internal.extraction_attention_required": { inApp: true, browser: false },
      "internal.quote_responses_ready": { inApp: true, browser: false },
      "internal.quote_follow_up_required": { inApp: true, browser: false },
      "internal.quote_collection_failed": { inApp: true, browser: false },
      "internal.client_selection_received": { inApp: true, browser: false },
    },
    unseenCount: 0,
  };
}

function renderInternalHome() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <InternalHome />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openMainMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: /open account menu/i }), { button: 0 });
  await screen.findByRole("menuitem", { name: "Settings" });
}

describe("InternalHome", () => {
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

    fetchJobsByOrganizationMock.mockResolvedValue([]);
    fetchPublishedPackagesByOrganizationMock.mockResolvedValue([]);
    fetchOrganizationMembershipsMock.mockResolvedValue([
      {
        id: "membership-2",
        userId: "user-2",
        email: "team@example.com",
        role: "client",
        createdAt: "2026-03-07T00:00:00.000Z",
      },
    ]);
    updateOrganizationMembershipRoleMock.mockResolvedValue(undefined);
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

  it("renders the admin dashboard on the shared shell and signs out through the shared account menu", async () => {
    useAppSessionMock.mockReturnValue({
      user: makeUser(),
      activeMembership: makeMembership("internal_admin"),
      isVerifiedAuth: true,
      signOut: signOutMock,
    });

    renderInternalHome();

    expect(await screen.findByText("Operations Dashboard")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Dashboard" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "New Job" }).length).toBeGreaterThan(0);
    expect(screen.getByText("Team Access")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open account menu/i })).toBeInTheDocument();

    await openMainMenu();

    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Log out" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    await waitFor(() => {
      expect(signOutMock).toHaveBeenCalledTimes(1);
    });
  });

  it("applies the shared shell to estimators without rendering the admin-only access section", async () => {
    useAppSessionMock.mockReturnValue({
      user: makeUser(),
      activeMembership: makeMembership("internal_estimator"),
      isVerifiedAuth: true,
      signOut: signOutMock,
    });

    renderInternalHome();

    expect(await screen.findByText("Operations Dashboard")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Dashboard" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "New Job" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /open account menu/i })).toBeInTheDocument();
    expect(screen.queryByText("Team Access")).not.toBeInTheDocument();
  });
});
