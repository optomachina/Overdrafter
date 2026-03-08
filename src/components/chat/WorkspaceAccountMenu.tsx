import { useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  ArrowUpRight,
  Box,
  Bug,
  ChevronRight,
  CircleHelp,
  Command,
  Download,
  FilePenLine,
  FileText,
  Folder,
  LogOut,
  Loader2,
  Settings,
  Trash2,
  Undo2,
} from "lucide-react";
import { LogoutConfirmDialog } from "@/components/auth/LogoutConfirmDialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import type { AppMembership, ArchivedJobSummary, ArchivedProjectSummary } from "@/features/quotes/types";
import { getAccountDisplayProfile } from "@/lib/account-profile";
import { setDiagnosticsEnabled, setDiagnosticsPanelOpen } from "@/lib/diagnostics";
import { cn } from "@/lib/utils";

type WorkspaceAccountMenuProps = {
  user: User;
  activeMembership?: AppMembership | null;
  onSignOut: () => Promise<void> | void;
  onSignedOut?: () => void;
  archivedProjects?: ArchivedProjectSummary[];
  archivedJobs?: ArchivedJobSummary[];
  isArchiveLoading?: boolean;
  onUnarchivePart?: (jobId: string) => Promise<void> | void;
  onDeleteArchivedPart?: (jobId: string) => Promise<void> | void;
};

type AccountPanelId =
  | "settings"
  | "archive"
  | "help-center"
  | "release-notes"
  | "terms-policies"
  | "download-apps"
  | "keyboard-shortcuts";

type HelpItem = {
  id: AccountPanelId | "report-bug";
  label: string;
  icon: LucideIcon;
  description: string;
};

type ShortcutRow = {
  keys: string[];
  description: string;
};

type ReleaseNote = {
  dateLabel: string;
  title: string;
  bullets: string[];
};

const MENU_CONTENT_CLASS =
  "chatgpt-shell z-[70] w-[var(--radix-dropdown-menu-trigger-width)] min-w-0 box-border rounded-[30px] border border-white/[0.08] bg-[#2a2a2a] p-2.5 text-white shadow-[0_28px_80px_rgba(0,0,0,0.45)]";
const SUBMENU_CONTENT_CLASS =
  "chatgpt-shell z-[71] w-[320px] rounded-[30px] border border-white/[0.08] bg-[#2a2a2a] p-2.5 text-white shadow-[0_28px_80px_rgba(0,0,0,0.45)]";
const MENU_ITEM_CLASS =
  "gap-3.5 rounded-[20px] px-4 py-3 text-[15px] font-normal leading-6 text-white/[0.96] focus:bg-white/[0.08] focus:text-white";
const MENU_ICON_CLASS = "h-[22px] w-[22px] shrink-0 text-white/[0.92]";
const PANEL_SHEET_CLASS =
  "chatgpt-shell w-[min(100vw,30rem)] border-l border-white/[0.08] bg-[#2a2a2a] p-0 text-white sm:max-w-[30rem] [&>button]:right-5 [&>button]:top-5 [&>button]:rounded-full [&>button]:bg-white/[0.06] [&>button]:p-2 [&>button]:text-white/72 [&>button]:hover:bg-white/[0.1] [&>button]:hover:text-white";
const PANEL_CARD_CLASS = "rounded-[22px] border border-white/[0.08] bg-black/20 p-4";

type ArchiveListItem =
  | {
      kind: "project";
      archivedAt: string | null;
      id: string;
      project: ArchivedProjectSummary;
    }
  | {
      kind: "part";
      archivedAt: string | null;
      id: string;
      job: ArchivedJobSummary;
    };

