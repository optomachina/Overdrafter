import type { ReactNode } from "react";
import { GeneratedPartBadge } from "@/components/workspace/GeneratedPartBadge";
import { ClientPartRequestEditor } from "@/components/quotes/ClientPartRequestEditor";
import type { SingleQuantityState } from "@/features/quotes/single-quantity";
import type { ClientPartPropertyOverrideField, ClientPartRequestUpdateInput } from "@/features/quotes/types";

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
  fieldDefaults?: Partial<Record<ClientPartPropertyOverrideField, string | number | null>>;
  singleQuantity?: SingleQuantityState;
  jobTags?: readonly string[] | null;
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
  singleQuantity,
  jobTags = null,
}: PartInfoPanelProps) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-foreground">Part information</h2>
        <GeneratedPartBadge tags={jobTags} />
      </div>
      <section className="mt-3 min-w-0 border-t border-ws-border-subtle pt-4">
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
              onResetField={onResetField}
              onResetAllFields={onResetAllFields}
              fieldDefaults={fieldDefaults}
              singleQuantity={singleQuantity}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Part details are still loading.</p>
          )}
        </div>
      </section>
    </div>
  );
}

export type { PartInfoPanelProps };
