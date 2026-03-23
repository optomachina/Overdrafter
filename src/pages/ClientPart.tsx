import { useEffect, useState } from "react";
import {
  Archive,
  Bell,
  CalendarClock,
  Copy,
  FolderInput,
  History,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Star,
  MoveRight,
  PlusSquare,
  Search,
  StarOff,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { ActivityLog } from "@/components/quotes/ActivityLog";
import { ClientWorkspaceShell } from "@/components/workspace/ClientWorkspaceShell";
import { CadPanel } from "@/components/workspace/CadPanel";
import { PartInfoPanel } from "@/components/workspace/PartInfoPanel";
import { PdfPanel } from "@/components/workspace/PdfPanel";
import { QuoteChart } from "@/components/workspace/QuoteChart";
import { QuoteList } from "@/components/workspace/QuoteList";
import { QuoteStatBar } from "@/components/workspace/QuoteStatBar";
import { SearchPartsDialog } from "@/components/chat/SearchPartsDialog";
import { WorkspaceSidebar } from "@/components/chat/WorkspaceSidebar";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { ClientExtractionStatusNotice } from "@/components/quotes/ClientExtractionStatusNotice";
import { ClientPartHeader } from "@/components/quotes/ClientPartHeader";
import { ClientWorkspaceStateSummary, ClientWorkspaceToneBadge } from "@/components/quotes/ClientWorkspaceStateSummary";
import { DrawingPreviewDialog } from "@/components/quotes/DrawingPreviewDialog";
import { RequestSummaryBadges } from "@/components/quotes/RequestSummaryBadges";
import { ClientQuoteRequestStatusCard } from "@/components/quotes/ClientWorkspacePanelContent";
import { ProjectNameDialog } from "@/components/projects/ProjectNameDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useWorkspaceNotifications } from "@/features/notifications/use-workspace-notifications";
import { useClientPartController } from "@/features/quotes/use-client-part-controller";
import { buildClientWorkspaceState } from "@/features/quotes/client-workspace-state";
import { buildQuoteRequestViewModel } from "@/features/quotes/quote-request";
import { formatStatusLabel } from "@/features/quotes/utils";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type LocalComment = {
  id: string;
  body: string;
  authorLabel: string;
  createdAt: string;
};

const QUICK_DUE_DATE_PRESETS = [
  { label: "Tomorrow", days: 1 },
  { label: "In 3 days", days: 3 },
  { label: "Next week", days: 7 },
  { label: "In 2 weeks", days: 14 },
] as const;

function formatDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(base: Date, days: number): string {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return formatDateInputValue(next);
}

function getStoredCommentsKey(storageScopeKey: string, jobId: string): string {
  return `client-part-comments:${storageScopeKey}:${jobId}`;
}

function getStoredSubscribedKey(storageScopeKey: string, jobId: string): string {
  return `client-part-subscribed:${storageScopeKey}:${jobId}`;
}

function readStoredComments(storageScopeKey: string, jobId: string): LocalComment[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(getStoredCommentsKey(storageScopeKey, jobId));
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredComments(storageScopeKey: string, jobId: string, comments: LocalComment[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(getStoredCommentsKey(storageScopeKey, jobId), JSON.stringify(comments));
}

function readStoredSubscribed(storageScopeKey: string, jobId: string): boolean {
  if (typeof window === "undefined") {
    return true;
  }

  return window.localStorage.getItem(getStoredSubscribedKey(storageScopeKey, jobId)) !== "false";
}

function writeStoredSubscribed(storageScopeKey: string, jobId: string, subscribed: boolean) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    getStoredSubscribedKey(storageScopeKey, jobId),
    subscribed ? "true" : "false",
  );
}

const ClientPart = () => {
  const {
    accessibleJobsQuery,
    activeMembership,
    activityEntries,
    activePreset,
    archivedJobsQuery,
    archivedProjectsQuery,
    assignJobMutation,
    attachFilesPicker,
    cadFile,
    currentPartName,
    currentProjectOptions,
    displayPartTitle,
    drawingFile,
    drawingPdfUrl,
    drawingPreview,
    drawingPreviewPageUrls,
    drawingViewerMode,
    drawingPreviewState,
    drawingPreviewStatusMessage,
    extractionDiagnostics,
    effectiveRequestDraft,
    extraction,
    handleArchivePart,
    handleArchiveProject,
    handleAssignPartToProject,
    handleCreateProjectFromSelection,
    handleDeleteArchivedParts,
    handleDissolveProject,
    handleDownloadFile,
    handleDraftChange,
    handlePinPart,
    handlePinProject,
    handlePresetSelection,
    handleRemovePartFromProject,
    handleRenamePart,
    handleRenameProject,
    handleRequestQuote,
    handleSaveRequest,
    handleSaveRequestPatch,
    handleSelectQuoteOption,
    handleToggleCurrentPartPin,
    handleToggleVendorExclusion,
    handleUnarchivePart,
    handleUnpinPart,
    handleUnpinProject,
    isDrawingPreviewLoading,
    isPartDetailLoading,
    isPartArchiveBusy,
    isPartOptionsOpen,
    isRequestingQuote,
    isRenamingPart,
    isSearchOpen,
    jobId,
    navigate,
    newJobFilePicker,
    partDetail,
    partRenameValue,
    pinnedJobIds,
    prefetchPart,
    prefetchProject,
    presentation,
    projectCollaborationUnavailable,
    projectMemberships,
    quoteDataMessage,
    quoteDataStatus,
    quoteDiagnostics,
    quoteQuantityInput,
    rankedQuoteOptions,
    removeJobMutation,
    requestQuantities,
    requestSummaryQuantity,
    requestSummaryRequestedByDate,
    resolveSidebarProjectIdsForJob,
    revisionOptions,
    saveRequestMutation,
    selectedQuoteOption,
    selectedRevisionIndex,
    setIsPartArchiveBusy,
    setIsPartOptionsOpen,
    setIsSearchOpen,
    setPartRenameValue,
    setQuoteQuantityInput,
    setShowDrawingPreview,
    setShowMoveDialog,
    setShowRenameDialog,
    showDrawingPreview,
    showMoveDialog,
    showRenameDialog,
    sidebarPinsQuery,
    sidebarProjects,
    signOut,
    summariesByJobId,
    summary,
    user,
    isAuthInitializing,
  } = useClientPartController();

  const notificationCenter = useWorkspaceNotifications({
    jobIds: (accessibleJobsQuery.data ?? []).map((job) => job.id),
    role: activeMembership?.role,
    userId: user?.id,
  });
  const storageScopeKey = user?.id ?? "anonymous";

  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(selectedQuoteOption?.offerId ?? null);
  const [comments, setComments] = useState<LocalComment[]>([]);
  const [commentDraft, setCommentDraft] = useState("");
  const [isDueDateDialogOpen, setIsDueDateDialogOpen] = useState(false);
  const [dueDateDraft, setDueDateDraft] = useState(requestSummaryRequestedByDate ?? "");
  const [isSubscribed, setIsSubscribed] = useState(true);
  const [isVersionHistoryOpen, setIsVersionHistoryOpen] = useState(false);

  useEffect(() => {
    setSelectedOfferId(selectedQuoteOption?.offerId ?? null);
  }, [selectedQuoteOption?.offerId]);

  useEffect(() => {
    setComments(readStoredComments(storageScopeKey, jobId));
    setIsSubscribed(readStoredSubscribed(storageScopeKey, jobId));
  }, [jobId, storageScopeKey]);

  useEffect(() => {
    setDueDateDraft(requestSummaryRequestedByDate ?? "");
  }, [requestSummaryRequestedByDate]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;

      if (
        event.defaultPrevented ||
        !jobId ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (target instanceof HTMLElement &&
          (target.isContentEditable ||
            target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT"))
      ) {
        return;
      }

      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        void handleToggleCurrentPartPin();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleToggleCurrentPartPin, jobId]);

  if (isAuthInitializing) {
    return <AuthBootstrapScreen message="Restoring your part workspace." />;
  }

  if (!user) {
    return null;
  }

  const workspaceState =
    partDetail?.job && partDetail.part
      ? buildClientWorkspaceState({
          job: partDetail.job,
          summary,
          part: partDetail.part,
          options: rankedQuoteOptions,
          selectedOption: selectedQuoteOption,
          requestedByDate: requestSummaryRequestedByDate,
        })
      : null;
  const quoteRequestViewModel =
    partDetail?.job
      ? buildQuoteRequestViewModel({
          job: partDetail.job,
          part: partDetail.part,
          latestQuoteRequest: partDetail.latestQuoteRequest,
          latestQuoteRun: partDetail.latestQuoteRun,
        })
      : null;

  const handleQuoteRequestAction = () => {
    if (!quoteRequestViewModel || quoteRequestViewModel.action.kind === "none") {
      return;
    }

    void handleRequestQuote(quoteRequestViewModel.action.kind === "retry");
  };

  const handleWorkspaceOfferSelect = (offerId: string | null) => {
    if (offerId === null) {
      setSelectedOfferId(null);
      handleSelectQuoteOption(null);
      return;
    }

    const nextOption = rankedQuoteOptions.find((option) => option.offerId === offerId) ?? null;

    if (!nextOption) {
      return;
    }

    setSelectedOfferId(offerId);
    handleSelectQuoteOption(nextOption);
  };

  const breadcrumbProject = projectMemberships[0]?.project ?? null;
  const isFavorite = pinnedJobIds.includes(jobId);
  const currentUrl = typeof window === "undefined" ? `/parts/${jobId}` : window.location.href;

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(currentUrl);
      toast.success("Part link copied.");
    } catch {
      toast.error("Unable to copy the part link.");
    }
  };

  const handleAddComment = () => {
    const body = commentDraft.trim();

    if (!body) {
      return;
    }

    const nextComments = [
      {
        id: `${jobId}-${Date.now()}`,
        body,
        authorLabel: user.email ?? "You",
        createdAt: new Date().toISOString(),
      },
      ...comments,
    ];

    setComments(nextComments);
    writeStoredComments(storageScopeKey, jobId, nextComments);
    setCommentDraft("");
    toast.success("Comment added.");
  };

  const handleToggleSubscribed = () => {
    const next = !isSubscribed;
    setIsSubscribed(next);
    writeStoredSubscribed(storageScopeKey, jobId, next);
    toast.success(next ? "Subscribed to updates." : "Unsubscribed from updates.");
  };

  const handleSaveDueDate = () => {
    handleSaveRequestPatch({
      requestedByDate: dueDateDraft.trim().length > 0 ? dueDateDraft : null,
    });
    setIsDueDateDialogOpen(false);
  };

  return (
    <>
      <ClientWorkspaceShell
        onLogoClick={() => navigate("/")}
        sidebarRailActions={[
          { label: "New Job", icon: PlusSquare, onClick: newJobFilePicker.openFilePicker },
          { label: "Search", icon: Search, onClick: () => setIsSearchOpen(true) },
        ]}
        sidebarContent={
          <WorkspaceSidebar
            projects={sidebarProjects}
            jobs={accessibleJobsQuery.data ?? []}
            summariesByJobId={summariesByJobId}
            activeJobId={jobId}
            onCreateJob={newJobFilePicker.openFilePicker}
            onCreateProject={projectCollaborationUnavailable ? undefined : newJobFilePicker.openFilePicker}
            onSearch={() => setIsSearchOpen(true)}
            storageScopeKey={user.id}
            pinnedProjectIds={sidebarPinsQuery.data?.projectIds ?? []}
            pinnedJobIds={sidebarPinsQuery.data?.jobIds ?? []}
            onPinProject={handlePinProject}
            onUnpinProject={handleUnpinProject}
            onPinPart={handlePinPart}
            onUnpinPart={handleUnpinPart}
            onAssignPartToProject={handleAssignPartToProject}
            onRemovePartFromProject={handleRemovePartFromProject}
            onCreateProjectFromSelection={
              projectCollaborationUnavailable ? undefined : handleCreateProjectFromSelection
            }
            onRenameProject={handleRenameProject}
            onRenamePart={handleRenamePart}
            onArchivePart={handleArchivePart}
            onArchiveProject={handleArchiveProject}
            onDissolveProject={handleDissolveProject}
            onSelectProject={(projectId) => navigate(`/projects/${projectId}`)}
            onSelectPart={(jobId) => navigate(`/parts/${jobId}`)}
            onPrefetchProject={prefetchProject}
            onPrefetchPart={prefetchPart}
            resolveProjectIdsForJob={resolveSidebarProjectIdsForJob}
          />
        }
        sidebarFooter={
          <WorkspaceAccountMenu
            user={user}
            activeMembership={activeMembership}
            notificationCenter={notificationCenter}
            onSignOut={signOut}
            onSignedOut={() => navigate("/", { replace: true })}
            archivedProjects={archivedProjectsQuery.data}
            archivedJobs={archivedJobsQuery.data}
            isArchiveLoading={archivedProjectsQuery.isLoading || archivedJobsQuery.isLoading}
            onUnarchivePart={handleUnarchivePart}
            onDeleteArchivedParts={handleDeleteArchivedParts}
          />
        }
      >
        <div className="mx-auto flex w-full max-w-[1480px] flex-1 flex-col gap-6 px-6 pb-10 pt-4">
          {isPartDetailLoading ? (
            <div className="flex min-h-[320px] items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-white/60" />
            </div>
          ) : partDetail?.job && presentation ? (
            <>
              <ClientPartHeader
                eyebrow="Issue detail"
                title={displayPartTitle}
                description={presentation.description}
                badges={
                  <>
                    <Badge className="border border-white/10 bg-white/6 text-white/75">
                      {formatStatusLabel(partDetail.job.status)}
                    </Badge>
                    {quoteRequestViewModel ? (
                      <ClientWorkspaceToneBadge
                        tone={quoteRequestViewModel.tone}
                        label={`Quote ${quoteRequestViewModel.label}`}
                        className="tracking-normal normal-case"
                      />
                    ) : null}
                    {projectMemberships.length > 0 ? (
                      projectMemberships.map((project) => (
                        <Badge key={project.project.id} className="border border-white/10 bg-white/6 text-white/75">
                          {project.project.name}
                        </Badge>
                      ))
                    ) : (
                      <Badge className="border border-white/10 bg-white/6 text-white/75">Standalone part</Badge>
                    )}
                    {!cadFile ? (
                      <Badge className="border border-amber-400/25 bg-amber-500/10 text-amber-200">
                        CAD missing
                      </Badge>
                    ) : null}
                    {!drawingFile ? (
                      <Badge className="border border-sky-400/25 bg-sky-500/10 text-sky-200">
                        Drawing missing
                      </Badge>
                    ) : null}
                  </>
                }
                details={
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2 text-sm text-white/55">
                      <button
                        type="button"
                        className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-white/70 transition hover:bg-white/8 hover:text-white"
                        onClick={() => navigate("/")}
                      >
                        Workspace
                      </button>
                      <span className="text-white/25">/</span>
                      {breadcrumbProject ? (
                        <>
                          <button
                            type="button"
                            className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-white/70 transition hover:bg-white/8 hover:text-white"
                            onClick={() => navigate(`/projects/${breadcrumbProject.id}`)}
                          >
                            {breadcrumbProject.name}
                          </button>
                          <span className="text-white/25">/</span>
                        </>
                      ) : null}
                      <span className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-white">
                        {displayPartTitle}
                      </span>
                    </div>

                    <RequestSummaryBadges
                      requestedServiceKinds={
                        effectiveRequestDraft?.requestedServiceKinds ?? summary?.requestedServiceKinds ?? []
                      }
                      quantity={requestSummaryQuantity}
                      requestedQuoteQuantities={requestQuantities}
                      requestedByDate={requestSummaryRequestedByDate}
                    />
                  </div>
                }
                actions={
                  <>
                    <TooltipProvider delayDuration={150}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            aria-label={isFavorite ? "Unfavorite part" : "Favorite part"}
                            className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                            onClick={() => void handleToggleCurrentPartPin()}
                          >
                            {isFavorite ? <Star className="fill-current" /> : <StarOff />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {isFavorite ? "Remove favorite" : "Add favorite"} <span className="ml-2 text-white/45">F</span>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>

                    {revisionOptions.length > 1 ? (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                          onClick={() => {
                            const previousId =
                              revisionOptions[
                                (selectedRevisionIndex - 1 + revisionOptions.length) % revisionOptions.length
                              ]?.jobId;
                            if (previousId) {
                              navigate(`/parts/${previousId}`);
                            }
                          }}
                        >
                          Prev rev
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                          onClick={() => {
                            const nextId =
                              revisionOptions[(selectedRevisionIndex + 1) % revisionOptions.length]?.jobId;
                            if (nextId) {
                              navigate(`/parts/${nextId}`);
                            }
                          }}
                        >
                          {revisionOptions[selectedRevisionIndex]?.revision ?? "Rev"}
                        </Button>
                      </>
                    ) : null}
                    {projectMemberships.length === 1 ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                        onClick={() => navigate(`/projects/${projectMemberships[0]!.project.id}`)}
                      >
                        Open project
                      </Button>
                    ) : null}
                    {!projectCollaborationUnavailable ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                        onClick={() => setShowMoveDialog(true)}
                      >
                        <FolderInput className="mr-2 h-4 w-4" />
                        Manage projects
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      className="rounded-full border-white/10 bg-white/8 text-white hover:bg-white/12"
                      onClick={attachFilesPicker.openFilePicker}
                    >
                      <Upload className="mr-2 h-4 w-4" />
                      Attach files
                    </Button>
                    <Button type="button" className="rounded-full shadow-sm" onClick={() => navigate(`/parts/${jobId}/review`)}>
                      Review order
                      <MoveRight className="ml-2 h-4 w-4" />
                    </Button>
                    <DropdownMenu open={isPartOptionsOpen} onOpenChange={setIsPartOptionsOpen}>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label="Issue detail actions"
                          className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="w-64 border-white/10 bg-[#1f1f1f] p-2 text-white"
                      >
                        <DropdownMenuItem
                          onSelect={(event) => {
                            event.preventDefault();
                            setIsPartOptionsOpen(false);
                            setIsDueDateDialogOpen(true);
                          }}
                        >
                          <CalendarClock className="mr-2 h-4 w-4" />
                          Set due date
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={(event) => {
                            event.preventDefault();
                            setIsPartOptionsOpen(false);
                            toast.message("Make a copy is not wired for part workspaces yet.");
                          }}
                        >
                          <Copy className="mr-2 h-4 w-4" />
                          Make a copy
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={(event) => {
                            event.preventDefault();
                            setIsPartOptionsOpen(false);
                            handleToggleSubscribed();
                          }}
                        >
                          <Bell className="mr-2 h-4 w-4" />
                          {isSubscribed ? "Unsubscribe" : "Subscribe"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={(event) => {
                            event.preventDefault();
                            setIsPartOptionsOpen(false);
                            void handleToggleCurrentPartPin();
                          }}
                        >
                          <Star className="mr-2 h-4 w-4" />
                          {isFavorite ? "Unfavorite" : "Favorite"}
                          <DropdownMenuShortcut>F</DropdownMenuShortcut>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={(event) => {
                            event.preventDefault();
                            setIsPartOptionsOpen(false);
                            void handleCopyLink();
                          }}
                        >
                          <Copy className="mr-2 h-4 w-4" />
                          Copy link
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={(event) => {
                            event.preventDefault();
                            setIsPartOptionsOpen(false);
                            toast.success("Reminder set for tomorrow morning.");
                          }}
                        >
                          <Bell className="mr-2 h-4 w-4" />
                          Remind me
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={(event) => {
                            event.preventDefault();
                            setIsPartOptionsOpen(false);
                            setIsVersionHistoryOpen(true);
                          }}
                        >
                          <History className="mr-2 h-4 w-4" />
                          Show version history
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className="bg-white/10" />
                        <DropdownMenuItem
                          onSelect={(event) => {
                            event.preventDefault();
                            setIsPartOptionsOpen(false);
                            setIsPartArchiveBusy(true);
                            void handleArchivePart(jobId).finally(() => setIsPartArchiveBusy(false));
                          }}
                          disabled={isPartArchiveBusy}
                          className="text-rose-200 focus:bg-rose-500/10 focus:text-rose-100"
                        >
                          <Archive className="mr-2 h-4 w-4" />
                          Archive part
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                }
              />

              {workspaceState ? <ClientWorkspaceStateSummary state={workspaceState} /> : null}

              <div className="grid items-start gap-4 xl:grid-cols-[2fr_1fr]">
                <div className="flex flex-col gap-4">
                  <QuoteStatBar quotes={rankedQuoteOptions} />
                  <QuoteChart
                    quotes={rankedQuoteOptions}
                    selectedOfferId={selectedOfferId}
                    onSelect={handleWorkspaceOfferSelect}
                  />
                  <QuoteList
                    quotes={rankedQuoteOptions}
                    selectedOfferId={selectedOfferId}
                    onSelect={handleWorkspaceOfferSelect}
                    requestedByDate={requestSummaryRequestedByDate}
                    quoteDataStatus={quoteDataStatus}
                    quoteDataMessage={quoteDataMessage}
                    quoteDiagnostics={quoteDiagnostics}
                    activePreset={activePreset}
                    onPresetSelect={handlePresetSelection}
                    onToggleVendorExclusion={handleToggleVendorExclusion}
                  />
                </div>

                <div className="flex flex-col gap-6">
                  <PartInfoPanel
                    part={partDetail.part}
                    summary={summary}
                    extraction={extraction}
                    effectiveRequestDraft={effectiveRequestDraft}
                    quoteQuantityInput={quoteQuantityInput}
                    onQuoteQuantityInputChange={setQuoteQuantityInput}
                    onDraftChange={handleDraftChange}
                    onSave={handleSaveRequest}
                    onUploadRevision={attachFilesPicker.openFilePicker}
                    isSaving={saveRequestMutation.isPending}
                    drawingFileName={drawingFile?.original_name ?? null}
                    statusContent={
                      <>
                        <ClientExtractionStatusNotice diagnostics={extractionDiagnostics} />
                        {quoteRequestViewModel ? (
                          <ClientQuoteRequestStatusCard
                            tone={quoteRequestViewModel.tone}
                            label={quoteRequestViewModel.label}
                            detail={quoteRequestViewModel.detail}
                            actionLabel={quoteRequestViewModel.action.label}
                            actionDisabled={quoteRequestViewModel.action.disabled}
                            blockerReasons={quoteRequestViewModel.blockerReasons}
                            isBusy={isRequestingQuote}
                            onAction={quoteRequestViewModel.action.kind === "none" ? null : handleQuoteRequestAction}
                          />
                        ) : null}
                      </>
                    }
                  />
                  <CadPanel cadFile={cadFile} />
                  <PdfPanel
                    drawingFile={drawingFile}
                    drawingPreview={drawingPreview}
                    drawingPdfUrl={drawingPdfUrl}
                    drawingPreviewPageUrls={drawingPreviewPageUrls}
                    drawingViewerMode={drawingViewerMode}
                    drawingPreviewState={drawingPreviewState}
                    drawingPreviewStatusMessage={drawingPreviewStatusMessage}
                    isLoading={isDrawingPreviewLoading}
                    onOpenDialog={drawingFile ? () => setShowDrawingPreview(true) : undefined}
                  />
                </div>
              </div>

              <section className="rounded-[30px] border border-white/8 bg-[#262626] p-5 md:p-6">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-white/35">Activity</p>
                    <h2 className="mt-2 text-xl font-semibold text-white">Comments and history</h2>
                    <p className="mt-1 text-sm text-white/55">
                      Leave context for collaborators and review the part activity feed.
                    </p>
                  </div>
                </div>

                <div className="mt-5 rounded-[24px] border border-white/8 bg-black/20 p-4">
                  <label htmlFor="activity-comment" className="text-sm font-medium text-white/78">
                    Leave a comment
                  </label>
                  <Textarea
                    id="activity-comment"
                    value={commentDraft}
                    onChange={(event) => setCommentDraft(event.target.value)}
                    placeholder="Add context, decisions, or a follow-up note."
                    className="mt-3 min-h-28 border-white/10 bg-[#171717] text-white placeholder:text-white/30"
                  />
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <p className="text-xs text-white/40">Comments stay attached to this part in your current browser.</p>
                    <Button type="button" onClick={handleAddComment} disabled={commentDraft.trim().length === 0}>
                      <MessageSquare className="mr-2 h-4 w-4" />
                      Comment
                    </Button>
                  </div>
                </div>

                <Tabs defaultValue="activity" className="mt-5">
                  <TabsList className="h-auto flex-wrap justify-start gap-2 rounded-[16px] bg-black/20 p-1.5">
                    <TabsTrigger value="activity">Activity</TabsTrigger>
                    <TabsTrigger value="comments">Comments</TabsTrigger>
                  </TabsList>

                  <TabsContent value="activity" className="mt-4">
                    <ActivityLog entries={activityEntries} />
                  </TabsContent>

                  <TabsContent value="comments" className="mt-4">
                    <div className="rounded-[24px] border border-white/8 bg-[#262626] p-5">
                      {comments.length === 0 ? (
                        <p className="text-sm text-white/45">No comments yet.</p>
                      ) : (
                        <div className="space-y-3">
                          {comments.map((comment) => (
                            <article key={comment.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-sm font-medium text-white">{comment.authorLabel}</p>
                                <p className="text-xs uppercase tracking-[0.16em] text-white/35">
                                  {new Date(comment.createdAt).toLocaleString()}
                                </p>
                              </div>
                              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-white/65">
                                {comment.body}
                              </p>
                            </article>
                          ))}
                        </div>
                      )}
                    </div>
                  </TabsContent>
                </Tabs>
              </section>
            </>
          ) : (
            <div className="rounded-[26px] border border-white/8 bg-[#262626] px-6 py-12 text-center text-white/45">
              This part could not be loaded.
            </div>
          )}
        </div>
      </ClientWorkspaceShell>

      <SearchPartsDialog
        open={isSearchOpen}
        onOpenChange={setIsSearchOpen}
        projects={sidebarProjects}
        jobs={accessibleJobsQuery.data ?? []}
        summariesByJobId={summariesByJobId}
        onSelectProject={(projectId) => navigate(`/projects/${projectId}`)}
        onSelectPart={(jobId) => navigate(`/parts/${jobId}`)}
      />

      <input
        ref={newJobFilePicker.inputRef}
        type="file"
        multiple
        accept={newJobFilePicker.accept}
        onChange={(event) => {
          void newJobFilePicker.handleFileInputChange(event);
        }}
        className="hidden"
        aria-label="Create new job from files"
      />
      <input
        ref={attachFilesPicker.inputRef}
        type="file"
        multiple
        accept={attachFilesPicker.accept}
        onChange={(event) => {
          void attachFilesPicker.handleFileInputChange(event);
        }}
        className="hidden"
        aria-label="Attach files to part"
      />

      {drawingFile ? (
        <DrawingPreviewDialog
          open={showDrawingPreview}
          onOpenChange={setShowDrawingPreview}
          fileName={drawingFile.original_name}
          pageCount={drawingPreview?.pageCount ?? 0}
          viewerMode={drawingViewerMode}
          pdfUrl={drawingPdfUrl}
          pages={drawingPreviewPageUrls}
          isLoading={isDrawingPreviewLoading}
          state={drawingPreviewState}
          statusMessage={drawingPreviewStatusMessage}
          onDownload={() => {
            void handleDownloadFile(drawingFile);
          }}
        />
      ) : null}

      <ProjectNameDialog
        open={showRenameDialog}
        onOpenChange={(open) => {
          setShowRenameDialog(open);
          if (!open) {
            setPartRenameValue(currentPartName);
          }
        }}
        title="Rename part"
        description="Update the part name shown throughout your workspace."
        value={partRenameValue}
        onValueChange={setPartRenameValue}
        submitLabel="Save"
        placeholder="Part name"
        isPending={isRenamingPart}
        isSubmitDisabled={partRenameValue.trim().length === 0 || partRenameValue.trim() === currentPartName}
        onSubmit={() => handleRenamePart(jobId, partRenameValue.trim())}
      />

      <Dialog open={showMoveDialog} onOpenChange={setShowMoveDialog}>
        <DialogContent className="border-white/10 bg-[#1f1f1f] text-white">
          <DialogHeader>
            <DialogTitle>Manage project membership</DialogTitle>
            <DialogDescription className="text-white/55">
              Add this part to more projects or remove it from projects it already belongs to.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {currentProjectOptions.length === 0 ? (
              <p className="text-sm text-white/45">No compatible projects are available for this part.</p>
            ) : (
              currentProjectOptions.map((project) => (
                <button
                  key={project.project.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-left transition hover:bg-white/4",
                    partDetail?.projectIds.includes(project.project.id) && "border-white/20",
                  )}
                  disabled={assignJobMutation.isPending || removeJobMutation.isPending}
                  onClick={() => {
                    if (partDetail?.projectIds.includes(project.project.id)) {
                      removeJobMutation.mutate(project.project.id);
                      return;
                    }

                    assignJobMutation.mutate(project.project.id);
                  }}
                >
                  <div>
                    <p className="text-sm font-medium text-white">{project.project.name}</p>
                    <p className="text-xs text-white/45">{project.partCount} parts</p>
                  </div>
                  {partDetail?.projectIds.includes(project.project.id) ? (
                    <XCircle className="h-4 w-4 text-white/45" />
                  ) : (
                    <MoveRight className="h-4 w-4 text-white/45" />
                  )}
                </button>
              ))
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              className="border-white/10 bg-transparent text-white hover:bg-white/6"
              onClick={() => setShowMoveDialog(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isDueDateDialogOpen} onOpenChange={setIsDueDateDialogOpen}>
        <DialogContent className="border-white/10 bg-[#1f1f1f] text-white">
          <DialogHeader>
            <DialogTitle>Set due date</DialogTitle>
            <DialogDescription className="text-white/55">
              Match the Linear issue action with quick-select dates or a typed date.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              {QUICK_DUE_DATE_PRESETS.map((preset) => (
                <Button
                  key={preset.label}
                  type="button"
                  variant="outline"
                  className="justify-start border-white/10 bg-transparent text-white hover:bg-white/6"
                  onClick={() => setDueDateDraft(addDays(new Date(), preset.days))}
                >
                  {preset.label}
                </Button>
              ))}
            </div>

            <div className="space-y-2">
              <label htmlFor="part-due-date" className="text-sm font-medium text-white/78">
                Due date
              </label>
              <Input
                id="part-due-date"
                type="date"
                value={dueDateDraft}
                onChange={(event) => setDueDateDraft(event.target.value)}
                className="border-white/10 bg-[#171717] text-white"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="border-white/10 bg-transparent text-white hover:bg-white/6"
              onClick={() => setDueDateDraft("")}
            >
              Clear
            </Button>
            <Button type="button" onClick={handleSaveDueDate}>
              Save due date
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isVersionHistoryOpen} onOpenChange={setIsVersionHistoryOpen}>
        <DialogContent className="max-w-3xl border-white/10 bg-[#1f1f1f] text-white">
          <DialogHeader>
            <DialogTitle>Version history</DialogTitle>
            <DialogDescription className="text-white/55">
              Current client-visible history combines activity events with browser-local comments.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 lg:grid-cols-2">
            <ActivityLog entries={activityEntries} className="bg-[#262626]" />
            <div className="rounded-[24px] border border-white/8 bg-[#262626] p-5">
              <p className="text-xs uppercase tracking-[0.18em] text-white/35">Comments</p>
              {comments.length === 0 ? (
                <p className="mt-4 text-sm text-white/45">No comments yet.</p>
              ) : (
                <div className="mt-4 space-y-3">
                  {comments.map((comment) => (
                    <article key={comment.id} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                      <p className="text-sm font-medium text-white">{comment.authorLabel}</p>
                      <p className="mt-1 text-xs uppercase tracking-[0.16em] text-white/35">
                        {new Date(comment.createdAt).toLocaleString()}
                      </p>
                      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-white/65">{comment.body}</p>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default ClientPart;
