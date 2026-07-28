import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowUpRight, Copy, FileText, Upload } from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { QuoteIntelligenceShell } from "@/components/quote-intelligence/QuoteIntelligenceShell";
import { ClientQuoteDecisionPanel } from "@/components/quotes/ClientQuoteDecisionPanel";
import { ClientQuoteRequestStatusCard } from "@/components/quotes/ClientWorkspacePanelContent";
import { SignInDialog } from "@/components/SignInDialog";
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
import { Input } from "@/components/ui/input";
import {
  buildAppAwareHref,
  createQuoteDisplayCode,
} from "@/features/quotes/quote-intelligence-view-model";
import {
  MAX_QUOTE_REFERENCE_LENGTH,
  readQuoteReference,
  writeQuoteReference,
} from "@/features/quotes/quote-local-reference";
import { buildQuoteRequestViewModel } from "@/features/quotes/quote-request";
import { useClientHomeController } from "@/features/quotes/use-client-home-controller";
import { useClientPartController } from "@/features/quotes/use-client-part-controller";
import { cn } from "@/lib/utils";

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "Not available";
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return "Not available";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
}

function getValidHttpsUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function QuoteFact({
  label,
  value,
  unavailable = false,
}: Readonly<{
  label: string;
  value: string;
  unavailable?: boolean;
}>) {
  return (
    <div className="border-t border-border py-3">
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </dt>
      <dd className={cn("mt-1 text-sm text-foreground", unavailable && "text-muted-foreground")}>
        {value}
      </dd>
    </div>
  );
}

