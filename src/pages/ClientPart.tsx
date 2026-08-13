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
import { ClientQuoteRequestFlow } from "@/components/quotes/ClientQuoteRequestFlow";
import { QuoteIntelligenceShell } from "@/components/quote-intelligence/QuoteIntelligenceShell";
import { PartProductDataBar } from "@/components/quotes/PartProductDataBar";
import { PartViewerRow } from "@/components/quotes/PartViewerRow";
import { QuoteSelectionFunctionBar } from "@/components/quotes/QuoteSelectionFunctionBar";
import { PartInfoPanel } from "@/components/workspace/PartInfoPanel";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { ClientExtractionStatusNotice } from "@/components/quotes/ClientExtractionStatusNotice";
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
import { buildQuoteRequestViewModel } from "@/features/quotes/quote-request";
import {
  buildScopedPreset,
  getPresetMode,
  getPresetScope,
  type ClientQuoteSelectionOption,
} from "@/features/quotes/selection";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

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
      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground/80">{comment.body}</p>
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
    availableQuoteVendors,
    quoteLaneEligibility,
    isQuoteCollectionModeLoading,
    isQuoteVendorScopeLoading,
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
    handleSelectQuoteOption,
    handleToggleCurrentPartPin,
    handleToggleVendorExclusion,
    handleUnarchivePart,
    isDrawingPreviewLoading,
    isPartDetailLoading,
    isPartArchiveBusy,
    isCancelingQuoteRequest,
    isPartOptionsOpen,
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
    quoteVendorScopeError,
    rankedQuoteOptions,
    removeJobMutation,
    requestSummaryRequestedByDate,
    revisionOptions,
    saveRequestMutation,
    selectedQuoteOption,
    selectedQuoteVendors,
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
    workspaceAccessScope,
  } = useClientPartController(undefined, { warmNavigation: false });

  const notificationCenter = useWorkspaceNotifications({
    accessScope: workspaceAccessScope,
    jobIds: accessibleJobs.map((job) => job.id),
    role: activeMembership?.role,
    userId: user?.id,
  });

  const storageScopeKey = user?.id ?? "anonymous";

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
    return <AuthBootstrapScreen message="Restoring your part workspace." />;
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

  const handleConfirmQuoteRequest = async (vendors: typeof selectedQuoteVendors) => {
    const accepted = await handleRequestQuote(vendors);
    if (!accepted) return false;

    setIsQuoteRequestFlowOpen(false);
    window.requestAnimationFrame(() => {
      const quoteInformation = document.getElementById("quote-information");
      if (typeof quoteInformation?.scrollIntoView === "function") {
        quoteInformation.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    return true;
  };

  const handleWorkspaceOfferSelect = (option: ClientQuoteSelectionOption | null) => {
    if (option === null) {
      setSelectedOptionKey(null);
      handleSelectQuoteOption(null);
      return;
    }

    setSelectedOptionKey(option.key);
    handleSelectQuoteOption(option);
  };
  const partPresetScope = getPresetScope(activePreset);
  const partPresetMode = getPresetMode(activePreset);

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
            {quoteRequestViewModel ? (
              <ClientQuoteRequestStatusCard
                status={quoteRequestViewModel.status}
                tone={quoteRequestViewModel.tone}
                label={quoteRequestViewModel.label}
                detail={
                  !automaticQuoteCollectionEnabled &&
                  (quoteRequestViewModel.action.kind === "request" ||
                    quoteRequestViewModel.action.kind === "retry")
                    ? "Your sourcing guidance is available below. Pro enables automatic vendor quote collection."
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
                    : "Free sourcing preview"
                }
              />
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
      <ClientQuoteRequestFlow
        open={isQuoteRequestFlowOpen}
        onOpenChange={handleQuoteRequestFlowOpenChange}
        partLabel={displayPartTitle || currentPartName}
        availableVendors={availableQuoteVendors}
        laneEligibility={quoteLaneEligibility}
        initialSelectedVendors={selectedQuoteVendors}
        canSubmit={automaticQuoteCollectionEnabled}
        isLoading={isQuoteVendorScopeLoading || saveRequestMutation.isPending}
        isSubmitting={isRequestingQuote}
        loadError={quoteVendorScopeError}
        blockerReasons={quoteRequestViewModel?.blockerReasons ?? []}
        files={[
          ...(cadFile
            ? [{ kind: "CAD" as const, name: cadFile.original_name, sizeBytes: cadFile.size_bytes }]
            : []),
          ...(drawingFile
            ? [{ kind: "Drawing" as const, name: drawingFile.original_name, sizeBytes: drawingFile.size_bytes }]
            : []),
        ]}
        disclosureFields={[
          {
            label: "Description",
            value: partDetail?.part?.approvedRequirement?.description || "Not specified",
          },
          {
            label: "Quantity",
            value: partDetail?.part?.approvedRequirement?.quote_quantities.length
              ? `${partDetail.part.approvedRequirement.quote_quantities.join(", ")} pcs`
              : "Not specified",
          },
          {
            label: "Process",
            value:
              typeof partDetail?.part?.approvedRequirement?.spec_snapshot === "object" &&
              partDetail.part.approvedRequirement.spec_snapshot !== null &&
              !Array.isArray(partDetail.part.approvedRequirement.spec_snapshot) &&
              typeof partDetail.part.approvedRequirement.spec_snapshot.process === "string"
                ? partDetail.part.approvedRequirement.spec_snapshot.process
                : "Not specified",
          },
          {
            label: "Material",
            value: partDetail?.part?.approvedRequirement?.material || "Not specified",
          },
          {
            label: "Finish",
            value: partDetail?.part?.approvedRequirement?.finish || "Not specified",
          },
          {
            label: "Tightest tolerance",
            value: partDetail?.part?.approvedRequirement?.tightest_tolerance_inch != null
              ? `±${partDetail.part.approvedRequirement.tightest_tolerance_inch} in`
              : "Not specified",
          },
          {
            label: "Needed by",
            value: partDetail?.part?.approvedRequirement?.requested_by_date || "Not specified",
          },
          {
            label: "Specification",
            value: partDetail?.part?.approvedRequirement?.spec_snapshot
              ? JSON.stringify(partDetail.part.approvedRequirement.spec_snapshot)
              : "Not specified",
          },
        ]}
        onConfirm={handleConfirmQuoteRequest}
      />
      <QuoteIntelligenceShell
        title={displayPartTitle || "Part"}
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
                            className="rounded-full border border-border bg-muted px-3 py-1 text-foreground/80 transition hover:bg-accent hover:text-foreground"
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
                      disabled={isQuoteCollectionModeLoading}
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
                          className="text-rose-200 focus:bg-rose-500/10 focus:text-rose-100"
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
                    description="Set the sourcing criteria, then compare every quote by price and lead time."
                    options={rankedQuoteOptions}
                    selectedOption={
                      rankedQuoteOptions.find((option) => option.key === selectedOptionKey) ?? selectedQuoteOption
                    }
                    onSelect={handleWorkspaceOfferSelect}
                    requestedByDate={requestSummaryRequestedByDate}
                    quoteDataStatus={quoteDataStatus}
                    quoteDataMessage={quoteDataMessage}
                    quoteDiagnostics={quoteDiagnostics}
                    activePreset={activePreset}
                    onToggleVendorExclusion={handleToggleVendorExclusion}
                    headerActions={
                      <Button
                        type="button"
                        className="rounded-full shadow-sm"
                        onClick={() => navigate(appAwareHref(`/parts/${jobId}/review`))}
                        disabled={rankedQuoteOptions.length === 0}
                      >
                        Review order
                        <MoveRight className="ml-2 h-4 w-4" />
                      </Button>
                    }
                    controls={
                      <QuoteSelectionFunctionBar
                        scope={partPresetScope}
                        mode={partPresetMode}
                        requestedByDate={requestSummaryRequestedByDate}
                        matchingOptionCount={
                          requestSummaryRequestedByDate
                            ? rankedQuoteOptions.filter((option) => option.dueDateEligible).length
                            : null
                        }
                        totalOptionCount={rankedQuoteOptions.length}
                        onScopeChange={(nextScope) => applyPartPreset(partPresetMode, nextScope)}
                        onModeChange={(nextMode) => applyPartPreset(nextMode, partPresetScope)}
                        onRequestedByDateChange={(nextDate) => handleSaveRequestPatch({ requestedByDate: nextDate })}
                        disabled={saveRequestMutation.isPending}
                        dueDateHelpText="Highlights which vendors can meet the requested delivery date and dims the rest immediately."
                      />
                    }
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
                      <label htmlFor="activity-comment" className="text-sm font-medium text-foreground/80">
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
