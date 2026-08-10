import { useId } from "react";
import { ArrowRight, FileUp, LogIn } from "lucide-react";

const quotePoints = [
  { name: "Mesa Precision", detail: "$2,240 · 7 days", x: 130, y: 100 },
  { name: "Apex CNC", detail: "$1,842 · 11 days", x: 250, y: 180, recommended: true },
  { name: "Orbit Manufacturing", detail: "$1,990 · 14 days", x: 340, y: 150 },
  { name: "Northline", detail: "$1,695 · 18 days", x: 445, y: 210 },
];

type QuoteIntelligenceLandingProps = {
  onUpload: () => void;
  onSignIn: () => void;
  onCreateAccount?: () => void;
  isUploadDisabled?: boolean;
};

export function QuoteIntelligenceLanding({
  onUpload,
  onSignIn,
  onCreateAccount,
  isUploadDisabled = false,
}: QuoteIntelligenceLandingProps) {
  const quoteChartSummaryId = useId();

  return (
    <main className="min-h-svh overflow-hidden bg-paper text-paper-ink">
      <header className="flex h-16 items-center border-b border-paper-hairline px-5 sm:px-8 lg:px-12">
        <span className="font-display text-[15px] font-bold uppercase tracking-[-0.04em]">OverDrafter</span>
        <button
          type="button"
          onClick={onSignIn}
          className="ml-auto inline-flex min-h-11 items-center gap-2 border border-paper-hairline bg-paper-surface px-4 text-[13px] font-medium transition-colors hover:bg-paper-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-paper-red"
        >
          <LogIn className="h-4 w-4" aria-hidden="true" />
          Sign in
        </button>
      </header>

      <section className="grid min-h-[calc(100svh-7.5rem)] items-center gap-8 px-5 py-8 sm:px-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(28rem,1.15fr)] lg:gap-12 lg:px-12">
        <div className="w-full max-w-2xl">
          <p className="font-mono text-micro uppercase text-paper-red">Machined aluminum sourcing</p>
          <h1 className="mt-5 max-w-[12ch] font-display text-[44px] font-bold leading-[0.98] tracking-[-0.055em] sm:text-[64px]">
            Files In
            <br />
            <span className="text-paper-muted">Parts Out</span>
          </h1>
          <p className="mt-6 max-w-2xl text-body-lg text-paper-muted">
            Upload CAD files and drawings to collect vendor quotes, compare price and lead time, and choose the best
            source for your budget and deadline.
          </p>
          <div className="mt-8 flex flex-col items-start gap-3 sm:flex-row">
            <button
              type="button"
              onClick={onUpload}
              disabled={isUploadDisabled}
              className="inline-flex min-h-12 items-center gap-3 bg-paper-ink px-5 text-[14px] font-semibold text-paper transition-colors hover:bg-paper-data focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-paper-red disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FileUp className="h-4 w-4" aria-hidden="true" />
              Upload a part package
            </button>
            {onCreateAccount ? (
              <button
                type="button"
                onClick={onCreateAccount}
                className="inline-flex min-h-12 items-center gap-2 border-b border-paper-ink px-1 text-[14px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-paper-red"
              >
                Create account
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.08em] text-paper-muted">
            Launch scope · machined aluminum · STEP + PDF
          </p>
        </div>

        <figure className="min-w-0 border-t border-paper-hairline pt-5 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0">
          <figcaption className="flex items-baseline justify-between gap-4 border-b border-paper-hairline pb-3">
            <span className="font-display text-lg font-bold">Quote comparison</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-paper-muted">
              Price × lead time
            </span>
          </figcaption>
          <svg
            viewBox="0 0 560 300"
            role="img"
            aria-label="Vendor quotes plotted by total price and lead time"
            aria-describedby={quoteChartSummaryId}
            className="mt-3 w-full"
          >
            <g fill="none" stroke="var(--hairline)">
              <path d="M70 36v212h450" stroke="var(--hairline-strong)" />
              <path d="M70 68h450M70 128h450M70 188h450M70 248h450" />
              <path d="M182 36v212M294 36v212M406 36v212M518 36v212" />
            </g>

            <g fill="var(--muted-ink)" fontFamily="monospace" fontSize="10">
              <text x="6" y="19">TOTAL PRICE</text>
              <text x="34" y="72">$2.4k</text>
              <text x="34" y="132">$2.1k</text>
              <text x="34" y="192">$1.8k</text>
              <text x="34" y="252">$1.5k</text>
              <text x="65" y="270">5</text>
              <text x="176" y="270">10</text>
              <text x="288" y="270">15</text>
              <text x="400" y="270">20</text>
              <text x="431" y="291">LEAD TIME · DAYS</text>
            </g>

            <path d="M340 36v212" fill="none" stroke="var(--accent-red)" strokeDasharray="5 5" opacity="0.6" />
            <text x="348" y="52" fill="var(--accent-red)" fontFamily="monospace" fontSize="10">
              14 DAY TARGET
            </text>

            {quotePoints.map((point) => (
              <g key={point.name} className="group cursor-default transition-opacity hover:opacity-75">
                <title>{`${point.name}: ${point.detail}`}</title>
                {point.recommended ? (
                  <circle cx={point.x} cy={point.y} r="12" fill="var(--surface)" stroke="var(--accent-red)" strokeWidth="2" />
                ) : null}
                <circle
                  cx={point.x}
                  cy={point.y}
                  r="5"
                  fill={point.recommended ? "var(--accent-red)" : "var(--text)"}
                />
                <text
                  x={point.x + 12}
                  y={point.y - 8}
                  fill={point.recommended ? "var(--accent-red)" : "var(--text)"}
                  fontFamily="monospace"
                  fontSize="10"
                  fontWeight={point.recommended ? "700" : "400"}
                >
                  {point.name}
                </text>
                <text x={point.x + 12} y={point.y + 8} fill="var(--muted-ink)" fontFamily="monospace" fontSize="9">
                  {point.detail}
                </text>
              </g>
            ))}
          </svg>
          <p id={quoteChartSummaryId} className="sr-only">
            Apex CNC is recommended at $1,842 with an 11-day lead time. Mesa Precision is $2,240 with a 7-day lead
            time. Orbit Manufacturing is $1,990 with a 14-day lead time. Northline is $1,695 with an 18-day lead time.
          </p>
        </figure>
      </section>

      <footer className="flex min-h-14 items-center justify-between gap-4 border-t border-paper-hairline px-5 font-mono text-[10px] uppercase tracking-[0.08em] text-paper-muted sm:px-8 lg:px-12">
        <span>© 2026 OverDrafter</span>
        <span>Manufacturing sourcing software</span>
      </footer>
    </main>
  );
}