const ClientQuoteDetail = () => {
  const { quoteCode: routeQuoteCode = "" } = useParams();
  const [searchParams] = useSearchParams();
  const appMode = searchParams.get("app") === "ios" ? "ios" : null;
  const quoteCode = routeQuoteCode.trim().toUpperCase();
  const quotesHref = buildAppAwareHref("/quotes", appMode);
  const [showCancelConfirmation, setShowCancelConfirmation] = useState(false);
  const {
    accessibleJobs,
    accessibleJobsQuery,
    activeMembership,
    authDialogMode,
    isAuthDialogOpen,
    newJobFilePicker,
    openAuth,
    setIsAuthDialogOpen,
    signOut,
    user,
  } = useClientHomeController();
  const matchingJobs = useMemo(
    () =>
      accessibleJobs.filter(
        (job) => createQuoteDisplayCode(job.id).toUpperCase() === quoteCode,
      ),
    [accessibleJobs, quoteCode],
  );
  const resolvedJobId = matchingJobs.length === 1 ? matchingJobs[0]?.id : undefined;
  const controller = useClientPartController(resolvedJobId, {
    redirectUnauthenticated: false,
  });
  const [customerReference, setCustomerReference] = useState("");

  useEffect(() => {
    setCustomerReference(resolvedJobId ? readQuoteReference(resolvedJobId) ?? "" : "");
  }, [resolvedJobId]);

  if ((controller.isAuthInitializing || accessibleJobsQuery.isLoading) && !user) {
    return <AuthBootstrapScreen message="Opening your quote." />;
  }

  if (!user) {
    return (
      <>
        <QuoteIntelligenceShell
          eyebrow="Private quote link"
          title={`Quote ${quoteCode || "access"}`}
          description="Sign in with an account that has workspace access to open the files, request facts, and supplier responses attached to this quote."
        >
          <div className="border-y border-border py-10">
            <p className="max-w-xl text-sm leading-6 text-muted-foreground">
              The short quote code is a locator, not an access credential. Signing in keeps the shared URL in place
              while OverDrafter checks your workspace membership.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button type="button" className="rounded-[4px]" onClick={() => openAuth("signin")}>
                Sign in to view quote
              </Button>
              <Button
                type="button"
                variant="outline"
                className="rounded-[4px]"
                onClick={() => openAuth("signup")}
              >
                Create account
              </Button>
            </div>
          </div>
        </QuoteIntelligenceShell>
        <SignInDialog
          open={isAuthDialogOpen}
          onOpenChange={setIsAuthDialogOpen}
          initialMode={authDialogMode}
        />
      </>
    );
  }

  const uploadSlot = (
    <>
      <Button
        type="button"
        size="sm"
        aria-label="Upload parts"
        className="h-9 rounded-[4px]"
        onClick={newJobFilePicker.openFilePicker}
      >
        <Upload className="h-4 w-4 sm:mr-2" />
        <span className="hidden sm:inline">Upload parts</span>
      </Button>
      <input
        ref={newJobFilePicker.inputRef}
        className="hidden"
        type="file"
        multiple
        accept={newJobFilePicker.accept}
        onChange={(event) => {
          void newJobFilePicker.handleFileInputChange(event);
        }}
      />
    </>
  );
  const accountSlot = (
    <WorkspaceAccountMenu
      user={user}
      activeMembership={activeMembership}
      onSignOut={signOut}
    />
  );

  if (matchingJobs.length > 1) {
    return (
      <QuoteIntelligenceShell
        eyebrow="Quote locator"
        title={`Quote ${quoteCode}`}
        description="This temporary display code matches more than one accessible quote. No quote was opened."
        uploadSlot={uploadSlot}
        accountSlot={accountSlot}
      >
        <div className="border-y border-border py-10">
          <p className="max-w-xl text-sm leading-6 text-muted-foreground">
            Return to Quotes and choose the quote from its access-filtered list. Stored random quote identities will
            replace this collision-safe bridge without changing authorization.
          </p>
          <Button asChild variant="outline" className="mt-5 rounded-[4px]">
            <Link to={quotesHref}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to quotes
            </Link>
          </Button>
        </div>
      </QuoteIntelligenceShell>
    );
  }

  if (!resolvedJobId) {
    const isLoading = accessibleJobsQuery.isLoading || accessibleJobsQuery.isFetching;

    return (
      <QuoteIntelligenceShell
        eyebrow="Quote locator"
        title={isLoading ? "Opening quote…" : `Quote ${quoteCode || "not found"}`}
        description={
          isLoading
            ? "Checking the quotes available to your account."
            : "This link does not match a quote available to your account."
        }
        uploadSlot={uploadSlot}
        accountSlot={accountSlot}
      >
        {!isLoading ? (
          <div className="border-y border-border py-10">
            <p className="max-w-xl text-sm leading-6 text-muted-foreground">
              The quote may belong to another workspace, may have been archived, or the link may be incomplete. The
              short code does not bypass workspace access.
            </p>
            <Button asChild variant="outline" className="mt-5 rounded-[4px]">
              <Link to={quotesHref}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to quotes
              </Link>
            </Button>
          </div>
        ) : null}
      </QuoteIntelligenceShell>
    );
  }

  if (controller.isPartDetailLoading || !controller.partDetail?.job) {
    return (
      <QuoteIntelligenceShell
        eyebrow={`Quote ${quoteCode}`}
        title="Loading quote details…"
        description="Collecting the current request and published supplier responses."
        uploadSlot={uploadSlot}
        accountSlot={accountSlot}
      >
        <div className="grid gap-px border-y border-border bg-border md:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <div key={index} className="h-24 animate-pulse bg-background" />
          ))}
        </div>
      </QuoteIntelligenceShell>
    );
  }

  const { partDetail } = controller;
  const quoteRequest = buildQuoteRequestViewModel({
    job: partDetail.job,
    part: partDetail.part,
    latestQuoteRequest: partDetail.latestQuoteRequest,
    latestQuoteRun: partDetail.latestQuoteRun,
  });
  const sourceUrl = getValidHttpsUrl(controller.selectedQuoteOption?.quoteUrl);
  const requestedAt =
    partDetail.latestQuoteRequest?.created_at ??
    partDetail.latestQuoteRun?.created_at ??
    null;
  const quoteTitle = customerReference || controller.displayPartTitle || `Quote ${quoteCode}`;
  const shareUrl =
    typeof window === "undefined"
      ? `/quotes/${quoteCode}`
      : `${window.location.origin}/quotes/${quoteCode}`;

  const handleQuoteRequestAction = () => {
    if (quoteRequest.action.kind === "none") {
      return;
    }

    if (quoteRequest.action.kind === "cancel") {
      setShowCancelConfirmation(true);
      return;
    }

    void controller.handleRequestQuote(quoteRequest.action.kind === "retry");
  };

  const handleSaveReference = () => {
    const savedReference = writeQuoteReference(resolvedJobId, customerReference);
    setCustomerReference(savedReference ?? "");
    toast.success(savedReference ? "Customer reference saved in this browser." : "Customer reference cleared.");
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success("Login-gated quote link copied.");
    } catch {
      toast.error("Unable to copy the quote link.");
    }
  };

  return (
    <QuoteIntelligenceShell
      eyebrow={`Quote ${quoteCode}`}
      title={quoteTitle}
      description="Request facts, supplier responses, and the decision surface stay together on one access-controlled page."
      uploadSlot={uploadSlot}
      accountSlot={accountSlot}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <Button asChild variant="ghost" className="rounded-[4px] px-2">
          <Link to={quotesHref}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Quotes
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" className="rounded-[4px]" onClick={handleCopyLink}>
            <Copy className="mr-2 h-4 w-4" />
            Copy private link
          </Button>
          <Button asChild variant="outline" className="rounded-[4px]">
            <Link to={buildAppAwareHref(`/parts/${resolvedJobId}`, appMode)}>
              <FileText className="mr-2 h-4 w-4" />
              Files & request
            </Link>
          </Button>
        </div>
      </div>

      <section className="grid gap-8 border-b border-border py-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            Customer reference
          </p>
          <div className="mt-2 flex max-w-xl flex-col gap-2 sm:flex-row">
            <Input
              value={customerReference}
              maxLength={MAX_QUOTE_REFERENCE_LENGTH}
              aria-label="Customer quote reference"
              placeholder="Add your RFQ or internal quote number"
              className="h-10 rounded-[4px] bg-transparent"
              onChange={(event) => setCustomerReference(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  handleSaveReference();
                }
              }}
            />
            <Button type="button" variant="outline" className="h-10 rounded-[4px]" onClick={handleSaveReference}>
              Save
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            This release saves the reference in this browser. The immutable quote code and link do not change.
          </p>

          <ClientQuoteRequestStatusCard
            className="mt-6 rounded-[4px]"
            status={quoteRequest.status}
            tone={quoteRequest.tone}
            label={quoteRequest.label}
            detail={quoteRequest.detail}
            actionLabel={quoteRequest.action.label}
            actionDisabled={quoteRequest.action.disabled || controller.isCancelingQuoteRequest}
            blockerReasons={quoteRequest.blockerReasons}
            isBusy={controller.isRequestingQuote || controller.isCancelingQuoteRequest}
            onAction={quoteRequest.action.kind === "none" ? null : handleQuoteRequestAction}
          />
        </div>

        <dl>
          <QuoteFact label="Quote code" value={quoteCode} />
          <QuoteFact label="Part" value={controller.displayPartTitle || partDetail.job.title} />
          <QuoteFact label="Requested" value={formatDate(requestedAt)} unavailable={!requestedAt} />
          <QuoteFact
            label="Published offers"
            value={`${controller.rankedQuoteOptions.length}`}
            unavailable={controller.rankedQuoteOptions.length === 0}
          />
          <QuoteFact label="Valid through" value="Not provided by source" unavailable />
          <QuoteFact label="Supplier response time" value="Not available in current records" unavailable />
          <QuoteFact label="Link access" value="OverDrafter login and workspace access required" />
        </dl>
      </section>

      <ClientQuoteDecisionPanel
        className="mt-6 rounded-[4px] bg-transparent"
        title="Supplier responses"
        description="Lead time runs left to right. Quoted manufacturing total runs bottom to top. Supplier identities remain private to this buyer workspace."
        options={controller.rankedQuoteOptions}
        selectedOption={controller.selectedQuoteOption}
        onSelect={controller.handleSelectQuoteOption}
        requestedByDate={controller.requestSummaryRequestedByDate}
        quoteDataStatus={controller.quoteDataStatus}
        quoteDataMessage={controller.quoteDataMessage}
        quoteDiagnostics={controller.quoteDiagnostics}
        partId={partDetail.part?.id ?? null}
        organizationId={partDetail.job.organization_id}
        activePreset={controller.activePreset}
        onPresetSelect={controller.handlePresetSelection}
        onToggleVendorExclusion={controller.handleToggleVendorExclusion}
        emptyState="No published supplier response is available yet. The request status above shows the current collection state."
        headerActions={
          sourceUrl ? (
            <Button asChild variant="outline" className="rounded-[4px]">
              <a href={sourceUrl} target="_blank" rel="noreferrer">
                Source quote
                <ArrowUpRight className="ml-2 h-4 w-4" />
              </a>
            </Button>
          ) : (
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              Source link unavailable
            </span>
          )
        }
      />

      <AlertDialog open={showCancelConfirmation} onOpenChange={setShowCancelConfirmation}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel quote collection?</AlertDialogTitle>
            <AlertDialogDescription>
              Supplier responses already received remain in the quote. Collection still in progress will stop where
              the vendor integration permits it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep collecting</AlertDialogCancel>
            <AlertDialogAction
              disabled={!partDetail.latestQuoteRequest?.id}
              onClick={() => {
                const requestId = partDetail.latestQuoteRequest?.id;

                if (!requestId) {
                  return;
                }

                setShowCancelConfirmation(false);
                void controller.handleCancelQuoteRequest(requestId);
              }}
            >
              Cancel request
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </QuoteIntelligenceShell>
  );
};

export default ClientQuoteDetail;
