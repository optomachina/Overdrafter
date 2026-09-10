import type { ReactNode } from "react";
import { Box, ChevronDown, MessageSquare, SlidersHorizontal } from "lucide-react";

type EngineeringConversationLayoutProps = {
  readonly conversation: ReactNode;
  readonly composer: ReactNode;
  readonly cadPanel: ReactNode;
  readonly toolsPanel: ReactNode;
  readonly contextSummary: ReactNode;
  readonly conversationOpen: boolean;
  readonly onConversationToggle: () => void;
  readonly title?: string;
};

/** Presentation shell for conversation and model evidence; each slot owns its real state and actions. */
export function EngineeringConversationLayout({
  conversation,
  composer,
  cadPanel,
  toolsPanel,
  contextSummary,
  conversationOpen,
  onConversationToggle,
  title = "Prepared assembly",
}: EngineeringConversationLayoutProps) {
  return (
    <main className="flex h-dvh min-h-[480px] flex-col bg-background text-foreground">
      <header className="relative z-20 flex shrink-0 items-center justify-between gap-4 px-5 py-4 sm:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <Box aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.65} />
          <span className="text-[15px] font-semibold tracking-tight">OverDrafter</span>
          <span className="hidden text-xs text-muted-foreground sm:inline">Internal preview</span>
        </div>
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-full p-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <SlidersHorizontal aria-hidden="true" className="size-4" />
            <span className="sr-only sm:not-sr-only">Workbench tools</span>
          </summary>
          <div className="absolute right-3 top-full max-h-[65dvh] w-[min(380px,calc(100vw-24px))] overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-lg">
            <div className="mb-5 border-b border-border pb-4 text-sm">{contextSummary}</div>
            {toolsPanel}
          </div>
        </details>
      </header>

      <section aria-label="CAD workspace" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <h1 className="sr-only">{title}</h1>
        <div className="min-h-0 flex-1">{cadPanel}</div>
      </section>

      <section aria-label="Engineering conversation" className="relative z-10 shrink-0 px-3 pb-[max(16px,env(safe-area-inset-bottom))] pt-2 sm:pb-6">
        <div className="relative mx-auto w-full max-w-xl">
          <div hidden={!conversationOpen} id="engineering-conversation-history" className="absolute bottom-full mb-3 max-h-[min(48dvh,480px)] w-full overflow-y-auto overscroll-contain rounded-2xl border border-border bg-card p-5 shadow-lg sm:p-6">
            <div className="flex flex-col gap-5">{conversation}</div>
          </div>
          <div className="mb-2 flex justify-center">
            <button type="button" aria-expanded={conversationOpen} aria-controls="engineering-conversation-history" onClick={onConversationToggle} className="flex items-center gap-2 rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <MessageSquare aria-hidden="true" className="size-3.5" />
              Conversation
              <ChevronDown aria-hidden="true" className={`size-3 transition-transform motion-reduce:transition-none ${conversationOpen ? "" : "rotate-180"}`} />
            </button>
          </div>
          <fieldset className="min-w-0 rounded-[28px] bg-[#111113] p-2 text-white shadow-[0_8px_30px_-12px_rgba(0,0,0,0.45)] ring-1 ring-white/10 focus-within:ring-2 focus-within:ring-neutral-400">
            <legend className="sr-only">Message composer</legend>
            {composer}
          </fieldset>
        </div>
      </section>
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
