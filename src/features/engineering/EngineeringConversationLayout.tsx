import type { ReactNode } from "react";
import { Box, ChevronDown, SlidersHorizontal } from "lucide-react";

type EngineeringConversationLayoutProps = {
  readonly conversation: ReactNode;
  readonly composer: ReactNode;
  readonly cadPanel: ReactNode;
  readonly toolsPanel: ReactNode;
  readonly contextSummary: ReactNode;
  readonly title?: string;
};

/** Presentation shell for conversation and model evidence; each slot owns its real state and actions. */
export function EngineeringConversationLayout({
  conversation,
  composer,
  cadPanel,
  toolsPanel,
  contextSummary,
  title = "Prepared assembly",
}: EngineeringConversationLayoutProps) {
  return (
    <main className="min-h-dvh bg-background text-foreground lg:flex lg:h-dvh lg:min-h-[560px] lg:flex-col lg:overflow-hidden">
      <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-border bg-card px-5 py-3 sm:px-7">
        <div className="flex min-w-0 items-center gap-3">
          <Box aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.65} />
          <span className="text-[15px] font-semibold tracking-tight">OverDrafter</span>
          <span aria-hidden="true" className="hidden text-border sm:inline">/</span>
          <span className="hidden text-sm text-muted-foreground sm:inline">Engineering</span>
        </div>
        <span className="shrink-0 rounded-full border border-border px-2.5 py-1 text-[10px] font-medium tracking-wide text-muted-foreground sm:text-xs">
          Internal preview
        </span>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,42fr)_minmax(0,58fr)]">
        <section aria-label="Engineering conversation" className="order-2 flex min-h-0 min-w-0 flex-col bg-card lg:order-1 lg:border-r lg:border-border">
          <div className="shrink-0 border-b border-border px-5 py-5 sm:px-7">
            <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Working context</p>
            <div className="text-sm leading-relaxed">{contextSummary}</div>
          </div>

          <div className="min-h-0 flex-1 px-5 py-7 sm:px-7 lg:overflow-y-auto lg:overscroll-contain">
            <div className="mx-auto flex max-w-2xl flex-col gap-7">{conversation}</div>
          </div>

          <div className="sticky bottom-0 z-10 shrink-0 bg-card px-4 pb-4 pt-3 sm:px-6 sm:pb-5 lg:static">
            <fieldset className="mx-auto min-w-0 max-w-2xl rounded-2xl border border-border bg-background p-3 shadow-sm focus-within:border-foreground/40 focus-within:ring-1 focus-within:ring-foreground/10 sm:p-4">
              <legend className="sr-only">Message composer</legend>
              {composer}
            </fieldset>
          </div>
        </section>

        <section aria-label="CAD workspace" className="order-1 flex min-h-0 min-w-0 flex-col border-b border-border lg:order-2 lg:border-b-0">
          <div className="flex shrink-0 items-center gap-3 px-5 pb-4 pt-5 sm:px-7 sm:pt-6">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
              <Box aria-hidden="true" className="size-[18px] text-muted-foreground" strokeWidth={1.5} />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Model view</p>
              <h1 className="mt-0.5 break-words text-base font-medium tracking-tight">{title}</h1>
            </div>
          </div>

          <div className="min-h-[320px] min-w-0 flex-1 px-4 pb-4 sm:px-6 lg:min-h-0 lg:overflow-y-auto">
            <div className="min-h-[320px] rounded-xl border border-border bg-card lg:h-full lg:min-h-0">
              {cadPanel}
            </div>
          </div>

          <details className="group shrink-0 border-t border-border bg-card">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-7 [&::-webkit-details-marker]:hidden">
              <SlidersHorizontal aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
              Workbench tools
              <ChevronDown aria-hidden="true" className="ml-auto size-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
            </summary>
            <div className="border-t border-border px-5 py-5 sm:px-7 lg:max-h-[36dvh] lg:overflow-y-auto">
              {toolsPanel}
            </div>
          </details>
        </section>
      </div>
    </main>
  );
}

type ConversationMessageProps = {
  readonly role: "user" | "assistant";
  readonly children: ReactNode;
};

/** Visually distinguishes authored requests from assistant responses without implying execution state. */
export function ConversationMessage({ role, children }: ConversationMessageProps) {
  if (role === "user") {
    return (
      <article aria-label="Your message" className="ml-8 self-end rounded-2xl bg-muted px-4 py-3 text-sm leading-7 sm:ml-12 sm:px-5">
        <p className="mb-1 text-[11px] font-medium leading-5 text-muted-foreground">You</p>
        <div className="min-w-0 break-words">{children}</div>
      </article>
    );
  }

  return (
    <article aria-label="Assistant message" className="min-w-0 text-sm leading-7">
      <p className="mb-2 text-xs font-semibold tracking-tight">OverDrafter</p>
      <div className="space-y-3 break-words">{children}</div>
    </article>
  );
}

/** Groups a proposed change and the caller's explicit decision actions within the conversation. */
export function ProposalCard({ children }: { readonly children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-background p-4 text-sm leading-6 sm:p-5">
      {children}
    </div>
  );
}
