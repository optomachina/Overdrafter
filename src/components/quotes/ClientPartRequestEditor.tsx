import { Loader2, RotateCcw, Upload } from "lucide-react";
import { useState, type ReactNode } from "react";
import { RfqLineItemMetadataFields } from "@/components/quotes/RfqLineItemMetadataFields";
import { SingleQuantityField } from "@/components/quotes/SingleQuantityField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { QUANTITY_FORMAT_ERROR, type SingleQuantityState } from "@/features/quotes/single-quantity";
import { QUOTE_QUANTITIES_FORMAT_ERROR, validateRequestedQuoteQuantitiesInput } from "@/features/quotes/request-intake";
import type { ClientPartPropertyOverrideField, ClientPartRequestUpdateInput } from "@/features/quotes/types";
import { CLIENT_PART_PROPERTY_OVERRIDE_FIELDS } from "@/features/quotes/types";
import { useSingleQuantityInput } from "@/features/quotes/use-single-quantity-input";

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
  onResetAllFields?: () => void;
  fieldDefaults?: FieldDefaults;
  /**
   * OVD-997: set to replace Qty and Quote quantities with one Quantity field. Left unset (flag off),
   * the editor shows both fields and validates each before allowing Save.
   */
  singleQuantity?: SingleQuantityState;
};

function numberFieldValue(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(value) ? "" : String(value);
}

const TOLERANCE_PATTERN = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

