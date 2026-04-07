import type { ReactNode } from "react";
import { ClientPartRequestEditor } from "@/components/quotes/ClientPartRequestEditor";
import type { ClientPartRequestUpdateInput } from "@/features/quotes/types";

type PartInfoPanelProps = {
  effectiveRequestDraft: ClientPartRequestUpdateInput | null;
  quoteQuantityInput: string;
  onQuoteQuantityInputChange: (value: string) => void;
  onDraftChange: (next: Partial<ClientPartRequestUpdateInput>) => void;
  onSave: () => void;
  onUploadRevision: () => void;
  isSaving?: boolean;
  statusContent?: ReactNode;
};

export function PartInfoPanel({
  effectiveRequestDraft,
  quoteQuantityInput,
  onQuoteQuantityInputChange,
  onDraftChange,
  onSave,
  onUploadRevision,
  isSaving = false,
  statusContent = null,
}: PartInfoPanelProps) {
  return (
    <div>
      <p className="mb-[6px] text-[9px] font-bold uppercase tracking-[0.14em] text-white/20">Part information</p>
      <section className="rounded-[12px] border border-ws-border-subtle bg-ws-card p-4">
        {statusContent ? <div className="mb-4 space-y-4">{statusContent}</div> : null}

        <div>
          {effectiveRequestDraft ? (
            <ClientPartRequestEditor
              draft={effectiveRequestDraft}
              quoteQuantityInput={quoteQuantityInput}
              onQuoteQuantityInputChange={onQuoteQuantityInputChange}
              onChange={onDraftChange}
              onSave={onSave}
              onUploadRevision={onUploadRevision}
              isSaving={isSaving}
            />
          ) : (
            <p className="text-sm text-white/45">Part details are still loading.</p>
          )}
        </div>
      </section>
    </div>
  );
}

export type { PartInfoPanelProps };