const HELP_ITEMS: HelpItem[] = [
  {
    id: "help-center",
    label: "Help center",
    icon: CircleHelp,
    description: "Entry point for the support surfaces in this workspace.",
  },
  {
    id: "release-notes",
    label: "Release notes",
    icon: FilePenLine,
    description: "Recent product changes for the client workspace.",
  },
  {
    id: "terms-policies",
    label: "Terms & policies",
    icon: FileText,
    description: "First-pass legal and policy placeholders for the app.",
  },
  {
    id: "report-bug",
    label: "Report a bug",
    icon: Bug,
    description: "Open diagnostics so you can copy a structured bug report.",
  },
  {
    id: "download-apps",
    label: "Download apps",
    icon: Download,
    description: "Surface current availability for web and future native clients.",
  },
  {
    id: "keyboard-shortcuts",
    label: "Keyboard shortcuts",
    icon: Command,
    description: "Show the shortcuts already implemented in the app.",
  },
];

const SHORTCUT_ROWS: ShortcutRow[] = [
  {
    keys: ["Enter"],
    description: "Send the prompt from the workspace composer.",
  },
  {
    keys: ["Shift", "Enter"],
    description: "Insert a newline in the workspace composer.",
  },
  {
    keys: ["Ctrl/Cmd", "B"],
    description: "Toggle the sidebar when the sidebar component is mounted.",
  },
  {
    keys: ["Ctrl/Cmd", "Shift", "D"],
    description: "Open the diagnostics panel and troubleshooting console.",
  },
];

const RELEASE_NOTES: ReleaseNote[] = [
  {
    dateLabel: "March 7, 2026",
    title: "Workspace account menu refresh",
    bullets: [
      "Replaced the footer email block with a ChatGPT-style account entry.",
      "Added a Help submenu, settings panel, and shortcut reference surfaces.",
      "Moved sign-out into the account menu instead of a dedicated footer button.",
    ],
  },
  {
    dateLabel: "March 6, 2026",
    title: "Client workspace collaboration",
    bullets: [
      "Added shared projects, project members, and shared-invite flows.",
      "Added part search and improved pinned items in the client sidebar.",
      "Expanded diagnostics capture for easier bug reporting and support triage.",
    ],
  },
];

function formatProviderLabel(user: User): string {
  const provider =
    typeof user.app_metadata?.provider === "string"
      ? user.app_metadata.provider
      : typeof user.identities?.[0]?.provider === "string"
        ? user.identities[0].provider
        : "email";

  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function openDiagnosticsPanel() {
  setDiagnosticsEnabled(true);
  setDiagnosticsPanelOpen(true);
}

function getRoleLabel(role: AppMembership["role"] | null | undefined): string {
  switch (role) {
    case "internal_admin":
      return "Admin";
    case "internal_estimator":
      return "Estimator";
    case "client":
    default:
      return "Client";
  }
}

function PanelSectionTitle({ children }: { children: string }) {
  return <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/38">{children}</p>;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <dt className="text-sm text-white/55">{label}</dt>
      <dd className="max-w-[60%] text-right text-sm font-medium text-white">{value}</dd>
    </div>
  );
}

function HelpCenterButton({
  icon: Icon,
  label,
  description,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-[20px] border border-white/[0.08] bg-white/[0.02] px-4 py-4 text-left transition hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
      onClick={onClick}
    >
      <Icon className="h-5 w-5 shrink-0 text-white/[0.92]" strokeWidth={1.85} />
      <div className="min-w-0 flex-1">
        <p className="text-[16px] leading-6 text-white">{label}</p>
        <p className="mt-1 text-sm leading-5 text-white/52">{description}</p>
      </div>
      <ChevronRight className="h-5 w-5 shrink-0 text-white/40" />
    </button>
  );
}

