import { ExternalLink, Route, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ClientSourcingResult } from "@/features/quotes/sourcing-result";
import { cn } from "@/lib/utils";

interface ClientSourcingResultPanelProps {
  readonly compact?: boolean;
  readonly isProcessSaving?: boolean;
  readonly onProcessSelect?: (process: "CNC milling" | "CNC turning") => void;
  readonly result: ClientSourcingResult;
  readonly selectedProcess?: string | null;
}

export function ClientSourcingResultPanel({
  compact = false,
  isProcessSaving = false,
  onProcessSelect,
  result,
  selectedProcess = null,
}: ClientSourcingResultPanelProps) {
  if (result.outcome === "unsupported_package") {
    const normalizedProcess = selectedProcess?.trim().toLowerCase() ?? "";
    let selectedProcessKind: "milling" | "turning" | null = null;

    if (normalizedProcess.includes("mill")) {
      selectedProcessKind = "milling";
    } else if (normalizedProcess.includes("turn") || normalizedProcess.includes("lathe")) {
      selectedProcessKind = "turning";
    }

    const showProcessSelector =
      (result.reason === "process_unresolved" || result.reason === "unsupported_process") &&
      Boolean(onProcessSelect);

    return (
      <section className="rounded-[22px] border border-border bg-ws-card p-5">
        <Badge className="border border-border bg-muted font-mono text-muted-foreground">
          Action needed
        </Badge>
        <h2 className="mt-3 text-lg font-semibold text-foreground">{result.title}</h2>
        <p className="mt-2 text-sm leading-6 text-foreground/80">{result.explanation}</p>
        <p className="mt-3 text-sm font-medium text-foreground">{result.nextAction}</p>
        {showProcessSelector ? (
          <div className="mt-4 border-t border-border pt-4">
            <p className="text-sm font-medium text-foreground">Select the manufacturing process</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Your selection is saved to the request and provider matching refreshes automatically.
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <Button
                type="button"
                variant={selectedProcessKind === "milling" ? "default" : "outline"}
                aria-pressed={selectedProcessKind === "milling"}
                className={cn(
                  "w-full rounded-full sm:w-auto",
                  selectedProcessKind !== "milling" && "bg-transparent",
                )}
                disabled={isProcessSaving}
                onClick={() => onProcessSelect?.("CNC milling")}
              >
                CNC milling
              </Button>
              <Button
                type="button"
                variant={selectedProcessKind === "turning" ? "default" : "outline"}
                aria-pressed={selectedProcessKind === "turning"}
                className={cn(
                  "w-full rounded-full sm:w-auto",
                  selectedProcessKind !== "turning" && "bg-transparent",
                )}
                disabled={isProcessSaving}
                onClick={() => onProcessSelect?.("CNC turning")}
              >
                CNC turning
              </Button>
            </div>
          </div>
        ) : null}
      </section>
    );
  }

  const hasLiveOffers = result.outcome === "live_offers_available";
  let heading = "Qualified next steps, available now";
  let detail =
    "Automatic collection has not produced a live offer yet. These potential providers and official RFQ links keep the request moving without operator intervention.";

  if (hasLiveOffers) {
    const offerNoun = result.liveOfferCount === 1 ? "offer" : "offers";
    const fallbackSuffix =
      result.recommendations.length > 0 ? " plus fallback options" : "";
    heading = `${result.liveOfferCount} live ${offerNoun}${fallbackSuffix}`;
    if (compact) {
      detail = "Open the full workspace to compare the returned offers.";
    } else {
      detail =
        result.recommendations.length > 0
          ? "Compare returned offers below. These provider links remain available if another lane is a better fit."
          : "Compare the returned offers below.";
    }
  } else if (result.reason === "free_preview") {
    detail =
      "These are potential providers ranked from reviewed capability data. They are not returned quotes and no price is implied.";
  }

  return (
    <section className="rounded-[22px] border border-border bg-ws-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="border border-border bg-muted font-mono text-muted-foreground">
              {hasLiveOffers ? "Live offers available" : "Provider recommendations available"}
            </Badge>
            <Badge className="border border-border bg-muted text-muted-foreground">
              Sourcing result
            </Badge>
          </div>
          <h2 className="mt-3 text-lg font-semibold text-foreground">{heading}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            {detail}
          </p>
        </div>
        <ShieldCheck className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
      </div>

      <div className={compact ? "mt-5 grid gap-3" : "mt-5 grid gap-3 lg:grid-cols-3"}>
        {result.recommendations.map((recommendation, index) => (
          <article
            key={recommendation.vendorName}
            className="rounded-[18px] border border-border bg-muted p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                  Potential provider #{index + 1}
                </p>
                <h3 className="mt-1 text-base font-semibold text-foreground">
                  {recommendation.vendorLabel}
                </h3>
              </div>
              <Badge className="border border-border bg-accent text-foreground">
                {recommendation.fitScore}% fit
              </Badge>
            </div>
            <ul className="mt-4 space-y-2 text-sm text-foreground/80">
              {recommendation.fitReasons.map((reason) => (
                <li key={reason} className="flex gap-2">
                  <Route className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs text-muted-foreground">
              Capability reviewed {new Date(recommendation.capabilityReviewedAt).toLocaleDateString()}.
              {hasLiveOffers
                ? " This recommendation remains available as a fallback; returned live offers are listed separately below."
                : " No live price has been returned for this recommendation."}
            </p>
            <Button asChild className="mt-4 w-full rounded-full">
              <a
                href={recommendation.officialRfqUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open official RFQ
                <ExternalLink className="ml-2 h-4 w-4" aria-hidden="true" />
              </a>
            </Button>
          </article>
        ))}
      </div>
    </section>
  );
}
