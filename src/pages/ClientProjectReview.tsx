import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { Loader2, MoveLeft, MoveRight } from "lucide-react";
import { ChatWorkspaceLayout } from "@/components/chat/ChatWorkspaceLayout";
import { RequestSummaryBadges } from "@/components/quotes/RequestSummaryBadges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  fetchAccessibleJobs,
  fetchClientQuoteWorkspaceByJobIds,
  fetchJobsByProject,
  fetchProject,
} from "@/features/quotes/api";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import {
  buildClientQuoteSelectionOptions,
  buildVendorLabelMap,
  getSelectedOption,
  summarizeSelectedQuoteOptions,
} from "@/features/quotes/selection";
import { formatCurrency, formatLeadTime } from "@/features/quotes/utils";
import { useAppSession } from "@/hooks/use-app-session";

const ClientProjectReview = () => {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const { user } = useAppSession();
  const [showCheckoutPlaceholder, setShowCheckoutPlaceholder] = useState(false);

  const accessibleJobsQuery = useQuery({
    queryKey: ["review-accessible-jobs"],
    queryFn: fetchAccessibleJobs,
    enabled: Boolean(user),
  });
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
      };
    });
  }, [workspaceQuery.data]);

  const selectionSummary = useMemo(
    () => summarizeSelectedQuoteOptions(selectedLineItems.map((lineItem) => lineItem.selectedOption)),
    [selectedLineItems],
  );

  if (!user) {
    return <Navigate to="/?auth=signin" replace />;
  }

  return (
    <ChatWorkspaceLayout
      onLogoClick={() => navigate("/")}
      sidebarContent={<div className="px-5 py-6 text-sm text-white/45">Reviewing selected project quotes.</div>}
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
                  Final review of selected vendors, delivery timing, and project totals before checkout.
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
                <Button type="button" className="rounded-full" onClick={() => setShowCheckoutPlaceholder(true)}>
                  Continue
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

            <section className="rounded-[26px] border border-white/8 bg-[#262626] p-6">
              <p className="text-xs uppercase tracking-[0.18em] text-white/35">Line items</p>
              <div className="mt-4 space-y-3">
                {selectedLineItems.map(({ item, selectedOption }) => {
                  const presentation = getClientItemPresentation(item.job, item.summary);

                  return (
                    <div key={item.job.id} className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                          <p className="text-sm font-semibold text-white">{presentation.title}</p>
                          <RequestSummaryBadges
                            quantity={item.summary?.quantity ?? item.part?.quantity ?? null}
                            requestedQuoteQuantities={item.summary?.requestedQuoteQuantities ?? []}
                            requestedByDate={item.summary?.requestedByDate ?? null}
                            className="mt-3"
                          />
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
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-[26px] border border-white/8 bg-[#262626] p-6">
              <p className="text-xs uppercase tracking-[0.18em] text-white/35">Shipping / payment / PO</p>
              <p className="mt-4 text-sm text-white/70">
                Placeholder surface for shipping method, billing, and purchase-order collection until checkout services are wired.
              </p>
            </section>

            {showCheckoutPlaceholder ? (
              <section className="rounded-[26px] border border-white/8 bg-[#262626] p-6">
                <p className="text-sm text-white/70">
                  Checkout backend wiring is not available in this workspace yet. This route preserves the review step and future payment / PO handoff.
                </p>
              </section>
            ) : null}
          </>
        )}
      </div>
    </ChatWorkspaceLayout>
  );
};

export default ClientProjectReview;
