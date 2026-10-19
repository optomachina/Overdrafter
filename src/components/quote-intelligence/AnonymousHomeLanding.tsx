import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DrawingToQuoteDemo,
  HardwareAgentDemo,
  ParallelProvidersDemo,
  ProjectLedgerDemo,
} from "@/components/quote-intelligence/AnonymousHomeDemos";
import { AnonymousQuoteChartShowcase } from "@/components/quote-intelligence/AnonymousQuoteChartShowcase";

type AnonymousHomeLandingProps = {
  readonly onSignIn?: () => void;
  readonly onSignUp: () => void;
};

type DemoSectionProps = {
  readonly id: string;
  readonly headline: string;
  readonly body: string;
  readonly children: ReactNode;
};

function DemoSection({ id, headline, body, children }: DemoSectionProps) {
  return (
    <section className="mt-28 sm:mt-36" aria-labelledby={id}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] lg:items-end lg:gap-16">
        <h2
          id={id}
          className="max-w-[640px] font-sans text-[30px] font-semibold leading-[1.08] tracking-[-0.035em] text-foreground [text-wrap:balance] sm:text-[40px]"
        >
          {headline}
        </h2>
        <p className="text-[15px] leading-[1.6] text-muted-foreground sm:text-[16px]">{body}</p>
      </div>
      <div className="mt-10">{children}</div>
    </section>
  );
}

export function AnonymousHomeLanding({ onSignUp }: AnonymousHomeLandingProps) {
  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col px-6 pb-20">
      <section className="pt-8 sm:pt-12">
        <h1 className="max-w-[860px] font-sans text-[38px] font-semibold leading-[1.04] tracking-[-0.04em] text-foreground [text-wrap:balance] sm:text-[52px] lg:text-[60px]">
          OverDrafter is your agent for{" "}
          <span className="text-muted-foreground">building hardware.</span>
        </h1>

        <Button type="button" className="mt-9 min-h-11" onClick={onSignUp}>
          Create account
        </Button>

        <p className="mt-4 max-w-[560px] text-[12px] leading-[1.55] text-muted-foreground">
          Automatic vendor collection is available only through the free, invitation-only Founding Beta. OverDrafter
          signup is free. Official RFQ links may still require vendor sign-in or vendor-issued guest access.
        </p>

        <div className="mt-10 sm:mt-12">
          <HardwareAgentDemo />
        </div>
      </section>

      <DemoSection
        id="agent-drawings-heading"
        headline="Agents turn drawings into quotes"
        body="Hand off the STEP file and PDF drawing. OverDrafter reads the specs and requests quotes, while you focus on making decisions."
      >
        <DrawingToQuoteDemo />
      </DemoSection>

      <DemoSection
        id="agent-parallel-heading"
        headline="Works autonomously, quotes in parallel"
        body="Every supported provider is asked at once. Offers stream in as they arrive, with no one chasing emails."
      >
        <ParallelProvidersDemo />
      </DemoSection>

      <AnonymousQuoteChartShowcase onGetStarted={onSignUp} />

      <DemoSection
        id="agent-project-heading"
        headline="Quote the whole project at once"
        body="Bring every part in the build. Each one is read and quoted in parallel, and you review a single ledger."
      >
        <ProjectLedgerDemo />
      </DemoSection>

      <section className="mt-28 border-t border-ws-border-subtle pt-12 sm:mt-36" aria-labelledby="home-cta-heading">
        <h2
          id="home-cta-heading"
          className="font-sans text-[30px] font-semibold leading-[1.08] tracking-[-0.035em] text-foreground sm:text-[40px]"
        >
          Try OverDrafter now.
        </h2>
        <Button type="button" className="mt-6 min-h-11" onClick={onSignUp}>
          Get started
        </Button>
      </section>
    </div>
  );
}
