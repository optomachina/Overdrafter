import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceNotificationsController } from "@/features/notifications/use-workspace-notifications";
import type { AppMembership } from "@/features/quotes/types";
import JobCreate from "./JobCreate";

const useAppSessionMock = vi.fn();
const useClientWorkspaceDataMock = vi.fn();
const useWorkspaceNotificationsMock = vi.fn();
const createJobMock = vi.hoisted(() => vi.fn());
const uploadFilesToJobMock = vi.hoisted(() => vi.fn());
const betaAccessMock = vi.hoisted(() => ({
  status: "eligible" as "eligible" | "not_enrolled" | "notice_required" | "revoked" | "unavailable",
  access: {
    state: "eligible",
    policyRevision: "revision-1",
    termsPath: "/legal/beta-terms",
    privacyPath: "/legal/privacy",
  } as Record<string, string> | null,
  canUpload: true,
  acceptNotice: vi.fn().mockResolvedValue(undefined),
  isAcceptingNotice: false,
  acceptanceError: null,
  refetch: vi.fn(),
}));

vi.mock("@/components/app/AppShell", () => ({
  AppShell: () => {
    throw new Error("JobCreate should not render AppShell for internal users.");
  },
}));

vi.mock("@/features/quotes/api", () => ({
  createJob: vi.fn(),
  inferFileKind: vi.fn(() => "step"),
  isProjectCollaborationSchemaUnavailable: () => false,
  reconcileJobParts: vi.fn(),
  requestExtraction: vi.fn(),
  resendSignupConfirmation: vi.fn(),
  uploadFilesToJob: vi.fn(),
}));
vi.mock("@/features/quotes/api/jobs-api", () => ({
  createJob: createJobMock,
}));
vi.mock("@/features/quotes/api/extraction-api", () => ({
  reconcileJobParts: vi.fn(),
  requestExtraction: vi.fn(),
}));
vi.mock("@/features/quotes/api/session-access", () => ({
  resendSignupConfirmation: vi.fn(),
}));
vi.mock("@/features/quotes/api/uploads-api", () => ({
  inferFileKind: vi.fn(() => "step"),
  uploadFilesToJob: uploadFilesToJobMock,
}));
vi.mock("@/features/quotes/api/shared/schema-runtime", () => ({
  isProjectCollaborationSchemaUnavailable: () => false,
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

vi.mock("@/features/quotes/file-validation", () => ({
  ALLOWED_QUOTE_UPLOAD_EXTENSIONS: [".step", ".stp", ".pdf"],
  validateQuoteFiles: vi.fn(() => ({ accepted: [], errors: [] })),
}));

vi.mock("@/lib/cad-preview", () => ({
  createCadPreviewSourceFromFile: vi.fn(),
  isStepPreviewableFile: vi.fn(() => false),
}));

vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: () => useAppSessionMock(),
}));
vi.mock("@/features/quotes/use-founding-beta-access", () => ({
  useFoundingBetaAccess: () => betaAccessMock,
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

function renderJobCreate() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/jobs/new"]}>
        <JobCreate />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openMainMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: /open account menu/i }), { button: 0 });
  await screen.findByRole("menuitem", { name: "Settings" });
}

describe("JobCreate", () => {
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

    useClientWorkspaceDataMock.mockReturnValue({
      accessibleJobsQuery: { data: [{ id: "job-1" }], isLoading: false },
      archivedProjectsQuery: { data: [], isLoading: false },
      archivedJobsQuery: { data: [], isLoading: false },
    });
    useWorkspaceNotificationsMock.mockReturnValue(makeNotificationCenter());
    createJobMock.mockReset();
    uploadFilesToJobMock.mockReset();
    betaAccessMock.status = "eligible";
    betaAccessMock.access = {
      state: "eligible",
      policyRevision: "revision-1",
      termsPath: "/legal/beta-terms",
      privacyPath: "/legal/privacy",
    };
    betaAccessMock.canUpload = true;
    betaAccessMock.refetch.mockReset().mockResolvedValue({
      data: { state: "eligible" },
      isError: false,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps internal users on the shared dashboard shell for /jobs/new", async () => {
    useAppSessionMock.mockReturnValue({
      user: makeUser(),
      activeMembership: makeMembership("internal_admin"),
      isVerifiedAuth: true,
      signOut: vi.fn(),
    });

    renderJobCreate();

    expect(await screen.findByText("Create CNC Quote Job")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Dashboard" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "New Job" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /open account menu/i })).toBeInTheDocument();

    await openMainMenu();

    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Log out" })).toBeInTheDocument();
  });

  it.each([
    ["not_enrolled", "invitation required"],
    ["notice_required", "accept the current Founding Beta notice"],
    ["revoked", "New drafts and uploads are paused"],
    ["unavailable", "could not be verified"],
  ] as const)("keeps %s access fail-closed without creating or uploading", async (state, copy) => {
    betaAccessMock.status = state;
    betaAccessMock.access = state === "notice_required"
      ? {
          state,
          policyRevision: "revision-1",
          termsPath: "/legal/beta-terms",
          privacyPath: "/legal/privacy",
        }
      : null;
    betaAccessMock.canUpload = false;
    betaAccessMock.refetch.mockResolvedValue({ data: { state }, isError: false });
    useAppSessionMock.mockReturnValue({
      user: makeUser(),
      activeMembership: makeMembership("internal_admin"),
      isVerifiedAuth: true,
      signOut: vi.fn(),
    });

    renderJobCreate();

    expect(await screen.findAllByText(new RegExp(copy, "i"))).not.toHaveLength(0);
    expect(screen.getByRole("button", { name: "Add files" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Create and queue extraction/i })).toBeDisabled();
    expect(createJobMock).not.toHaveBeenCalled();
    expect(uploadFilesToJobMock).not.toHaveBeenCalled();
  });

  it("does not open the picker when an eligible cache cannot be revalidated", async () => {
    betaAccessMock.refetch.mockResolvedValue({ data: { state: "eligible" }, isError: true });
    useAppSessionMock.mockReturnValue({
      user: makeUser(),
      activeMembership: makeMembership("internal_admin"),
      isVerifiedAuth: true,
      signOut: vi.fn(),
    });
    const inputClick = vi.spyOn(HTMLInputElement.prototype, "click");

    renderJobCreate();
    fireEvent.click(await screen.findByRole("button", { name: "Add files" }));

    expect(inputClick).not.toHaveBeenCalled();
    expect(createJobMock).not.toHaveBeenCalled();
    expect(uploadFilesToJobMock).not.toHaveBeenCalled();
  });
});
