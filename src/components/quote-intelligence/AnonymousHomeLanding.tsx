import { Button } from "@/components/ui/button";
import { AnonymousQuoteChartShowcase } from "@/components/quote-intelligence/AnonymousQuoteChartShowcase";
import {
  anonymousHomeDefaultQuote,
  anonymousHomeExamplePart,
} from "@/components/quote-intelligence/anonymous-home-example";
import { formatCurrency } from "@/features/quotes/utils";

type AnonymousHomeLandingProps = {
  readonly onSignIn: () => void;
  readonly onSignUp: () => void;
};

const extractedSpecifications = [
  { label: "Material", value: anonymousHomeExamplePart.material },
  { label: "Finish", value: anonymousHomeExamplePart.finish },
  { label: "Tolerance", value: anonymousHomeExamplePart.tolerance },
  { label: "Quantity", value: `${anonymousHomeExamplePart.requestedQuantity} pcs` },
  { label: "Revision", value: anonymousHomeExamplePart.revision },
];

export function AnonymousHomeLanding({ onSignIn, onSignUp }: AnonymousHomeLandingProps) {
  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col px-6 pb-20">
      <section className="pt-16">
        <p className="mb-5 font-mono text-[11px] font-medium tracking-[0.08em] text-muted-foreground">
          Manufacturing workspace
        </p>

        <h1 className="font-display text-[44px] font-bold leading-[0.94] tracking-[-0.05em] text-foreground sm:text-[60px] lg:text-[76px]">
          CAD In
          <br />
          <span className="text-muted-foreground">Parts Out</span>
        </h1>

        <p className="mt-6 max-w-[560px] text-[17px] leading-[1.65] text-muted-foreground">
          Organize CAD files and drawings, review provider recommendations, and compare quote results. Automatic
          vendor collection is available only through the free, invitation-only Founding Beta.
        </p>
        <div className="mt-8 flex flex-col items-stretch gap-2.5 sm:flex-row sm:items-center">
          <Button type="button" className="min-h-11" onClick={onSignUp}>
            Create account
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 border-border bg-transparent text-foreground hover:bg-accent"
            onClick={onSignIn}
          >
            Log in
          </Button>
        </div>

        <p className="mt-3 max-w-[620px] text-[11px] leading-[1.5] text-muted-foreground">
          OverDrafter signup is free. Official RFQ links may still require vendor sign-in or vendor-issued guest
          access.
        </p>
      </section>

      <AnonymousQuoteChartShowcase onGetStarted={onSignUp} />

      <section className="mt-24">
        <div className="mb-9 flex items-center gap-4">
          <p className="ws-section-label">How it works</p>
          <div className="h-px flex-1 bg-accent" />
        </div>

        <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
          <article className="rounded-surface-lg border border-ws-border-subtle bg-ws-card p-6">
            <p className="mb-2.5 font-mono text-[10px] font-semibold tracking-[0.1em] text-muted-foreground">
              01 / UPLOAD
            </p>
            <h2 className="mb-2 font-display text-[15px] font-semibold text-foreground">Drop your part package.</h2>
            <p className="mb-4 text-[13px] leading-[1.6] text-muted-foreground">
              Upload STEP files and PDF drawings together. Matching filenames keep CAD and drawing files paired from
              the start.
            </p>

            <div>
              <div className="flex flex-col gap-1.5 border-b border-border py-1.5 text-[12px] sm:flex-row sm:items-center sm:justify-between">
                <span className="text-foreground">{anonymousHomeExamplePart.cadFilename}</span>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">STEP · 1.4 MB</span>
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    CAD
                  </span>
                </div>
              </div>
              <div className="flex flex-col gap-1.5 py-1.5 text-[12px] sm:flex-row sm:items-center sm:justify-between">
                <span className="text-foreground">{anonymousHomeExamplePart.drawingFilename}</span>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Drawing · 0.3 MB</span>
                  <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Drawing
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-2.5 border-t border-ws-border-subtle px-2.5 py-2 font-mono text-[11px] uppercase tracking-[0.06em] text-foreground">
              Matched · 1 CAD/PDF pair
            </div>
          </article>

          <article className="rounded-surface-lg border border-ws-border-subtle bg-ws-card p-6">
            <p className="mb-2.5 font-mono text-[10px] font-semibold tracking-[0.1em] text-muted-foreground">
              02 / EXTRACT
            </p>
            <h2 className="mb-2 font-display text-[15px] font-semibold text-foreground">
              Specs pulled from your drawing.
            </h2>
            <p className="mb-4 text-[13px] leading-[1.6] text-muted-foreground">
              Material, finish, tolerances, revision, and thread callouts are extracted from the drawing. Review and
              correct the result before quoting.
            </p>

            <div className="space-y-1.5">
              {extractedSpecifications.map((row) => (
                <div key={row.label} className="flex text-[12px]">
                  <span className="w-[44%] text-muted-foreground">{row.label}</span>
                  <span className="font-medium text-foreground">{row.value}</span>
                </div>
              ))}
            </div>

            <p className="mt-2 text-[11px] text-muted-foreground">
              Source: example drawing · {anonymousHomeExamplePart.drawingFilename}
            </p>
          </article>

          <article className="rounded-surface-lg border border-ws-border-subtle bg-ws-card p-6">
            <p className="mb-2.5 font-mono text-[10px] font-semibold tracking-[0.1em] text-muted-foreground">
              03 / SOURCE
            </p>
            <h2 className="mb-2 font-display text-[15px] font-semibold text-foreground">
              Start with useful supplier direction.
            </h2>
            <p className="mb-4 text-[13px] leading-[1.6] text-muted-foreground">
              Reviewed capability data ranks suitable providers and links to official RFQ paths. Organizations
              enrolled in the free, invitation-only Founding Beta can collect supported live quotes automatically.
            </p>

            <div>
              <div className="mb-1.5 flex flex-col gap-1 border-b border-ws-border-subtle px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-[12px] font-semibold text-foreground">Provider matches ready</span>
                <span className="text-[11px] text-muted-foreground">Reviewed capabilities</span>
              </div>
              <div className="flex flex-col gap-1 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-[12px] font-semibold text-foreground">Live offer received</span>
                <span className="text-[11px] text-muted-foreground">Founding Beta collection</span>
              </div>
            </div>
          </article>

          <article className="rounded-surface-lg border border-ws-border-subtle bg-ws-card p-6">
            <p className="mb-2.5 font-mono text-[10px] font-semibold tracking-[0.1em] text-muted-foreground">
              04 / SELECT
            </p>
            <h2 className="mb-2 font-display text-[15px] font-semibold text-foreground">
              Compare and choose the best fit.
            </h2>
            <p className="mb-4 text-[13px] leading-[1.6] text-muted-foreground">
              Published options keep price, lead time, process, and certification together. Your selection stays
              recorded with the project.
            </p>

            <div className="border-y border-ws-border-subtle py-2.5">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-paper-red">
                  Selected example
                </span>
                <span className="text-[12px] font-semibold text-foreground">
                  {anonymousHomeDefaultQuote.supplier}
                </span>
              </div>
              <div className="mt-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-[11px] text-muted-foreground">Illustrative decision record</span>
                <span className="font-mono text-[11px] text-foreground">
                  {formatCurrency(anonymousHomeDefaultQuote.totalPriceUsd)} ·{" "}
                  {anonymousHomeDefaultQuote.leadTimeBusinessDays} working days
                </span>
              </div>
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}
