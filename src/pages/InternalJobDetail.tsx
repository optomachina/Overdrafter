import { Loader2 } from "lucide-react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { AppShell } from "@/components/app/AppShell";
import { EmailVerificationPrompt } from "@/components/EmailVerificationPrompt";
import { Card, CardContent } from "@/components/ui/card";
import { useAppSession } from "@/hooks/use-app-session";
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
const InternalJobDetail = () => {
  const navigate = useNavigate();
  const { jobId = "" } = useParams();
  const { user, activeMembership, isVerifiedAuth, signOut } = useAppSession();
  const queryState = useInternalJobDetailQuery({
    activeMembership,
    hasUser: Boolean(user),
    jobId,
  });
  const viewModel = useInternalJobDetailViewModel({
    job: queryState.job,
    latestQuoteRun: queryState.latestQuoteRun,
  });
  const mutations = useInternalJobDetailMutations({
    clientSummary: viewModel.clientSummary,
    drafts: viewModel.drafts,
    forcePublish: !queryState.readinessQuery.data?.ready,
    jobId,
    latestQuoteRunId: queryState.latestQuoteRun?.id ?? null,
    navigate,
    signOut,
    userEmail: user?.email ?? null,
  });
  const writeActionsDisabled = !isVerifiedAuth;

  if (!user) {
    return <Navigate to="/?auth=signin" replace />;
  }

  if (!activeMembership || activeMembership.role === "client") {
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

  if (queryState.jobQuery.isError || !queryState.job) {
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
          writeActionsDisabled={writeActionsDisabled}
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

      <InternalJobOverviewSection job={queryState.job} />

      <section className="mt-8 grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <InternalJobRequirementsSection
          cadPreviewSources={viewModel.cadPreviewSources}
          getDraftForPart={viewModel.getDraftForPart}
          getQuoteQuantityInput={viewModel.getQuoteQuantityInput}
          job={queryState.job}
          jobRequestDefaults={viewModel.jobRequestDefaults}
          onDraftQuantityChange={viewModel.setDraftQuantity}
          onQuoteQuantityInputChange={(partId, value) =>
            viewModel.setQuoteQuantityInputs((current) => ({
              ...current,
              [partId]: value,
            }))
          }
          onQuoteQuantityInputCommit={viewModel.commitQuoteQuantityInput}
          updateDraft={viewModel.updateDraft}
          writeActionsDisabled={writeActionsDisabled}
        />

        <div className="space-y-6">
          <InternalJobDebugSection
            disabled={writeActionsDisabled}
            job={queryState.job}
            jobId={jobId}
            latestQuoteRun={queryState.latestQuoteRun}
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
            writeActionsDisabled={writeActionsDisabled}
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
