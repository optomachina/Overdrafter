import { ArrowRight, FileUp, LogIn } from "lucide-react";

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

      <section className="grid min-h-[calc(100svh-4rem)] lg:grid-cols-[minmax(0,0.8fr)_minmax(36rem,1.2fr)]">
        <div className="flex flex-col justify-center px-5 py-12 sm:px-8 lg:px-12">
          <p className="font-mono text-micro uppercase text-paper-red">Machined aluminum sourcing</p>
          <h1 className="mt-5 max-w-[12ch] font-display text-[44px] font-bold leading-[0.98] tracking-[-0.055em] sm:text-[64px]">
            Parts in. Clear sourcing paths out.
          </h1>
          <p className="mt-6 max-w-md text-body-lg text-paper-muted">
            Upload a STEP model and PDF drawing. Free gives you ranked potential providers and official RFQ links. Pro
            automatically collects supported vendor quotes for $49/month.
          </p>
          <p className="mt-4 max-w-md text-[13px] leading-relaxed text-paper-muted">
            Recommendations come from reviewed capability data. If vendor automation is unavailable, the same useful
            sourcing guidance remains available.
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

        <div className="relative min-h-[36rem] border-t border-paper-hairline bg-paper-surface p-5 sm:p-8 lg:border-l lg:border-t-0 lg:p-12">
          <div className="absolute inset-0 opacity-50 [background-image:linear-gradient(var(--hairline)_1px,transparent_1px),linear-gradient(90deg,var(--hairline)_1px,transparent_1px)] [background-size:32px_32px]" aria-hidden="true" />
          <figure className="relative flex h-full min-h-[32rem] flex-col border border-paper-hairline bg-paper-surface">
            <figcaption className="flex items-center justify-between border-b border-paper-hairline px-4 py-3 font-mono text-[10px] uppercase tracking-[0.08em] text-paper-muted">
              <span>Illustrative Pro workspace · sample data</span>
              <span>Q7M4DX</span>
            </figcaption>
            <div className="grid flex-1 md:grid-cols-[0.8fr_1.2fr]">
              <div className="flex items-center justify-center border-b border-paper-hairline p-8 md:border-b-0 md:border-r">
                <svg viewBox="0 0 260 240" role="img" aria-label="Example technical part outline" className="w-full max-w-[280px]">
                  <path d="M44 172 112 54l104 45-68 118Z" fill="none" stroke="var(--text)" strokeWidth="2" />
                  <path d="m44 172 103 45 69-118M112 54l35 163" fill="none" stroke="var(--hairline-strong)" />
                  <circle cx="117" cy="126" r="24" fill="var(--surface)" stroke="var(--accent-red)" strokeWidth="2" />
                  <path d="M16 212h112M18 204v16M128 204v16" stroke="var(--muted-ink)" />
                  <text x="55" y="232" fill="var(--muted-ink)" fontSize="10" fontFamily="monospace">112.00 mm</text>
                </svg>
              </div>
              <div className="flex flex-col p-5 sm:p-7">
                <div>
                  <p className="font-mono text-[10px] uppercase text-paper-muted">FLT-BRACKET-01 · REV B</p>
                  <h2 className="mt-2 font-display text-2xl font-bold">Example returned offers</h2>
                  <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.08em] text-paper-red">
                    Sample prices and lead times — not live quotes
                  </p>
                </div>
                <svg viewBox="0 0 420 230" role="img" aria-label="Example price versus lead-time comparison" className="mt-8 w-full">
                  <path d="M48 18v172h342M48 61h342M48 104h342M48 147h342" fill="none" stroke="var(--hairline)" />
                  <circle cx="138" cy="84" r="6" fill="var(--text)" />
                  <circle cx="246" cy="126" r="6" fill="var(--accent-red)" />
                  <circle cx="334" cy="54" r="6" fill="var(--text)" />
                  <text x="48" y="214" fill="var(--muted-ink)" fontSize="11" fontFamily="monospace">READY-TO-SHIP DAYS →</text>
                  <text x="8" y="16" fill="var(--muted-ink)" fontSize="11" fontFamily="monospace">TOTAL</text>
                </svg>
                <div className="mt-auto border-t border-paper-hairline">
                  {[
                    ["Apex CNC", "$1,842", "12 days"],
                    ["Mesa Precision", "$2,010", "8 days"],
                    ["Northline", "$1,695", "18 days"],
                  ].map(([supplier, total, lead]) => (
                    <div key={supplier} className="grid grid-cols-[1fr_auto_auto] gap-4 border-b border-paper-hairline py-3 text-[12px]">
                      <span>{supplier}</span>
                      <span className="font-mono">{total}</span>
                      <span className="font-mono text-paper-muted">{lead}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </figure>
        </div>
      </section>
    </main>
  );
}
