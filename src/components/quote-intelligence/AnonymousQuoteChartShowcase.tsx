import { Component, lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { ArrowDownLeft, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  anonymousHomeDefaultQuote,
  anonymousHomeDefaultQuoteKey,
  anonymousHomeExamplePart,
  anonymousHomeExampleQuotes,
  anonymousHomeFastestQuote,
  anonymousHomeLowestPriceQuote,
} from "@/components/quote-intelligence/anonymous-home-example";
import { formatCurrency } from "@/features/quotes/utils";
import { cn } from "@/lib/utils";

const ClientQuoteComparisonChart = lazy(() =>
  import("@/components/quotes/ClientQuoteComparisonChart").then((module) => ({
    default: module.ClientQuoteComparisonChart,
  })),
);

type AnonymousQuoteChartShowcaseProps = {
  readonly onGetStarted: () => void;
};

type QuoteChartErrorBoundaryProps = {
  children: ReactNode;
};

type QuoteChartErrorBoundaryState = {
  hasError: boolean;
};

class QuoteChartErrorBoundary extends Component<QuoteChartErrorBoundaryProps, QuoteChartErrorBoundaryState> {
  state: QuoteChartErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): QuoteChartErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Anonymous quote comparison chart failed to load", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-[320px] items-center justify-center border border-ws-border-subtle bg-ws-inset px-6 text-center sm:h-[420px]">
          <p className="max-w-sm text-[13px] leading-[1.6] text-muted-foreground">
            The interactive chart is temporarily unavailable. You can still compare and select every illustrative
            option below.
          </p>
        </div>
      );
    }

    return this.props.children;
  }
}

function getQuoteByKey(key: string | null) {
  return anonymousHomeExampleQuotes.find((quote) => quote.key === key) ?? anonymousHomeDefaultQuote;
}

