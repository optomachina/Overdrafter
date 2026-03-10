import { Loader2, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  return (
    <div className="space-y-4">
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
        <Button type="button" className="rounded-full" onClick={onSave} disabled={isSaving || !draft.material.trim()}>
          {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Save request details
        </Button>
      </div>
    </div>
  );
}
