import { STATUS_TONE } from "@/components/quotes/status-tone";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Archive,
  Bell,
  ChevronRight,
  Copy,
  Download,
  FolderInput,
  History,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Share2,
  Star,
  MoveRight,
  Upload,
  XCircle,
} from "lucide-react";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { ActivityLog } from "@/components/quotes/ActivityLog";
import { ClientQuoteDecisionPanel } from "@/components/quotes/ClientQuoteDecisionPanel";
import { ClientSourcingResultPanel } from "@/components/quotes/ClientSourcingResultPanel";
import { XometryBetaDispatchConfirmationDialog } from "@/components/quotes/XometryBetaDispatchConfirmationDialog";
import { getQuoteSelectionPrompt, hasPublishedQuotePackage } from "@/features/quotes/sourcing-result";
import { LIVE_DISPATCH_PROVIDER_LABELS } from "@/features/quotes/xometry-beta-dispatch";
import { requestAccountSettingsPanel } from "@/components/chat/account-settings-request";
import { QuoteIntelligenceShell } from "@/components/quote-intelligence/QuoteIntelligenceShell";
import { PartProductDataBar } from "@/components/quotes/PartProductDataBar";
import { PartViewerRow } from "@/components/quotes/PartViewerRow";
import { QuoteSelectionFunctionBar } from "@/components/quotes/QuoteSelectionFunctionBar";
import { SavedNeedByNotice } from "@/components/quotes/SavedNeedByNotice";
import { PartInfoPanel } from "@/components/workspace/PartInfoPanel";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { ClientExtractionStatusNotice } from "@/components/quotes/ClientExtractionStatusNotice";
import { ExportControlStatusNotice } from "@/components/quotes/ExportControlStatusNotice";
import { ClientPartHeader } from "@/components/quotes/ClientPartHeader";
import { DrawingPreviewDialog } from "@/components/quotes/DrawingPreviewDialog";
import { ClientQuoteRequestStatusCard } from "@/components/quotes/ClientWorkspacePanelContent";
import { ProjectNameDialog } from "@/components/projects/ProjectNameDialog";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useWorkspaceNotifications } from "@/features/notifications/use-workspace-notifications";
import { buildAppAwareHref } from "@/features/quotes/quote-intelligence-view-model";
import { useClientPartController } from "@/features/quotes/use-client-part-controller";
import { toPanelDeadline } from "@/features/quotes/api/part-deadline-api";
import { usePartDeadline } from "@/features/quotes/use-part-deadline";
import { buildQuoteRequestViewModel } from "@/features/quotes/quote-request";
import {
  buildScopedPreset,
  filterQuoteOptionsForScope,
  getPresetMode,
  getPresetScope,
  type ClientQuoteSelectionOption,
} from "@/features/quotes/selection";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/** OVD-991: the filter changes the view only, whether or not a Need by date is saved on the request. */
const NEED_BY_VIEW_ONLY_HELP_TEXT =
  "Highlights vendors that meet this date in this view only. It is not saved to the request.";
const NEED_BY_SAVED_HELP_TEXT =
  "Highlights which vendors can meet the requested delivery date and dims the rest immediately.";

type LocalComment = {
  id: string;
  body: string;
  authorLabel: string;
  createdAt: string;
};

