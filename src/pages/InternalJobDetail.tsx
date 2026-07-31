import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AppShell } from "@/components/app/AppShell";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { EmailVerificationPrompt } from "@/components/EmailVerificationPrompt";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchManualQuoteOperatorAccess } from "@/features/quotes/api/manual-quote-admin-api";
import { useAppSession } from "@/hooks/use-app-session";
import type { ManualQuoteCompletionTarget } from "@/components/quotes/ManualQuoteIntakeCard";
import { InternalJobDebugSection } from "./internal-job-detail/InternalJobDebugSection";
import { InternalJobHeaderActions } from "./internal-job-detail/InternalJobHeaderActions";
import { InternalJobOverviewSection } from "./internal-job-detail/InternalJobOverviewSection";
import { InternalJobPublicationCard } from "./internal-job-detail/InternalJobPublicationCard";
import { InternalJobRequirementsSection } from "./internal-job-detail/InternalJobRequirementsSection";
import { InternalJobVendorCompareSection } from "./internal-job-detail/InternalJobVendorCompareSection";
import { InternalJobWorkerQueueCard } from "./internal-job-detail/InternalJobWorkerQueueCard";
import { useInternalJobDetailQuery } from "./internal-job-detail/use-internal-job-detail-query";
import { useInternalJobDetailMutations } from "./internal-job-detail/use-internal-job-detail-mutations";
import { useInternalJobDetailViewModel } from "./internal-job-detail/internal-job-detail-view-model";
import { recordWorkspaceSessionDiagnostic } from "@/lib/workspace-session-diagnostics";

function getManualQuoteIntakeDisabled(
  completionTarget: ManualQuoteCompletionTarget | null,
  isVerifiedAuth: boolean,
  anyWritePending: boolean,
  isDiagnosticReadOnlyView: boolean,
  fullyWriteActionsDisabled: boolean,
): boolean {
  if (!completionTarget) {
    return fullyWriteActionsDisabled;
  }

  return !isVerifiedAuth || anyWritePending || isDiagnosticReadOnlyView;
}

