import { Loader2, Upload } from "lucide-react";
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
import type { ClientPartRequestUpdateInput } from "@/features/quotes/types";

type ClientPartRequestEditorProps = {
  draft: ClientPartRequestUpdateInput;
  quoteQuantityInput: string;
  onQuoteQuantityInputChange: (value: string) => void;
  onChange: (next: Partial<ClientPartRequestUpdateInput>) => void;
  onSave: () => void;
  onUploadRevision: () => void;
  isSaving?: boolean;
  footer?: ReactNode;
};

function numberFieldValue(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(value) ? "" : String(value);
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
          <Input
            id="client-request-part-number"
            value={draft.partNumber ?? ""}
            onChange={(event) => onChange({ partNumber: event.target.value || null })}
            className="border-white/10 bg-black/20 text-white"
          />
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
          <Input
            id="client-request-description"
            value={draft.description ?? ""}
            onChange={(event) => onChange({ description: event.target.value || null })}
            className="border-white/10 bg-black/20 text-white"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="client-request-material">Material</Label>
          <Input
            id="client-request-material"
            value={draft.material}
            onChange={(event) => onChange({ material: event.target.value })}
            className="border-white/10 bg-black/20 text-white"
            placeholder={showQuoteFields ? "e.g. 6061-T6 aluminum" : "Optional for non-quote services"}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="client-request-finish">Finish</Label>
          <Input
            id="client-request-finish"
            value={draft.finish ?? ""}
            onChange={(event) => onChange({ finish: event.target.value || null })}
            className="border-white/10 bg-black/20 text-white"
          />
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="client-request-threads">Threads</Label>
          <Textarea
            id="client-request-threads"
            value={draft.threads ?? ""}
            onChange={(event) => onChange({ threads: event.target.value || null })}
            className="min-h-[88px] border-white/10 bg-black/20 text-white"
            placeholder="Optional thread callouts such as 1/4-20 UNC-2B."
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="client-request-tolerance">Tightest tolerance (in)</Label>
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