function CommentCard({ comment }: { comment: LocalComment }) {
  return (
    <article className="rounded-lg border border-border bg-muted p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">{comment.authorLabel}</p>
        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
          {new Date(comment.createdAt).toLocaleString()}
        </p>
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground">{comment.body}</p>
    </article>
  );
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
  const [searchParams, setSearchParams] = useSearchParams();
  const appMode = searchParams.get("app") === "ios" ? "ios" : null;
  const appAwareHref = (href: string) => buildAppAwareHref(href, appMode);
  const {
    activeMembership,
    automaticQuoteCollectionEnabled,
    isQuoteCollectionModeLoading,
    isVerifiedAuth,
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
    handleCancelQuoteRequest,
    handleDeleteArchivedParts,
    handleDownloadFile,
    handleDraftChange,
    handlePresetSelection,
    handleRenamePart,
    handleRequestQuote,
    handleResetField,
    handleResetAllFields,
    handleSaveRequest,
    handleSaveRequestPatch,
    handleNeedByFilterChange,
    handleSelectQuoteOption,
    handleToggleCurrentPartPin,
    handleToggleVendorExclusion,
    handleUnarchivePart,
    isDrawingPreviewLoading,
    isPartDetailLoading,
    isPartArchiveBusy,
    isCancelingQuoteRequest,
    isPartOptionsOpen,
    isPlatformAdmin,
    isRequestingQuote,
    isRenamingPart,
    jobId,
    navigate,
    partDetail,
    partRenameValue,
    pinnedJobIds,
    presentation,
    projectCollaborationUnavailable,
    projectMemberships,
    quoteDataMessage,
    quoteDataStatus,
    quoteDiagnostics,
    quoteQuantityInput,
    rankedQuoteOptions,
    removeJobMutation,
    requestSummaryRequestedByDate,
    quoteViewRequestedByDate,
    needByFilterIsViewOnly,
    needByRemovalSavesDrawingThreads,
    revisionOptions,
    saveRequestMutation,
    singleQuantity,
    selectedQuoteOption,
    previousQuoteSelectionUnavailable,
    selectedRevisionIndex,
    sourcingResult,
    setIsPartArchiveBusy,
    setIsPartOptionsOpen,
    setPartRenameValue,
    setQuoteQuantityInput,
    setShowDrawingPreview,
    setShowMoveDialog,
    setShowRenameDialog,
    showDrawingPreview,
    showMoveDialog,
    showRenameDialog,
    signOut,
    summary,
    user,
    accessibleJobs,
    isAuthInitializing,
    hasCachedSession,
    workspaceAccessScope,
    quoteConfirmationIdentity,
    canRecoverQuoteRequest,
    dispatchProvider,
    providerFanout,
    xometryDispatchScope,
    xometryDispatchScopeError,
    xometryDispatchScopeDenialCode,
    xometryDispatchUnits,
    setXometryDispatchUnits,
    refetchXometryDispatchScope,
    isXometryDispatchScopeLoading,
  } = useClientPartController(undefined, { warmNavigation: false });

  const notificationCenter = useWorkspaceNotifications({
    accessScope: workspaceAccessScope,
    isPlatformAdmin,
    jobIds: accessibleJobs.map((job) => job.id),
    role: activeMembership?.role,
    userId: user?.id,
  });

  const storageScopeKey = user?.id ?? "anonymous";
  const partDeadline = usePartDeadline(partDetail?.part?.id);

  const [selectedOptionKey, setSelectedOptionKey] = useState<string | null>(selectedQuoteOption?.key ?? null);
  const [comments, setComments] = useState<LocalComment[]>([]);
  const [commentDraft, setCommentDraft] = useState("");
  const [isActivityOpen, setIsActivityOpen] = useState(false);
  const [showCancelRequestDialog, setShowCancelRequestDialog] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(true);
  const [isVersionHistoryOpen, setIsVersionHistoryOpen] = useState(false);
  const [isQuoteRequestFlowOpen, setIsQuoteRequestFlowOpen] = useState(false);

  useEffect(() => {
    if (searchParams.get("quote") !== "request") {
      return;
    }

    setIsQuoteRequestFlowOpen(true);
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("quote");
    setSearchParams(nextSearchParams, { replace: true });
  }, [searchParams, setSearchParams]);

  const hasPublishedPackage = hasPublishedQuotePackage(partDetail);
  const validSelectedQuoteOption =
    rankedQuoteOptions.find((option) => option.isSelectable && option.key === selectedOptionKey) ??
    selectedQuoteOption;
  // Keep optimistic highlighting, but review must use the persisted package choice.
  const reviewQuoteOption = hasPublishedPackage ? selectedQuoteOption : validSelectedQuoteOption;

  useEffect(() => {
    setSelectedOptionKey(selectedQuoteOption?.key ?? null);
  }, [selectedQuoteOption?.key]);

  useEffect(() => {
    setComments(readStoredComments(storageScopeKey, jobId));
    setIsSubscribed(readStoredSubscribed(storageScopeKey, jobId));
  }, [jobId, storageScopeKey]);

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

  if (isAuthInitializing && !user) {
    // A persisted session means the user is probably signed in: draw the shell now and keep
    // part data and the account menu gated on the verified `user`.
    return hasCachedSession ? (
      <QuoteIntelligenceShell title="Part">
        <div className="flex min-h-[320px] flex-1 items-center justify-center" role="status" aria-label="Restoring your part workspace">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </QuoteIntelligenceShell>
    ) : (
      <AuthBootstrapScreen message="Restoring your part workspace." />
    );
  }

  if (!user) {
    return null;
  }

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

    if (quoteRequestViewModel.action.kind === "cancel") {
      setShowCancelRequestDialog(true);
      return;
    }

    setIsQuoteRequestFlowOpen(true);
  };

  const handleQuoteRequestFlowOpenChange = (open: boolean) => {
    if (open && saveRequestMutation.isPending) {
      return;
    }

    setIsQuoteRequestFlowOpen(open);
  };

  const handleConfirmQuoteRequest = async (input: {
    approvalReference: string;
    declaredModelUnits: "inch" | "millimeter";
    envelopeRevision?: string;
    policyRevision: string;
    scopeFingerprint: string;
  }) => {
    return handleRequestQuote(input);
  };

  const handleWorkspaceOfferSelect = (option: ClientQuoteSelectionOption | null) => {
    const persistedKey = selectedQuoteOption?.key ?? null;
    setSelectedOptionKey(option?.key ?? null);
    // The mutation's own error toast is the error state; only the local selection needs rolling back.
    handleSelectQuoteOption(option, () => setSelectedOptionKey(persistedKey));
  };
  const reviewOrderDisabledForSelection = (hasPublishedPackage || rankedQuoteOptions.length > 0) && !reviewQuoteOption;

  const partPresetScope = getPresetScope(activePreset);
  const partPresetMode = getPresetMode(activePreset);
  const scopedOptions = filterQuoteOptionsForScope(rankedQuoteOptions, partPresetScope);
  const reviewOrderDisabledForScope = Boolean(reviewQuoteOption) &&
    (scopedOptions.length === 0 || !scopedOptions.some((option) => option.key === reviewQuoteOption?.key));
  const reviewOrderDisabledReason = reviewOrderDisabledForScope
    ? "Switch to All sourcing to see your selected quote"
    : reviewOrderDisabledForSelection ? getQuoteSelectionPrompt(hasPublishedPackage) : undefined;

  const applyPartPreset = (mode: "balanced" | "cheapest" | "fastest", scope: "domestic" | "global") => {
    handlePresetSelection(buildScopedPreset(mode, scope));
  };

  const breadcrumbProject = projectMemberships[0]?.project ?? null;
  const isFavorite = pinnedJobIds.includes(jobId);
  const currentUrl = typeof window === "undefined"
    ? appAwareHref(`/parts/${jobId}`)
    : new URL(appAwareHref(`/parts/${jobId}`), window.location.origin).toString();

  const navigateToAdjacentRevision = (direction: "previous" | "next") => {
    if (revisionOptions.length < 2) {
      return;
    }

    const offset = direction === "previous" ? -1 : 1;
    const nextIndex = (selectedRevisionIndex + offset + revisionOptions.length) % revisionOptions.length;
    const revisionJobId = revisionOptions[nextIndex]?.jobId;

    if (revisionJobId) {
      navigate(appAwareHref(`/parts/${revisionJobId}`));
    }
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(currentUrl);
      toast.success("Part link copied.");
    } catch {
      toast.error("Unable to copy the part link.");
    }
  };

  const handleSharePart = async () => {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: displayPartTitle || "Part",
          url: currentUrl,
        });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
      }
    }

    await handleCopyLink();
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

  const dbDefaults = partDetail?.part?.clientRequirement?.projectPartProperties?.defaults;
  const extractionDefaults = extraction
    ? {
        description: extraction.description,
        partNumber: extraction.partNumber,
        revision: extraction.revision ?? null,
        material: extraction.material.normalized ?? extraction.material.raw,
        finish: extraction.finish.normalized ?? extraction.finish.raw,
        tightestToleranceInch: extraction.tightestTolerance.valueInch,
        threads: extraction.threads?.join(", ") ?? null,
        process: null,
      }
    : undefined;

  const partFieldDefaults = dbDefaults
    ? { ...extractionDefaults, ...dbDefaults }
    : extractionDefaults;

  const partInformation =
    partDetail?.job && presentation ? (
      <PartInfoPanel
        effectiveRequestDraft={effectiveRequestDraft}
        quoteQuantityInput={quoteQuantityInput}
        onQuoteQuantityInputChange={setQuoteQuantityInput}
        onDraftChange={handleDraftChange}
        onSave={handleSaveRequest}
        onUploadRevision={attachFilesPicker.openFilePicker}
        isSaving={saveRequestMutation.isPending}
        onResetField={handleResetField}
        onResetAllFields={handleResetAllFields}
        fieldDefaults={partFieldDefaults}
        singleQuantity={singleQuantity}
        statusContent={
          <>
            {revisionOptions.length > 1 ? (
              <section aria-label="Revision navigation" className="border-b border-border pb-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                      Revision
                    </p>
                    <p className="mt-1 truncate text-sm text-foreground">
                      {revisionOptions[selectedRevisionIndex]?.title ?? displayPartTitle}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="rounded-[4px]"
                      onClick={() => navigateToAdjacentRevision("previous")}
                    >
                      Previous
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="rounded-[4px]"
                      onClick={() => navigateToAdjacentRevision("next")}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </section>
            ) : null}
            <ClientExtractionStatusNotice diagnostics={extractionDiagnostics} />
            <ExportControlStatusNotice jobId={jobId} />
            {quoteRequestViewModel ? (
              <ClientQuoteRequestStatusCard
                status={quoteRequestViewModel.status}
                tone={quoteRequestViewModel.tone}
                label={quoteRequestViewModel.label}
                detail={
                  !automaticQuoteCollectionEnabled &&
                  (quoteRequestViewModel.action.kind === "request" ||
                    quoteRequestViewModel.action.kind === "retry")
                    ? "Automatic quote collection is not enabled for this organization. Provider recommendations and official RFQ links remain available. The Founding Beta is free and invitation-only. No payment card, order, or supplier commitment is created."
                    : quoteRequestViewModel.detail
                }
                actionLabel={
                  !automaticQuoteCollectionEnabled &&
                  (quoteRequestViewModel.action.kind === "request" ||
                    quoteRequestViewModel.action.kind === "retry")
                    ? null
                    : quoteRequestViewModel.action.label
                }
                actionDisabled={
                  quoteRequestViewModel.action.disabled
                  || isCancelingQuoteRequest
                  || isQuoteCollectionModeLoading
                }
                blockerReasons={quoteRequestViewModel.blockerReasons}
                isBusy={isRequestingQuote || isCancelingQuoteRequest}
                onAction={
                  quoteRequestViewModel.action.kind === "none" ||
                  (!automaticQuoteCollectionEnabled &&
                    (quoteRequestViewModel.action.kind === "request" ||
                      quoteRequestViewModel.action.kind === "retry"))
                    ? null
                    : handleQuoteRequestAction
                }
                heading={
                  automaticQuoteCollectionEnabled
                    ? "Automatic quote status"
                    : "Automatic quote access"
                }
              />
            ) : null}
            {canRecoverQuoteRequest ? (
              <section aria-label="Previous quote request" className="space-y-3 border-t border-border pt-4">
                <p className="text-sm text-muted-foreground">
                  Your previous request has an unconfirmed outcome. Reopen its original confirmation to check safely.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleQuoteRequestFlowOpenChange(true)}
                >
                  Check previous quote request
                </Button>
              </section>
            ) : null}
          </>
        }
      />
    ) : null;

  return (
    <>
      <AlertDialog open={showCancelRequestDialog} onOpenChange={setShowCancelRequestDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel quote request?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the current vendor quote request for this package. You can request a new quote again after canceling.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep request</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const requestId = partDetail?.latestQuoteRequest?.id;

                if (!requestId) {
                  return;
                }

                void handleCancelQuoteRequest(requestId);
              }}
              disabled={isCancelingQuoteRequest}
            >
              {isCancelingQuoteRequest ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Cancel request
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <XometryBetaDispatchConfirmationDialog
        key={quoteConfirmationIdentity}
        open={isQuoteRequestFlowOpen}
        onOpenChange={handleQuoteRequestFlowOpenChange}
        declaredModelUnits={xometryDispatchUnits}
        onDeclaredModelUnitsChange={setXometryDispatchUnits}
        provider={dispatchProvider}
        fanout={providerFanout}
        scope={automaticQuoteCollectionEnabled ? xometryDispatchScope : null}
        isScopeLoading={isXometryDispatchScopeLoading || saveRequestMutation.isPending}
        isSubmitting={isRequestingQuote}
        scopeError={
          automaticQuoteCollectionEnabled
            ? xometryDispatchScopeError
            : `Automatic ${LIVE_DISPATCH_PROVIDER_LABELS[dispatchProvider]} beta dispatch is not enabled for this organization.`
        }
        scopeDenialCode={automaticQuoteCollectionEnabled ? xometryDispatchScopeDenialCode : null}
        organizationId={partDetail?.job.organization_id ?? null}
        onOpenSourcingSettings={() => {
          handleQuoteRequestFlowOpenChange(false);
          requestAccountSettingsPanel();
        }}
        onRetryScope={async () => {
          await refetchXometryDispatchScope();
        }}
        onConfirm={handleConfirmQuoteRequest}
      />
      <QuoteIntelligenceShell
        title={displayPartTitle || "Part"}
        foundingBetaAccess={{
          organizationId: partDetail?.job.organization_id,
          userId: user.id,
          enabled: isVerifiedAuth,
        }}
        accountSlot={
          <WorkspaceAccountMenu
            user={user}
            compact
            activeMembership={activeMembership}
            notificationCenter={notificationCenter}
            onSignOut={signOut}
            onSignedOut={() => navigate(appAwareHref("/"), { replace: true })}
            archivedProjects={archivedProjectsQuery.data}
            archivedJobs={archivedJobsQuery.data}
            isArchiveLoading={archivedProjectsQuery.isLoading || archivedJobsQuery.isLoading}
            onUnarchivePart={handleUnarchivePart}
            onDeleteArchivedParts={handleDeleteArchivedParts}
          />
        }
      >
        <div className="flex w-full flex-1 flex-col gap-6">
          {isPartDetailLoading ? (
            <div className="flex min-h-[320px] items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : null}
          {!isPartDetailLoading && (!partDetail?.job || !presentation) ? (
            <div className="rounded-[26px] border border-border bg-ws-card px-6 py-12 text-center text-muted-foreground">
              This part could not be loaded.
            </div>
          ) : null}
          {!isPartDetailLoading && partDetail?.job && presentation ? (
            <>
              <ClientPartHeader
                className="rounded-[12px]"
                title={null}
                description={presentation.description}
                details={
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                      {breadcrumbProject ? (
                        <>
                          <Link
                            to={appAwareHref(`/projects/${breadcrumbProject.id}`)}
                            className="rounded-full border border-border bg-muted px-3 py-1 text-foreground transition hover:bg-accent hover:text-foreground"
                          >
                            {breadcrumbProject.name}
                          </Link>
                          <span className="text-muted-foreground">/</span>
                        </>
                      ) : null}
                      <span className="rounded-full border border-border bg-accent px-3 py-1 text-foreground">
                        {displayPartTitle}
                      </span>
                    </div>
                  </div>
                }
                actions={
                  <>
                    <Button
                      type="button"
                      onClick={() => setIsQuoteRequestFlowOpen(true)}
                      disabled={isQuoteCollectionModeLoading || !automaticQuoteCollectionEnabled}
                    >
                      Quote
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label="Download CAD file"
                      title={cadFile ? `Download ${cadFile.original_name}` : "No CAD file available"}
                      className="rounded-[2px] border-border bg-transparent text-foreground hover:bg-accent"
                      onClick={() => {
                        if (cadFile) {
                          void handleDownloadFile(cadFile);
                        }
                      }}
                      disabled={!cadFile}
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label="Upload part files"
                      title="Upload part files"
                      className="rounded-[2px] border-border bg-transparent text-foreground hover:bg-accent"
                      onClick={attachFilesPicker.openFilePicker}
                    >
                      <Upload className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label="Share part"
                      title="Share part"
                      className="rounded-[2px] border-border bg-transparent text-foreground hover:bg-accent"
                      onClick={() => void handleSharePart()}
                    >
                      <Share2 className="h-4 w-4" />
                    </Button>
                    <DropdownMenu open={isPartOptionsOpen} onOpenChange={setIsPartOptionsOpen}>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label="More part actions"
                          className="rounded-[2px] border-border bg-transparent text-foreground hover:bg-accent"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="w-64 border-border bg-ws-overlay p-2 text-foreground"
                      >
                        {projectMemberships.length === 1 ? (
                          <DropdownMenuItem
                            onSelect={(event) => {
                              event.preventDefault();
                              setIsPartOptionsOpen(false);
                              navigate(appAwareHref(`/projects/${projectMemberships[0]!.project.id}`));
                            }}
                          >
                            <FolderInput className="mr-2 h-4 w-4" />
                            Open project
                          </DropdownMenuItem>
                        ) : null}
                        {!projectCollaborationUnavailable ? (
                          <DropdownMenuItem
                            onSelect={(event) => {
                              event.preventDefault();
                              setIsPartOptionsOpen(false);
                              setShowMoveDialog(true);
                            }}
                          >
                            <FolderInput className="mr-2 h-4 w-4" />
                            Manage projects
                          </DropdownMenuItem>
                        ) : null}
                        {projectMemberships.length === 1 || !projectCollaborationUnavailable ? (
                          <DropdownMenuSeparator className="bg-border" />
                        ) : null}
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
                        <DropdownMenuSeparator className="bg-border" />
                        <DropdownMenuItem
                          onSelect={(event) => {
                            event.preventDefault();
                            setIsPartOptionsOpen(false);
                            setIsPartArchiveBusy(true);
                            void handleArchivePart(jobId).finally(() => setIsPartArchiveBusy(false));
                          }}
                          disabled={isPartArchiveBusy}
                          className={STATUS_TONE.action}
                        >
                          <Archive className="mr-2 h-4 w-4" />
                          Archive part
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                }
              >
                <div className="space-y-5">
                  <PartViewerRow
                    itemKey={jobId}
                    cadFile={cadFile}
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
                  <section aria-labelledby="part-information-heading" className="border-t border-border pt-4">
                    <h2 id="part-information-heading" className="sr-only">Part summary</h2>
                    <PartProductDataBar
                      part={partDetail.part}
                      summary={summary}
                      extraction={extraction}
                      draft={effectiveRequestDraft}
                    />
                  </section>
                </div>
              </ClientPartHeader>

              {partInformation}

              <section
                id="quote-information"
                aria-label="Quote information"
                className="scroll-mt-6 space-y-4 border-t border-border pt-5"
              >
                {sourcingResult?.outcome === "unsupported_package" ? (
                  <ClientSourcingResultPanel
                    result={sourcingResult}
                    selectedProcess={effectiveRequestDraft?.process}
                    isProcessSaving={saveRequestMutation.isPending}
                    onProcessSelect={(process) => handleSaveRequestPatch({ process })}
                  />
                ) : null}
                <ClientQuoteDecisionPanel
                    className="rounded-[12px]"
                    title="Quote comparison"
                    description="Set the sourcing criteria, then compare every quote by delivered date and expected delivered cost."
                    options={rankedQuoteOptions}
                    selectedOption={validSelectedQuoteOption}
                    previousSelectionUnavailable={previousQuoteSelectionUnavailable}
                    onSelect={handleWorkspaceOfferSelect}
                    requestedByDate={quoteViewRequestedByDate}
                    quoteDataStatus={quoteDataStatus}
                    quoteDataMessage={quoteDataMessage}
                    quoteDiagnostics={quoteDiagnostics}
                    activePreset={activePreset}
                    onScopeChange={(scope) => applyPartPreset(partPresetMode, scope)}
                    onToggleVendorExclusion={handleToggleVendorExclusion}
                    deadline={toPanelDeadline(partDeadline)}
                    requestCompletion={{
                      request: partDetail.latestQuoteRequest
                        ? {
                            id: partDetail.latestQuoteRequest.id,
                            status: partDetail.latestQuoteRequest.status,
                            requestedVendors: partDetail.latestQuoteRequest.requested_vendors,
                          }
                        : null,
                      run: partDetail.latestQuoteRun
                        ? { id: partDetail.latestQuoteRun.id, quoteRequestId: partDetail.latestQuoteRun.quote_request_id }
                        : null,
                      vendorResults: (partDetail.part?.vendorQuotes ?? []).map((quote) => ({
                        id: quote.id,
                        vendor: quote.vendor,
                        quoteRunId: quote.quote_run_id,
                        status: quote.status,
                      })),
                    }}
                    headerActions={
                      <div className="flex shrink-0 flex-col items-start gap-2 lg:items-end">
                        <Button
                          type="button"
                          className="rounded-full shadow-sm"
                          onClick={() => navigate(appAwareHref(`/parts/${jobId}/review`))}
                          disabled={scopedOptions.length === 0 || !reviewQuoteOption || reviewOrderDisabledForScope}
                          title={reviewOrderDisabledReason}
                          aria-describedby={reviewOrderDisabledReason ? "review-order-disabled-reason" : undefined}
                        >
                          Review order
                          <MoveRight className="ml-2 h-4 w-4" />
                        </Button>
                        {reviewOrderDisabledReason ? (
                          <span id="review-order-disabled-reason" className="text-sm text-muted-foreground">
                            {reviewOrderDisabledReason}
                          </span>
                        ) : null}
                      </div>
                    }
                    controls={(deadlineCounts, viewDeadline) => (
                      <>
                        {needByFilterIsViewOnly && requestSummaryRequestedByDate ? (
                          <SavedNeedByNotice
                            requestedByDate={requestSummaryRequestedByDate}
                            onRemove={() => handleSaveRequestPatch({ requestedByDate: null })}
                            disabled={saveRequestMutation.isPending}
                            savesDrawingThreads={needByRemovalSavesDrawingThreads}
                          />
                        ) : null}
                        <QuoteSelectionFunctionBar
                          scope={partPresetScope}
                          requestedByDate={quoteViewRequestedByDate}
                          viewDeadline={viewDeadline}
                          deadlineCounts={viewDeadline ? deadlineCounts : null}
                          onScopeChange={(nextScope) => applyPartPreset(partPresetMode, nextScope)}
                          onRequestedByDateChange={handleNeedByFilterChange}
                          disabled={saveRequestMutation.isPending}
                          dueDateHelpText={
                            needByFilterIsViewOnly
                              ? NEED_BY_VIEW_ONLY_HELP_TEXT
                              : NEED_BY_SAVED_HELP_TEXT
                          }
                        />
                      </>
                    )}
                />
                {sourcingResult && sourcingResult.outcome !== "unsupported_package" ? (
                  <ClientSourcingResultPanel
                    result={sourcingResult}
                    selectedProcess={effectiveRequestDraft?.process}
                    isProcessSaving={saveRequestMutation.isPending}
                    onProcessSelect={(process) => handleSaveRequestPatch({ process })}
                  />
                ) : null}
              </section>

              <section className="border-t border-border pt-4">
                <button
                  type="button"
                  aria-expanded={isActivityOpen}
                  aria-controls="part-activity"
                  onClick={() => setIsActivityOpen((isOpen) => !isOpen)}
                  className="flex w-full items-center justify-between rounded-[4px] px-2 py-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span>Activity and history</span>
                  <ChevronRight
                    aria-hidden="true"
                    className={cn("h-4 w-4 text-muted-foreground transition-transform", isActivityOpen && "rotate-90")}
                  />
                </button>
                {isActivityOpen ? (
                  <div id="part-activity" className="mt-3 border-t border-border pt-5">
                    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Activity</p>
                        <h2 className="mt-2 text-xl font-semibold text-foreground">Comments and history</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Leave context for collaborators and review the part activity feed.
                        </p>
                      </div>
                    </div>

                    <div className="mt-5 rounded-surface-lg border border-border bg-muted p-4">
                      <label htmlFor="activity-comment" className="text-sm font-medium text-foreground">
                        Leave a comment
                      </label>
                      <Textarea
                        id="activity-comment"
                        value={commentDraft}
                        onChange={(event) => setCommentDraft(event.target.value)}
                        placeholder="Add context, decisions, or a follow-up note."
                        className="mt-3 min-h-28 border-border bg-ws-shell text-foreground placeholder:text-muted-foreground"
                      />
                      <div className="mt-3 flex items-center justify-between gap-3">
                        <p className="text-xs text-muted-foreground">
                          Comments stay attached to this part in your current browser.
                        </p>
                        <Button type="button" onClick={handleAddComment} disabled={commentDraft.trim().length === 0}>
                          <MessageSquare className="mr-2 h-4 w-4" />
                          Comment
                        </Button>
                      </div>
                    </div>

                    <Tabs defaultValue="activity" className="mt-5">
                      <TabsList className="h-auto flex-wrap justify-start gap-2 rounded-[16px] bg-muted p-1.5">
                        <TabsTrigger value="activity">Activity</TabsTrigger>
                        <TabsTrigger value="comments">Comments</TabsTrigger>
                      </TabsList>

                      <TabsContent value="activity" className="mt-4">
                        <ActivityLog entries={activityEntries} />
                      </TabsContent>
                      <TabsContent value="comments" className="mt-4">
                        <div className="rounded-surface-lg border border-border bg-ws-card p-5">
                          {comments.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No comments yet.</p>
                          ) : (
                            <div className="space-y-3">
                              {comments.map((comment) => (
                                <CommentCard key={comment.id} comment={comment} />
                              ))}
                            </div>
                          )}
                        </div>
                      </TabsContent>
                    </Tabs>
                  </div>
                ) : null}
              </section>
            </>
          ) : null}
        </div>
      </QuoteIntelligenceShell>

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
        <DialogContent className="border-border bg-ws-overlay text-foreground">
          <DialogHeader>
            <DialogTitle>Manage project membership</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Add this part to more projects or remove it from projects it already belongs to.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {currentProjectOptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No compatible projects are available for this part.</p>
            ) : (
              currentProjectOptions.map((project) => (
                <button
                  key={project.project.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between rounded-lg border border-border bg-muted px-4 py-3 text-left transition hover:bg-accent",
                    partDetail?.projectIds.includes(project.project.id) && "border-foreground/30",
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
                    <p className="text-sm font-medium text-foreground">{project.project.name}</p>
                    <p className="text-xs text-muted-foreground">{project.partCount} parts</p>
                  </div>
                  {partDetail?.projectIds.includes(project.project.id) ? (
                    <XCircle className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <MoveRight className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>
              ))
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              className="border-border bg-transparent text-foreground hover:bg-accent"
              onClick={() => setShowMoveDialog(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isVersionHistoryOpen} onOpenChange={setIsVersionHistoryOpen}>
        <DialogContent className="max-w-3xl border-border bg-ws-overlay text-foreground">
          <DialogHeader>
            <DialogTitle>Version history</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Current client-visible history combines activity events with browser-local comments.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 lg:grid-cols-2">
            <ActivityLog entries={activityEntries} className="bg-ws-card" />
            <div className="rounded-surface-lg border border-border bg-ws-card p-5">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Comments</p>
              {comments.length === 0 ? (
                <p className="mt-4 text-sm text-muted-foreground">No comments yet.</p>
              ) : (
                <div className="mt-4 space-y-3">
                  {comments.map((comment) => (
                    <CommentCard key={comment.id} comment={comment} />
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
