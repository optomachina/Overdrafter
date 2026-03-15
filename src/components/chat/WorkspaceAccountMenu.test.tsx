import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";
import type { WorkspaceNotificationsController } from "@/features/notifications/use-workspace-notifications";
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
      requested_service_kinds: ["manufacturing_quote"],
      primary_service_kind: "manufacturing_quote",
      service_notes: null,
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

const archivedJobsWithSecondEntry: ArchivedJobSummary[] = [
  ...archivedJobs,
  {
    job: {
      ...archivedJobs[0].job,
      id: "job-2",
      title: "Archived Part Two",
      archived_at: "2026-03-07T12:00:00.000Z",
      created_at: "2026-03-05T00:00:00.000Z",
      updated_at: "2026-03-07T12:00:00.000Z",
    },
    summary: null,
    projectNames: [],
  },
];

function ArchiveMenuStatefulHarness({
  initialJobs,
  rejectDelete = false,
}: {
  initialJobs: ArchivedJobSummary[];
  rejectDelete?: boolean;
}) {
  const [jobs, setJobs] = useState(initialJobs);

  return (
    <WorkspaceAccountMenu
      user={makeUser()}
      activeMembership={membership}
      onSignOut={vi.fn()}
      archivedProjects={archivedProjects}
      archivedJobs={jobs}
      onUnarchivePart={async (jobId) => {
        setJobs((current) => current.filter((entry) => entry.job.id !== jobId));
      }}
      onDeleteArchivedParts={async (jobIds) => {
        if (rejectDelete) {
          throw new Error("Delete failed.");
        }

        setJobs((current) => current.filter((entry) => !jobIds.includes(entry.job.id)));
      }}
    />
  );
}