// Returns the typed tolerance as a positive finite number, or null when the text is empty or not a valid value.
function parseToleranceText(text: string): number | null {
  const trimmed = text.trim();
  if (!TOLERANCE_PATTERN.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

type FieldDefaults = Partial<Record<ClientPartPropertyOverrideField, string | number | null>>;

function hasResetTarget(
  field: ClientPartPropertyOverrideField,
  draft: ClientPartRequestUpdateInput,
  defaults: FieldDefaults | undefined,
): boolean {
  const defaultValue = defaults?.[field];
  if (defaultValue === null || defaultValue === undefined) {
    return false;
  }
  const raw = draft[field as keyof ClientPartRequestUpdateInput];
  if (typeof raw !== "string" && typeof raw !== "number" && raw !== null && raw !== undefined) {
    return false;
  }
  return String(raw !== null && raw !== undefined ? raw : "") !== String(defaultValue);
}

function ResetButton({
  field,
  defaultValue,
  onReset,
  position = "center",
}: {
  readonly field: ClientPartPropertyOverrideField;
  readonly defaultValue: string | number | null | undefined;
  readonly onReset: (field: ClientPartPropertyOverrideField) => void;
  readonly position?: "center" | "top";
}) {
  const posClass = position === "top" ? "top-2" : "top-1/2 -translate-y-1/2";
  return (
    <button
      type="button"
      aria-label={`Reset to extracted: ${String(defaultValue ?? "")}`}
      title={`Reset to extracted: ${String(defaultValue ?? "")}`}
      className={`absolute right-2 ${posClass} text-muted-foreground hover:text-foreground/80`}
      onClick={() => onReset(field)}
    >
      <RotateCcw className="h-3.5 w-3.5" />
    </button>
  );
}

function FieldResetButton({
  field,
  draft,
  fieldDefaults,
  onResetField,
  position,
}: {
  readonly field: ClientPartPropertyOverrideField;
  readonly draft: ClientPartRequestUpdateInput;
  readonly fieldDefaults: FieldDefaults | undefined;
  readonly onResetField: ((field: ClientPartPropertyOverrideField) => void) | undefined;
  readonly position?: "center" | "top";
}) {
  if (!onResetField || !hasResetTarget(field, draft, fieldDefaults)) {
    return null;
  }
  return <ResetButton field={field} defaultValue={fieldDefaults?.[field]} onReset={onResetField} position={position} />;
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
  onResetAllFields,
  fieldDefaults,
  singleQuantity,
}: ClientPartRequestEditorProps) {
  const materialRequired = true;
  // The tolerance field keeps the typed text locally: round-tripping through the numeric draft would
  // rewrite partial input ("0." -> "0", ".005" -> "") on every keystroke.
  const [toleranceText, setToleranceText] = useState(() => numberFieldValue(draft.tightestToleranceInch));
  const [seenTolerance, setSeenTolerance] = useState(draft.tightestToleranceInch ?? null);
  const draftTolerance = draft.tightestToleranceInch ?? null;
  if (draftTolerance !== seenTolerance) {
    setSeenTolerance(draftTolerance);
    if (parseToleranceText(toleranceText) !== draftTolerance) {
      setToleranceText(numberFieldValue(draftTolerance));
    }
  }
  const [toleranceTouched, setToleranceTouched] = useState(false);
  const toleranceBlocked = toleranceText.trim().length > 0 && parseToleranceText(toleranceText) === null;
  // All-zero prefixes ("0", "0.", "0.00") are normal steps towards "0.005": Save stays blocked but the
  // error is held back until the field loses focus, so valid typing does not flash an assertive alert.
  const toleranceIncomplete = /^\s*0*\.?0*\s*$/.test(toleranceText);
  const toleranceInvalid = toleranceBlocked && (!toleranceIncomplete || toleranceTouched);
  const quantityInput = useSingleQuantityInput(
    draft,
    singleQuantity ?? { allowAboveOne: true, loading: false, unavailable: false },
    onChange,
  );
  const quoteQuantities = validateRequestedQuoteQuantitiesInput(quoteQuantityInput, draft.quantity);
  const quoteQuantitiesBlocked = !singleQuantity && quoteQuantities.invalidTokens.length > 0;

  return (
    <div className="min-w-0 space-y-4">
      <div className="grid min-w-0 grid-cols-1 gap-4">
        <div className="space-y-2">
          <Label htmlFor="client-request-part-number">Part number</Label>
          <div className="relative">
            <Input
              id="client-request-part-number"
              value={draft.partNumber ?? ""}
              onChange={(event) => onChange({ partNumber: event.target.value || null })}
              className="border-border bg-muted text-foreground"
            />
            <FieldResetButton field="partNumber" draft={draft} fieldDefaults={fieldDefaults} onResetField={onResetField} />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="client-request-revision">Revision</Label>
          <div className="relative">
            <Input
              id="client-request-revision"
              value={draft.revision ?? ""}
              onChange={(event) => onChange({ revision: event.target.value || null })}
              className="border-border bg-muted text-foreground"
            />
            <FieldResetButton field="revision" draft={draft} fieldDefaults={fieldDefaults} onResetField={onResetField} />
          </div>
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="client-request-description">Description</Label>
          <div className="relative">
            <Input
              id="client-request-description"
              value={draft.description ?? ""}
              onChange={(event) => onChange({ description: event.target.value || null })}
              className="border-border bg-muted text-foreground"
            />
            <FieldResetButton field="description" draft={draft} fieldDefaults={fieldDefaults} onResetField={onResetField} />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="client-request-material">Material</Label>
          <div className="relative">
            <Input
              id="client-request-material"
              value={draft.material}
              onChange={(event) => onChange({ material: event.target.value })}
              className="border-border bg-muted text-foreground"
              placeholder="e.g. 6061-T6 aluminum"
            />
            <FieldResetButton field="material" draft={draft} fieldDefaults={fieldDefaults} onResetField={onResetField} />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="client-request-finish">Finish</Label>
          <div className="relative">
            <Input
              id="client-request-finish"
              value={draft.finish ?? ""}
              onChange={(event) => onChange({ finish: event.target.value || null })}
              className="border-border bg-muted text-foreground"
            />
            <FieldResetButton field="finish" draft={draft} fieldDefaults={fieldDefaults} onResetField={onResetField} />
          </div>
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="client-request-threads">Threads</Label>
          <div className="relative">
            <Textarea
              id="client-request-threads"
              value={draft.threads ?? ""}
              onChange={(event) => {
                const value = event.target.value.trim();
                onChange({ threads: value.length > 0 ? value : null });
              }}
              className="min-h-[88px] border-border bg-muted text-foreground"
              placeholder="Optional thread callouts such as 1/4-20 UNC-2B."
            />
            <FieldResetButton field="threads" draft={draft} fieldDefaults={fieldDefaults} onResetField={onResetField} position="top" />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="client-request-tolerance">Tightest tolerance (in)</Label>
          <div className="relative">
            <Input
              id="client-request-tolerance"
              value={toleranceText}
              onChange={(event) => {
                const text = event.target.value;
                setToleranceText(text);
                setToleranceTouched(false);
                // Invalid text clears the draft number so it can never be saved as NaN or a guessed value.
                onChange({ tightestToleranceInch: parseToleranceText(text) });
              }}
              onBlur={() => setToleranceTouched(true)}
              className="border-border bg-muted text-foreground"
              aria-invalid={toleranceInvalid ? true : undefined}
              aria-describedby={toleranceInvalid ? "client-request-tolerance-error" : undefined}
              inputMode="decimal"
            />
            <FieldResetButton field="tightestToleranceInch" draft={draft} fieldDefaults={fieldDefaults} onResetField={onResetField} />
          </div>
          {toleranceInvalid ? (
            <p id="client-request-tolerance-error" role="alert" className="text-xs text-destructive">
              Enter a positive number in inches, for example 0.005.
            </p>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="client-request-process">Process</Label>
          <div className="relative">
            <Input
              id="client-request-process"
              value={draft.process ?? ""}
              onChange={(event) => onChange({ process: event.target.value || null })}
              className="border-border bg-muted text-foreground"
            />
            <FieldResetButton field="process" draft={draft} fieldDefaults={fieldDefaults} onResetField={onResetField} />
          </div>
        </div>
        {singleQuantity ? (
          <SingleQuantityField input={quantityInput} />
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="client-request-qty">Qty</Label>
              <Input
                id="client-request-qty"
                value={quantityInput.value}
                onChange={(event) => quantityInput.onTextChange(event.target.value)}
                onBlur={quantityInput.onBlur}
                aria-invalid={quantityInput.blocked || undefined}
                aria-describedby={[quantityInput.showError && "client-request-qty-error", !quoteQuantitiesBlocked && "client-request-quote-quantities-help"].filter(Boolean).join(" ") || undefined}
                className="border-border bg-muted text-foreground"
                inputMode="numeric"
              />
              {quantityInput.showError ? (
                <p id="client-request-qty-error" role="alert" className="text-xs text-destructive">
                  {QUANTITY_FORMAT_ERROR}
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="client-request-quote-quantities">Quote quantities</Label>
              <Input
                id="client-request-quote-quantities"
                value={quoteQuantityInput}
                onChange={(event) => onQuoteQuantityInputChange(event.target.value)}
                className="border-border bg-muted text-foreground"
                placeholder="10 / 25 / 50"
                aria-invalid={quoteQuantitiesBlocked || undefined}
                aria-describedby={quoteQuantitiesBlocked ? "client-request-quote-quantities-error" : "client-request-quote-quantities-help"}
              />
              {quoteQuantitiesBlocked ? (
                <p id="client-request-quote-quantities-error" role="alert" className="text-xs text-destructive">
                  {quoteQuantities.error ?? QUOTE_QUANTITIES_FORMAT_ERROR}
                </p>
              ) : (
                <p id="client-request-quote-quantities-help" className="text-xs text-muted-foreground">
                  {quoteQuantities.quantities[0] !== undefined && quoteQuantities.quantities[0] !== draft.quantity
                    ? `Saving sets Qty to ${quoteQuantities.quantities[0]}, the first quote quantity. Change Quote quantities to save a different Qty.`
                    : "The first quote quantity becomes the saved Qty. Leave blank to use Qty."}
                </p>
              )}
            </div>
          </>
        )}
        <div className="space-y-2">
          <Label htmlFor="client-request-date">Need by</Label>
          <Input
            id="client-request-date"
            type="date"
            value={draft.requestedByDate ?? ""}
            onChange={(event) => onChange({ requestedByDate: event.target.value || null })}
            className="border-border bg-muted text-foreground"
          />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="client-request-notes">Notes</Label>
          <Textarea
            id="client-request-notes"
            value={draft.notes ?? ""}
            onChange={(event) => onChange({ notes: event.target.value || null })}
            className="min-h-[108px] border-border bg-muted text-foreground"
            placeholder="Optional drawing callouts, schedule constraints, or packaging notes."
          />
        </div>
      </div>

      <div className="space-y-3 rounded-[1.75rem] border border-border bg-accent p-4">
        <div>
          <p className="text-sm font-medium text-foreground">RFQ details</p>
          <p className="mt-1 text-xs text-muted-foreground">
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
          className="rounded-full border-border bg-transparent text-foreground hover:bg-accent"
          onClick={onUploadRevision}
        >
          <Upload className="mr-2 h-4 w-4" />
          Upload revised file
        </Button>
        {onResetAllFields && CLIENT_PART_PROPERTY_OVERRIDE_FIELDS.some((f) => hasResetTarget(f, draft, fieldDefaults)) ? (
          <Button
            type="button"
            variant="outline"
            className="rounded-full border-border bg-transparent text-foreground hover:bg-accent"
            onClick={onResetAllFields}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset all to extracted
          </Button>
        ) : null}
        <Button
          type="button"
          className="rounded-full"
          onClick={onSave}
          disabled={isSaving || toleranceBlocked || quantityInput.blocked || quoteQuantitiesBlocked || (materialRequired && !draft.material.trim())}
        >
          {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Save request details
        </Button>
      </div>
    </div>
  );
}
