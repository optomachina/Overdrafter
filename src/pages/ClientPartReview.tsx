import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { Loader2, MoveLeft, MoveRight } from "lucide-react";
import { ChatWorkspaceLayout } from "@/components/chat/ChatWorkspaceLayout";
import { ProcurementHandoffPanel } from "@/components/quotes/ProcurementHandoffPanel";
import { RequestSummaryBadges } from "@/components/quotes/RequestSummaryBadges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  fetchClientQuoteWorkspaceByJobIds,
} from "@/features/quotes/api";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import {
  createDefaultProcurementHandoffState,
  summarizeProcurementHandoff,
} from "@/features/quotes/procurement-handoff";
import {
  buildClientQuoteSelectionOptions,
  buildVendorLabelMap,
  getSelectedOption,
} from "@/features/quotes/selection";
import { formatCurrency, formatLeadTime } from "@/features/quotes/utils";
import { useAppSession } from "@/hooks/use-app-session";

const ClientPartReview = () => {
  const { jobId = "" } = useParams();
  const navigate = useNavigate();
  const { user } = useAppSession();
  const [handoffState, setHandoffState] = useState(createDefaultProcurementHandoffState);
  const [showHandoffSummary, setShowHandoffSummary] = useState(false);

  const workspaceQuery = useQuery({
    queryKey: ["part-review", jobId],
    queryFn: async () => {
      const [item] = await fetchClientQuoteWorkspaceByJobIds([jobId]);
      return item ?? null;
    },
    enabled: Boolean(user) && Boolean(jobId),
  });

  const selectedOption = useMemo(() => {
    const workspaceItem = workspaceQuery.data;

    if (!workspaceItem?.part) {
      return null;
    }

    const vendorLabels = buildVendorLabelMap(workspaceItem.part.vendorQuotes.map((quote) => quote.vendor));
    const options = buildClientQuoteSelectionOptions({
      vendorQuotes: workspaceItem.part.vendorQuotes,
      requestedByDate: workspaceItem.summary?.requestedByDate ?? workspaceItem.job.requested_by_date ?? null,
      vendorLabels,
    });

    return getSelectedOption(options, workspaceItem.job.selected_vendor_quote_offer_id);
  }, [workspaceQuery.data]);

  const handoffSummary = useMemo(() => summarizeProcurementHandoff(handoffState), [handoffState]);

  if (!user) {
    return <Navigate to="/?auth=signin" replace />;
  }

  return (
    <ChatWorkspaceLayout
      onLogoClick={() => navigate("/")}
      sidebarContent={<div className="px-5 py-6 text-sm text-white/45">Reviewing your selected part quote.</div>}
    >
      <div className="mx-auto flex w-full max-w-[960px] flex-1 flex-col gap-6 px-6 pb-10 pt-4">
        {workspaceQuery.isLoading ? (
          <div className="flex min-h-[320px] items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-white/60" />
          </div>
        ) : !workspaceQuery.data ? (
          <div className="rounded-[26px] border border-white/8 bg-[#262626] px-6 py-12 text-center text-white/45">
            This review page could not be loaded.
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-white/35">Review</p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
                  {getClientItemPresentation(workspaceQuery.data.job, workspaceQuery.data.summary).title}
                </h1>
                <p className="mt-2 text-sm text-white/55">
                  Confirm the selected quote and capture shipping, billing, and PO handoff details before OverDrafter follow-up.
                </p>
                <RequestSummaryBadges
                  requestedServiceKinds={workspaceQuery.data.summary?.requestedServiceKinds ?? []}
                  quantity={workspaceQuery.data.summary?.quantity ?? workspaceQuery.data.part?.quantity ?? null}
                  requestedQuoteQuantities={workspaceQuery.data.summary?.requestedQuoteQuantities ?? []}
                  requestedByDate={workspaceQuery.data.summary?.requestedByDate ?? null}
                  className="mt-4"
                />
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                  onClick={() => navigate(`/parts/${jobId}`)}
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

            <section className="rounded-[26px] border border-white/8 bg-[#262626] p-6">
              <p className="text-xs uppercase tracking-[0.18em] text-white/35">Selected option</p>
              {selectedOption ? (
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                    <p className="text-sm font-semibold text-white">{selectedOption.vendorLabel}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Badge className="border border-white/10 bg-white/6 text-white/70">
                        Qty {selectedOption.requestedQuantity}
                      </Badge>
                      <Badge className="border border-white/10 bg-white/6 text-white/70">
                        {selectedOption.domesticStatus === "domestic"
                          ? "USA"
                          : selectedOption.domesticStatus === "foreign"
                            ? "Foreign"
                            : "Unknown"}
                      </Badge>
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                    <p className="text-sm text-white/45">Price</p>
                    <p className="mt-2 text-2xl font-semibold text-white">
                      {formatCurrency(selectedOption.totalPriceUsd)}
                    </p>
                    <p className="mt-3 text-sm text-white/55">
                      {selectedOption.resolvedDeliveryDate ?? formatLeadTime(selectedOption.leadTimeBusinessDays)}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="mt-4 text-sm text-white/45">No quote has been selected yet for this part.</p>
              )}
            </section>

            <section className="rounded-[26px] border border-white/8 bg-[#262626] p-6">
              <p className="text-xs uppercase tracking-[0.18em] text-white/35">Request context</p>
              <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">RFQ context</p>
                <p className="mt-2 text-sm text-white/70">
                  {workspaceQuery.data.job.description ?? "No freeform request text provided."}
                </p>
              </div>
            </section>

            <ProcurementHandoffPanel
              scopeLabel="part"
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
                  This route packages the selected quote with procurement handoff details. No payment is collected and no order is placed here.
                </p>
                {handoffSummary.missingFields.length > 0 ? (
                  <p className="mt-4 text-sm text-amber-100">
                    Missing: {handoffSummary.missingFields.join(", ")}.
                  </p>
                ) : (
                  <p className="mt-4 text-sm text-emerald-100">
                    Shipping, billing, and contact details are ready for manual release coordination.
                  </p>
                )}
              </section>
            ) : null}
          </>
        )}
      </div>
    </ChatWorkspaceLayout>
  );
};

export default ClientPartReview;
