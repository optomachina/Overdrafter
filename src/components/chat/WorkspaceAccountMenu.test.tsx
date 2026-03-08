import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";
import type { AppMembership, ArchivedJobSummary, ArchivedProjectSummary } from "@/features/quotes/types";
import { WorkspaceAccountMenu } from "./WorkspaceAccountMenu";

const diagnosticsMocks = vi.hoisted(() => ({
  setDiagnosticsEnabled: vi.fn(),
  setDiagnosticsPanelOpen: vi.fn(),
}));

vi.mock("@/lib/diagnostics", () => ({
  setDiagnosticsEnabled: diagnosticsMocks.setDiagnosticsEnabled,
  setDiagnosticsPanelOpen: diagnosticsMocks.setDiagnosticsPanelOpen,
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

const membership: AppMembership = {
  id: "membership-1",
  role: "client",
  organizationId: "org-1",
  organizationName: "Wilson Works",
  organizationSlug: "wilson-works",
};

const archivedProjects: ArchivedProjectSummary[] = [
  {
    project: {
      id: "project-1",
      organization_id: "org-1",
      owner_user_id: "user-1",
      name: "Archived Project",
      description: null,
      archived_at: "2026-03-08T12:00:00.000Z",
      created_at: "2026-03-06T00:00:00.000Z",
      updated_at: "2026-03-08T12:00:00.000Z",
    },
    currentUserRole: "owner",
    partCount: 2,
  },
];

const archivedJobs: ArchivedJobSummary[] = [
  {
    job: {
      id: "job-1",
      organization_id: "org-1",
      project_id: null,
      selected_vendor_quote_offer_id: null,
      created_by: "user-1",
      title: "Archived Part",
      description: null,
      status: "uploaded",
      source: "client_home",
      active_pricing_policy_id: null,
      tags: [],
      requested_quote_quantities: [],
      requested_by_date: null,
      archived_at: "2026-03-08T12:00:00.000Z",
      created_at: "2026-03-06T00:00:00.000Z",
      updated_at: "2026-03-08T12:00:00.000Z",
    },
    summary: null,
    projectNames: ["Archived Project"],
  },
];

async function openMainMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: /open account menu/i }), { button: 0 });
  await screen.findByRole("menuitem", { name: "Settings" });
}

async function openHelpSubmenu() {
  const helpItem = screen.getByRole("menuitem", { name: "Help" });
  fireEvent.keyDown(helpItem, { key: "ArrowRight" });
  await screen.findByRole("menuitem", { name: "Help center" });
}