function ShortcutKeys({ keys }: { keys: string[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {keys.map((key) => (
        <kbd
          key={key}
          className="rounded-[10px] border border-white/[0.08] bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-white/88"
        >
          {key}
        </kbd>
      ))}
    </div>
  );
}

function formatArchivedAt(value: string | null) {
  if (!value) {
    return "Archived recently";
  }

  return `Archived ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value))}`;
}

export function WorkspaceAccountMenu({
  user,
  activeMembership = null,
  onSignOut,
  onSignedOut,
  archivedProjects = [],
  archivedJobs = [],
  isArchiveLoading = false,
  onUnarchivePart,
  onDeleteArchivedPart,
}: WorkspaceAccountMenuProps) {
  const profile = getAccountDisplayProfile(user);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<AccountPanelId | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutDialogOpen, setSignOutDialogOpen] = useState(false);
  const [pendingUnarchiveJobIds, setPendingUnarchiveJobIds] = useState<string[]>([]);
  const [pendingDeleteJobIds, setPendingDeleteJobIds] = useState<string[]>([]);
  const [jobPendingDeleteConfirmation, setJobPendingDeleteConfirmation] = useState<ArchivedJobSummary | null>(null);
  const roleLabel = getRoleLabel(activeMembership?.role);
  const archiveItems = useMemo<ArchiveListItem[]>(
    () =>
      [
        ...archivedProjects.map((project) => ({
          kind: "project" as const,
          archivedAt: project.project.archived_at,
          id: project.project.id,
          project,
        })),
        ...archivedJobs.map((job) => ({
          kind: "part" as const,
          archivedAt: job.job.archived_at,
          id: job.job.id,
          job,
        })),
      ].sort((left, right) => {
        const leftTime = left.archivedAt ? new Date(left.archivedAt).getTime() : 0;
        const rightTime = right.archivedAt ? new Date(right.archivedAt).getTime() : 0;

        if (rightTime !== leftTime) {
          return rightTime - leftTime;
        }

        if (left.kind !== right.kind) {
          return left.kind.localeCompare(right.kind);
        }

        return left.id.localeCompare(right.id);
      }),
    [archivedJobs, archivedProjects],
  );

  const openPanel = (panelId: AccountPanelId) => {
    setMenuOpen(false);
    setActivePanel(panelId);
  };

  const handleHelpAction = (panelId: HelpItem["id"]) => {
    if (panelId === "report-bug") {
      setMenuOpen(false);
      openDiagnosticsPanel();
      return;
    }

    openPanel(panelId);
  };

  const handleSignOut = async () => {
    setIsSigningOut(true);

    try {
      await onSignOut();
      setSignOutDialogOpen(false);
      onSignedOut?.();
    } finally {
      setIsSigningOut(false);
    }
  };

  const handleUnarchivePart = async (jobId: string) => {
    if (!onUnarchivePart) {
      return;
    }

    setPendingUnarchiveJobIds((current) => (current.includes(jobId) ? current : [...current, jobId]));

    try {
      await onUnarchivePart(jobId);
    } finally {
      setPendingUnarchiveJobIds((current) => current.filter((id) => id !== jobId));
    }
  };

  const handleDeleteArchivedPart = async (jobId: string) => {
    if (!onDeleteArchivedPart) {
      return;
    }

    setPendingDeleteJobIds((current) => (current.includes(jobId) ? current : [...current, jobId]));

    try {
      await onDeleteArchivedPart(jobId);
      setJobPendingDeleteConfirmation((current) => (current?.job.id === jobId ? null : current));
    } finally {
      setPendingDeleteJobIds((current) => current.filter((id) => id !== jobId));
    }
  };

  const renderPanelBody = () => {
    switch (activePanel) {
      case "settings":
        return (
          <div className="space-y-6">
            <div className={PANEL_CARD_CLASS}>
              <PanelSectionTitle>Account</PanelSectionTitle>
              <div className="mt-4 flex items-center gap-4">
                <Avatar className="h-12 w-12">
                  <AvatarFallback className="bg-[#10a37f] text-[18px] font-medium text-white">
                    {profile.initials}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="truncate text-[20px] font-medium tracking-[-0.01em] text-white">{profile.displayName}</p>
                  <p className="truncate text-sm text-white/52">{user.email ?? "No email available"}</p>
                </div>
              </div>
            </div>

            <div className={PANEL_CARD_CLASS}>
              <PanelSectionTitle>Details</PanelSectionTitle>
              <dl className="mt-3 divide-y divide-white/[0.08]">
                <DetailRow label="Email" value={user.email ?? "Unavailable"} />
                <DetailRow label="Sign-in method" value={formatProviderLabel(user)} />
                <DetailRow
                  label="Organization"
                  value={activeMembership?.organizationName ?? "Personal workspace"}
                />
                <DetailRow label="Role" value={roleLabel} />
              </dl>
            </div>

            <div className={PANEL_CARD_CLASS}>
              <PanelSectionTitle>Support</PanelSectionTitle>
              <div className="mt-4 space-y-3">
                <HelpCenterButton
                  icon={CircleHelp}
                  label="Help center"
                  description="Browse the support sections available from the account menu."
                  onClick={() => setActivePanel("help-center")}
                />
                <HelpCenterButton
                  icon={Bug}
                  label="Report a bug"
                  description="Open diagnostics and copy a structured report for support."
                  onClick={openDiagnosticsPanel}
                />
              </div>
            </div>
          </div>
        );
      case "help-center":
        return (
          <div className="space-y-4">
            <div className={PANEL_CARD_CLASS}>
              <p className="text-sm leading-6 text-white/62">
                Use these support surfaces to check recent changes, review shortcuts, capture diagnostics, or stage
                policy content for production copy later.
              </p>
            </div>
            {HELP_ITEMS.map((item) => (
              <HelpCenterButton
                key={item.id}
                icon={item.icon}
                label={item.label}
                description={item.description}
                onClick={() => handleHelpAction(item.id)}
              />
            ))}
          </div>
        );
      case "archive":
        return (
          <div className="space-y-3">
            {isArchiveLoading ? (
              <div className={PANEL_CARD_CLASS}>
                <p className="text-sm leading-6 text-white/58">Loading archived items...</p>
              </div>
            ) : archiveItems.length === 0 ? (
              <div className={PANEL_CARD_CLASS}>
                <p className="text-sm leading-6 text-white/58">No archived items yet.</p>
              </div>
            ) : (
              archiveItems.map((item) => {
                if (item.kind === "project") {
                  return (
                    <div key={`project-${item.project.project.id}`} className={cn(PANEL_CARD_CLASS, "group/item")}>
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex min-w-0 items-start gap-3">
                          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.04]">
                            <Folder className="h-[18px] w-[18px] text-white/80" strokeWidth={1.9} />
                          </span>
                          <div className="min-w-0">
                            <h3 className="truncate text-[17px] font-medium text-white">{item.project.project.name}</h3>
                            <p className="mt-1 text-sm text-white/52">{formatArchivedAt(item.project.project.archived_at)}</p>
                          </div>
                        </div>
                        <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1 text-xs font-medium text-white/70">
                          {item.project.partCount} {item.project.partCount === 1 ? "part" : "parts"}
                        </span>
                      </div>
                    </div>
                  );
                }

                const presentation = getClientItemPresentation(item.job.job, item.job.summary ?? undefined);
                const isUnarchivePending = pendingUnarchiveJobIds.includes(item.job.job.id);
                const isDeletePending = pendingDeleteJobIds.includes(item.job.job.id);
                const isBusy = isUnarchivePending || isDeletePending;

                return (
                  <div
                    key={`part-${item.job.job.id}`}
                    data-testid={`archived-part-card-${item.job.job.id}`}
                    className={cn(PANEL_CARD_CLASS, "group/item min-w-0 overflow-hidden")}
                  >
                    <div className="relative flex min-w-0 items-start gap-4">
                      <div className="flex min-w-0 items-start gap-3 pr-0 sm:pr-[13.5rem]">
                        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.04]">
                          <Box className="h-[18px] w-[18px] text-white/80" strokeWidth={1.9} />
                        </span>
                        <div className="min-w-0">
                          <h3 className="truncate text-[17px] font-medium text-white">{presentation.title}</h3>
                          <p className="mt-1 text-sm text-white/52">{formatArchivedAt(item.job.job.archived_at)}</p>
                          {item.job.projectNames.length > 0 ? (
                            <p className="mt-3 truncate text-sm text-white/62">{item.job.projectNames.join(" · ")}</p>
                          ) : null}
                        </div>
                      </div>

                      <div
                        data-testid={`archived-part-actions-${item.job.job.id}`}
                        className="pointer-events-none absolute right-0 top-0 flex max-w-full items-center gap-2 pl-4 opacity-0 transition group-hover/item:pointer-events-auto group-hover/item:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
                      >
                        {onUnarchivePart ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={isBusy}
                            className="h-9 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 text-white/78 hover:bg-white/[0.08] hover:text-white"
                            onClick={() => void handleUnarchivePart(item.job.job.id)}
                          >
                            {isUnarchivePending ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <>
                                <Undo2 className="mr-2 h-4 w-4" />
                                Unarchive
                              </>
                            )}
                          </Button>
                        ) : null}

                        {onDeleteArchivedPart ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={isBusy}
                            className="h-9 rounded-full border border-red-500/20 bg-red-500/10 px-3 text-red-100 hover:bg-red-500/18 hover:text-white"
                            onClick={() => setJobPendingDeleteConfirmation(item.job)}
                          >
                            {isDeletePending ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <>
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </>
                            )}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        );
      case "release-notes":
        return (
          <div className="space-y-4">
            {RELEASE_NOTES.map((note) => (
              <article key={note.title} className={PANEL_CARD_CLASS}>
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/40">{note.dateLabel}</p>
                <h3 className="mt-3 text-[18px] font-medium tracking-[-0.01em] text-white">{note.title}</h3>
                <ul className="mt-4 space-y-2 text-sm leading-6 text-white/65">
                  {note.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        );
      case "terms-policies":
        return (
          <div className="space-y-4">
            <div className={PANEL_CARD_CLASS}>
              <PanelSectionTitle>Current status</PanelSectionTitle>
              <p className="mt-4 text-sm leading-6 text-white/62">
                These are first-pass placeholders. Replace this copy with finalized Terms of Service, Privacy Policy,
                and related production links when they are ready.
              </p>
            </div>
            <div className={PANEL_CARD_CLASS}>
              <h3 className="text-[17px] font-medium text-white">Terms of Service</h3>
              <p className="mt-2 text-sm leading-6 text-white/58">
                Intended to cover acceptable use, quoting workflow expectations, and account responsibilities.
              </p>
            </div>
            <div className={PANEL_CARD_CLASS}>
              <h3 className="text-[17px] font-medium text-white">Privacy Policy</h3>
              <p className="mt-2 text-sm leading-6 text-white/58">
                Intended to document file handling, account metadata usage, and support diagnostics retention.
              </p>
            </div>
            <div className={PANEL_CARD_CLASS}>
              <h3 className="text-[17px] font-medium text-white">Security & data handling</h3>
              <p className="mt-2 text-sm leading-6 text-white/58">
                Intended to summarize storage, vendor quoting handoff, and internal access controls.
              </p>
            </div>
          </div>
        );
      case "download-apps":
        return (
          <div className="space-y-4">
            <div className={PANEL_CARD_CLASS}>
              <h3 className="text-[18px] font-medium text-white">Current availability</h3>
              <p className="mt-2 text-sm leading-6 text-white/60">
                The browser workspace is available now. Native client surfaces are staged as placeholders until
                installable builds exist.
              </p>
            </div>
            <div className="grid gap-3">
              <div className={PANEL_CARD_CLASS}>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-[17px] font-medium text-white">Web app</h3>
                    <p className="mt-1 text-sm text-white/58">Use the current browser workspace today.</p>
                  </div>
                  <span className="rounded-full border border-[#10a37f]/30 bg-[#10a37f]/10 px-3 py-1 text-xs font-medium text-[#7be0c0]">
                    Available
                  </span>
                </div>
              </div>
              <div className={PANEL_CARD_CLASS}>
                <h3 className="text-[17px] font-medium text-white">Desktop app</h3>
                <p className="mt-1 text-sm text-white/58">Placeholder for macOS and Windows installers.</p>
              </div>
              <div className={PANEL_CARD_CLASS}>
                <h3 className="text-[17px] font-medium text-white">Mobile apps</h3>
                <p className="mt-1 text-sm text-white/58">Placeholder for iPhone, iPad, and Android builds.</p>
              </div>
            </div>
          </div>
        );
      case "keyboard-shortcuts":
        return (
          <div className="space-y-4">
            {SHORTCUT_ROWS.map((shortcut) => (
              <div key={`${shortcut.keys.join("+")}-${shortcut.description}`} className={PANEL_CARD_CLASS}>
                <ShortcutKeys keys={shortcut.keys} />
                <p className="mt-4 text-sm leading-6 text-white/62">{shortcut.description}</p>
              </div>
            ))}
          </div>
        );
      default:
        return null;
    }
  };

  const panelTitle =
    activePanel === "settings"
      ? "Settings"
      : activePanel === "archive"
        ? "Archive"
      : activePanel === "help-center"
        ? "Help center"
        : activePanel === "release-notes"
          ? "Release notes"
          : activePanel === "terms-policies"
            ? "Terms & policies"
            : activePanel === "download-apps"
              ? "Download apps"
              : activePanel === "keyboard-shortcuts"
                ? "Keyboard shortcuts"
                : "";

  const panelDescription =
    activePanel === "settings"
      ? "Account details and support entry points for the current workspace."
      : activePanel === "archive"
        ? "Archived projects and parts are listed here for reference."
      : activePanel === "help-center"
        ? "Browse support sections available from the account menu."
        : activePanel === "release-notes"
          ? "Recent updates relevant to the client workspace."
          : activePanel === "terms-policies"
            ? "Placeholder legal and policy content ready for production copy."
            : activePanel === "download-apps"
              ? "Current app availability and placeholders for future installs."
              : activePanel === "keyboard-shortcuts"
                ? "Shortcuts already implemented in this workspace."
                : "";

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Open account menu"
            disabled={isSigningOut}
            className={cn(
              "chatgpt-shell group/account flex w-full items-center gap-3 rounded-[24px] px-3 py-2.5 text-left text-white transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 disabled:cursor-not-allowed disabled:opacity-60",
              menuOpen ? "bg-white/[0.06]" : "bg-transparent hover:bg-white/[0.06] focus-visible:bg-white/[0.06]",
            )}
          >
            <Avatar className="h-11 w-11 shrink-0">
              <AvatarFallback className="bg-[#10a37f] text-[18px] font-medium text-white">
                {profile.initials}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-medium leading-5 tracking-[-0.01em] text-white/[0.96]">
                {profile.displayName}
              </p>
              <p className="truncate text-[13px] leading-5 text-white/48">
                {roleLabel}
                {"\u00A0\u00A0"}
                v{__APP_VERSION__}
              </p>
            </div>
            <div
              className={cn(
                "pointer-events-none hidden h-8 w-8 items-center justify-center rounded-full bg-white/[0.08] text-white/72 transition group-hover/account:flex group-focus-visible/account:flex md:flex",
                menuOpen ? "opacity-100" : "md:opacity-0 md:group-hover/account:opacity-100 md:group-focus-visible/account:opacity-100",
              )}
            >
              <ChevronRight className="h-4 w-4" />
            </div>
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={12}
          collisionPadding={16}
          className={MENU_CONTENT_CLASS}
        >
          <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => openPanel("settings")}>
            <Settings className={MENU_ICON_CLASS} strokeWidth={1.85} />
            <span>Settings</span>
          </DropdownMenuItem>

          <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => openPanel("archive")}>
            <Archive className={MENU_ICON_CLASS} strokeWidth={1.85} />
            <span>Archive</span>
          </DropdownMenuItem>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={cn(MENU_ITEM_CLASS, "data-[state=open]:bg-white/[0.08]")}>
              <CircleHelp className={MENU_ICON_CLASS} strokeWidth={1.85} />
              <span>Help</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              sideOffset={10}
              collisionPadding={16}
              className={SUBMENU_CONTENT_CLASS}
            >
              {HELP_ITEMS.map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  className={MENU_ITEM_CLASS}
                  onSelect={() => handleHelpAction(item.id)}
                >
                  <item.icon className={MENU_ICON_CLASS} strokeWidth={1.85} />
                  <span>{item.label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuItem
            className={MENU_ITEM_CLASS}
            onSelect={() => {
              setMenuOpen(false);
              setSignOutDialogOpen(true);
            }}
          >
            <LogOut className={MENU_ICON_CLASS} strokeWidth={1.85} />
            <span>Log out</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <LogoutConfirmDialog
        open={signOutDialogOpen}
        onOpenChange={(open) => {
          if (!isSigningOut) {
            setSignOutDialogOpen(open);
          }
        }}
        onConfirm={handleSignOut}
        emailAddress={user.email}
        isPending={isSigningOut}
      />

      <Sheet open={activePanel !== null} onOpenChange={(open) => (!open ? setActivePanel(null) : undefined)}>
        <SheetContent side="right" className={PANEL_SHEET_CLASS}>
          <div className="flex h-full flex-col">
            <SheetHeader className="border-b border-white/[0.08] px-6 py-6">
              <SheetTitle className="pr-12 text-[28px] font-medium tracking-[-0.02em] text-white">
                {panelTitle}
              </SheetTitle>
              <SheetDescription className="max-w-[28rem] pr-12 text-sm leading-6 text-white/52">
                {panelDescription}
              </SheetDescription>
            </SheetHeader>

            <ScrollArea className="flex-1">
              <div className="space-y-4 px-6 py-6">{renderPanelBody()}</div>
            </ScrollArea>

            {activePanel && activePanel !== "settings" ? (
              <div className="border-t border-white/[0.08] px-6 py-4">
                <Button
                  type="button"
                  variant="ghost"
                  className="h-10 rounded-full border border-white/[0.08] bg-transparent px-4 text-white/80 hover:bg-white/[0.06] hover:text-white"
                  onClick={() => setActivePanel("help-center")}
                >
                  <ArrowUpRight className="mr-2 h-4 w-4" />
                  Back to Help center
                </Button>
              </div>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={Boolean(jobPendingDeleteConfirmation)}
        onOpenChange={(open) => {
          if (!open && !jobPendingDeleteConfirmation) {
            return;
          }

          if (!pendingDeleteJobIds.includes(jobPendingDeleteConfirmation?.job.id ?? "")) {
            setJobPendingDeleteConfirmation(open ? jobPendingDeleteConfirmation : null);
          }
        }}
      >
        <AlertDialogContent className="chatgpt-shell border-white/[0.08] bg-[#2a2a2a] text-white">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete archived part?</AlertDialogTitle>
            <AlertDialogDescription className="text-white/55">
              {jobPendingDeleteConfirmation
                ? `Delete ${getClientItemPresentation(jobPendingDeleteConfirmation.job, jobPendingDeleteConfirmation.summary ?? undefined).title} permanently. This cannot be undone.`
                : "Delete this archived part permanently. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/[0.08] bg-transparent text-white hover:bg-white/[0.06] hover:text-white">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-500"
              disabled={
                !jobPendingDeleteConfirmation ||
                pendingDeleteJobIds.includes(jobPendingDeleteConfirmation.job.id)
              }
              onClick={(event) => {
                if (!jobPendingDeleteConfirmation) {
                  event.preventDefault();
                  return;
                }

                event.preventDefault();
                void handleDeleteArchivedPart(jobPendingDeleteConfirmation.job.id);
              }}
            >
              {jobPendingDeleteConfirmation &&
              pendingDeleteJobIds.includes(jobPendingDeleteConfirmation.job.id) ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
