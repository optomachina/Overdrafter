import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  ArrowUpRight,
  Bell,
  Box,
  Bug,
  ChevronRight,
  CircleHelp,
  Command,
  Download,
  FilePenLine,
  FileText,
  FlaskConical,
  Folder,
  LogOut,
  Loader2,
  ScanSearch,
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
import { Switch } from "@/components/ui/switch";
import {
  WORKSPACE_NOTIFICATION_TYPE_DEFINITIONS,
} from "@/features/notifications/use-workspace-notifications";
import type {
  BrowserNotificationPermissionState,
  WorkspaceNotificationChannel,
  WorkspaceNotificationItem,
  WorkspaceNotificationsController,
  WorkspaceNotificationType,
} from "@/features/notifications/use-workspace-notifications";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import type { AppMembership, ArchivedJobSummary, ArchivedProjectSummary, OrganizationDetails } from "@/features/quotes/types";
import { fetchOrganizationDetails, updateOrganizationDetails } from "@/features/quotes/api/organizations-api";
import { Input } from "@/components/ui/input";
import { getAccountDisplayProfile } from "@/lib/account-profile";
import { setDiagnosticsEnabled, setDiagnosticsPanelOpen, useDiagnosticsSnapshot } from "@/lib/diagnostics";
import { shouldShowExtractionLauncher } from "@/components/debug/extraction-launcher-visibility";
import { openExtractionLauncher } from "@/components/debug/ExtractionLauncher";
import { openFixturePanel } from "@/components/debug/FixturePanel";
import { isFixtureModeAvailable } from "@/features/quotes/client-workspace-fixtures";
import { cn } from "@/lib/utils";

type WorkspaceAccountMenuProps = {
  user: User;
  activeMembership?: AppMembership | null;
  notificationCenter?: WorkspaceNotificationsController | null;
  onSignOut: () => Promise<void> | void;
  onSignedOut?: () => void;
  archivedProjects?: ArchivedProjectSummary[];
  archivedJobs?: ArchivedJobSummary[];
  isArchiveLoading?: boolean;
  onUnarchivePart?: (jobId: string) => Promise<void> | void;
  onDeleteArchivedParts?: (jobIds: string[]) => Promise<void> | void;
};

type AccountPanelId =
  | "notifications"
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
  "workspace-shell z-[70] w-[var(--radix-dropdown-menu-trigger-width)] min-w-0 box-border rounded-surface-lg border border-white/[0.08] bg-ws-raised p-2.5 text-white shadow-[0_28px_80px_rgba(0,0,0,0.45)]";
const SUBMENU_CONTENT_CLASS =
  "workspace-shell z-[71] w-[320px] rounded-surface-lg border border-white/[0.08] bg-ws-raised p-2.5 text-white shadow-[0_28px_80px_rgba(0,0,0,0.45)]";
const MENU_ITEM_CLASS =
  "gap-3.5 rounded-surface-lg px-4 py-3 text-[15px] font-normal leading-6 text-white/[0.96] focus:bg-white/[0.08] focus:text-white";
const MENU_ICON_CLASS = "h-[22px] w-[22px] shrink-0 text-white/[0.92]";
const PANEL_SHEET_CLASS =
  "workspace-shell w-[min(100vw,30rem)] border-l border-white/[0.08] bg-ws-raised p-0 text-white sm:max-w-[30rem] [&>button]:right-5 [&>button]:top-5 [&>button]:rounded-full [&>button]:bg-white/[0.06] [&>button]:p-2 [&>button]:text-white/72 [&>button]:hover:bg-white/[0.1] [&>button]:hover:text-white";
const PANEL_CARD_CLASS = "rounded-surface-lg border border-white/[0.08] bg-black/20 p-4";
const NOTIFICATION_BADGE_CLASS =
  "rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300";

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