describe("WorkspaceAccountMenu", () => {
  beforeEach(() => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    diagnosticsMocks.setDiagnosticsEnabled.mockReset();
    diagnosticsMocks.setDiagnosticsPanelOpen.mockReset();
    vi.unstubAllGlobals();
  });

  it("shows the resolved full name, current role, and footer-sized avatar without the email", () => {
    render(<WorkspaceAccountMenu user={makeUser()} activeMembership={membership} onSignOut={vi.fn()} />);

    expect(screen.getByText("Blaine Wilson")).toBeInTheDocument();
    expect(screen.getByText("Client")).toBeInTheDocument();
    expect(screen.queryByText("blaine@example.com")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open account menu/i }).querySelector(".h-11.w-11")).not.toBeNull();
  });

  it("ties the main dropdown width to the account trigger width", async () => {
    render(<WorkspaceAccountMenu user={makeUser()} activeMembership={membership} onSignOut={vi.fn()} />);

    await openMainMenu();

    expect(screen.getByRole("menu")).toHaveClass("w-[var(--radix-dropdown-menu-trigger-width)]");
  });

  it("opens the help submenu with the requested items", async () => {
    render(<WorkspaceAccountMenu user={makeUser()} activeMembership={membership} onSignOut={vi.fn()} />);

    await openMainMenu();
    await openHelpSubmenu();

    expect(screen.getByRole("menuitem", { name: "Help center" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Release notes" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Terms & policies" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Report a bug" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Download apps" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("opens the archive panel from the account menu", async () => {
    render(
      <WorkspaceAccountMenu
        user={makeUser()}
        activeMembership={membership}
        onSignOut={vi.fn()}
        archivedProjects={archivedProjects}
        archivedJobs={archivedJobs}
      />,
    );

    await openMainMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));

    expect(await screen.findByRole("tab", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Parts" })).toBeInTheDocument();
    expect(screen.getByText("Archived Project")).toBeInTheDocument();
  });

  it("shows archive empty states", async () => {
    render(<WorkspaceAccountMenu user={makeUser()} activeMembership={membership} onSignOut={vi.fn()} />);

    await openMainMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));

    expect(await screen.findByText("No archived projects yet.")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Parts" })).toBeInTheDocument();
  });

  it("opens the settings panel from the account menu", async () => {
    render(<WorkspaceAccountMenu user={makeUser()} activeMembership={membership} onSignOut={vi.fn()} />);

    await openMainMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));

    expect(await screen.findByText("Sign-in method")).toBeInTheDocument();
    expect(screen.getByText("Wilson Works")).toBeInTheDocument();
    expect(screen.getByText("Role")).toBeInTheDocument();
    expect(screen.getAllByText("Client").length).toBeGreaterThan(0);
  });

  it("opens diagnostics from the report bug action", async () => {
    render(<WorkspaceAccountMenu user={makeUser()} activeMembership={membership} onSignOut={vi.fn()} />);

    await openMainMenu();
    await openHelpSubmenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Report a bug" }));

    await waitFor(() => {
      expect(diagnosticsMocks.setDiagnosticsEnabled).toHaveBeenCalledWith(true);
      expect(diagnosticsMocks.setDiagnosticsPanelOpen).toHaveBeenCalledWith(true);
    });
  });

  it("opens a confirmation dialog before signing out", async () => {
    const onSignOut = vi.fn().mockResolvedValue(undefined);
    const onSignedOut = vi.fn();

    render(
      <WorkspaceAccountMenu
        user={makeUser()}
        activeMembership={membership}
        onSignOut={onSignOut}
        onSignedOut={onSignedOut}
      />,
    );

    expect(screen.queryByText(/sign out/i)).not.toBeInTheDocument();

    await openMainMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Are you sure you want to log out?")).toBeInTheDocument();
    expect(screen.getByText("Log out of Overdrafter as")).toBeInTheDocument();
    expect(screen.getByText("blaine@example.com?")).toBeInTheDocument();
    expect(onSignOut).not.toHaveBeenCalled();
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("signs out after confirming from the modal", async () => {
    const onSignOut = vi.fn().mockResolvedValue(undefined);
    const onSignedOut = vi.fn();

    render(
      <WorkspaceAccountMenu
        user={makeUser()}
        activeMembership={membership}
        onSignOut={onSignOut}
        onSignedOut={onSignedOut}
      />,
    );

    await openMainMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));
    fireEvent.click(await screen.findByRole("button", { name: "Log out" }));

    await waitFor(() => {
      expect(onSignOut).toHaveBeenCalledTimes(1);
      expect(onSignedOut).toHaveBeenCalledTimes(1);
    });
  });

  it("cancels logout from the modal without signing out", async () => {
    const onSignOut = vi.fn().mockResolvedValue(undefined);

    render(<WorkspaceAccountMenu user={makeUser()} activeMembership={membership} onSignOut={onSignOut} />);

    await openMainMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    expect(onSignOut).not.toHaveBeenCalled();
  });

  it("dismisses the logout dialog when clicking outside it", async () => {
    const onSignOut = vi.fn().mockResolvedValue(undefined);

    render(<WorkspaceAccountMenu user={makeUser()} activeMembership={membership} onSignOut={onSignOut} />);

    await openMainMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));
    await screen.findByRole("dialog");

    const overlay = document.querySelector("[data-state='open'].bg-black\\/62") as HTMLElement | null;
    expect(overlay).not.toBeNull();

    if (overlay) {
      fireEvent.pointerDown(overlay);
      fireEvent.click(overlay);
    }

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    expect(onSignOut).not.toHaveBeenCalled();
  });
});
