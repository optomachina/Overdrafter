import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Box, FolderKanban, PlusSquare, Search } from "lucide-react";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { CadPreviewThumbnail } from "@/components/CadPreviewThumbnail";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { QuoteIntelligenceLanding } from "@/components/quote-intelligence/QuoteIntelligenceLanding";
import { QuoteIntelligenceShell } from "@/components/quote-intelligence/QuoteIntelligenceShell";
import { SignInDialog } from "@/components/SignInDialog";
import {
  buildPartCollection,
  filterPartCollection,
  parseEngineeringQuery,
  type PartCollectionFilter,
} from "@/features/quotes/quote-intelligence-view-model";
import { useClientHomeController } from "@/features/quotes/use-client-home-controller";
import { useQuoteIntelligenceWorkspace } from "@/features/quotes/use-quote-intelligence-workspace";
import type { CadPreviewAssetRecord } from "@/features/quotes/types";
import {
  createCadPreviewSourceFromJobFile,
  isStepPreviewableFile,
  type CadPreviewSource,
} from "@/lib/cad-preview";

const FILTERS: Array<{ value: PartCollectionFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "parts", label: "Parts" },
  { value: "assemblies", label: "Assemblies" },
];

function PartPreview({
  asset,
  kind,
  source,
}: Readonly<{
  asset: CadPreviewAssetRecord | null;
  kind: "part" | "project_group";
  source: CadPreviewSource | null | undefined;
}>) {
  if (kind === "project_group") {
    return (
      <>
        <FolderKanban className="h-7 w-7" aria-hidden="true" />
        <span className="sr-only">Project group</span>
      </>
    );
  }

  if (source || asset) {
    return <CadPreviewThumbnail asset={asset} fallbackSource={source ?? null} />;
  }

  return (
    <>
      <Box className="h-7 w-7" aria-hidden="true" />
      <span className="sr-only">Part preview unavailable</span>
    </>
  );
}

