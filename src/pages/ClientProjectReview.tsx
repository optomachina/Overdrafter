import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { Loader2, MoveLeft, MoveRight } from "lucide-react";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { ClientWorkspaceShell } from "@/components/workspace/ClientWorkspaceShell";
import { ProcurementHandoffPanel } from "@/components/quotes/ProcurementHandoffPanel";
import { ClientWorkspaceStateSummary, ClientWorkspaceToneBadge } from "@/components/quotes/ClientWorkspaceStateSummary";
import { RequestSummaryBadges } from "@/components/quotes/RequestSummaryBadges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  fetchClientQuoteWorkspaceByJobIds,
  fetchJobsByProject,
  fetchProject,
} from "@/features/quotes/api/workspace-access";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import {
  buildClientWorkspaceState,
  summarizeClientWorkspaceStates,
} from "@/features/quotes/client-workspace-state";
import {
  createDefaultProcurementHandoffState,
  summarizeProcurementHandoff,
} from "@/features/quotes/procurement-handoff";
import {
  buildClientQuoteSelectionOptions,
  buildVendorLabelMap,
  getSelectedOption,
  summarizeSelectedQuoteOptions,
} from "@/features/quotes/selection";
import { formatCurrency, formatLeadTime } from "@/features/quotes/utils";
import { useAppSession } from "@/hooks/use-app-session";
import { recordWorkspaceSessionDiagnostic } from "@/lib/workspace-session-diagnostics";

