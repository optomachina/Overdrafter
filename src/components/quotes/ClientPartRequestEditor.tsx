import { Loader2, RotateCcw, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { RfqLineItemMetadataFields } from "@/components/quotes/RfqLineItemMetadataFields";
import { RequestServiceIntentFields } from "@/components/quotes/RequestServiceIntentFields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  requestedServicesRequireMaterial,
  requestedServicesSupportQuoteFields,
} from "@/features/quotes/service-intent";
import type { ClientPartPropertyOverrideField, ClientPartRequestUpdateInput } from "@/features/quotes/types";

type ClientPartRequestEditorProps = {
  draft: ClientPartRequestUpdateInput;
  quoteQuantityInput: string;
  onQuoteQuantityInputChange: (value: string) => void;
  onChange: (next: Partial<ClientPartRequestUpdateInput>) => void;
  onSave: () => void;
  onUploadRevision: () => void;
  isSaving?: boolean;
  footer?: ReactNode;
  onResetField?: (field: ClientPartPropertyOverrideField) => void;
  fieldDefaults?: Partial<Record<ClientPartPropertyOverrideField, string | number | null>>;
};

function numberFieldValue(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(value) ? "" : String(value);
}

function hasResetTarget(
  field: ClientPartPropertyOverrideField,
  draft: ClientPartRequestUpdateInput,
  defaults: Partial<Record<ClientPartPropertyOverrideField, string | number | null>> | undefined,
): boolean {
  const defaultValue = defaults?.[field];
  if (defaultValue === null || defaultValue === undefined) {
    return false;
  }
  const draftValue = draft[field as keyof ClientPartRequestUpdateInput];
  return String(draftValue ?? "") !== String(defaultValue);
}

