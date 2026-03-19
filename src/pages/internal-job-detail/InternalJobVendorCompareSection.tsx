import { ArrowUpRight } from "lucide-react";
import { RequestedQuantityFilter } from "@/components/quotes/RequestedQuantityFilter";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type {
  JobAggregate,
  VendorQuoteAggregate,
} from "@/features/quotes/types";
import type { RequestedQuantityFilterValue } from "@/features/quotes/request-scenarios";
import {
  formatCurrency,
  formatLeadTime,
  formatStatusLabel,
  formatVendorName,
  getImportedVendorOffers,
  hasManualQuoteIntakeSource,
  isManualImportVendor,
  projectedClientPrice,
} from "@/features/quotes/utils";

type InternalJobVendorCompareSectionProps = {
  activeCompareRequestedQuantity: RequestedQuantityFilterValue | null;
  compareQuantities: number[];
  job: JobAggregate;
  onChangeQuantity: (value: RequestedQuantityFilterValue | null) => void;
  optionKindsByOfferId: Map<string, string[]>;
  quoteRows: VendorQuoteAggregate[];
  visibleQuoteRows: VendorQuoteAggregate[];
};

export function InternalJobVendorCompareSection({
  activeCompareRequestedQuantity,
  compareQuantities,
  job,
  onChangeQuantity,
  optionKindsByOfferId,
  quoteRows,
  visibleQuoteRows,
}: InternalJobVendorCompareSectionProps) {
  const partById = new Map(job.parts.map((part) => [part.id, part]));

  return (
    <section className="mt-8">
      <Card className="border-white/10 bg-white/5">
        <CardHeader>
          <CardTitle>Vendor compare view</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <RequestedQuantityFilter
            quantities={compareQuantities}
            value={activeCompareRequestedQuantity}
            onChange={onChangeQuantity}
          />
          {!quoteRows.length ? (
            <p className="text-sm text-white/55">
              No vendor quote rows yet. Once the worker processes queued tasks, raw vendor results will appear here.
            </p>
          ) : visibleQuoteRows.length === 0 ? (
            <p className="text-sm text-white/55">
              No vendor quote rows are available for qty {activeCompareRequestedQuantity}.
            </p>
          ) : (
            visibleQuoteRows.map((quote) => {
              const part = partById.get(quote.part_id);
              const importedOffers = getImportedVendorOffers(quote);
              const isManualVendor = isManualImportVendor(quote.vendor);
              const isManualIntake = hasManualQuoteIntakeSource(quote);

              return (
                <div key={quote.id} className="rounded-3xl border border-white/8 bg-black/20 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className="text-lg font-medium">{part?.name ?? "Unknown part"}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                        <p className="text-white/50">{formatVendorName(quote.vendor)}</p>
                        <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/65">
                          Qty {quote.requested_quantity}
                        </Badge>
                        {isManualVendor ? (
                          <Badge className="border border-sky-500/20 bg-sky-500/10 text-sky-200">
                            Manual source
                          </Badge>
                        ) : null}
                        {isManualIntake ? (
                          <Badge className="border border-amber-500/20 bg-amber-500/10 text-amber-200">
                            Manual intake
                          </Badge>
                        ) : !isManualVendor ? (
                          <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/65">
                            Browser adapter
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                    <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/75">
                      {formatStatusLabel(quote.status)}
                    </Badge>
                  </div>
                  <Separator className="my-4 bg-white/10" />
                  <div className="grid gap-4 md:grid-cols-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-white/40">Raw total</p>
                      <p className="mt-2 text-lg font-medium">{formatCurrency(quote.total_price_usd)}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-white/40">Projected client</p>
                      <p className="mt-2 text-lg font-medium">
                        {formatCurrency(projectedClientPrice(quote.total_price_usd))}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-white/40">Lead time</p>
                      <p className="mt-2 text-lg font-medium">{formatLeadTime(quote.lead_time_business_days)}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-white/40">Quote link</p>
                      {quote.quote_url ? (
                        <a
                          href={quote.quote_url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-2 inline-flex items-center text-sm text-primary hover:underline"
                        >
                          Open vendor quote
                          <ArrowUpRight className="ml-1 h-4 w-4" />
                        </a>
                      ) : (
                        <p className="mt-2 text-sm text-white/50">Not available</p>
                      )}
                    </div>
                  </div>
                  {Array.isArray(quote.dfm_issues) && quote.dfm_issues.length > 0 ? (
                    <div className="mt-4 rounded-2xl border border-white/8 bg-white/5 p-4 text-sm text-white/55">
                      <p className="font-medium text-white">DFM issues</p>
                      {(quote.dfm_issues as string[]).map((issue) => (
                        <p key={issue} className="mt-2">
                          {issue}
                        </p>
                      ))}
                    </div>
                  ) : null}
                  {importedOffers.length > 0 ? (
                    <div className="mt-4 rounded-2xl border border-white/8 bg-white/5 p-4">
                      <div className="flex items-center justify-between gap-4">
                        <p className="text-sm font-medium text-white">Imported offer lanes</p>
                        <p className="text-xs text-white/45">
                          {importedOffers.length} option{importedOffers.length === 1 ? "" : "s"}
                        </p>
                      </div>
                      <div className="mt-4 grid gap-3">
                        {importedOffers.map((offer) => {
                          const laneLabel = offer.laneLabel || [offer.sourcing, offer.tier].filter(Boolean).join(" / ");
                          const publishedOptionKinds = offer.id ? optionKindsByOfferId.get(offer.id) ?? [] : [];

                          return (
                            <div key={offer.offerId} className="rounded-2xl border border-white/8 bg-black/20 p-4">
                              <div className="flex flex-wrap items-start justify-between gap-4">
                                <div>
                                  <p className="font-medium text-white">{laneLabel || offer.supplier}</p>
                                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                                    {offer.quoteRef ? (
                                      <Badge
                                        variant="secondary"
                                        className="border border-white/10 bg-white/5 text-white/70"
                                      >
                                        Ref: {offer.quoteRef}
                                      </Badge>
                                    ) : null}
                                    {offer.shipReceiveBy ? (
                                      <Badge
                                        variant="secondary"
                                        className="border border-white/10 bg-white/5 text-white/70"
                                      >
                                        Ship/receive: {offer.shipReceiveBy}
                                      </Badge>
                                    ) : null}
                                    {offer.process ? (
                                      <Badge
                                        variant="secondary"
                                        className="border border-white/10 bg-white/5 text-white/70"
                                      >
                                        {offer.process}
                                      </Badge>
                                    ) : null}
                                    <Badge
                                      variant="secondary"
                                      className="border border-white/10 bg-white/5 text-white/70"
                                    >
                                      Qty {offer.requestedQuantity}
                                    </Badge>
                                    {publishedOptionKinds.map((kind) => (
                                      <Badge
                                        key={`${offer.offerId}-${kind}`}
                                        className="border border-primary/20 bg-primary/10 text-primary"
                                      >
                                        Published: {kind}
                                      </Badge>
                                    ))}
                                  </div>
                                </div>
                                <div className="text-right">
                                  <p className="text-lg font-medium text-white">{formatCurrency(offer.totalPriceUsd)}</p>
                                  <p className="text-sm text-white/50">{formatLeadTime(offer.leadTimeBusinessDays)}</p>
                                </div>
                              </div>
                              <div className="mt-4 grid gap-3 text-sm text-white/55 md:grid-cols-3">
                                <div>
                                  <p className="text-xs uppercase tracking-[0.2em] text-white/35">Unit</p>
                                  <p className="mt-1 text-white/75">{formatCurrency(offer.unitPriceUsd)}</p>
                                </div>
                                <div>
                                  <p className="text-xs uppercase tracking-[0.2em] text-white/35">Material</p>
                                  <p className="mt-1 text-white/75">{offer.material || "N/A"}</p>
                                </div>
                                <div>
                                  <p className="text-xs uppercase tracking-[0.2em] text-white/35">Finish</p>
                                  <p className="mt-1 text-white/75">{offer.finish || "N/A"}</p>
                                </div>
                              </div>
                              {offer.notes ? <p className="mt-3 text-sm text-white/55">{offer.notes}</p> : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </section>
  );
}