function makeNotificationCenter(
  overrides: Partial<WorkspaceNotificationsController> = {},
): WorkspaceNotificationsController {
  return {
    allItems: [
      {
        id: "client.quote_package_ready:package-1",
        sourceEventId: "event-1",
        notificationType: "client.quote_package_ready",
        occurredAt: "2026-03-13T12:00:00.000Z",
        jobId: "job-1",
        packageId: "package-1",
        title: "Quote package ready",
        detail: "Curated quote options are available for review in this workspace.",
        tone: "active",
        isSeen: false,
      },
    ],
    browserPermission: "default",
    isLoading: false,
    isRequestingPermission: false,
    items: [
      {
        id: "client.quote_package_ready:package-1",
        sourceEventId: "event-1",
        notificationType: "client.quote_package_ready",
        occurredAt: "2026-03-13T12:00:00.000Z",
        jobId: "job-1",
        packageId: "package-1",
        title: "Quote package ready",
        detail: "Curated quote options are available for review in this workspace.",
        tone: "active",
        isSeen: false,
      },
    ],
    markAllSeen: vi.fn(),
    requestBrowserPermission: vi.fn().mockResolvedValue(undefined),
    setChannelEnabled: vi.fn(),
    setItemSeen: vi.fn(),
    supportedTypes: ["client.quote_package_ready"],
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
    unseenCount: 1,
    ...overrides,
  };
}

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

  it("shows the resolved full name, current role with version, and footer-sized avatar without the email", () => {
    render(<WorkspaceAccountMenu user={makeUser()} activeMembership={membership} onSignOut={vi.fn()} />);

    expect(screen.getByText("Blaine Wilson")).toBeInTheDocument();
    expect(screen.getByText(/Client\s+v0\.0\.1/)).toBeInTheDocument();
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
    const onUnarchivePart = vi.fn();
    const onDeleteArchivedParts = vi.fn();
    render(
      <WorkspaceAccountMenu
        user={makeUser()}
        activeMembership={membership}
        onSignOut={vi.fn()}
        archivedProjects={archivedProjects}
        archivedJobs={archivedJobs}
        onUnarchivePart={onUnarchivePart}
        onDeleteArchivedParts={onDeleteArchivedParts}
      />,
    );

    await openMainMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));

    const projectHeading = await screen.findByRole("heading", { name: "Archived Project" });
    const partHeading = screen.getByRole("heading", { name: "Archived Part" });
    const partCard = screen.getByTestId("archived-part-card-job-1");
    const partActions = screen.getByTestId("archived-part-actions-job-1");
    const footerActions = screen.getByTestId("archive-footer-actions");
    expect(screen.queryByRole("tab", { name: "Projects" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Parts" })).not.toBeInTheDocument();

    expect(partHeading.compareDocumentPosition(projectHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector(".lucide-folder")).not.toBeNull();
    expect(document.querySelector(".lucide-box")).not.toBeNull();
    expect(partCard).toHaveClass("min-w-0", "overflow-hidden");
    expect(partActions).toHaveClass("absolute", "right-0", "top-0", "opacity-0");
    expect(footerActions).toHaveClass("sm:flex-row", "sm:justify-between");
    expect(screen.getByRole("button", { name: "Unarchive" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(within(footerActions).getByRole("button", { name: "Back to Help center" })).toBeInTheDocument();
    expect(within(footerActions).getByRole("button", { name: "Delete all" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Unarchive" }));
    await waitFor(() => {
      expect(onUnarchivePart).toHaveBeenCalledWith("job-1");
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete archived part?")).toBeInTheDocument();
    expect(onDeleteArchivedParts).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(onDeleteArchivedParts).toHaveBeenCalledWith(["job-1"]);
    });
  });

  it("keeps archived part actions hidden until hover or button focus styles apply", async () => {
    render(
      <WorkspaceAccountMenu
        user={makeUser()}
        activeMembership={membership}
        onSignOut={vi.fn()}
        archivedProjects={archivedProjects}
        archivedJobs={archivedJobs}
        onUnarchivePart={vi.fn()}
        onDeleteArchivedParts={vi.fn()}
      />,
    );

    await openMainMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));

    const partActions = await screen.findByTestId("archived-part-actions-job-1");
    expect(screen.getByRole("button", { name: "Unarchive" })).not.toHaveFocus();
    expect(partActions).toHaveClass("opacity-0", "group-hover/item:opacity-100", "focus-within:opacity-100");
    expect(partActions).not.toHaveClass("pointer-events-none");
    expect(partActions).not.toHaveClass("group-focus-within/item:opacity-100");
  });

  it("refreshes the archive list after unarchiving and deleting parts", async () => {
    render(<ArchiveMenuStatefulHarness initialJobs={archivedJobsWithSecondEntry} />);

    await openMainMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));

    fireEvent.click(within(await screen.findByTestId("archived-part-card-job-1")).getByRole("button", { name: "Unarchive" }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Archived Part" })).not.toBeInTheDocument();
    });

    fireEvent.click(within(screen.getByTestId("archived-part-card-job-2")).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Archived Part Two" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Delete all" })).toBeDisabled();
    });
  });

  it("deletes all archived parts after confirmation", async () => {
    render(<ArchiveMenuStatefulHarness initialJobs={archivedJobsWithSecondEntry} />);

    await openMainMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete all" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete all archived parts?")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete all" }));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Archived Part" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Archived Part Two" })).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Archived Project" })).toBeInTheDocument();
      expect(screen.queryByText("No archived items yet.")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Delete all" })).toBeDisabled();
    });
  });

  it("cancels delete all without mutating the archive list", async () => {
    render(<ArchiveMenuStatefulHarness initialJobs={archivedJobsWithSecondEntry} />);

    await openMainMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete all" }));

    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    expect(screen.getByRole("heading", { name: "Archived Part" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Archived Part Two" })).toBeInTheDocument();
  });

  it("keeps delete failures handled inside the archive menu", async () => {
    const unhandledRejectionListener = vi.fn();
    window.addEventListener("unhandledrejection", unhandledRejectionListener);
    try {
      render(<ArchiveMenuStatefulHarness initialJobs={archivedJobs} rejectDelete />);

      await openMainMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

      const dialog = await screen.findByRole("alertdialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

      await waitFor(() => {
        expect(screen.getByRole("alertdialog")).toBeInTheDocument();
      });

      await waitFor(() => {
        expect(unhandledRejectionListener).not.toHaveBeenCalled();
      });
    } finally {
      window.removeEventListener("unhandledrejection", unhandledRejectionListener);
    }
  });

  it("shows archive empty states", async () => {
    render(
      <WorkspaceAccountMenu
        user={makeUser()}
        activeMembership={membership}
        onSignOut={vi.fn()}
        onDeleteArchivedParts={vi.fn()}
      />,
    );

    await openMainMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));

    expect(await screen.findByText("No archived items yet.")).toBeInTheDocument();
    expect(screen.queryByText("0 archived parts")).not.toBeInTheDocument();
    expect(screen.getByTestId("archive-footer-actions")).toContainElement(
      screen.getByRole("button", { name: "Delete all" }),
    );
    expect(screen.getByRole("button", { name: "Delete all" })).toBeDisabled();
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

  it("opens the notifications panel and marks current items seen", async () => {
    const notificationCenter = makeNotificationCenter();
    render(
      <WorkspaceAccountMenu
        user={makeUser()}
        activeMembership={membership}
        notificationCenter={notificationCenter}
        onSignOut={vi.fn()}
      />,
    );

    await openMainMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /notifications/i }));

    expect(await screen.findByText("Browser permission")).toBeInTheDocument();
    expect(screen.getAllByText("Quote package ready").length).toBeGreaterThan(0);
    expect(notificationCenter.markAllSeen).toHaveBeenCalledTimes(1);
  });

  it("requests browser permission and updates notification preferences from the panel", async () => {
    const notificationCenter = makeNotificationCenter();
    render(
      <WorkspaceAccountMenu
        user={makeUser()}
        activeMembership={membership}
        notificationCenter={notificationCenter}
        onSignOut={vi.fn()}
      />,
    );

    await openMainMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /notifications/i }));

    fireEvent.click(await screen.findByRole("button", { name: /allow browser notifications/i }));
    await waitFor(() => {
      expect(notificationCenter.requestBrowserPermission).toHaveBeenCalledTimes(1);
    });

    const inAppSwitch = screen.getByRole("switch", { name: "Quote package ready In-app center" });
    fireEvent.click(inAppSwitch);
    expect(notificationCenter.setChannelEnabled).toHaveBeenCalledWith("client.quote_package_ready", "inApp", false);
  });

  it("lets the user toggle seen state for an individual notification", async () => {
    const notificationCenter = makeNotificationCenter({
      allItems: [
        {
          id: "client.quote_package_ready:package-1",
          sourceEventId: "event-1",
          notificationType: "client.quote_package_ready",
          occurredAt: "2026-03-13T12:00:00.000Z",
          jobId: "job-1",
          packageId: "package-1",
          title: "Quote package ready",
          detail: "Curated quote options are available for review in this workspace.",
          tone: "active",
          isSeen: true,
        },
      ],
      items: [
        {
          id: "client.quote_package_ready:package-1",
          sourceEventId: "event-1",
          notificationType: "client.quote_package_ready",
          occurredAt: "2026-03-13T12:00:00.000Z",
          jobId: "job-1",
          packageId: "package-1",
          title: "Quote package ready",
          detail: "Curated quote options are available for review in this workspace.",
          tone: "active",
          isSeen: true,
        },
      ],
      unseenCount: 0,
    });

    render(
      <WorkspaceAccountMenu
        user={makeUser()}
        activeMembership={membership}
        notificationCenter={notificationCenter}
        onSignOut={vi.fn()}
      />,
    );

    await openMainMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /notifications/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Mark unseen" }));

    expect(notificationCenter.setItemSeen).toHaveBeenCalledWith("client.quote_package_ready:package-1", false);
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
