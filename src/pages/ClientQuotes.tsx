import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Search, Upload } from "lucide-react";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { QuoteIntelligenceLanding } from "@/components/quote-intelligence/QuoteIntelligenceLanding";
import { QuoteIntelligenceShell } from "@/components/quote-intelligence/QuoteIntelligenceShell";
import { useQuoteReferences } from "@/components/quote-intelligence/useQuoteReferences";
import { SignInDialog } from "@/components/SignInDialog";
import {
  buildQuoteCollection,
  buildQuoteDetailHref,
  filterQuoteCollection,
  parseEngineeringQuery,
} from "@/features/quotes/quote-intelligence-view-model";
import { useClientHomeController } from "@/features/quotes/use-client-home-controller";
import { useQuoteIntelligenceWorkspace } from "@/features/quotes/use-quote-intelligence-workspace";

function formatDate(value: string | null): string {
  if (!value) {
    return "Unavailable";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unavailable"
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function formatUsd(value: number | null): string | null {
  return value === null
    ? null
    : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

export default function ClientQuotes() {
  const controller = useClientHomeController();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const parsedQuery = useMemo(() => parseEngineeringQuery(query), [query]);
  const jobIds = useMemo(() => controller.accessibleJobs.map((job) => job.id), [controller.accessibleJobs]);
  const referencesByJobId = useQuoteReferences(jobIds);
  const quoteWorkspace = useQuoteIntelligenceWorkspace(
    jobIds,
    Boolean(controller.user),
    controller.workspaceAccessScope,
  );
  const projects = useMemo(
    () =>
      controller.sidebarProjects.map((project) => ({
        id: project.id,
        name: project.name,
        partCount: project.partCount,
        updatedAt: project.updatedAt,
      })),
    [controller.sidebarProjects],
  );
  const quotes = useMemo(
    () =>
      buildQuoteCollection({
        jobs: controller.accessibleJobs,
        summariesByJobId: controller.summariesByJobId,
        projects,
        projectIdsByJobId: controller.navigationModel.partToProjectIds,
        referencesByJobId,
        metadataByJobId: quoteWorkspace.metadataByJobId,
        factsByJobId: quoteWorkspace.factsByJobId,
      }),
    [
      controller.accessibleJobs,
      controller.navigationModel.partToProjectIds,
      controller.summariesByJobId,
      projects,
      quoteWorkspace.factsByJobId,
      quoteWorkspace.metadataByJobId,
      referencesByJobId,
    ],
  );
  const rows = useMemo(() => filterQuoteCollection(quotes, parsedQuery), [parsedQuery, quotes]);
  const appMode = searchParams.get("app") === "ios" ? "ios" : null;

  if (controller.isAuthInitializing && !controller.user) {
    return <AuthBootstrapScreen message="Restoring your quote workspace." />;
  }

  if (!controller.user) {
    return (
      <>
        <QuoteIntelligenceLanding
          onUpload={controller.newJobFilePicker.openFilePicker}
          onSignIn={() => controller.openAuth("signin")}
          onCreateAccount={() => controller.openAuth("signup")}
        />
        <SignInDialog
          open={controller.isAuthDialogOpen}
          onOpenChange={controller.setIsAuthDialogOpen}
          initialMode={controller.authDialogMode}
        />
      </>
    );
  }

  function renderQuotes() {
    const isLoading =
      controller.accessibleJobsQuery.isLoading ||
      (jobIds.length > 0 && quoteWorkspace.workspaceQuery.isLoading);

    if (isLoading) {
      return (
        <p className="border-b border-paper-hairline py-12 text-center text-body-sm text-paper-muted" role="status">
          Loading quote states…
        </p>
      );
    }

    if (controller.accessibleJobsQuery.isError) {
      return (
        <div className="border-b border-paper-hairline py-12 text-center" role="alert">
          <p className="text-body-sm">Quotes could not be loaded.</p>
          <button
            type="button"
            onClick={() => void controller.accessibleJobsQuery.refetch()}
            className="mt-4 min-h-11 border border-paper-ink px-4 text-[12px] font-semibold"
          >
            Try again
          </button>
        </div>
      );
    }

    if (rows.length === 0) {
      return (
        <div className="border-b border-paper-hairline py-14 text-center">
          <p className="font-display text-subsection">{query ? "No matching quotes" : "No quote work yet"}</p>
          <p className="mt-2 text-body-sm text-paper-muted">
            {query ? "Change the search to broaden the result set." : "Upload a part package to begin a request."}
          </p>
        </div>
      );
    }

    return (
      <div className="border-b border-paper-hairline" aria-live="polite">
        {rows.map((quote) => {
          const selectedPrice = formatUsd(quote.selectedPriceUsd);

          return (
            <Link
              key={quote.id}
              to={buildQuoteDetailHref(quote.displayCode, appMode)}
              className="group grid gap-4 border-t border-paper-hairline py-5 transition-colors hover:bg-paper-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-paper-red lg:grid-cols-[minmax(0,1.4fr)_minmax(9rem,0.6fr)_minmax(12rem,0.7fr)_auto]"
            >
              <span className="min-w-0">
                <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="truncate font-display text-[17px] font-bold">{quote.title}</span>
                  <span className="font-mono text-[11px] font-bold text-paper-red">{quote.displayCode}</span>
                </span>
                <span className="mt-1 block line-clamp-1 text-[12px] text-paper-muted">{quote.description}</span>
                <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] uppercase text-paper-muted">
                  {quote.reference ? <span>Ref {quote.reference}</span> : null}
                  {quote.partReference ? <span>Part {quote.partReference}</span> : null}
                  {quote.projectNames.length > 0 ? <span>{quote.projectNames.join(", ")}</span> : null}
                </span>
                {quote.matchExplanations.length > 0 ? (
                  <span className="mt-2 flex flex-wrap gap-2">
                    {quote.matchExplanations.map((explanation) => (
                      <span key={`${explanation.label}:${explanation.value ?? ""}`} className="rounded-[2px] border border-paper-hairline px-2 py-1 text-[10px] text-paper-muted">
                        {explanation.label}{explanation.value ? ` · ${explanation.value}` : ""}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
              <span>
                <span className="block font-mono text-[10px] uppercase text-paper-muted">State</span>
                <span className="mt-1 block text-[13px] font-medium">{quote.stateLabel}</span>
              </span>
              <span className="grid grid-cols-2 gap-4 lg:grid-cols-1 lg:gap-2">
                <span>
                  <span className="block font-mono text-[10px] uppercase text-paper-muted">Offers</span>
                  <span className="mt-1 block text-[12px]">{quote.offerCount ?? "Unavailable"}</span>
                </span>
                <span>
                  <span className="block font-mono text-[10px] uppercase text-paper-muted">Request time</span>
                  <span className="mt-1 block text-[12px]">{formatDate(quote.requestedAt)}</span>
                </span>
              </span>
              <span className="lg:text-right">
                <span className="block font-mono text-[10px] uppercase text-paper-muted">Updated</span>
                <span className="mt-1 block text-[12px]">{formatDate(quote.updatedAt)}</span>
                {quote.selectedSupplier ? (
                  <span className="mt-2 block text-[11px] text-paper-muted">
                    Selected: {quote.selectedSupplier}{selectedPrice ? ` · ${selectedPrice}` : ""}
                  </span>
                ) : null}
              </span>
            </Link>
          );
        })}
      </div>
    );
  }

  return (
    <QuoteIntelligenceShell
      title="Quotes"
      uploadSlot={
        <>
          <input
            ref={controller.newJobFilePicker.inputRef}
            type="file"
            accept={controller.newJobFilePicker.accept}
            multiple
            className="sr-only"
            onChange={controller.newJobFilePicker.handleFileInputChange}
            aria-label="Choose part files to upload"
          />
          <button
            type="button"
            aria-label="Upload"
            onClick={controller.newJobFilePicker.openFilePicker}
            className="inline-flex min-h-10 items-center gap-2 border border-paper-hairline bg-paper-surface px-3 text-[12px] font-medium hover:bg-paper-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-paper-red"
          >
            <Upload className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Upload</span>
          </button>
        </>
      }
      accountSlot={
        <WorkspaceAccountMenu
          user={controller.user}
          compact
          activeMembership={controller.activeMembership}
          onSignOut={controller.signOut}
        />
      }
    >
      <label className="block border-b border-paper-hairline pb-5">
        <span className="mb-2 block font-mono text-micro uppercase text-paper-muted">Search quotes</span>
        <span className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-paper-muted" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search title, reference, display code, project, supplier, or state"
            className="h-12 w-full rounded-[2px] border border-paper-hairline bg-paper-surface pl-10 pr-3 text-[14px] outline-none placeholder:text-paper-muted focus:border-paper-red focus:ring-1 focus:ring-paper-red"
          />
        </span>
      </label>

      {renderQuotes()}
    </QuoteIntelligenceShell>
  );
}
