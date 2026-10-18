import type { ReactNode, Ref } from "react";
import { Check } from "lucide-react";
import {
  anonymousHomeExamplePart,
  anonymousHomeExampleQuotes,
} from "@/components/quote-intelligence/anonymous-home-example";
import { useScriptedLoop } from "@/components/quote-intelligence/use-scripted-loop";
import { formatCurrency } from "@/features/quotes/utils";
import { cn } from "@/lib/utils";

const part = anonymousHomeExamplePart;
const quotes = anonymousHomeExampleQuotes;

/** Tick at which each provider returns its offer, staggered so arrival order differs from list order. */
const requestTick = 62;
const providerArrivalTicks = [84, 102, 124, 74, 90, 112] as const;

function arrivalTick(index: number) {
  return providerArrivalTicks[index] ?? 120;
}

const command = `Quote ${part.cadFilename} + ${part.drawingFilename}, ${part.requestedQuantity} pcs`;
const charsPerTick = 2;
const typingTicks = Math.ceil(command.length / charsPerTick);
const demoLength = 135;

type DemoFrameProps = {
  readonly title: string;
  readonly children: ReactNode;
  readonly hostRef?: Ref<HTMLDivElement>;
  readonly label?: string;
};

export function DemoFrame({ title, children, hostRef, label = "Sample data · not live quotes" }: DemoFrameProps) {
  return (
    <div ref={hostRef} className="rounded-surface-lg bg-ws-inset p-3 sm:p-8">
      <div className="overflow-hidden rounded-surface-lg border border-ws-border-subtle bg-ws-card">
        <div className="flex items-center justify-between gap-3 border-b border-ws-border-subtle px-4 py-2.5">
          <span className="truncate font-mono text-[12px] text-muted-foreground">{title}</span>
          <span className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-paper-red">
            {label}
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}

function StepLine({ done, children }: { readonly done: boolean; readonly children: ReactNode }) {
  return (
    <li
      className={cn(
        "flex items-start gap-2 text-[12px] leading-[1.5] transition-opacity duration-200",
        done ? "opacity-100" : "opacity-0",
      )}
    >
      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-paper-red" aria-hidden="true" />
      <span className="text-foreground">{children}</span>
    </li>
  );
}

function ProviderRow({ index, tick }: { readonly index: number; readonly tick: number }) {
  const quote = quotes[index];
  const received = tick >= arrivalTick(index);
  const requested = tick >= requestTick;
  return (
    <div className="flex items-center justify-between gap-3 border-b border-ws-border-subtle px-4 py-2.5 text-[12px] last:border-b-0">
      <span className="truncate text-foreground">{quote.supplier}</span>
      <span
        className={cn(
          "shrink-0 font-mono text-[12px]",
          received ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {received
          ? `${formatCurrency(quote.totalPriceUsd)} · ${quote.leadTimeBusinessDays}d`
          : requested
            ? "Quoting…"
            : "Queued"}
      </span>
    </div>
  );
}

/** Hero demo: command, extraction, and providers answering in parallel. */
export function HardwareAgentDemo() {
  const { hostRef, tick } = useScriptedLoop<HTMLDivElement>({ length: demoLength });
  const typed = command.slice(0, Math.min(tick, typingTicks) * charsPerTick);
  const received = quotes.filter((_, index) => tick >= arrivalTick(index)).length;

  return (
    <DemoFrame title={`${part.partNumber} · new request`} hostRef={hostRef}>
      <div className="grid min-h-[360px] md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5 border-b border-ws-border-subtle p-5 md:border-b-0 md:border-r">
          <p className="min-h-[2.75rem] font-mono text-[12px] leading-[1.6] text-foreground" aria-label={command}>
            <span className="text-paper-red">&gt; </span>
            {typed}
            {tick < typingTicks ? <span className="ml-px inline-block h-3.5 w-[6px] translate-y-0.5 bg-foreground" /> : null}
          </p>
          <ul className="space-y-2.5" aria-live="polite">
            <StepLine done={tick >= typingTicks + 8}>Matched 1 CAD/PDF pair</StepLine>
            <StepLine done={tick >= typingTicks + 22}>
              Read the drawing: {part.material} · {part.finish} · {part.tolerance}
            </StepLine>
            <StepLine done={tick >= requestTick}>Requested quotes from {quotes.length} providers</StepLine>
            <StepLine done={received === quotes.length}>{quotes.length} offers ready to compare</StepLine>
          </ul>
        </div>
        <div className="flex flex-col">
          <div className="flex items-center justify-between border-b border-ws-border-subtle px-4 py-2.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              Providers
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {received} of {quotes.length} offers
            </span>
          </div>
          {quotes.map((quote, index) => (
            <ProviderRow key={quote.key} index={index} tick={tick} />
          ))}
        </div>
      </div>
    </DemoFrame>
  );
}

/** Section 1: a drawing becomes extracted requirements. */
export function DrawingToQuoteDemo() {
  const { hostRef, tick } = useScriptedLoop<HTMLDivElement>({ length: 60, holdTicks: 50 });
  const specs = [
    ["Material", part.material],
    ["Finish", part.finish],
    ["Tolerance", part.tolerance],
    ["Quantity", `${part.requestedQuantity} pcs`],
    ["Revision", part.revision],
  ] as const;

  return (
    <DemoFrame title={`${part.partNumber} · drawing`} hostRef={hostRef} label="Sample data · example part">
      <div className="grid md:grid-cols-2">
        <div className="border-b border-ws-border-subtle p-5 md:border-b-0 md:border-r">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Uploaded</p>
          <div className="mt-3 space-y-2 font-mono text-[12px] text-foreground">
            <p className={cn("transition-opacity duration-200", tick >= 4 ? "opacity-100" : "opacity-0")}>
              {part.cadFilename} <span className="text-muted-foreground">· CAD</span>
            </p>
            <p className={cn("transition-opacity duration-200", tick >= 12 ? "opacity-100" : "opacity-0")}>
              {part.drawingFilename} <span className="text-muted-foreground">· Drawing</span>
            </p>
          </div>
          <p
            className={cn(
              "mt-5 border-t border-ws-border-subtle pt-3 font-mono text-[12px] uppercase tracking-[0.06em] text-foreground transition-opacity duration-200",
              tick >= 18 ? "opacity-100" : "opacity-0",
            )}
          >
            Matched · 1 CAD/PDF pair
          </p>
        </div>
        <div className="p-5">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            Read from the drawing
          </p>
          <dl className="mt-3 space-y-2">
            {specs.map(([label, value], index) => (
              <div
                key={label}
                className={cn(
                  "flex gap-3 text-[12px] transition-opacity duration-200",
                  tick >= 26 + index * 5 ? "opacity-100" : "opacity-0",
                )}
              >
                <dt className="w-[40%] text-muted-foreground">{label}</dt>
                <dd className="font-medium text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-[12px] text-muted-foreground">Review and correct before quoting.</p>
        </div>
      </div>
    </DemoFrame>
  );
}

/** Section 2: every provider is asked at once and answers on its own clock. */
export function ParallelProvidersDemo() {
  const { hostRef, tick } = useScriptedLoop<HTMLDivElement>({ length: demoLength, holdTicks: 40 });

  return (
    <DemoFrame title={`${part.partNumber} · ${quotes.length} providers`} hostRef={hostRef} label="Founding Beta · sample data">
      <div className="px-5 py-4">
        {quotes.map((quote, index) => {
          const end = arrivalTick(index);
          const progress = Math.min(1, Math.max(0, (tick - requestTick) / (end - requestTick)));
          const done = tick >= end;
          return (
            <div
              key={quote.key}
              className="grid grid-cols-[110px_minmax(0,1fr)_88px] items-center gap-3 border-b border-ws-border-subtle py-2.5 last:border-b-0 sm:grid-cols-[170px_minmax(0,1fr)_110px]"
            >
              <span className="truncate text-[12px] text-foreground">{quote.supplier}</span>
              <div className="h-1.5 bg-ws-inset" aria-hidden="true">
                <div
                  className={cn("h-full", done ? "bg-foreground" : "bg-paper-red")}
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
              <span className="text-right font-mono text-[12px] text-foreground">
                {done ? formatCurrency(quote.totalPriceUsd) : tick >= requestTick ? "Quoting…" : "Queued"}
              </span>
            </div>
          );
        })}
      </div>
    </DemoFrame>
  );
}

type LedgerPart = {
  readonly name: string;
  readonly process: string;
  readonly providers: number;
  readonly startsAt: number;
  readonly doneAt: number;
};

const ledgerParts: readonly LedgerPart[] = [
  { name: "FLT-BRACKET-01", process: "CNC milling", providers: 6, startsAt: 6, doneAt: 60 },
  { name: "FLT-HOUSING-02", process: "CNC milling", providers: 6, startsAt: 10, doneAt: 78 },
  { name: "FLT-PANEL-03", process: "Sheet metal", providers: 5, startsAt: 14, doneAt: 70 },
  { name: "FLT-SHAFT-04", process: "CNC turning", providers: 4, startsAt: 18, doneAt: 92 },
  { name: "FLT-FRAME-05", process: "Weldment", providers: 3, startsAt: 22, doneAt: 108 },
];

/** Section 4: a whole project quoting in parallel. */
export function ProjectLedgerDemo() {
  const { hostRef, tick } = useScriptedLoop<HTMLDivElement>({ length: demoLength, holdTicks: 40 });
  const ready = ledgerParts.filter((entry) => tick >= entry.doneAt).length;

  return (
    <DemoFrame title="FLT-GIMBAL · project" hostRef={hostRef}>
      <div className="flex items-center justify-between border-b border-ws-border-subtle px-4 py-2.5">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Parts</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {ready} of {ledgerParts.length} ready to compare
        </span>
      </div>
      {ledgerParts.map((entry) => {
        const status =
          tick >= entry.doneAt ? "Offers ready" : tick >= entry.startsAt ? "Quoting…" : "Reading drawing";
        return (
          <div
            key={entry.name}
            className="grid grid-cols-[minmax(0,1fr)_96px] items-center gap-3 border-b border-ws-border-subtle px-4 py-2.5 text-[12px] last:border-b-0 sm:grid-cols-[minmax(0,1fr)_120px_130px_100px]"
          >
            <span className="truncate font-mono text-foreground">{entry.name}</span>
            <span className="hidden text-muted-foreground sm:block">{entry.process}</span>
            <span className="hidden font-mono text-[12px] text-muted-foreground sm:block">
              {entry.providers} providers
            </span>
            <span
              className={cn(
                "text-right font-mono text-[12px]",
                tick >= entry.doneAt ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {status}
            </span>
          </div>
        );
      })}
    </DemoFrame>
  );
}
