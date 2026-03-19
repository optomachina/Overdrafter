import { Loader2 } from "lucide-react";
import { Navigate, useParams } from "react-router-dom";
import { AppShell } from "@/components/app/AppShell";
import { EmailVerificationPrompt } from "@/components/EmailVerificationPrompt";
import { InternalJobExtractionDebugPanel } from "@/components/quotes/InternalJobExtractionDebugPanel";
import { InternalJobHeaderActions } from "@/components/quotes/InternalJobHeaderActions";
import { InternalJobPartRequirementsPanel } from "@/components/quotes/InternalJobPartRequirementsPanel";
import { InternalJobPublicationReadinessPanel } from "@/components/quotes/InternalJobPublicationReadinessPanel";
import { InternalJobVendorComparePanel } from "@/components/quotes/InternalJobVendorComparePanel";
import { InternalJobWorkerQueuePanel } from "@/components/quotes/InternalJobWorkerQueuePanel";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useInternalJobDetailMutations } from "@/features/quotes/use-internal-job-detail-mutations";
import { useInternalJobDetailQuery } from "@/features/quotes/use-internal-job-detail-query";
import { formatStatusLabel } from "@/features/quotes/utils";
import { useAppSession } from "@/hooks/use-app-session";
import { useDiagnosticsSnapshot } from "@/lib/diagnostics";

const InternalJobDetail = () => {
  const params = useParams();
  const jobId = params.jobId ?? "";
  const { user, activeMembership, isVerifiedAuth, signOut } = useAppSession();
  const diagnostics = useDiagnosticsSnapshot();
  const {
    jobQuery,
    readinessQuery,
    job,
    partViewModels,
    latestQuoteRun,
    latestPackage,
    optionKindsByOfferId,
    quoteRows,
    compareQuantities,
    visibleQuoteRows,
    normalizedApprovedDrafts,
    clientSummary,
    activeCompareRequestedQuantity,
    updateDraft,
    setQuoteQuantityInput,
    commitQuoteQuantityInput,
    setClientSummary,
    setActiveCompareRequestedQuantity,
  } = useInternalJobDetailQuery({
    jobId,
    user,
    activeMembership,
  });
  const mutations = useInternalJobDetailMutations({
    jobId,
    normalizedApprovedDrafts,
    latestQuoteRunId: latestQuoteRun?.id ?? null,
    clientSummary,
    readinessReady: readinessQuery.data?.ready,
    userEmail: user?.email,
    signOut,
  });

  if (!user) {
    return <Navigate to="/?auth=signin" replace />;
  }

  if (!activeMembership || activeMembership.role === "client") {
    return <Navigate to="/" replace />;
  }

  if (jobQuery.isLoading) {
    return (
      <AppShell title="Loading job" subtitle="Collecting job state, extraction evidence, and quote results.">
        <div className="flex min-h-[40vh] items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppShell>
    );
  }

  if (jobQuery.isError || !job) {
    return (
      <AppShell title="Job unavailable" subtitle="The requested job could not be loaded.">
        <Card className="border-destructive/30 bg-destructive/10">
          <CardContent className="p-6 text-sm text-destructive">
            {jobQuery.error instanceof Error ? jobQuery.error.message : "Unknown error"}
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  const writeActionsDisabled = !isVerifiedAuth;
  const showDebugTools = diagnostics.enabled || import.meta.env.DEV;

  return (
    <AppShell
      title={job.job.title}
      subtitle={job.job.description || "Internal review, quote orchestration, and publication for this CNC job."}
      actions={
        <InternalJobHeaderActions
          disabled={writeActionsDisabled}
          isQueueingExtraction={mutations.isQueueingExtraction}
          isSavingRequirements={mutations.isSavingRequirements}
          isStartingQuoteRun={mutations.isStartingQuoteRun}
          onQueueExtraction={mutations.queueExtraction}
          onSaveApprovedRequirements={mutations.saveApprovedRequirements}
          onStartQuoteRun={mutations.startQuoteRun}
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
              void mutations.refreshVerification();
            }}
            onResend={() => {
              void mutations.resendVerification();
            }}
            onChangeEmail={() => {
              void mutations.changeEmail();
            }}
          />
        </section>
      ) : null}

      {job.job.tags.length > 0 ? (
        <section className="mb-6 flex flex-wrap gap-2">
          {job.job.tags.map((tag) => (
            <Badge
              key={`${job.job.id}-${tag}`}
              variant="secondary"
              className="border border-primary/20 bg-primary/10 text-primary"
            >
              {tag}
            </Badge>
          ))}
        </section>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-4">
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-white/70">Job status</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/80">
              {formatStatusLabel(job.job.status)}
            </Badge>
          </CardContent>
        </Card>
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-white/70">Parts</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{job.parts.length}</p>
          </CardContent>
        </Card>
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-white/70">Files</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{job.files.length}</p>
          </CardContent>
        </Card>
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-white/70">Pricing policy</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">{job.pricingPolicy?.version ?? "v1_markup_20"}</p>
            <p className="mt-1 text-sm text-white/55">
              {job.pricingPolicy?.markup_percent ?? 20}% markup
            </p>
          </CardContent>
        </Card>
      </section>

      <section className="mt-8 grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <InternalJobPartRequirementsPanel
          partViewModels={partViewModels}
          disabled={writeActionsDisabled}
          updateDraft={updateDraft}
          setQuoteQuantityInput={setQuoteQuantityInput}
          commitQuoteQuantityInput={commitQuoteQuantityInput}
        />

        <div className="space-y-6">
          <InternalJobExtractionDebugPanel
            jobId={jobId}
            parts={job.parts}
            latestQuoteRun={latestQuoteRun}
            workQueue={job.workQueue}
            debugExtractionRuns={job.debugExtractionRuns}
            drawingPreviewAssets={job.drawingPreviewAssets}
            disabled={writeActionsDisabled}
            showDebugTools={showDebugTools}
          />

          <InternalJobPublicationReadinessPanel
            latestQuoteRun={latestQuoteRun}
            latestPackage={latestPackage}
            readiness={readinessQuery.data}
            clientSummary={clientSummary}
            disabled={writeActionsDisabled}
            isPublishing={mutations.isPublishingPackage}
            onClientSummaryChange={setClientSummary}
            onPublish={mutations.publishPackage}
          />

          <InternalJobWorkerQueuePanel workQueue={job.workQueue} />
        </div>
      </section>

      <InternalJobVendorComparePanel
        parts={job.parts}
        compareQuantities={compareQuantities}
        activeCompareRequestedQuantity={activeCompareRequestedQuantity}
        visibleQuoteRows={visibleQuoteRows}
        quoteRows={quoteRows}
        optionKindsByOfferId={optionKindsByOfferId}
        onRequestedQuantityChange={setActiveCompareRequestedQuantity}
      />
    </AppShell>
  );
};

export default InternalJobDetail;