const InternalJobDetail = () => {
  const navigate = useNavigate();
  const { jobId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const targetRequestId = searchParams.get("quoteRequestId");
  const targetQuoteRunId = searchParams.get("quoteRunId");
  const hasCompletionIntent = Boolean(targetRequestId || targetQuoteRunId);
  const { user, activeMembership, isPlatformAdmin, isVerifiedAuth, signOut, isAuthInitializing } =
    useAppSession();
  const queryState = useInternalJobDetailQuery({
    activeMembership,
    hasUser: Boolean(user),
    isPlatformAdmin,
    jobId,
  });
  const isDiagnosticReadOnlyView = Boolean(activeMembership?.role === "client" && queryState.allowDiagnosticReadOnly);
  const showInternalDiagnostics = activeMembership?.role !== "client";
  const viewModel = useInternalJobDetailViewModel({
    job: queryState.job,
    latestQuoteRun: queryState.latestQuoteRun,
  });
  const mutations = useInternalJobDetailMutations({
    clientSummary: viewModel.clientSummary,
    drafts: viewModel.drafts,
    forcePublish: queryState.readinessQuery.data?.ready === false,
    jobId,
    latestQuoteRunId: queryState.latestQuoteRun?.id ?? null,
    navigate,
    signOut,
    userEmail: user?.email ?? null,
  });
  const manualQuoteAccessQuery = useQuery({
    queryKey: ["manual-quote-admin-access"],
    queryFn: fetchManualQuoteOperatorAccess,
    enabled: Boolean(user) && hasCompletionIntent,
  });
  const anyWritePending =
    mutations.requestExtractionMutation.isPending ||
    mutations.saveRequirementsMutation.isPending ||
    mutations.startQuoteRunMutation.isPending ||
    mutations.publishMutation.isPending;
  const isCrossOrgReadOnlyView = Boolean(
    isPlatformAdmin &&
      activeMembership?.organizationId &&
      queryState.job?.job.organization_id &&
      activeMembership.organizationId !== queryState.job.job.organization_id,
  );
  const writeActionsDisabled = !isVerifiedAuth || anyWritePending || isCrossOrgReadOnlyView;
  const fullyWriteActionsDisabled = writeActionsDisabled || isDiagnosticReadOnlyView;
  const completionTarget = useMemo<ManualQuoteCompletionTarget | null>(() => {
    if (!hasCompletionIntent) {
      return null;
    }

    const request = queryState.job?.quoteRequests?.find(
      (candidate) => candidate.id === targetRequestId,
    );
    const quoteRun = queryState.job?.quoteRuns.find(
      (candidate) => candidate.id === targetQuoteRunId,
    );
    const access = manualQuoteAccessQuery.data;
    let staleReason: string | null = null;

    if (!targetRequestId || !targetQuoteRunId) {
      staleReason = "This inbox link is incomplete. Return to the queue and open the request again.";
    } else if (manualQuoteAccessQuery.isLoading) {
      staleReason = "Checking manual-request authorization.";
    } else if (manualQuoteAccessQuery.isError || !access?.hasCapability) {
      staleReason = "You are not authorized to complete manual quote requests.";
    } else if (!request) {
      staleReason = "This manual request is no longer available on the selected job.";
    } else if (!quoteRun) {
      staleReason = "The linked quote run is no longer available on the selected job.";
    } else if (
      request.request_mode !== "manual" ||
      request.job_id !== jobId ||
      quoteRun.job_id !== jobId ||
      quoteRun.quote_request_id !== request.id
    ) {
      staleReason = "The request, quote run, and job lineage no longer match.";
    } else if (!["queued", "requesting"].includes(request.status)) {
      staleReason = `This request is already ${request.status}.`;
    } else if (!["queued", "running"].includes(quoteRun.status)) {
      staleReason = `The linked quote run is already ${quoteRun.status}.`;
    } else if (queryState.job?.job.status !== "awaiting_vendor_manual_review") {
      staleReason = `This job is already ${queryState.job?.job.status ?? "unavailable"}.`;
    }

    return {
      requestId: targetRequestId ?? "missing-request",
      quoteRunId: targetQuoteRunId,
      jobId,
      requestStatus: request?.status ?? null,
      quoteRunStatus: quoteRun?.status ?? null,
      jobStatus: queryState.job?.job.status ?? null,
      partIds: queryState.job?.parts.map((part) => part.id) ?? [],
      isStale: staleReason !== null,
      staleReason,
      hasAal2: access?.hasAal2 === true,
    };
  }, [
    hasCompletionIntent,
    jobId,
    manualQuoteAccessQuery.data,
    manualQuoteAccessQuery.isError,
    manualQuoteAccessQuery.isLoading,
    queryState.job,
    targetQuoteRunId,
    targetRequestId,
  ]);
  const manualQuoteIntakeDisabled = getManualQuoteIntakeDisabled(
    completionTarget,
    isVerifiedAuth,
    anyWritePending,
    isDiagnosticReadOnlyView,
    fullyWriteActionsDisabled,
  );

  if (isAuthInitializing) {
    return <AuthBootstrapScreen message="Restoring your internal review session." />;
  }

  if (!user) {
    recordWorkspaceSessionDiagnostic(
      "warn",
      "internal-job-detail.redirect.unauthenticated",
      "Redirecting to sign-in after startup auth resolution completed without a user.",
      {
        jobId,
      },
    );
    return <Navigate to="/?auth=signin" replace />;
  }

  if (!activeMembership || (activeMembership.role === "client" && !isDiagnosticReadOnlyView)) {
    return <Navigate to="/" replace />;
  }

  if (queryState.jobQuery.isLoading) {
    return (
      <AppShell title="Loading job" subtitle="Collecting job state, extraction evidence, and quote results.">
        <div className="flex min-h-[40vh] items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppShell>
    );
  }

  if (!queryState.job) {
    return (
      <AppShell title="Job unavailable" subtitle="The requested job could not be loaded.">
        <Card className="border-destructive/30 bg-destructive/10">
          <CardContent className="p-6 text-sm text-destructive">
            {queryState.jobQuery.error instanceof Error
              ? queryState.jobQuery.error.message
              : "Unknown error"}
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell
      title={queryState.job.job.title}
      subtitle={
        queryState.job.job.description ||
        "Internal review, quote orchestration, and publication for this CNC job."
      }
      actions={
        <InternalJobHeaderActions
          onRequestExtraction={() => mutations.requestExtractionMutation.mutate()}
          onSaveRequirements={() => mutations.saveRequirementsMutation.mutate()}
          onStartQuoteRun={() => mutations.startQuoteRunMutation.mutate()}
          requestExtractionPending={mutations.requestExtractionMutation.isPending}
          saveRequirementsPending={mutations.saveRequirementsMutation.isPending}
          startQuoteRunPending={mutations.startQuoteRunMutation.isPending}
          writeActionsDisabled={fullyWriteActionsDisabled}
        />
      }
    >
      {!isVerifiedAuth && user.email ? (
        <section className="mb-8">
          <EmailVerificationPrompt
            email={user.email}
            isRefreshing={mutations.isRefreshingVerification}
            isResending={mutations.isResendingVerification}
            onRefreshSession={() => {
              void mutations.handleRefreshVerification();
            }}
            onResend={() => {
              void mutations.handleResendVerification();
            }}
            onChangeEmail={() => {
              void mutations.handleChangeEmail();
            }}
          />
        </section>
      ) : null}

      {isCrossOrgReadOnlyView ? (
        <section className="mb-8">
          <Card className="border-border bg-muted">
            <CardHeader>
              <CardTitle>Read-only God Mode</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 text-sm text-muted-foreground">
              Cross-organization job detail is available for inspection, but editing and publish
              actions stay disabled outside your home organization.
            </CardContent>
          </Card>
        </section>
      ) : null}

      {isDiagnosticReadOnlyView ? (
        <section className="mb-8">
          <Card className="border-border bg-muted">
            <CardHeader>
              <CardTitle>Diagnostic Read-Only View</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 text-sm text-muted-foreground">
              This internal job page is open for diagnostics from your client session. Editing, queueing, and publish actions stay disabled.
            </CardContent>
          </Card>
        </section>
      ) : null}

      <InternalJobOverviewSection job={queryState.job} />

      <section className="mt-8 grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <InternalJobRequirementsSection
          cadPreviewSources={viewModel.cadPreviewSources}
          getDraftForPart={viewModel.getDraftForPart}
          getQuoteQuantityInput={viewModel.getQuoteQuantityInput}
          job={queryState.job}
          onDraftQuantityChange={viewModel.setDraftQuantity}
          onQuoteQuantityInputChange={(partId, value) =>
            viewModel.setQuoteQuantityInputs((current) => ({
              ...current,
              [partId]: value,
            }))
          }
          onQuoteQuantityInputCommit={viewModel.commitQuoteQuantityInput}
          updateDraft={viewModel.updateDraft}
          workQueue={queryState.job.workQueue}
          showInternalDiagnostics={showInternalDiagnostics}
          writeActionsDisabled={fullyWriteActionsDisabled}
        />

        <div className="space-y-6">
          <InternalJobDebugSection
            completionTarget={completionTarget}
            disabled={fullyWriteActionsDisabled}
            job={queryState.job}
            jobId={jobId}
            latestQuoteRun={queryState.latestQuoteRun}
            manualQuoteDisabled={manualQuoteIntakeDisabled}
            showDebugTools={queryState.showDebugTools}
          />
          <InternalJobPublicationCard
            clientSummary={viewModel.clientSummary}
            latestPackage={viewModel.latestPackage}
            latestQuoteRun={queryState.latestQuoteRun}
            onClientSummaryChange={viewModel.setClientSummary}
            onPublish={() => mutations.publishMutation.mutate()}
            publishPending={mutations.publishMutation.isPending}
            readiness={queryState.readinessQuery.data}
            writeActionsDisabled={fullyWriteActionsDisabled}
          />
          <InternalJobWorkerQueueCard tasks={queryState.job.workQueue} />
        </div>
      </section>

      <InternalJobVendorCompareSection
        activeCompareRequestedQuantity={viewModel.activeCompareRequestedQuantity}
        compareQuantities={viewModel.compareQuantities}
        job={queryState.job}
        onChangeQuantity={viewModel.setActiveCompareRequestedQuantity}
        optionKindsByOfferId={viewModel.optionKindsByOfferId}
        quoteRows={viewModel.quoteRows}
        visibleQuoteRows={viewModel.visibleQuoteRows}
      />
    </AppShell>
  );
};

export default InternalJobDetail;
