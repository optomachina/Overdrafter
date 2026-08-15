import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Box, FileText, FolderKanban, PlusSquare, Search } from "lucide-react";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { QuoteIntelligenceLanding } from "@/components/quote-intelligence/QuoteIntelligenceLanding";
import { QuoteIntelligenceShell } from "@/components/quote-intelligence/QuoteIntelligenceShell";
import { useQuoteReferences } from "@/components/quote-intelligence/useQuoteReferences";
import { SignInDialog } from "@/components/SignInDialog";
import {
  buildGlobalSearchResults,
  buildPartCollection,
  buildQuoteCollection,
  parseEngineeringQuery,
} from "@/features/quotes/quote-intelligence-view-model";
import { useClientHomeController } from "@/features/quotes/use-client-home-controller";
import { useQuoteIntelligenceWorkspace } from "@/features/quotes/use-quote-intelligence-workspace";

const RESULT_LABELS = {
  part: "Part",
  project: "Project group",
  quote: "Quote",
} as const;

const RESULT_ICONS = {
  part: Box,
  project: FolderKanban,
  quote: FileText,
} as const;

export default function ClientSearch() {
  const controller = useClientHomeController();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchParamsKey = searchParams.toString();
  const [query, setQuery] = useState(() => searchParams.get("q")?.trim() ?? "");
  const lastWrittenSearchParamsRef = useRef<string | null>(null);
  const parsedQuery = useMemo(() => parseEngineeringQuery(query), [query]);
  const appMode = searchParams.get("app") === "ios" ? "ios" : null;
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
  const parts = useMemo(
    () =>
      buildPartCollection({
        jobs: controller.accessibleJobs,
        summariesByJobId: controller.summariesByJobId,
        projects,
        projectIdsByJobId: controller.navigationModel.partToProjectIds,
        metadataByJobId: quoteWorkspace.metadataByJobId,
        appMode,
      }),
    [
      appMode,
      controller.accessibleJobs,
      controller.navigationModel.partToProjectIds,
      controller.summariesByJobId,
      projects,
      quoteWorkspace.metadataByJobId,
    ],
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
  const results = useMemo(
    () => buildGlobalSearchResults({ parts, quotes, query: parsedQuery, appMode }),
    [appMode, parsedQuery, parts, quotes],
  );

  useEffect(() => {
    if (lastWrittenSearchParamsRef.current === searchParamsKey) {
      lastWrittenSearchParamsRef.current = null;
      return;
    }

    const currentSearchParams = new URLSearchParams(searchParamsKey);
    const urlQuery = currentSearchParams.get("q") ?? "";
    const normalizedUrlQuery = urlQuery.trim();
    setQuery(normalizedUrlQuery);

    if (urlQuery === normalizedUrlQuery) {
      return;
    }

    if (normalizedUrlQuery) {
      currentSearchParams.set("q", normalizedUrlQuery);
    } else {
      currentSearchParams.delete("q");
    }

    lastWrittenSearchParamsRef.current = currentSearchParams.toString();
    setSearchParams(currentSearchParams, { replace: true });
  }, [searchParamsKey, setSearchParams]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const nextSearchParams = new URLSearchParams(searchParamsKey);
      const normalizedQuery = query.trim();

      if (normalizedQuery) {
        nextSearchParams.set("q", normalizedQuery);
      } else {
        nextSearchParams.delete("q");
      }

      const nextSearchParamsKey = nextSearchParams.toString();
      if (nextSearchParamsKey === searchParamsKey) {
        return;
      }

      lastWrittenSearchParamsRef.current = nextSearchParamsKey;
      setSearchParams(nextSearchParams, { replace: true });
    }, 150);

    return () => window.clearTimeout(timeoutId);
  }, [query, searchParamsKey, setSearchParams]);

  if (controller.isAuthInitializing && !controller.user) {
    return <AuthBootstrapScreen message="Restoring global search." />;
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

  function renderResults() {
    const isLoading =
      controller.accessibleJobsQuery.isLoading ||
      (jobIds.length > 0 && quoteWorkspace.workspaceQuery.isLoading);

    if (isLoading) {
      return (
        <p className="border-b border-paper-hairline py-12 text-center text-body-sm text-paper-muted" role="status">
          Building your accessible index…
        </p>
      );
    }

    if (controller.accessibleJobsQuery.isError) {
      return (
        <div className="border-b border-paper-hairline py-12 text-center" role="alert">
          <p className="text-body-sm">Search data could not be loaded.</p>
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

    if (!query.trim()) {
      return (
        <div className="border-b border-paper-hairline py-14 text-center">
          <p className="font-display text-subsection">Search the working record</p>
          <p className="mx-auto mt-2 max-w-lg text-body-sm text-paper-muted">
            Explicit dimensions and units are interpreted from your query. No geometry is inferred from filenames or placeholder projections.
          </p>
        </div>
      );
    }

    if (results.length === 0) {
      return (
        <div className="border-b border-paper-hairline py-14 text-center" aria-live="polite">
          <p className="font-display text-subsection">No accessible matches</p>
          <p className="mt-2 text-body-sm text-paper-muted">Try a part reference, project name, quote code, material, finish, service, or explicit dimension.</p>
        </div>
      );
    }

    return (
      <div className="border-b border-paper-hairline" aria-live="polite">
        <p className="border-b border-paper-hairline py-3 font-mono text-[10px] uppercase text-paper-muted">
          {results.length} {results.length === 1 ? "result" : "results"}
        </p>
        {results.map((result) => {
          const Icon = RESULT_ICONS[result.kind];

          return (
            <Link
              key={`${result.kind}:${result.id}`}
              to={result.href}
              className="grid min-h-[76px] grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-4 border-b border-paper-hairline py-3 transition-colors last:border-b-0 hover:bg-paper-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-paper-red"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-[2px] border border-paper-hairline bg-paper-surface text-paper-muted">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block truncate font-display text-[15px] font-bold">{result.title}</span>
                <span className="mt-1 block truncate text-[11px] text-paper-muted">{result.context}</span>
                {result.explanations.length > 0 ? (
                  <span className="mt-2 flex flex-wrap gap-2">
                    {result.explanations.map((explanation) => (
                      <span key={`${explanation.label}:${explanation.value ?? ""}`} className="rounded-[2px] border border-paper-hairline px-2 py-1 text-[10px] text-paper-muted">
                        {explanation.label}{explanation.value ? ` · ${explanation.value}` : ""}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
              <span className="pr-2 font-mono text-[10px] uppercase text-paper-red">{RESULT_LABELS[result.kind]}</span>
            </Link>
          );
        })}
      </div>
    );
  }

  return (
    <QuoteIntelligenceShell
      title="Search"
      foundingBetaAccess={{
        organizationId: controller.activeMembership?.organizationId,
        userId: controller.user.id,
        enabled: controller.isVerifiedAuth,
      }}
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
            className="inline-flex h-11 w-11 items-center justify-center gap-2 border border-paper-hairline bg-paper-surface text-[12px] font-medium hover:bg-paper-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-paper-red sm:h-auto sm:min-h-9 sm:w-auto sm:px-3"
          >
            <PlusSquare className="h-4 w-4" aria-hidden="true" />
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
        <span className="mb-2 block font-mono text-micro uppercase text-paper-muted">Global search</span>
        <span className="relative block">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-paper-muted" aria-hidden="true" />
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Part, project, quote code, 6061, Ø12 mm, anodized…"
            className="h-14 w-full rounded-[2px] border border-paper-hairline bg-paper-surface pl-12 pr-4 text-[16px] outline-none placeholder:text-paper-muted focus:border-paper-red focus:ring-1 focus:ring-paper-red"
          />
        </span>
      </label>

      {parsedQuery.chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-paper-hairline py-3" aria-label="Query interpretations">
          <span className="font-mono text-[10px] uppercase text-paper-muted">Interpreted as</span>
          {parsedQuery.chips.map((chip) => (
            <span key={chip.id} className="rounded-[2px] border border-paper-red px-2 py-1 font-mono text-[11px] text-paper-red">
              {chip.label}
            </span>
          ))}
        </div>
      ) : null}

      {renderResults()}
    </QuoteIntelligenceShell>
  );
}