function formatUpdatedAt(value: string | null): string {
  if (!value) {
    return "Update unavailable";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Update unavailable"
    : `Updated ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date)}`;
}

export default function ClientParts() {
  const controller = useClientHomeController();
  const [searchParams] = useSearchParams();
  const appMode = searchParams.get("app") === "ios" ? "ios" : null;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PartCollectionFilter>("all");
  const parsedQuery = useMemo(() => parseEngineeringQuery(query), [query]);
  const jobIds = useMemo(() => controller.accessibleJobs.map((job) => job.id), [controller.accessibleJobs]);
  const quoteWorkspace = useQuoteIntelligenceWorkspace(
    jobIds,
    Boolean(controller.user),
    controller.workspaceAccessScope,
  );
  const cadPreviewSourcesByJobId = useMemo(() => {
    const sources = new Map<string, ReturnType<typeof createCadPreviewSourceFromJobFile>>();

    (quoteWorkspace.workspaceQuery.data ?? []).forEach((item) => {
      const primaryCadFile = item.part?.cadFile;
      const cadFile =
        primaryCadFile && isStepPreviewableFile(primaryCadFile.original_name)
          ? primaryCadFile
          : item.files.find(
              (file) => file.file_kind === "cad" && isStepPreviewableFile(file.original_name),
            );

      if (cadFile) {
        sources.set(item.job.id, createCadPreviewSourceFromJobFile(cadFile));
      }
    });

    return sources;
  }, [quoteWorkspace.workspaceQuery.data]);
  const cadPreviewAssetsByJobId = useMemo(() => {
    const assets = new Map<string, CadPreviewAssetRecord>();

    (quoteWorkspace.workspaceQuery.data ?? []).forEach((item) => {
      if (item.part?.cadPreview) {
        assets.set(item.job.id, item.part.cadPreview);
      }
    });

    return assets;
  }, [quoteWorkspace.workspaceQuery.data]);
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
  const collection = useMemo(
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
  const rows = useMemo(
    () => filterPartCollection(collection, filter, parsedQuery),
    [collection, filter, parsedQuery],
  );

  if (controller.isAuthInitializing && !controller.user) {
    return <AuthBootstrapScreen message="Restoring your parts workspace." />;
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

  const uploadSlot = (
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
        className="inline-flex h-11 w-11 items-center justify-center gap-2 border border-paper-hairline bg-paper-surface text-[12px] font-medium transition-colors hover:bg-paper-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-paper-red sm:h-auto sm:min-h-10 sm:w-auto sm:px-3"
      >
        <PlusSquare className="h-4 w-4" aria-hidden="true" />
        <span className="hidden sm:inline">Upload</span>
      </button>
    </>
  );
  const accountSlot = (
    <WorkspaceAccountMenu
      user={controller.user}
      compact
      activeMembership={controller.activeMembership}
      onSignOut={controller.signOut}
    />
  );

  function renderParts() {
    const isLoading =
      controller.accessibleJobsQuery.isLoading ||
      (jobIds.length > 0 && quoteWorkspace.workspaceQuery.isLoading);

    if (isLoading) {
      return (
        <p className="border-b border-paper-hairline py-12 text-center text-body-sm text-paper-muted" role="status">
          Loading accessible parts…
        </p>
      );
    }

    if (controller.accessibleJobsQuery.isError) {
      return (
        <div className="border-b border-paper-hairline py-12 text-center" role="alert">
          <p className="text-body-sm">Parts could not be loaded.</p>
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
      const isAssembliesFilter = filter === "assemblies";

      return (
        <div className="border-b border-paper-hairline py-14 text-center">
          <p className="font-display text-subsection">
            {isAssembliesFilter ? "No released assemblies yet" : "No matching parts"}
          </p>
          <p className="mx-auto mt-2 max-w-lg text-body-sm text-paper-muted">
            {isAssembliesFilter
              ? "Project groups are not treated as assemblies. Assemblies will appear only when immutable BOM and revision data exists."
              : "Change the search or upload a part package to add accessible artifacts."}
          </p>
        </div>
      );
    }

    return (
      <div className="border-b border-paper-hairline" aria-live="polite">
        {rows.map((row) => {
          const previewSource = row.kind === "part" ? cadPreviewSourcesByJobId.get(row.id) : null;
          const previewAsset = row.kind === "part" ? cadPreviewAssetsByJobId.get(row.id) ?? null : null;

          return (
            <Link
              key={`${row.kind}:${row.id}`}
              to={row.href}
              className="group grid min-h-[92px] grid-cols-[64px_minmax(0,1fr)] gap-4 border-t border-paper-hairline py-4 transition-colors hover:bg-paper-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-paper-red sm:grid-cols-[72px_minmax(0,1fr)_auto]"
            >
              <span className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-[2px] border border-paper-hairline bg-paper-surface text-paper-muted sm:h-[72px] sm:w-[72px]">
                <PartPreview asset={previewAsset} kind={row.kind} source={previewSource} />
              </span>
              <span className="min-w-0">
                <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="truncate font-display text-[16px] font-bold">{row.title}</span>
                  <span className="font-mono text-[10px] uppercase text-paper-red">{row.statusLabel}</span>
                </span>
                <span className="mt-1 line-clamp-2 block text-[12px] text-paper-muted">{row.description}</span>
                <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] uppercase text-paper-muted">
                  {row.reference ? <span>{row.reference}{row.revision ? ` · Rev ${row.revision}` : ""}</span> : null}
                  {row.quantity ? <span>Qty {row.quantity}</span> : null}
                  {row.partCount !== null ? <span>{row.partCount} parts</span> : null}
                  {row.material ? <span>{row.material}</span> : null}
                  {row.finish ? <span>{row.finish}</span> : null}
                  {row.process ? <span>{row.process}</span> : null}
                  {row.projectNames.length > 0 ? <span>{row.projectNames.join(", ")}</span> : null}
                </span>
                {row.matchExplanations.length > 0 ? (
                  <span className="mt-2 flex flex-wrap gap-2">
                    {row.matchExplanations.map((explanation) => (
                      <span key={`${explanation.label}:${explanation.value ?? ""}`} className="rounded-[2px] border border-paper-hairline px-2 py-1 text-[10px] text-paper-muted">
                        {explanation.label}{explanation.value ? ` · ${explanation.value}` : ""}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
              <span className="hidden self-center pr-3 font-mono text-[10px] uppercase text-paper-muted sm:block">
                {formatUpdatedAt(row.updatedAt)}
              </span>
            </Link>
          );
        })}
      </div>
    );
  }

  return (
    <QuoteIntelligenceShell
      title="Parts"
      uploadSlot={uploadSlot}
      accountSlot={accountSlot}
    >
      <div className="grid gap-4 border-b border-paper-hairline pb-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <label className="block">
          <span className="mb-2 block font-mono text-micro uppercase text-paper-muted">Search parts</span>
          <span className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-paper-muted" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Try 6061, Ø12 mm, anodized, or a part reference"
              className="h-12 w-full rounded-[2px] border border-paper-hairline bg-paper-surface pl-10 pr-3 text-[14px] outline-none transition-colors placeholder:text-paper-muted focus:border-paper-red focus:ring-1 focus:ring-paper-red"
            />
          </span>
        </label>
        <div className="inline-flex w-fit rounded-[2px] border border-paper-hairline" role="group" aria-label="Part type">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
              className={`min-h-11 border-r border-paper-hairline px-4 text-[12px] font-medium last:border-r-0 ${
                filter === option.value ? "bg-paper-ink text-paper" : "bg-paper-surface text-paper-muted hover:text-paper-ink"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

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

      {renderParts()}
    </QuoteIntelligenceShell>
  );
}
