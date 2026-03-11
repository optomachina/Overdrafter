import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSessionData } from "@/features/quotes/types";
import ClientHome from "./ClientHome";

const fetchAppSessionDataMock = vi.fn<() => Promise<AppSessionData>>();
const requestPasswordResetMock = vi.fn();
const resendSignupConfirmationMock = vi.fn();
const updateCurrentUserPasswordMock = vi.fn();
const signInWithPasswordMock = vi.fn();
const signUpMock = vi.fn();
const authGetUserMock = vi.fn();
const adminSignOutMock = vi.fn();
const navigateMock = vi.fn();
let authStateChangeCallbacks: Array<(event: string, session: Session | null) => void> = [];

vi.mock("@/features/quotes/api", () => ({
  fetchAppSessionData: () => fetchAppSessionDataMock(),
  requestPasswordReset: (...args: unknown[]) => requestPasswordResetMock(...args),
  resendSignupConfirmation: (...args: unknown[]) => resendSignupConfirmationMock(...args),
  updateCurrentUserPassword: (...args: unknown[]) => updateCurrentUserPasswordMock(...args),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      onAuthStateChange: (callback: (event: string, session: Session | null) => void) => {
        authStateChangeCallbacks.push(callback);

        return {
          data: {
            subscription: {
              unsubscribe: vi.fn(),
            },
          },
        };
      },
      signInWithPassword: (...args: unknown[]) => signInWithPasswordMock(...args),
      signUp: (...args: unknown[]) => signUpMock(...args),
      getUser: (...args: unknown[]) => authGetUserMock(...args),
      admin: {
        signOut: (...args: unknown[]) => adminSignOutMock(...args),
      },
    },
  },
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();

  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock("@/components/chat/ChatWorkspaceLayout", () => ({
  ChatWorkspaceLayout: ({
    topRightContent,
    sidebarContent,
    sidebarFooter,
    children,
  }: {
    topRightContent?: React.ReactNode;
    sidebarContent?: React.ReactNode;
    sidebarFooter?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div>
      <div data-testid="top-right">{topRightContent}</div>
      <div data-testid="sidebar">{sidebarContent}</div>
      <div data-testid="content">{children}</div>
      <div data-testid="sidebar-footer">{sidebarFooter}</div>
    </div>
  ),
}));

vi.mock("@/components/chat/PromptComposer", () => ({
  PromptComposer: React.forwardRef(function PromptComposerMock(
    _props: Record<string, unknown>,
    _ref: React.ForwardedRef<{ focus: () => void }>,
  ) {
    return <div>Prompt composer</div>;
  }),
}));

vi.mock("@/components/chat/SearchPartsDialog", () => ({
  SearchPartsDialog: () => null,
}));

vi.mock("@/components/chat/WorkspaceSidebar", () => ({
  WorkspaceSidebar: () => <div>Workspace sidebar</div>,
}));

vi.mock("@/components/chat/WorkspaceAccountMenu", () => ({
  WorkspaceAccountMenu: () => <div>Account menu</div>,
}));

vi.mock("@/components/chat/GuestSidebarCta", () => ({
  GuestSidebarCta: ({ onLogIn }: { onLogIn: () => void }) => (
    <button type="button" onClick={onLogIn}>
      Log in
    </button>
  ),
}));

vi.mock("@/features/quotes/use-client-home-controller", async () => {
  const ReactModule = await import("react");
  const { useAppSession } = await import("@/hooks/use-app-session");

  return {
    useClientHomeController: () => {
      const session = useAppSession();
      const [isAuthDialogOpen, setIsAuthDialogOpen] = ReactModule.useState(false);
      const [isSearchOpen, setIsSearchOpen] = ReactModule.useState(false);
      const inputRef = ReactModule.useRef<HTMLInputElement>(null);

      return {
        activeMembership: session.activeMembership,
        archivedJobsQuery: { data: [], isLoading: false },
        archivedProjectsQuery: { data: [], isLoading: false },
        authDialogMode: "sign-in" as const,
        composerRef: ReactModule.createRef(),
        handleAssignPartToProject: vi.fn(),
        handleArchivePart: vi.fn(),
        handleArchiveProject: vi.fn(),
        handleComposerSubmit: vi.fn(),
        handleCreateProjectFromSelection: vi.fn(),
        handleDeleteArchivedPart: vi.fn(),
        handleDissolveProject: vi.fn(),
        handlePinPart: vi.fn(),
        handlePinProject: vi.fn(),
        handleRemovePartFromProject: vi.fn(),
        handleRenameProject: vi.fn(),
        handleUnarchivePart: vi.fn(),
        handleUnpinPart: vi.fn(),
        handleUnpinProject: vi.fn(),
        isAuthDialogOpen,
        isSearchOpen,
        navigate: navigateMock,
        newJobFilePicker: {
          accept: "",
          handleFileInputChange: vi.fn(),
          inputRef,
          openFilePicker: vi.fn(),
        },
        openAuth: () => setIsAuthDialogOpen(true),
        prefetchPart: vi.fn(),
        prefetchProject: vi.fn(),
        projectCollaborationUnavailable: false,
        resolveSidebarProjectIdsForJob: vi.fn(() => []),
        setIsAuthDialogOpen,
        setIsSearchOpen,
        sidebarPinsQuery: { data: { projectIds: [], jobIds: [] } },
        sidebarProjects: [],
        signOut: session.signOut,
        summariesByJobId: new Map(),
        user: session.user,
        accessibleJobsQuery: { data: [], isLoading: false },
      };
    },
  };
});

function deferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function renderClientHome() {
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
        <ClientHome />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ClientHome auth flow", () => {
  beforeEach(() => {
    authStateChangeCallbacks = [];
    navigateMock.mockReset();
    signUpMock.mockResolvedValue({ data: { session: null }, error: null });
    authGetUserMock.mockResolvedValue({ data: { user: null }, error: null });
    requestPasswordResetMock.mockResolvedValue(undefined);
    resendSignupConfirmationMock.mockResolvedValue(undefined);
    updateCurrentUserPasswordMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("closes the dialog and removes guest login buttons as soon as sign-in emits an auth event", async () => {
    const membershipHydration = deferredPromise<AppSessionData>();
    fetchAppSessionDataMock
      .mockResolvedValueOnce({
        user: null,
        memberships: [],
        isVerifiedAuth: false,
        authState: "anonymous",
      })
      .mockReturnValueOnce(membershipHydration.promise);

    signInWithPasswordMock.mockImplementation(async ({ email }: { email: string }) => {
      const session = {
        access_token: "token-1",
        refresh_token: "refresh-token-1",
        expires_in: 3600,
        token_type: "bearer",
        user: {
          id: "user-1",
          email,
          app_metadata: {},
          user_metadata: {},
          aud: "authenticated",
          created_at: "2026-03-11T00:00:00.000Z",
        },
      } as Session;

      act(() => {
        authStateChangeCallbacks.forEach((callback) => callback("SIGNED_IN", session));
      });

      return {
        data: { user: session.user, session },
        error: null,
      };
    });

    renderClientHome();

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /^log in$/i }).length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByRole("button", { name: /^log in$/i })[0]);

    expect(screen.getByText("Log in to OverDrafter")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "client@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "Overdrafter123!" },
    });
    const dialog = screen.getByRole("dialog");
    const submitButton = within(dialog)
      .getAllByRole("button", { name: /^log in$/i })
      .find((element) => element.getAttribute("type") === "submit");

    expect(submitButton).toBeTruthy();
    fireEvent.click(submitButton!);

    await waitFor(() => {
      expect(signInWithPasswordMock).toHaveBeenCalledWith({
        email: "client@example.com",
        password: "Overdrafter123!",
      });
    });

    await waitFor(() => {
      expect(screen.queryByText("Log in to OverDrafter")).not.toBeInTheDocument();
    });

    expect(screen.queryAllByRole("button", { name: /^log in$/i })).toHaveLength(0);

    membershipHydration.resolve({
      user: {
        id: "user-1",
        email: "client@example.com",
      } as AppSessionData["user"],
      memberships: [
        {
          id: "membership-1",
          role: "client",
          organizationId: "org-1",
          organizationName: "Client Org",
          organizationSlug: "client-org",
        },
      ],
      isVerifiedAuth: true,
      authState: "authenticated",
    });

    await waitFor(() => {
      expect(fetchAppSessionDataMock).toHaveBeenCalledTimes(2);
    });
  });
});