type ArchiveDeleteConfirmationState =
  | {
      kind: "single";
      job: ArchivedJobSummary;
    }
  | {
      kind: "bulk";
      jobs: ArchivedJobSummary[];
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
      className="flex w-full items-center gap-3 rounded-surface-lg border border-white/[0.08] bg-white/[0.02] px-4 py-4 text-left transition hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
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
          className="rounded border border-white/[0.08] bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-white/88"
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

function formatNotificationTimestamp(value: string) {
  const date = new Date(value);
  const now = new Date();
  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  return new Intl.DateTimeFormat("en-US", {
    month: isSameDay ? undefined : "short",
    day: isSameDay ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function getNotificationToneClasses(tone: WorkspaceNotificationItem["tone"]) {
  switch (tone) {
    case "attention":
      return "border-amber-400/25 bg-amber-500/10 text-amber-100";
    case "active":
      return "border-emerald-500/30 bg-emerald-500/12 text-emerald-200";
    case "default":
    default:
      return "border-white/[0.08] bg-white/[0.06] text-white/72";
  }
}

function getBrowserPermissionLabel(permission: BrowserNotificationPermissionState) {
  switch (permission) {
    case "granted":
      return "Allowed";
    case "denied":
      return "Blocked";
    case "default":
      return "Not requested";
    case "unsupported":
    default:
      return "Unavailable";
  }
}

function getBrowserPermissionDescription(permission: BrowserNotificationPermissionState) {
  switch (permission) {
    case "granted":
      return "This browser can receive notification deliveries when a channel is opted in below.";
    case "denied":
      return "Browser notifications are blocked for this site. Re-enable them in browser site settings.";
    case "default":
      return "Request browser permission here, then opt individual notification types into browser delivery.";
    case "unsupported":
    default:
      return "This browser environment does not expose the Notification API.";
  }
}

export function WorkspaceAccountMenu({
  user,
  activeMembership = null,
  notificationCenter = null,
  onSignOut,
  onSignedOut,
  archivedProjects = [],
  archivedJobs = [],
  isArchiveLoading = false,
  onUnarchivePart,
  onDeleteArchivedParts,
}: WorkspaceAccountMenuProps) {
  const profile = getAccountDisplayProfile(user);
  const panelContentRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<AccountPanelId | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutDialogOpen, setSignOutDialogOpen] = useState(false);
  const [pendingUnarchiveJobIds, setPendingUnarchiveJobIds] = useState<string[]>([]);
  const [pendingDeleteJobIds, setPendingDeleteJobIds] = useState<string[]>([]);
  const [deleteConfirmation, setDeleteConfirmation] = useState<ArchiveDeleteConfirmationState | null>(null);

  // --- Organization details (company/billing/shipping) ---
  const emptyOrgDetails = useCallback(
    (): OrganizationDetails => ({
      id: activeMembership?.organizationId ?? "",
      name: activeMembership?.organizationName ?? "",
      companyName: null,
      logoUrl: null,
      phone: null,
      billingStreet: null,
      billingCity: null,
      billingState: null,
      billingZip: null,
      billingCountry: "US",
      shippingSameAsBilling: true,
      shippingStreet: null,
      shippingCity: null,
      shippingState: null,
      shippingZip: null,
      shippingCountry: "US",
    }),
    [activeMembership?.organizationId, activeMembership?.organizationName],
  );
  const [orgDetails, setOrgDetails] = useState<OrganizationDetails>(emptyOrgDetails);
  const [orgDetailsLoaded, setOrgDetailsLoaded] = useState(false);
  const [orgDetailsDraft, setOrgDetailsDraft] = useState<OrganizationDetails>(emptyOrgDetails);
  const [editingSection, setEditingSection] = useState<"company" | "billing" | "shipping" | null>(null);
  const [isSavingOrg, setIsSavingOrg] = useState(false);
  const [orgSaveError, setOrgSaveError] = useState<string | null>(null);
  const companyNameInputRef = useRef<HTMLInputElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const placesAutocompleteRef = useRef<any>(null);
  const isAdmin = activeMembership?.role === "internal_admin";

  // Fetch org details when settings panel opens
  useEffect(() => {
    if (activePanel !== "settings" || !activeMembership?.organizationId) return;
    let cancelled = false;
    setOrgDetailsLoaded(false);
    setEditingSection(null);
    setOrgSaveError(null);
    fetchOrganizationDetails(activeMembership.organizationId)
      .then((details) => {
        if (!cancelled) {
          setOrgDetails(details);
          setOrgDetailsDraft(details);
          setOrgDetailsLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          const empty = emptyOrgDetails();
          setOrgDetails(empty);
          setOrgDetailsDraft(empty);
          setOrgDetailsLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activePanel, activeMembership?.organizationId, emptyOrgDetails]);

  // Initialize Google Places Autocomplete on company name input when panel is open
  useEffect(() => {
    if (activePanel !== "settings" || !isAdmin) return;
    if (!companyNameInputRef.current) return;

    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;
    if (!apiKey) return;

    // Avoid re-initializing
    if (placesAutocompleteRef.current) return;

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
    script.async = true;
    script.onload = () => {
      if (!companyNameInputRef.current) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const g = (window as any).google;
      const autocomplete = new g.maps.places.Autocomplete(companyNameInputRef.current, {
        types: ["establishment"],
        fields: ["name", "formatted_phone_number", "address_components", "photos"],
      });
      autocomplete.addListener("place_changed", () => {
        const place = autocomplete.getPlace();
        if (!place) return;
        const getComponent = (type: string) =>
          place.address_components?.find((c) => c.types.includes(type))?.long_name ?? null;
        const getShortComponent = (type: string) =>
          place.address_components?.find((c) => c.types.includes(type))?.short_name ?? null;
        const streetNumber = getComponent("street_number") ?? "";
        const route = getComponent("route") ?? "";
        const street = [streetNumber, route].filter(Boolean).join(" ") || null;
        const logoUrl = place.photos?.[0]?.getUrl({ maxWidth: 128, maxHeight: 128 }) ?? null;
        setOrgDetailsDraft((prev) => ({
          ...prev,
          companyName: place.name ?? prev.companyName,
          phone: place.formatted_phone_number ?? prev.phone,
          logoUrl: logoUrl ?? prev.logoUrl,
          billingStreet: street,
          billingCity: getComponent("locality"),
          billingState: getShortComponent("administrative_area_level_1"),
          billingZip: getComponent("postal_code"),
          billingCountry: getShortComponent("country") ?? "US",
        }));
      });
      placesAutocompleteRef.current = autocomplete;
    };
    // Only append if not already on the page
    if (!document.querySelector(`script[src*="maps.googleapis.com"]`)) {
      document.head.appendChild(script);
    } else if (typeof (window as unknown as Record<string, unknown>)["google"] !== "undefined") {
      // Already loaded
      script.onload(new Event("load"));
    }
    return () => {
      placesAutocompleteRef.current = null;
    };
  }, [activePanel, isAdmin]);

  function patchDraft(patch: Partial<OrganizationDetails>) {
    setOrgDetailsDraft((prev) => ({ ...prev, ...patch }));
  }

  function openEdit(section: "company" | "billing" | "shipping") {
    setOrgDetailsDraft({ ...orgDetails });
    setOrgSaveError(null);
    setEditingSection(section);
  }

  function cancelEdit() {
    setOrgDetailsDraft({ ...orgDetails });
    setOrgSaveError(null);
    setEditingSection(null);
  }

  async function handleSaveOrgDetails() {
    if (!activeMembership?.organizationId) return;
    setIsSavingOrg(true);
    setOrgSaveError(null);
    try {
      const { id: _id, name: _name, ...patch } = orgDetailsDraft;
      await updateOrganizationDetails(activeMembership.organizationId, patch);
      setOrgDetails(orgDetailsDraft);
      setEditingSection(null);
    } catch {
      setOrgSaveError("Failed to save. Please try again.");
    } finally {
      setIsSavingOrg(false);
    }
  }

  const roleLabel = getRoleLabel(activeMembership?.role);
  const diagnosticsSnapshot = useDiagnosticsSnapshot();
  const showExtractionLauncher = shouldShowExtractionLauncher({
    membershipRole: activeMembership?.role ?? null,
    diagnosticsEnabled: diagnosticsSnapshot.enabled,
    isDev: import.meta.env.DEV,
  });
  const showFixtures = isFixtureModeAvailable();
  const notifications = notificationCenter ?? {
    allItems: [],
    browserPermission: "unsupported" as const,
    isLoading: false,
    isRequestingPermission: false,
    items: [],
    markAllSeen: () => undefined,
    requestBrowserPermission: async () => undefined,
    setChannelEnabled: () => undefined,
    setItemSeen: () => undefined,
    supportedTypes: [] as WorkspaceNotificationType[],
    typeDefinitions: WORKSPACE_NOTIFICATION_TYPE_DEFINITIONS,
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
  const archivedPartCount = archivedJobs.length;
  const hasPendingDelete = pendingDeleteJobIds.length > 0;
  const bulkDeleteJobIds = deleteConfirmation?.kind === "bulk" ? deleteConfirmation.jobs.map((job) => job.job.id) : [];
  const deleteAllDisabled = isArchiveLoading || archivedPartCount === 0 || hasPendingDelete;

  const openPanel = (panelId: AccountPanelId) => {
    setMenuOpen(false);
    setActivePanel(panelId);

    if (panelId === "notifications") {
      notifications.markAllSeen();
    }
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
    } catch {
      // The caller handles toast/error reporting for menu actions.
    } finally {
      setPendingUnarchiveJobIds((current) => current.filter((id) => id !== jobId));
    }
  };

  const handleDeleteArchivedParts = async (jobIds: string[]) => {
    if (!onDeleteArchivedParts) {
      return;
    }

    const normalizedIds = [...new Set(jobIds)];

    if (normalizedIds.length === 0) {
      return;
    }

    setPendingDeleteJobIds((current) => [...new Set([...current, ...normalizedIds])]);

    try {
      await onDeleteArchivedParts(normalizedIds);
      setDeleteConfirmation(null);
    } catch {
      // The caller handles toast/error reporting for menu actions.
    } finally {
      setPendingDeleteJobIds((current) => current.filter((id) => !normalizedIds.includes(id)));
    }
  };

  const renderPanelBody = () => {
    switch (activePanel) {
      case "notifications":
        return (
          <div className="space-y-4">
            <div className={PANEL_CARD_CLASS}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <PanelSectionTitle>Center status</PanelSectionTitle>
                  <p className="mt-3 text-[20px] font-medium tracking-[-0.01em] text-white">
                    {notifications.unseenCount > 0
                      ? `${notifications.unseenCount} unseen ${notifications.unseenCount === 1 ? "notification" : "notifications"}`
                      : "All caught up"}
                  </p>
                  <p className="mt-2 text-sm leading-6 text-white/58">
                    The first browser slice tracks durable quote-workflow transitions from this workspace and keeps
                    seen state on this browser until server-backed notification records exist.
                  </p>
                </div>
                <span className={NOTIFICATION_BADGE_CLASS}>{notifications.items.length} in center</span>
              </div>
            </div>

            <div className={PANEL_CARD_CLASS}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <PanelSectionTitle>Browser permission</PanelSectionTitle>
                  <p className="mt-3 text-[18px] font-medium text-white">
                    {getBrowserPermissionLabel(notifications.browserPermission)}
                  </p>
                  <p className="mt-2 text-sm leading-6 text-white/58">
                    {getBrowserPermissionDescription(notifications.browserPermission)}
                  </p>
                </div>
                <span className={NOTIFICATION_BADGE_CLASS}>{getBrowserPermissionLabel(notifications.browserPermission)}</span>
              </div>
              {notifications.browserPermission === "default" ? (
                <Button
                  type="button"
                  className="mt-4 rounded-full bg-white text-black hover:bg-white/90"
                  disabled={notifications.isRequestingPermission}
                  onClick={() => {
                    void notifications.requestBrowserPermission().then(() => {
                      if (window.Notification?.permission === "granted") {
                        notifications.supportedTypes.forEach((type) => {
                          notifications.setChannelEnabled(type, "browser", true);
                        });
                      }
                    });
                  }}
                >
                  {notifications.isRequestingPermission ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Requesting permission
                    </>
                  ) : (
                    "Allow browser notifications"
                  )}
                </Button>
              ) : null}
            </div>

            <div className={PANEL_CARD_CLASS}>
              <PanelSectionTitle>Preferences</PanelSectionTitle>
              <div className="mt-4 space-y-3">
                {notifications.supportedTypes.map((notificationType) => {
                  const definition = notifications.typeDefinitions[notificationType];
                  const preference = notifications.typePreferences[notificationType];

                  return (
                    <div
                      key={notificationType}
                      className="rounded border border-white/[0.08] bg-white/[0.03] p-4"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <h3 className="text-[16px] font-medium text-white">{definition.label}</h3>
                          <p className="mt-1 text-sm leading-6 text-white/52">{definition.description}</p>
                        </div>
                      </div>
                      <div className="mt-4 flex flex-col gap-2">
                        {(["inApp", "browser"] as WorkspaceNotificationChannel[]).map((channel) => {
                          const channelLabel = channel === "inApp" ? "In-app center" : "Browser alerts";
                          const channelDescription =
                            channel === "inApp"
                              ? "Show these updates in the web notification center."
                              : notifications.browserPermission === "granted"
                                ? "Send browser deliveries for newly arriving notifications."
                                : "Requires browser permission before deliveries can be enabled.";
                          const isDisabled = channel === "browser" && notifications.browserPermission !== "granted";

                          return (
                            <label
                              key={`${notificationType}-${channel}`}
                              className={cn(
                                "flex items-center justify-between gap-4 rounded border border-white/[0.08] px-4 py-3",
                                isDisabled ? "opacity-60" : "bg-black/10",
                              )}
                            >
                              <span className="min-w-0">
                                <span className="block text-sm font-medium text-white">{channelLabel}</span>
                                <span className="mt-1 block text-xs leading-5 text-white/48">{channelDescription}</span>
                              </span>
                              <Switch
                                aria-label={`${definition.label} ${channelLabel}`}
                                checked={preference?.[channel] ?? false}
                                disabled={isDisabled}
                                onCheckedChange={(checked) =>
                                  notifications.setChannelEnabled(notificationType, channel, checked)
                                }
                                className="data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-white/[0.18]"
                              />
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className={PANEL_CARD_CLASS}>
              <div className="flex items-center justify-between gap-3">
                <PanelSectionTitle>Recent notifications</PanelSectionTitle>
                {notifications.items.length > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-8 rounded-full border border-white/[0.08] px-3 text-xs text-white/72 hover:bg-white/[0.06] hover:text-white"
                    onClick={() => notifications.markAllSeen()}
                  >
                    Mark all seen
                  </Button>
                ) : null}
              </div>

              <div className="mt-4 space-y-3">
                {notifications.isLoading ? (
                  <p className="text-sm leading-6 text-white/58">Loading notifications...</p>
                ) : notifications.supportedTypes.length === 0 ? (
                  <p className="text-sm leading-6 text-white/58">
                    Notification preferences will appear here after a workspace role is resolved.
                  </p>
                ) : notifications.items.length === 0 ? (
                  <p className="text-sm leading-6 text-white/58">
                    No matching notification records are visible yet for this workspace.
                  </p>
                ) : (
                  notifications.items.map((item) => {
                    return (
                      <article
                        key={item.id}
                        className={cn(
                          "rounded border p-4",
                          item.isSeen
                            ? "border-white/[0.08] bg-white/[0.03]"
                            : "border-emerald-500/[0.28] bg-emerald-500/[0.08]",
                        )}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-medium", getNotificationToneClasses(item.tone))}>
                                {notifications.typeDefinitions[item.notificationType]?.label ?? item.title}
                              </span>
                              {!item.isSeen ? <span className={NOTIFICATION_BADGE_CLASS}>Unseen</span> : null}
                              <span className="text-xs text-white/42">{formatNotificationTimestamp(item.occurredAt)}</span>
                            </div>
                            <h3 className="mt-3 text-[16px] font-medium text-white">{item.title}</h3>
                            <p className="mt-2 text-sm leading-6 text-white/58">{item.detail}</p>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            className="h-8 rounded-full border border-white/[0.08] px-3 text-xs text-white/72 hover:bg-white/[0.06] hover:text-white"
                            onClick={() => notifications.setItemSeen(item.id, !item.isSeen)}
                          >
                            {item.isSeen ? "Mark unseen" : "Mark seen"}
                          </Button>
                        </div>
                      </article>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        );
      case "settings":
        return (
          <div className="space-y-6">
            <div className={PANEL_CARD_CLASS}>
              <PanelSectionTitle>Account</PanelSectionTitle>
              <div className="mt-4 flex items-center gap-4">
                <Avatar className="h-12 w-12">
                  <AvatarFallback className="bg-emerald-500 text-[18px] font-medium text-white">
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
                <DetailRow
                  label="Organization"
                  value={activeMembership?.organizationName ?? "Personal workspace"}
                />
              </dl>
            </div>

            {activeMembership?.organizationId && orgDetailsLoaded && (
              <>
                {/* Company — read-only display */}
                <div className={PANEL_CARD_CLASS}>
                  <div className="flex items-center justify-between">
                    <PanelSectionTitle>Company</PanelSectionTitle>
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => openEdit("company")}
                        className="text-xs text-white/52 hover:text-white/80 transition-colors"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  <dl className="mt-3 divide-y divide-white/[0.08]">
                    {orgDetails.logoUrl && (
                      <div className="py-3">
                        <img src={orgDetails.logoUrl} alt="Company logo" className="h-8 w-8 rounded object-contain" />
                      </div>
                    )}
                    <DetailRow label="Company name" value={orgDetails.companyName ?? "—"} />
                    <DetailRow label="Phone" value={orgDetails.phone ?? "—"} />
                  </dl>
                </div>

                {/* Billing Address — read-only display */}
                <div className={PANEL_CARD_CLASS}>
                  <div className="flex items-center justify-between">
                    <PanelSectionTitle>Billing Address</PanelSectionTitle>
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => openEdit("billing")}
                        className="text-xs text-white/52 hover:text-white/80 transition-colors"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  <dl className="mt-3 divide-y divide-white/[0.08]">
                    <DetailRow label="Street" value={orgDetails.billingStreet ?? "—"} />
                    <DetailRow
                      label="City / State / ZIP"
                      value={
                        [orgDetails.billingCity, orgDetails.billingState, orgDetails.billingZip]
                          .filter(Boolean)
                          .join(", ") || "—"
                      }
                    />
                    <DetailRow label="Country" value={orgDetails.billingCountry || "—"} />
                  </dl>
                </div>

                {/* Shipping Address — read-only display */}
                <div className={PANEL_CARD_CLASS}>
                  <div className="flex items-center justify-between">
                    <PanelSectionTitle>Shipping Address</PanelSectionTitle>
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => openEdit("shipping")}
                        className="text-xs text-white/52 hover:text-white/80 transition-colors"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  <dl className="mt-3 divide-y divide-white/[0.08]">
                    {orgDetails.shippingSameAsBilling ? (
                      <DetailRow label="Same as billing" value="" />
                    ) : (
                      <>
                        <DetailRow label="Street" value={orgDetails.shippingStreet ?? "—"} />
                        <DetailRow
                          label="City / State / ZIP"
                          value={
                            [orgDetails.shippingCity, orgDetails.shippingState, orgDetails.shippingZip]
                              .filter(Boolean)
                              .join(", ") || "—"
                          }
                        />
                        <DetailRow label="Country" value={orgDetails.shippingCountry || "—"} />
                      </>
                    )}
                  </dl>
                </div>

              </>
            )}

            <div className={PANEL_CARD_CLASS}>
              <PanelSectionTitle>Support</PanelSectionTitle>
              <div className="mt-4 space-y-3">
                <HelpCenterButton
                  icon={Bell}
                  label="Notifications"
                  description="Review browser permission, preferences, and seen state for workflow alerts."
                  onClick={() => setActivePanel("notifications")}
                />
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
              <>
                {onDeleteArchivedParts && archivedPartCount > 0 ? (
                  <div className={PANEL_CARD_CLASS}>
                    <h3 className="text-[17px] font-medium text-white">
                      {archivedPartCount} archived {archivedPartCount === 1 ? "part" : "parts"}
                    </h3>
                    <p className="mt-1 text-sm text-white/52">
                      Permanently remove archived parts and their related files from this workspace.
                    </p>
                  </div>
                ) : null}

                {archiveItems.map((item) => {
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
                  const isBusy = isUnarchivePending || isDeletePending || hasPendingDelete;

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
                          className="absolute right-0 top-0 flex max-w-full items-center gap-2 pl-4 opacity-0 transition group-hover/item:opacity-100 focus-within:opacity-100"
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

                          {onDeleteArchivedParts ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={isBusy}
                              className="h-9 rounded-full border border-red-500/20 bg-red-500/10 px-3 text-red-100 hover:bg-red-500/18 hover:text-white"
                              onClick={() => setDeleteConfirmation({ kind: "single", job: item.job })}
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
                })}
              </>
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
                  <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
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
    activePanel === "notifications"
      ? "Notifications"
      : activePanel === "settings"
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
    activePanel === "notifications"
      ? "Browser permission, notification preferences, and seen state for the first web notification slice."
      : activePanel === "settings"
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
              "workspace-shell group/account flex w-full items-center gap-3 rounded-surface-lg px-3 py-2.5 text-left text-white transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 disabled:cursor-not-allowed disabled:opacity-60",
              menuOpen ? "bg-white/[0.06]" : "bg-transparent hover:bg-white/[0.06] focus-visible:bg-white/[0.06]",
            )}
          >
            <Avatar className="h-11 w-11 shrink-0">
              <AvatarFallback className="bg-emerald-500 text-[18px] font-medium text-white">
                {profile.initials}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-medium leading-5 tracking-[-0.01em] text-white/[0.96]">
                {profile.displayName}
              </p>
              <p className="truncate text-[13px] leading-5 text-white/48">
                {roleLabel}
              </p>
            </div>
            {notifications.unseenCount > 0 ? (
              <span className="hidden shrink-0 h-5 w-5 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10 text-[11px] font-medium text-emerald-300 md:inline-flex" aria-label={`${notifications.unseenCount} unseen notifications`}>
                {notifications.unseenCount}
              </span>
            ) : null}
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
          <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => openPanel("notifications")}>
            <Bell className={MENU_ICON_CLASS} strokeWidth={1.85} />
            <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
              <span>Notifications</span>
              {notifications.unseenCount > 0 ? <span className={NOTIFICATION_BADGE_CLASS}>{notifications.unseenCount}</span> : null}
            </span>
          </DropdownMenuItem>

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

          {showExtractionLauncher ? (
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={openExtractionLauncher}>
              <ScanSearch className={MENU_ICON_CLASS} strokeWidth={1.85} />
              <span>Extraction</span>
            </DropdownMenuItem>
          ) : null}

          {showFixtures ? (
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={openFixturePanel}>
              <FlaskConical className={MENU_ICON_CLASS} strokeWidth={1.85} />
              <span>Fixtures</span>
            </DropdownMenuItem>
          ) : null}

          {showExtractionLauncher || diagnosticsSnapshot.enabled || import.meta.env.DEV ? (
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={openDiagnosticsPanel}>
              <Bug className={MENU_ICON_CLASS} strokeWidth={1.85} />
              <span>Diagnostics</span>
            </DropdownMenuItem>
          ) : null}

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
        <SheetContent
          side="right"
          ref={panelContentRef}
          tabIndex={-1}
          className={PANEL_SHEET_CLASS}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            panelContentRef.current?.focus();
          }}
        >
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

            {activePanel === "settings" && editingSection !== null && (
              <div className="border-t border-white/[0.08] bg-ws-raised px-6 pb-6 pt-5 shadow-[0_-8px_24px_rgba(0,0,0,0.4)]">
                <p className="mb-4 text-[15px] font-medium text-white">
                  {editingSection === "company" && "Edit Company"}
                  {editingSection === "billing" && "Edit Billing Address"}
                  {editingSection === "shipping" && "Edit Shipping Address"}
                </p>

                {editingSection === "company" && (
                  <div className="space-y-3">
                    <div>
                      <label className="mb-1.5 block text-xs text-white/55">Company name</label>
                      <Input
                        ref={companyNameInputRef}
                        value={orgDetailsDraft.companyName ?? ""}
                        onChange={(e) => patchDraft({ companyName: e.target.value })}
                        placeholder="4D Technology"
                        className="border-white/[0.12] bg-white/[0.06] text-white placeholder:text-white/28 focus-visible:ring-white/20"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs text-white/55">Phone</label>
                      <Input
                        value={orgDetailsDraft.phone ?? ""}
                        onChange={(e) => patchDraft({ phone: e.target.value })}
                        placeholder="+1 (520) 555-0100"
                        className="border-white/[0.12] bg-white/[0.06] text-white placeholder:text-white/28 focus-visible:ring-white/20"
                      />
                    </div>
                  </div>
                )}

                {editingSection === "billing" && (
                  <div className="space-y-3">
                    <div>
                      <label className="mb-1.5 block text-xs text-white/55">Street</label>
                      <Input
                        value={orgDetailsDraft.billingStreet ?? ""}
                        onChange={(e) => patchDraft({ billingStreet: e.target.value })}
                        placeholder="2348 E. Broadway Blvd"
                        className="border-white/[0.12] bg-white/[0.06] text-white placeholder:text-white/28 focus-visible:ring-white/20"
                      />
                    </div>
                    <div className="grid grid-cols-5 gap-2">
                      <div className="col-span-2">
                        <label className="mb-1.5 block text-xs text-white/55">City</label>
                        <Input
                          value={orgDetailsDraft.billingCity ?? ""}
                          onChange={(e) => patchDraft({ billingCity: e.target.value })}
                          placeholder="Tucson"
                          className="border-white/[0.12] bg-white/[0.06] text-white placeholder:text-white/28 focus-visible:ring-white/20"
                        />
                      </div>
                      <div className="col-span-1">
                        <label className="mb-1.5 block text-xs text-white/55">State</label>
                        <Input
                          value={orgDetailsDraft.billingState ?? ""}
                          onChange={(e) => patchDraft({ billingState: e.target.value })}
                          placeholder="AZ"
                          className="border-white/[0.12] bg-white/[0.06] text-white placeholder:text-white/28 focus-visible:ring-white/20"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="mb-1.5 block text-xs text-white/55">ZIP</label>
                        <Input
                          value={orgDetailsDraft.billingZip ?? ""}
                          onChange={(e) => patchDraft({ billingZip: e.target.value })}
                          placeholder="85716"
                          className="border-white/[0.12] bg-white/[0.06] text-white placeholder:text-white/28 focus-visible:ring-white/20"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs text-white/55">Country</label>
                      <Input
                        value={orgDetailsDraft.billingCountry}
                        onChange={(e) => patchDraft({ billingCountry: e.target.value })}
                        placeholder="US"
                        className="border-white/[0.12] bg-white/[0.06] text-white placeholder:text-white/28 focus-visible:ring-white/20"
                      />
                    </div>
                  </div>
                )}

                {editingSection === "shipping" && (
                  <div className="space-y-3">
                    {/* Styled button toggle — avoids native radio focus-trap issues inside Radix DismissableLayer */}
                    <div className="flex overflow-hidden rounded-lg border border-white/[0.1]">
                      <button
                        type="button"
                        onClick={() => patchDraft({ shippingSameAsBilling: true })}
                        className={cn(
                          "flex-1 px-3 py-2 text-sm transition-colors",
                          orgDetailsDraft.shippingSameAsBilling
                            ? "bg-white/[0.12] font-medium text-white"
                            : "text-white/52 hover:bg-white/[0.04] hover:text-white/80",
                        )}
                      >
                        Same as billing
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          patchDraft({
                            shippingSameAsBilling: false,
                            shippingStreet: orgDetailsDraft.shippingStreet ?? orgDetailsDraft.billingStreet,
                            shippingCity: orgDetailsDraft.shippingCity ?? orgDetailsDraft.billingCity,
                            shippingState: orgDetailsDraft.shippingState ?? orgDetailsDraft.billingState,
                            shippingZip: orgDetailsDraft.shippingZip ?? orgDetailsDraft.billingZip,
                            shippingCountry: orgDetailsDraft.shippingCountry || orgDetailsDraft.billingCountry,
                          })
                        }
                        className={cn(
                          "flex-1 border-l border-white/[0.1] px-3 py-2 text-sm transition-colors",
                          !orgDetailsDraft.shippingSameAsBilling
                            ? "bg-white/[0.12] font-medium text-white"
                            : "text-white/52 hover:bg-white/[0.04] hover:text-white/80",
                        )}
                      >
                        Different address
                      </button>
                    </div>

                    {!orgDetailsDraft.shippingSameAsBilling && (
                      <>
                        <div>
                          <label className="mb-1.5 block text-xs text-white/55">Street</label>
                          <Input
                            value={orgDetailsDraft.shippingStreet ?? ""}
                            onChange={(e) => patchDraft({ shippingStreet: e.target.value })}
                            placeholder="2348 E. Broadway Blvd"
                            className="border-white/[0.12] bg-white/[0.06] text-white placeholder:text-white/28 focus-visible:ring-white/20"
                          />
                        </div>
                        <div className="grid grid-cols-5 gap-2">
                          <div className="col-span-2">
                            <label className="mb-1.5 block text-xs text-white/55">City</label>
                            <Input
                              value={orgDetailsDraft.shippingCity ?? ""}
                              onChange={(e) => patchDraft({ shippingCity: e.target.value })}
                              placeholder="Tucson"
                              className="border-white/[0.12] bg-white/[0.06] text-white placeholder:text-white/28 focus-visible:ring-white/20"
                            />
                          </div>
                          <div className="col-span-1">
                            <label className="mb-1.5 block text-xs text-white/55">State</label>
                            <Input
                              value={orgDetailsDraft.shippingState ?? ""}
                              onChange={(e) => patchDraft({ shippingState: e.target.value })}
                              placeholder="AZ"
                              className="border-white/[0.12] bg-white/[0.06] text-white placeholder:text-white/28 focus-visible:ring-white/20"
                            />
                          </div>
                          <div className="col-span-2">
                            <label className="mb-1.5 block text-xs text-white/55">ZIP</label>
                            <Input
                              value={orgDetailsDraft.shippingZip ?? ""}
                              onChange={(e) => patchDraft({ shippingZip: e.target.value })}
                              placeholder="85716"
                              className="border-white/[0.12] bg-white/[0.06] text-white placeholder:text-white/28 focus-visible:ring-white/20"
                            />
                          </div>
                        </div>
                        <div>
                          <label className="mb-1.5 block text-xs text-white/55">Country</label>
                          <Input
                            value={orgDetailsDraft.shippingCountry}
                            onChange={(e) => patchDraft({ shippingCountry: e.target.value })}
                            placeholder="US"
                            className="border-white/[0.12] bg-white/[0.06] text-white placeholder:text-white/28 focus-visible:ring-white/20"
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}

                {orgSaveError && <p className="mt-3 text-xs text-red-400">{orgSaveError}</p>}

                <div className="mt-4 flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={cancelEdit}
                    disabled={isSavingOrg}
                    className="flex-1 border border-white/[0.1] text-white/72 hover:bg-white/[0.06] hover:text-white"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={handleSaveOrgDetails}
                    disabled={isSavingOrg}
                    className="flex-1"
                  >
                    {isSavingOrg ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Saving…
                      </>
                    ) : (
                      "Save"
                    )}
                  </Button>
                </div>
              </div>
            )}

            {activePanel && activePanel !== "settings" && activePanel !== "notifications" ? (
              <div
                data-testid={activePanel === "archive" ? "archive-footer-actions" : undefined}
                className={cn(
                  "border-t border-white/[0.08] px-6 py-4",
                  activePanel === "archive" ? "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" : "",
                )}
              >
                <Button
                  type="button"
                  variant="ghost"
                  className="h-10 rounded-full border border-white/[0.08] bg-transparent px-4 text-white/80 hover:bg-white/[0.06] hover:text-white"
                  onClick={() => setActivePanel("help-center")}
                >
                  <ArrowUpRight className="mr-2 h-4 w-4" />
                  Back to Help center
                </Button>

                {activePanel === "archive" && onDeleteArchivedParts ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={deleteAllDisabled}
                    className="h-10 rounded-full border border-red-500/20 bg-red-500/10 px-4 text-red-100 hover:bg-red-500/18 hover:text-white disabled:opacity-60"
                    onClick={() => setDeleteConfirmation({ kind: "bulk", jobs: archivedJobs })}
                  >
                    {deleteConfirmation?.kind === "bulk" && hasPendingDelete ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete all
                      </>
                    )}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={Boolean(deleteConfirmation)}
        onOpenChange={(open) => {
          if (!open && !deleteConfirmation) {
            return;
          }

          if (!hasPendingDelete) {
            setDeleteConfirmation(open ? deleteConfirmation : null);
          }
        }}
      >
        <AlertDialogContent className="workspace-shell border-white/[0.08] bg-ws-raised text-white">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteConfirmation?.kind === "bulk" ? "Delete all archived parts?" : "Delete archived part?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-white/55">
              {deleteConfirmation?.kind === "bulk"
                ? `Delete ${deleteConfirmation.jobs.length} archived parts permanently, including their related files. This cannot be undone.`
                : deleteConfirmation
                  ? `Delete ${getClientItemPresentation(deleteConfirmation.job.job, deleteConfirmation.job.summary ?? undefined).title} permanently. This cannot be undone.`
                  : "Delete this archived part permanently. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/[0.08] bg-transparent text-white hover:bg-white/[0.06] hover:text-white">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-500"
              disabled={!deleteConfirmation || hasPendingDelete}
              onClick={(event) => {
                if (!deleteConfirmation) {
                  event.preventDefault();
                  return;
                }

                event.preventDefault();
                void handleDeleteArchivedParts(
                  deleteConfirmation.kind === "bulk"
                    ? bulkDeleteJobIds
                    : [deleteConfirmation.job.job.id],
                );
              }}
            >
              {hasPendingDelete ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                deleteConfirmation?.kind === "bulk" ? "Delete all" : "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