export function ClientPartRequestEditor({
  draft,
  quoteQuantityInput,
  onQuoteQuantityInputChange,
  onChange,
  onSave,
  onUploadRevision,
  isSaving = false,
  footer = null,
  onResetField,
  fieldDefaults,
}: ClientPartRequestEditorProps) {
  const showQuoteFields = requestedServicesSupportQuoteFields(draft.requestedServiceKinds);
  const materialRequired = requestedServicesRequireMaterial(draft.requestedServiceKinds);

  return (
    <div className="space-y-4">
      <RequestServiceIntentFields
        value={{
          requestedServiceKinds: draft.requestedServiceKinds,
          primaryServiceKind: draft.primaryServiceKind,
          serviceNotes: draft.serviceNotes,
        }}
        onChange={(next) => onChange(next)}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="client-request-part-number">Part number</Label>
          <div className="relative">
            <Input
              id="client-request-part-number"
              value={draft.partNumber ?? ""}
              onChange={(event) => onChange({ partNumber: event.target.value || null })}
              className="border-white/10 bg-black/20 text-white"
            />
            {onResetField && hasResetTarget("partNumber", draft, fieldDefaults) ? (
              <button
                type="button"
                title={`Reset to extracted: ${String(fieldDefaults?.partNumber ?? "")}`}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70"
                onClick={() => onResetField("partNumber")}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="client-request-revision">Revision</Label>
          <Input
            id="client-request-revision"
            value={draft.revision ?? ""}
            onChange={(event) => onChange({ revision: event.target.value || null })}
            className="border-white/10 bg-black/20 text-white"
          />
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="client-request-description">Description</Label>
          <div className="relative">
            <Input
              id="client-request-description"
              value={draft.description ?? ""}
              onChange={(event) => onChange({ description: event.target.value || null })}
              className="border-white/10 bg-black/20 text-white"
            />
            {onResetField && hasResetTarget("description", draft, fieldDefaults) ? (
              <button
                type="button"
                title={`Reset to extracted: ${String(fieldDefaults?.description ?? "")}`}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70"
                onClick={() => onResetField("description")}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="client-request-material">Material</Label>
          <div className="relative">
            <Input
              id="client-request-material"
              value={draft.material}
              onChange={(event) => onChange({ material: event.target.value })}
              className="border-white/10 bg-black/20 text-white"
              placeholder={showQuoteFields ? "e.g. 6061-T6 aluminum" : "Optional for non-quote services"}
            />
            {onResetField && hasResetTarget("material", draft, fieldDefaults) ? (
              <button
                type="button"
                title={`Reset to extracted: ${String(fieldDefaults?.material ?? "")}`}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70"
                onClick={() => onResetField("material")}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="client-request-finish">Finish</Label>
          <div className="relative">
            <Input
              id="client-request-finish"
              value={draft.finish ?? ""}
              onChange={(event) => onChange({ finish: event.target.value || null })}
              className="border-white/10 bg-black/20 text-white"
            />
            {onResetField && hasResetTarget("finish", draft, fieldDefaults) ? (
              <button
                type="button"
                title={`Reset to extracted: ${String(fieldDefaults?.finish ?? "")}`}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70"
                onClick={() => onResetField("finish")}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="client-request-threads">Threads</Label>
          <div className="relative">
            <Textarea
              id="client-request-threads"
              value={draft.threads ?? ""}
              onChange={(event) => {
                const value = event.target.value.trim();
                onChange({ threads: value.length > 0 ? value : null });
              }}
              className="min-h-[88px] border-white/10 bg-black/20 text-white"
              placeholder="Optional thread callouts such as 1/4-20 UNC-2B."
            />
            {onResetField && hasResetTarget("threads", draft, fieldDefaults) ? (
              <button
                type="button"
                title={`Reset to extracted: ${String(fieldDefaults?.threads ?? "")}`}
                className="absolute right-2 top-2 text-white/30 hover:text-white/70"
                onClick={() => onResetField("threads")}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="client-request-tolerance">Tightest tolerance (in)</Label>
          <div className="relative">
            <Input
              id="client-request-tolerance"
              value={numberFieldValue(draft.tightestToleranceInch)}
              onChange={(event) =>
                onChange({
                  tightestToleranceInch: event.target.value.trim()
                    ? Number.parseFloat(event.target.value)
                    : null,
                })
              }
              className="border-white/10 bg-black/20 text-white"
              inputMode="decimal"
            />
            {onResetField && hasResetTarget("tightestToleranceInch", draft, fieldDefaults) ? (
              <button
                type="button"
                title={`Reset to extracted: ${String(fieldDefaults?.tightestToleranceInch ?? "")}`}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70"
                onClick={() => onResetField("tightestToleranceInch")}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="client-request-process">Process</Label>
          <Input
            id="client-request-process"
            value={draft.process ?? ""}
            onChange={(event) => onChange({ process: event.target.value || null })}
            className="border-white/10 bg-black/20 text-white"
          />
        </div>
        {showQuoteFields ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="client-request-qty">Qty</Label>
              <Input
                id="client-request-qty"
                value={numberFieldValue(draft.quantity)}
                onChange={(event) =>
                  onChange({
                    quantity: Math.max(1, Number.parseInt(event.target.value || "1", 10) || 1),
                  })
                }
                className="border-white/10 bg-black/20 text-white"
                inputMode="numeric"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="client-request-quote-quantities">Quote quantities</Label>
              <Input
                id="client-request-quote-quantities"
                value={quoteQuantityInput}
                onChange={(event) => onQuoteQuantityInputChange(event.target.value)}
                className="border-white/10 bg-black/20 text-white"
                placeholder="10 / 25 / 50"
              />
            </div>
          </>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="client-request-date">Need by</Label>
          <Input
            id="client-request-date"
            type="date"
            value={draft.requestedByDate ?? ""}
            onChange={(event) => onChange({ requestedByDate: event.target.value || null })}
            className="border-white/10 bg-black/20 text-white"
          />
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="client-request-notes">Notes</Label>
          <Textarea
            id="client-request-notes"
            value={draft.notes ?? ""}
            onChange={(event) => onChange({ notes: event.target.value || null })}
            className="min-h-[108px] border-white/10 bg-black/20 text-white"
            placeholder="Optional drawing callouts, schedule constraints, or packaging notes."
          />
        </div>
      </div>

      <div className="space-y-3 rounded-[1.75rem] border border-white/8 bg-white/5 p-4">
        <div>
          <p className="text-sm font-medium text-white">RFQ details</p>
          <p className="mt-1 text-xs text-white/50">
            Shipping, certification, sourcing, and release status details stay client-safe here. Internal
            review-only controls remain on the estimator side.
          </p>
        </div>
        <RfqLineItemMetadataFields
          idPrefix="client-request"
          value={{
            shipping: draft.shipping,
            certifications: draft.certifications,
            sourcing: draft.sourcing,
            release: draft.release,
          }}
          onChange={onChange}
          mode="client"
        />
      </div>

      {footer}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
          onClick={onUploadRevision}
        >
          <Upload className="mr-2 h-4 w-4" />
          Upload revised file
        </Button>
        <Button
          type="button"
          className="rounded-full"
          onClick={onSave}
          disabled={isSaving || (materialRequired && !draft.material.trim())}
        >
          {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Save request details
        </Button>
      </div>
    </div>
  );
}