export function AnonymousQuoteChartShowcase({ onGetStarted }: AnonymousQuoteChartShowcaseProps) {
  const [selectedKey, setSelectedKey] = useState(anonymousHomeDefaultQuoteKey);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [shouldLoadChart, setShouldLoadChart] = useState(false);
  const chartHostRef = useRef<HTMLDivElement>(null);
  const activeQuote = getQuoteByKey(hoveredKey ?? selectedKey);
  const isPreviewing = hoveredKey !== null && hoveredKey !== selectedKey;
  const savingsVersusFastest = anonymousHomeFastestQuote.totalPriceUsd - anonymousHomeDefaultQuote.totalPriceUsd;
  const daysFasterThanLowest =
    anonymousHomeLowestPriceQuote.leadTimeBusinessDays - anonymousHomeDefaultQuote.leadTimeBusinessDays;

  useEffect(() => {
    const chartHost = chartHostRef.current;
    if (!chartHost) {
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      setShouldLoadChart(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldLoadChart(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px" },
    );

    observer.observe(chartHost);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="mt-20" aria-labelledby="quote-chart-showcase-heading">
      <div className="max-w-[720px]">
        <p className="ws-section-label">Quote comparison</p>
        <h2
          id="quote-chart-showcase-heading"
          className="mt-4 font-display text-[30px] font-bold leading-[1.08] tracking-[-0.035em] text-foreground sm:text-[42px]"
        >
          Multiple quotes. One obvious tradeoff.
        </h2>
        <p className="mt-4 max-w-[650px] text-[15px] leading-[1.65] text-muted-foreground sm:text-[16px]">
          Price runs vertically. Lead time runs horizontally. The strongest options move toward the lower-left, so
          the field makes sense before you choose.
        </p>
      </div>

      <div className="mt-8 overflow-hidden rounded-surface-lg border border-ws-border-subtle bg-ws-card">
        <div className="flex flex-col gap-3 border-b border-ws-border-subtle px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-paper-red">
              Illustrative Pro comparison · sample data
            </p>
            <p className="mt-1 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              {anonymousHomeExamplePart.partNumber} · {anonymousHomeExamplePart.requestedQuantity} pcs
            </p>
            <p className="mt-1 text-[13px] font-medium text-foreground">
              {anonymousHomeExampleQuotes.length} illustrative CNC milling offers
            </p>
          </div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-paper-red">
            Sample prices · not live quotes
          </p>
        </div>

        <div className="grid lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="min-w-0 px-2 pb-3 pt-4 sm:px-5 sm:pb-5">
            <div className="mb-1 flex items-center gap-2 px-2 text-[11px] font-medium text-muted-foreground">
              <ArrowDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Lower-left means faster and less expensive
            </div>
            <div ref={chartHostRef}>
              {shouldLoadChart ? (
                <QuoteChartErrorBoundary>
                  <Suspense fallback={<div className="h-[320px] bg-ws-inset sm:h-[420px]" />}>
                    <ClientQuoteComparisonChart
                      options={anonymousHomeExampleQuotes}
                      selectedKey={selectedKey}
                      hoveredKey={hoveredKey}
                      partId="homepage-example"
                      diagnosticsEnabled={false}
                      colorMode="monochrome"
                      onSelect={(quote) => setSelectedKey(quote.key)}
                      onHover={setHoveredKey}
                    />
                  </Suspense>
                </QuoteChartErrorBoundary>
              ) : (
                <div className="h-[320px] bg-ws-inset sm:h-[420px]" aria-hidden="true" />
              )}
            </div>
          </div>

          <aside
            className="border-t border-ws-border-subtle bg-ws-inset p-5 lg:border-l lg:border-t-0 lg:p-6"
            aria-live="polite"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                {isPreviewing ? "Previewing example" : "Selected example"}
              </p>
              {!isPreviewing ? (
                <span className="inline-flex items-center gap-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-paper-red">
                  <Check className="h-3 w-3" aria-hidden="true" /> Selected
                </span>
              ) : null}
            </div>

            <h3 className="mt-5 font-display text-[20px] font-semibold tracking-[-0.02em] text-foreground">
              {activeQuote.supplier}
            </h3>
            <p className="mt-1 text-[12px] text-muted-foreground">
              {activeQuote.tier} · {activeQuote.sourcing}
            </p>

            <div className="mt-6 border-y border-ws-border-subtle py-4">
              <div className="flex items-end justify-between gap-3">
                <span className="text-[11px] text-muted-foreground">Sample total</span>
                <span className="font-mono text-[24px] font-semibold tracking-[-0.04em] text-foreground">
                  {formatCurrency(activeQuote.totalPriceUsd)}
                </span>
              </div>
              <div className="mt-3 flex items-end justify-between gap-3">
                <span className="text-[11px] text-muted-foreground">Sample lead time</span>
                <span className="font-mono text-[16px] font-semibold text-foreground">
                  {activeQuote.leadTimeBusinessDays} working days
                </span>
              </div>
            </div>

            {activeQuote.key === anonymousHomeDefaultQuoteKey ? (
              <div className="mt-5 space-y-3 text-[12px] leading-[1.5]">
                <p className="flex gap-2 text-foreground">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-paper-red" aria-hidden="true" />
                  {formatCurrency(savingsVersusFastest)} less than the fastest example
                </p>
                <p className="flex gap-2 text-foreground">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-paper-red" aria-hidden="true" />
                  {daysFasterThanLowest} days faster than the lowest example
                </p>
              </div>
            ) : (
              <p className="mt-5 text-[12px] leading-[1.6] text-muted-foreground">
                Select this option to hold it in place and compare its price-to-speed tradeoff.
              </p>
            )}

            <p className="mt-6 text-[10px] leading-[1.5] text-muted-foreground">
              Illustrative quote data. These are not live offers.
            </p>
            <Button type="button" className="mt-5 min-h-11 w-full" onClick={onGetStarted}>
              Compare your quotes
            </Button>
          </aside>
        </div>

        <div className="grid border-t border-ws-border-subtle sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {anonymousHomeExampleQuotes.map((quote) => {
            const isSelected = quote.key === selectedKey;
            return (
              <button
                key={quote.key}
                type="button"
                aria-label={`Select ${quote.supplier} example`}
                aria-pressed={isSelected}
                className={cn(
                  "min-h-16 border-b border-ws-border-subtle px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-paper-red focus-visible:ring-inset sm:border-r",
                  isSelected ? "border-l-2 border-l-paper-red bg-ws-inset" : "hover:bg-ws-inset",
                )}
                onClick={() => setSelectedKey(quote.key)}
                onFocus={() => setHoveredKey(quote.key)}
                onBlur={() => setHoveredKey(null)}
                onMouseEnter={() => setHoveredKey(quote.key)}
                onMouseLeave={() => setHoveredKey(null)}
              >
                <span className="block text-[11px] font-semibold text-foreground">{quote.supplier}</span>
                <span className="mt-1 block font-mono text-[10px] text-muted-foreground">
                  {formatCurrency(quote.totalPriceUsd)} · {quote.leadTimeBusinessDays}d
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
