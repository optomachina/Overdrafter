import type { ReactNode } from "react";
import { ClientPartRequestEditor } from "@/components/quotes/ClientPartRequestEditor";
import type {
  ClientPartPropertyOverrideField,
  ClientPartRequestUpdateInput,
} from "@/features/quotes/types";

type PartInfoPanelProps = {
  effectiveRequestDraft: ClientPartRequestUpdateInput | null;
  quoteQuantityInput: string;
  onQuoteQuantityInputChange: (value: string) => void;
  onDraftChange: (next: Partial<ClientPartRequestUpdateInput>) => void;
  onSave: () => void;
  onUploadRevision: () => void;
  isSaving?: boolean;
  statusContent?: ReactNode;
  onResetField?: (field: ClientPartPropertyOverrideField) => void;
  onResetAllFields?: () => void;
  fieldDefaults?: Partial<
    Record<ClientPartPropertyOverrideField, string | number | null>
  >;
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
  onResetField,
  onResetAllFields,
  fieldDefaults,
}: PartInfoPanelProps) {
  return (
    <section
      aria-labelledby="part-requirements-heading"
      className="min-w-0 border-t border-paper-hairline pt-5"
    >
      <div className="mb-5 max-w-3xl">
        <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-paper-red">
          Part setup
        </p>
        <h2
          id="part-requirements-heading"
          className="mt-1 font-display text-xl font-bold text-paper-ink"
        >
          Part requirements
        </h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Review extracted values and complete the details used for quoting.
        </p>
      </div>

      {statusContent ? (
        <div
          data-testid="part-status-content"
          className="mb-5 grid min-w-0 gap-3 lg:grid-cols-2 [&>*:only-child]:lg:col-span-2 [&>*]:min-w-0"
        >
          {statusContent}
        </div>
      ) : null}

      <div className="min-w-0 border-t border-paper-hairline pt-5">
        {effectiveRequestDraft ? (
          <ClientPartRequestEditor
            draft={effectiveRequestDraft}
            quoteQuantityInput={quoteQuantityInput}
            onQuoteQuantityInputChange={onQuoteQuantityInputChange}
            onChange={onDraftChange}
            onSave={onSave}
            onUploadRevision={onUploadRevision}
            isSaving={isSaving}
            onResetField={onResetField}
            onResetAllFields={onResetAllFields}
            fieldDefaults={fieldDefaults}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Part details are still loading.
          </p>
        )}
      </div>
    </section>
  );
}

export type { PartInfoPanelProps };
