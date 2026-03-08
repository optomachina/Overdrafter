import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { PropsWithChildren, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SharedInvite from "./SharedInvite";

const mockUseAppSession = vi.fn();
const mockAcceptProjectInvite = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: () => mockUseAppSession(),
}));

vi.mock("@/features/quotes/api", () => ({
  acceptProjectInvite: (...args: unknown[]) => mockAcceptProjectInvite(...args),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

vi.mock("@/components/chat/ChatWorkspaceLayout", () => ({
  ChatWorkspaceLayout: ({
    children,
    sidebarContent,
    topRightContent,
    sidebarFooter,
  }: {
    children?: ReactNode;
    sidebarContent?: ReactNode;
    topRightContent?: ReactNode;
    sidebarFooter?: ReactNode;
  }) => (
    <div>
      <div>{topRightContent}</div>
      <div>{sidebarContent}</div>
      <div>{children}</div>
      <div>{sidebarFooter}</div>
    </div>
  ),
}));

vi.mock("@/components/chat/GuestSidebarCta", () => ({
  GuestSidebarCta: ({ onLogIn }: { onLogIn: () => void }) => (
    <button type="button" onClick={onLogIn}>
      Open auth
    </button>
  ),
}));

vi.mock("@/components/SignInDialog", () => ({
  SignInDialog: ({
    open,
    redirectPath,
  }: {
    open: boolean;
    redirectPath: string;
  }) => (open ? <div>Sign in dialog: {redirectPath}</div> : null),
}));

function renderSharedInvite(initialEntry = "/shared/invite-token") {
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

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/shared/:inviteToken" element={<SharedInvite />} />
          <Route path="/projects/:projectId" element={<div>Project destination</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SharedInvite", () => {
  beforeEach(() => {
    mockUseAppSession.mockReset();
    mockAcceptProjectInvite.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("opens auth for guests and preserves the invite redirect path", () => {
    mockUseAppSession.mockReturnValue({
      user: null,
      isVerifiedAuth: false,
    });

    renderSharedInvite();

    expect(screen.getByText("Sign in dialog: /shared/invite-token")).toBeInTheDocument();
    expect(screen.getByText(/sign in with the invited email address/i)).toBeInTheDocument();
    expect(mockAcceptProjectInvite).not.toHaveBeenCalled();
  });

  it("accepts the invite for verified users and redirects into the project", async () => {
    mockUseAppSession.mockReturnValue({
      user: { id: "user-1" },
      isVerifiedAuth: true,
    });
    mockAcceptProjectInvite.mockResolvedValue("project-42");

    renderSharedInvite();

    await waitFor(() => {
      expect(mockAcceptProjectInvite).toHaveBeenCalledWith("invite-token");
    });

    await waitFor(() => {
      expect(screen.getByText("Project destination")).toBeInTheDocument();
    });

    expect(toastSuccess).toHaveBeenCalledWith("Project access unlocked.");
  });

  it("surfaces invite acceptance failures", async () => {
    mockUseAppSession.mockReturnValue({
      user: { id: "user-1" },
      isVerifiedAuth: true,
    });
    mockAcceptProjectInvite.mockRejectedValue(new Error("Invite expired."));

    renderSharedInvite();

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Invite expired.");
    });

    expect(screen.getByText("Invite expired.")).toBeInTheDocument();
  });
});