const ClientProjectReview = () => {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const { user, isAuthInitializing } = useAppSession();
  const [handoffState, setHandoffState] = useState(createDefaultProcurementHandoffState);
  const [showHandoffSummary, setShowHandoffSummary] = useState(false);
  const projectQuery = useQuery({
    queryKey: ["review-project", projectId],
    queryFn: () => fetchProject(projectId),
    enabled: Boolean(user),
  });
  const projectJobsQuery = useQuery({
    queryKey: ["review-project-jobs", projectId],
    queryFn: () => fetchJobsByProject(projectId),
    enabled: Boolean(user),
  });

  const projectJobs = useMemo(() => projectJobsQuery.data ?? [], [projectJobsQuery.data]);

  const workspaceQuery = useQuery({
    queryKey: ["project-review-workspace", projectJobs.map((job) => job.id)],
    queryFn: () => fetchClientQuoteWorkspaceByJobIds(projectJobs.map((job) => job.id)),
    enabled: Boolean(user) && projectJobs.length > 0,
  });

  const selectedLineItems = useMemo(() => {
    const items = workspaceQuery.data ?? [];

    return items.map((item) => {
      const vendorLabels = item.part
        ? buildVendorLabelMap(item.part.vendorQuotes.map((quote) => quote.vendor))
        : new Map();
      const options = item.part
        ? buildClientQuoteSelectionOptions({
            vendorQuotes: item.part.vendorQuotes,
            requestedByDate: item.summary?.requestedByDate ?? item.job.requested_by_date ?? null,
            vendorLabels,
          })
        : [];
      const selectedOption = getSelectedOption(options, item.job.selected_vendor_quote_offer_id);

      return {
        item,
        selectedOption,
        workspaceState: buildClientWorkspaceState({
          job: item.job,
          summary: item.summary,
          part: item.part,
          options,
          selectedOption,
          requestedByDate: item.summary?.requestedByDate ?? item.job.requested_by_date ?? null,
          requireSelection: true,
        }),
      };
    });
  }, [workspaceQuery.data]);

  const selectionSummary = useMemo(
    () => summarizeSelectedQuoteOptions(selectedLineItems.map((lineItem) => lineItem.selectedOption)),
    [selectedLineItems],
  );
  const workspaceStateSummary = useMemo(
    () => summarizeClientWorkspaceStates(selectedLineItems.map((lineItem) => lineItem.workspaceState)),
    [selectedLineItems],
  );
  const handoffSummary = useMemo(() => summarizeProcurementHandoff(handoffState), [handoffState]);

  if (isAuthInitializing) {
    return <AuthBootstrapScreen message="Restoring your review session." />;
  }

  if (!user) {
    recordWorkspaceSessionDiagnostic(
      "warn",
      "client-project-review.redirect.unauthenticated",
      "Redirecting to sign-in after startup auth resolution completed without a user.",
      {
        projectId,
      },
    );
    return <Navigate to="/?auth=signin" replace />;
  }

  return (
    <ClientWorkspaceShell
      onLogoClick={() => navigate("/")}
      sidebarContent={
        <div className="space-y-1 py-2">
          <div className="rounded-[10px] border border-white/8 bg-black/20 px-3 py-3">
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Review</p>
            {projectQuery.data?.name ? (
              <p className="mt-1.5 truncate text-sm font-medium text-white">{projectQuery.data.name}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => navigate(`/projects/${projectId}`)}
            className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2.5 text-left text-sm text-white/60 transition hover:bg-white/6 hover:text-white"
          >
            <MoveLeft className="h-3.5 w-3.5 shrink-0" />
            Back to project
          </button>
        </div>
      }
    >
      <div className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col gap-6 px-6 pb-10 pt-4">
        {projectJobsQuery.isLoading || workspaceQuery.isLoading ? (
          <div className="flex min-h-[320px] items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-white/60" />
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-white/35">Review</p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
                  {projectQuery.data?.name ?? "Project"}
                </h1>
                <p className="mt-2 text-sm text-white/55">
                  Final review of selected vendors, delivery timing, project totals, and procurement handoff details before OverDrafter follow-up.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                  onClick={() => navigate(`/projects/${projectId}`)}
                >
                  <MoveLeft className="mr-2 h-4 w-4" />
                  Back to edit
                </Button>
                <Button type="button" className="rounded-full" onClick={() => setShowHandoffSummary(true)}>
                  Review handoff
                  <MoveRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </div>

            <section className="grid gap-3 md:grid-cols-4">
              <div className="rounded-[22px] border border-white/8 bg-[#262626] px-4 py-4">
                <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Selected total</p>
                <p className="mt-2 text-2xl font-semibold text-white">{formatCurrency(selectionSummary.totalPriceUsd)}</p>
              </div>
              <div className="rounded-[22px] border border-white/8 bg-[#262626] px-4 py-4">
                <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Selected lines</p>
                <p className="mt-2 text-2xl font-semibold text-white">{selectionSummary.selectedCount}</p>
              </div>
              <div className="rounded-[22px] border border-white/8 bg-[#262626] px-4 py-4">
                <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Domestic</p>
                <p className="mt-2 text-2xl font-semibold text-white">{selectionSummary.domesticCount}</p>
              </div>
              <div className="rounded-[22px] border border-white/8 bg-[#262626] px-4 py-4">
                <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Foreign / unknown</p>
                <p className="mt-2 text-2xl font-semibold text-white">
                  {selectionSummary.foreignCount + selectionSummary.unknownCount}
                </p>
              </div>
            </section>

            <section className="grid gap-3 md:grid-cols-3">
              <div className="rounded-[22px] border border-emerald-400/20 bg-emerald-500/8 px-4 py-4">
                <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Ready</p>
                <p className="mt-2 text-2xl font-semibold text-white">{workspaceStateSummary.ready}</p>
              </div>
              <div className="rounded-[22px] border border-amber-400/20 bg-amber-500/8 px-4 py-4">
                <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Warning</p>
                <p className="mt-2 text-2xl font-semibold text-white">{workspaceStateSummary.warning}</p>
              </div>
              <div className="rounded-[22px] border border-rose-400/20 bg-rose-500/8 px-4 py-4">
                <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Blocked</p>
                <p className="mt-2 text-2xl font-semibold text-white">{workspaceStateSummary.blocked}</p>
              </div>
            </section>

            <section className="rounded-[26px] border border-white/8 bg-[#262626] p-6">
              <p className="text-xs uppercase tracking-[0.18em] text-white/35">Line items</p>
              <div className="mt-4 space-y-3">
                {selectedLineItems.map(({ item, selectedOption, workspaceState }) => {
                  const presentation = getClientItemPresentation(item.job, item.summary);

                  return (
                    <div key={item.job.id} className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                          <p className="text-sm font-semibold text-white">{presentation.title}</p>
                          <RequestSummaryBadges
                            requestedServiceKinds={item.summary?.requestedServiceKinds ?? []}
                            quantity={item.summary?.quantity ?? item.part?.quantity ?? null}
                            requestedQuoteQuantities={item.summary?.requestedQuoteQuantities ?? []}
                            requestedByDate={item.summary?.requestedByDate ?? null}
                            className="mt-3"
                          />
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <ClientWorkspaceToneBadge
                              tone={workspaceState.tone}
                              className="tracking-normal normal-case"
                            />
                            <p className="text-xs text-white/55">{workspaceState.selection.label}</p>
                          </div>
                        </div>
                        {selectedOption ? (
                          <div className="text-left lg:text-right">
                            <p className="text-sm font-semibold text-white">{selectedOption.vendorLabel}</p>
                            <p className="mt-1 text-sm text-white/55">
                              {formatCurrency(selectedOption.totalPriceUsd)} ·{" "}
                              {selectedOption.resolvedDeliveryDate ?? formatLeadTime(selectedOption.leadTimeBusinessDays)}
                            </p>
                            <div className="mt-2 flex flex-wrap gap-2 lg:justify-end">
                              <Badge className="border border-white/10 bg-white/6 text-white/70">
                                {selectedOption.domesticStatus === "domestic"
                                  ? "USA"
                                  : selectedOption.domesticStatus === "foreign"
                                    ? "Foreign"
                                    : "Unknown"}
                              </Badge>
                            </div>
                          </div>
                        ) : (
                          <p className="text-sm text-white/45">No quote selected.</p>
                        )}
                      </div>
                      <ClientWorkspaceStateSummary
                        state={workspaceState}
                        className="mt-4"
                        maxReasons={2}
                      />
                    </div>
                  );
                })}
              </div>
            </section>

            <ProcurementHandoffPanel
              scopeLabel="project"
              value={handoffState}
              onChange={setHandoffState}
            />

            {showHandoffSummary ? (
              <section className="rounded-[26px] border border-white/8 bg-[#262626] p-6">
                <p className="text-xs uppercase tracking-[0.18em] text-white/35">Release check</p>
                <h2 className="mt-2 text-xl font-semibold text-white">
                  {handoffSummary.ready ? "Ready for OverDrafter follow-up" : "More procurement detail is still needed"}
                </h2>
                <p className="mt-3 text-sm text-white/70">
                  This route prepares a project-level procurement handoff only. Payment collection and order placement remain outside the app.
                </p>
                {handoffSummary.missingFields.length > 0 ? (
                  <p className="mt-4 text-sm text-amber-100">
                    Missing: {handoffSummary.missingFields.join(", ")}.
                  </p>
                ) : (
                  <p className="mt-4 text-sm text-emerald-100">
                    Shipping, billing, and contact details are ready for manual project release coordination.
                  </p>
                )}
              </section>
            ) : null}
          </>
        )}
      </div>
    </ClientWorkspaceShell>
  );
};

export default ClientProjectReview;
