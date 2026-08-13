import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  ClientSourcingResult,
  ProviderRecommendation,
} from "@/features/quotes/sourcing-result";
import { cn } from "@/lib/utils";

interface ClientSourcingResultPanelProps {
  readonly compact?: boolean;
  readonly isProcessSaving?: boolean;
  readonly onProcessSelect?: (process: "CNC milling" | "CNC turning") => void;
  readonly result: ClientSourcingResult;
  readonly selectedProcess?: string | null;
}

type UnsupportedPackageResult = Extract<ClientSourcingResult, { outcome: "unsupported_package" }>;
type RecommendationResult = Exclude<ClientSourcingResult, { outcome: "unsupported_package" }>;
type SelectedProcessKind = "milling" | "turning" | null;

function resolveSelectedProcessKind(selectedProcess: string | null): SelectedProcessKind {
  const normalizedProcess = selectedProcess?.trim().toLowerCase() ?? "";

  if (normalizedProcess.includes("mill")) {
    return "milling";
  }

  if (normalizedProcess.includes("turn") || normalizedProcess.includes("lathe")) {
    return "turning";
  }

  return null;
}

type UnsupportedPackagePanelProps = Readonly<{
  isProcessSaving: boolean;
  onProcessSelect?: (process: "CNC milling" | "CNC turning") => void;
  result: UnsupportedPackageResult;
  selectedProcess: string | null;
}>;

function UnsupportedPackagePanel({
  isProcessSaving,
  onProcessSelect,
  result,
  selectedProcess,
}: UnsupportedPackagePanelProps) {
  const selectedProcessKind = resolveSelectedProcessKind(selectedProcess);
  const requiresProcessSelection =
    result.reason === "process_unresolved" || result.reason === "unsupported_process";
  const showProcessSelector = requiresProcessSelection && Boolean(onProcessSelect);

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

function ProviderRecommendationRow({ recommendation }: Readonly<{ recommendation: ProviderRecommendation }>) {
  const fitSummary = recommendation.fitReasons[0] ?? "Reviewed against the current manufacturing requirements.";

  return (
    <li className="grid gap-2 border-t border-border py-3 first:border-t-0 sm:grid-cols-[minmax(10rem,0.8fr)_minmax(0,1.6fr)_auto] sm:items-center">
      <div>
        <p className="text-sm font-medium text-foreground">{recommendation.vendorLabel}</p>
        <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          {recommendation.fitScore}% capability fit
        </p>
      </div>
      <p className="text-xs text-muted-foreground">{fitSummary}</p>
      <Button asChild variant="ghost" className="h-8 justify-start rounded-[2px] px-2 text-xs sm:justify-center">
        <a href={recommendation.officialRfqUrl} target="_blank" rel="noreferrer">
          Open RFQ
          <ExternalLink className="ml-2 h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </Button>
    </li>
  );
}

function RecommendationPanel({ result }: Readonly<{ result: RecommendationResult }>) {
  const liveOfferLabel = result.outcome === "live_offers_available"
    ? `${result.liveOfferCount} live offer${result.liveOfferCount === 1 ? "" : "s"} shown in comparison`
    : "No live quotes yet";

  return (
    <section className="border-t border-border pt-3" aria-label="Additional sourcing paths">
      <details>
        <summary className="cursor-pointer list-none text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Additional sourcing paths</span>
          <span className="ml-2">
            {liveOfferLabel} · {result.recommendations.length} reviewed provider
            {result.recommendations.length === 1 ? "" : "s"}
          </span>
        </summary>
        <ul className="mt-3 border-y border-border">
          {result.recommendations.map((recommendation) => (
            <ProviderRecommendationRow
              key={recommendation.vendorName}
              recommendation={recommendation}
            />
          ))}
        </ul>
      </details>
    </section>
  );
}

export function ClientSourcingResultPanel({
  isProcessSaving = false,
  onProcessSelect,
  result,
  selectedProcess = null,
}: ClientSourcingResultPanelProps) {
  if (result.outcome === "unsupported_package") {
    return (
      <UnsupportedPackagePanel
        isProcessSaving={isProcessSaving}
        onProcessSelect={onProcessSelect}
        result={result}
        selectedProcess={selectedProcess}
      />
    );
  }

  return <RecommendationPanel result={result} />;
}
