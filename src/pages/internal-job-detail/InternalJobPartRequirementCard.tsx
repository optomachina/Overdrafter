import { AlertTriangle, CheckCircle2, FileUp } from "lucide-react";
import { CadModelThumbnail } from "@/components/CadModelThumbnail";
import { RfqLineItemMetadataFields } from "@/components/quotes/RfqLineItemMetadataFields";
import { RequestServiceIntentFields } from "@/components/quotes/RequestServiceIntentFields";
import { RequestSummaryBadges } from "@/components/quotes/RequestSummaryBadges";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestedServicesSupportQuoteFields } from "@/features/quotes/service-intent";
import type { ApprovedPartRequirement, PartAggregate, RequirementFieldDisplaySource } from "@/features/quotes/types";
import { normalizeApprovedRequirementDraft } from "@/features/quotes/request-scenarios";
import {
  buildRequirementDraft,
  formatStatusLabel,
  formatVendorName,
  normalizeDrawingExtraction,
  resolveRequirementField,
} from "@/features/quotes/utils";
import { isStepPreviewableFile } from "@/lib/cad-preview";
import { INTERNAL_JOB_DETAIL_VENDORS } from "./internal-job-detail-view-model";

type InternalJobPartRequirementCardProps = {
  cadPreviewSource: ReturnType<typeof import("@/lib/cad-preview").createCadPreviewSourceFromJobFile> | null;
  disabled: boolean;
  draft: ApprovedPartRequirement;
  jobRequestDefaults: Parameters<typeof buildRequirementDraft>[1];
  onDraftChange: (updater: (current: ApprovedPartRequirement) => ApprovedPartRequirement) => void;
  onDraftQuantityChange: (quantity: number) => void;
  onQuoteQuantityInputChange: (value: string) => void;
  onQuoteQuantityInputCommit: () => void;
  part: PartAggregate;
  quoteQuantityInput: string;
};

function extractionSourceLabel(selectedBy: "parser" | "model" | "review") {
  switch (selectedBy) {
    case "model":
      return "model fallback";
    case "review":
      return "manual review";
    default:
      return "parser";
  }
}

function draftSourceLabel(source: RequirementFieldDisplaySource) {
  switch (source) {
    case "client":
      return "client request";
    case "approved_user":
      return "approved user value";
    case "approved_auto":
      return "approved auto value";
    default:
      return "fresher extraction";
  }
}

export function InternalJobPartRequirementCard({
  cadPreviewSource,
  disabled,
  draft,
  jobRequestDefaults,
  onDraftChange,
  onDraftQuantityChange,
  onQuoteQuantityInputChange,
  onQuoteQuantityInputCommit,
  part,
  quoteQuantityInput,
}: InternalJobPartRequirementCardProps) {
  const extraction = normalizeDrawingExtraction(part.extraction, part.id);
  const currentDraft = draft ?? buildRequirementDraft(part, jobRequestDefaults);
  const cadPreviewable = part.cadFile ? isStepPreviewableFile(part.cadFile.original_name) : false;
  const showQuoteFields = requestedServicesSupportQuoteFields(currentDraft.requestedServiceKinds);
  const descriptionResolution = resolveRequirementField(part, "description", extraction);
  const partNumberResolution = resolveRequirementField(part, "partNumber", extraction);
  const revisionResolution = resolveRequirementField(part, "revision", extraction);
  const finishResolution = resolveRequirementField(part, "finish", extraction);
  const descriptionSelectedBy = extraction.fieldSelections?.description ?? "parser";
  const partNumberSelectedBy = extraction.fieldSelections?.partNumber ?? "parser";
  const revisionSelectedBy = extraction.fieldSelections?.revision ?? "parser";
  const materialSelectedBy = extraction.fieldSelections?.material ?? "parser";
  const finishSelectedBy = extraction.fieldSelections?.finish ?? "parser";
  const extractedFinishRaw = extraction.rawFields.finish.raw ?? extraction.finish.raw ?? null;
  const finishUsesRawField = Boolean(extraction.rawFields.finish.raw);
  const finishReviewNeeded = finishUsesRawField
    ? extraction.rawFields.finish.reviewNeeded
    : extraction.finish.reviewNeeded;
  const finishConfidence = finishUsesRawField
    ? extraction.rawFields.finish.confidence
    : extraction.finish.confidence;
  const descriptionInputId = `${part.id}-description-input`;
  const partNumberInputId = `${part.id}-part-number-input`;
  const revisionInputId = `${part.id}-revision-input`;
  const quantityInputId = `${part.id}-quantity-input`;
  const quoteQuantitiesInputId = `${part.id}-quote-quantities-input`;
  const requestedByDateInputId = `${part.id}-requested-by-date-input`;
  const materialInputId = `${part.id}-material-input`;
  const finishInputId = `${part.id}-finish-input`;
  const tightestToleranceInputId = `${part.id}-tightest-tolerance-inch-input`;

  return (
    <div className="rounded-3xl border border-white/8 bg-black/20 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-lg font-medium">{part.name}</p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
              CAD: {part.cadFile?.original_name ?? "Missing"}
            </Badge>
            <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
              Drawing: {part.drawingFile?.original_name ?? "Missing"}
            </Badge>
            <Badge variant="secondary" className="border border-primary/20 bg-primary/10 text-primary">
              Extraction: {formatStatusLabel(extraction.status)}
            </Badge>
          </div>
          <RequestSummaryBadges
            requestedServiceKinds={currentDraft.requestedServiceKinds}
            quantity={currentDraft.quantity}
            requestedQuoteQuantities={currentDraft.quoteQuantities}
            requestedByDate={currentDraft.requestedByDate}
            className="mt-3"
          />
        </div>
        {extraction.warnings.length > 0 ? (
          <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-xs text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" />
            {extraction.warnings.length} warning(s)
          </div>
        ) : (
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" />
            No blocking warnings
          </div>
        )}
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[13rem_1fr]">
        <div className="space-y-3">
          {part.cadFile ? (
            cadPreviewable && cadPreviewSource ? (
              <CadModelThumbnail source={cadPreviewSource} className="h-52 w-full" />
            ) : (
              <div className="flex h-52 flex-col items-center justify-center rounded-[1.6rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(11,15,24,0.95))] px-4 text-center">
                <div className="rounded-full border border-white/10 bg-white/5 p-3">
                  <FileUp className="h-6 w-6 text-primary" />
                </div>
                <p className="mt-4 text-sm font-medium text-white">CAD attached</p>
                <p className="mt-2 text-xs text-white/45">{part.cadFile.original_name}</p>
                <p className="mt-3 text-xs text-white/40">
                  Interactive preview is currently enabled for `.step` and `.stp`.
                </p>
              </div>
            )
          ) : (
            <div className="flex h-52 flex-col items-center justify-center rounded-[1.6rem] border border-dashed border-white/10 bg-black/20 px-4 text-center">
              <div className="rounded-full border border-white/10 bg-white/5 p-3">
                <AlertTriangle className="h-6 w-6 text-amber-300" />
              </div>
              <p className="mt-4 text-sm font-medium text-white">CAD missing</p>
              <p className="mt-2 text-xs text-white/45">Upload a STEP file to generate a reusable thumbnail.</p>
            </div>
          )}

          <div className="rounded-2xl border border-white/10 bg-white/5 p-3 text-xs text-white/55">
            <p className="font-medium text-white">Source files</p>
            <p className="mt-2 truncate">CAD: {part.cadFile?.original_name ?? "Missing"}</p>
            <p className="mt-1 truncate">Drawing: {part.drawingFile?.original_name ?? "Missing"}</p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <RequestServiceIntentFields
              value={{
                requestedServiceKinds: currentDraft.requestedServiceKinds,
                primaryServiceKind: currentDraft.primaryServiceKind,
                serviceNotes: currentDraft.serviceNotes,
              }}
              onChange={(next) =>
                onDraftChange((current) =>
                  normalizeApprovedRequirementDraft({
                    ...current,
                    ...next,
                  }),
                )
              }
              disabled={disabled}
              tone="internal"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={descriptionInputId}>Description</Label>
            <Input
              id={descriptionInputId}
              className="border-white/10 bg-black/20"
              value={currentDraft.description ?? ""}
              disabled={disabled}
              onChange={(event) =>
                onDraftChange((current) => ({
                  ...current,
                  description: event.target.value || null,
                }))
              }
            />
            <p className="text-xs text-white/45">
              Extracted raw: {extraction.rawFields.description.raw || "Not found"}
              {extraction.rawFields.description.reviewNeeded
                ? ` • review needed (${Math.round(extraction.rawFields.description.confidence * 100)}%)`
                : ""}
              {` • source: ${extractionSourceLabel(descriptionSelectedBy)}`}
            </p>
            {descriptionResolution.staleAuto && descriptionResolution.approvedValue ? (
              <p className="text-xs text-amber-300">
                Showing {draftSourceLabel(descriptionResolution.source)} instead of stale auto-approved value:{" "}
                {descriptionResolution.approvedValue}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor={partNumberInputId}>Part number</Label>
            <Input
              id={partNumberInputId}
              className="border-white/10 bg-black/20"
              value={currentDraft.partNumber ?? ""}
              disabled={disabled}
              onChange={(event) =>
                onDraftChange((current) => ({
                  ...current,
                  partNumber: event.target.value || null,
                }))
              }
            />
            <p className="text-xs text-white/45">
              Extracted raw: {extraction.rawFields.partNumber.raw || "Not found"}
              {extraction.rawFields.partNumber.reviewNeeded
                ? ` • review needed (${Math.round(extraction.rawFields.partNumber.confidence * 100)}%)`
                : ""}
              {` • source: ${extractionSourceLabel(partNumberSelectedBy)}`}
            </p>
            {partNumberResolution.staleAuto && partNumberResolution.approvedValue ? (
              <p className="text-xs text-amber-300">
                Showing {draftSourceLabel(partNumberResolution.source)} instead of stale auto-approved value:{" "}
                {partNumberResolution.approvedValue}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor={revisionInputId}>Revision</Label>
            <Input
              id={revisionInputId}
              className="border-white/10 bg-black/20"
              value={currentDraft.revision ?? ""}
              disabled={disabled}
              onChange={(event) =>
                onDraftChange((current) => ({
                  ...current,
                  revision: event.target.value || null,
                }))
              }
            />
            <p className="text-xs text-white/45">
              Extracted raw: {extraction.rawFields.revision.raw || "Not found"}
              {extraction.rawFields.revision.reviewNeeded
                ? ` • review needed (${Math.round(extraction.rawFields.revision.confidence * 100)}%)`
                : ""}
              {` • source: ${extractionSourceLabel(revisionSelectedBy)}`}
            </p>
            {revisionResolution.staleAuto && revisionResolution.approvedValue ? (
              <p className="text-xs text-amber-300">
                Showing {draftSourceLabel(revisionResolution.source)} instead of stale auto-approved value:{" "}
                {revisionResolution.approvedValue}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor={quantityInputId}>Quantity</Label>
            {showQuoteFields ? (
              <Input
                id={quantityInputId}
                type="number"
                min={1}
                className="border-white/10 bg-black/20"
                value={currentDraft.quantity}
                disabled={disabled}
                onChange={(event) => onDraftQuantityChange(Number(event.target.value || 1))}
              />
            ) : (
              <p className="rounded-2xl border border-white/8 bg-white/5 px-4 py-3 text-sm text-white/45">
                Hidden for non-quote services.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor={quoteQuantitiesInputId}>Quote quantities</Label>
            {showQuoteFields ? (
              <>
                <Input
                  id={quoteQuantitiesInputId}
                  className="border-white/10 bg-black/20"
                  value={quoteQuantityInput}
                  disabled={disabled}
                  placeholder="1/10/100"
                  onChange={(event) => onQuoteQuantityInputChange(event.target.value)}
                  onBlur={onQuoteQuantityInputCommit}
                />
                <p className="text-xs text-white/45">Use slash-delimited quantities like 1/10/100.</p>
              </>
            ) : (
              <p className="rounded-2xl border border-white/8 bg-white/5 px-4 py-3 text-sm text-white/45">
                Hidden for non-quote services.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor={requestedByDateInputId}>Requested by</Label>
            <Input
              id={requestedByDateInputId}
              type="date"
              className="border-white/10 bg-black/20"
              value={currentDraft.requestedByDate ?? ""}
              disabled={disabled}
              onChange={(event) =>
                onDraftChange((current) => ({
                  ...current,
                  requestedByDate: event.target.value || null,
                }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={materialInputId}>Material</Label>
            <Input
              id={materialInputId}
              className="border-white/10 bg-black/20"
              value={currentDraft.material ?? ""}
              disabled={disabled}
              onChange={(event) =>
                onDraftChange((current) => ({
                  ...current,
                  material: event.target.value,
                }))
              }
            />
            <p className="text-xs text-white/45">
              Extracted: {extraction.material.normalized || extraction.material.raw || "Not found"}
              {extraction.material.reviewNeeded
                ? ` • review needed (${Math.round(extraction.material.confidence * 100)}%)`
                : ""}
              {` • source: ${extractionSourceLabel(materialSelectedBy)}`}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor={finishInputId}>Finish</Label>
            <Input
              id={finishInputId}
              className="border-white/10 bg-black/20"
              value={currentDraft.finish ?? ""}
              disabled={disabled}
              onChange={(event) =>
                onDraftChange((current) => ({
                  ...current,
                  finish: event.target.value || null,
                }))
              }
            />
            <p className="text-xs text-white/45">
              Extracted raw: {extractedFinishRaw || "Not found"}
              {finishReviewNeeded ? ` • review needed (${Math.round(finishConfidence * 100)}%)` : ""}
              {` • source: ${extractionSourceLabel(finishSelectedBy)}`}
            </p>
            {finishResolution.staleAuto && finishResolution.approvedValue ? (
              <p className="text-xs text-amber-300">
                Showing {draftSourceLabel(finishResolution.source)} instead of stale auto-approved value:{" "}
                {finishResolution.approvedValue}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor={tightestToleranceInputId}>Tightest tolerance (inches)</Label>
            <Input
              id={tightestToleranceInputId}
              type="number"
              step="0.0001"
              className="border-white/10 bg-black/20"
              value={currentDraft.tightestToleranceInch ?? ""}
              disabled={disabled}
              onChange={(event) =>
                onDraftChange((current) => ({
                  ...current,
                  tightestToleranceInch: event.target.value ? Number(event.target.value) : null,
                }))
              }
            />
            <p className="text-xs text-white/45">Extracted: {extraction.tightestTolerance.raw || "Not found"}</p>
          </div>
        </div>
      </div>

      <div className="mt-5 rounded-2xl border border-white/8 bg-white/5 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-white">RFQ metadata</p>
            <p className="mt-1 text-xs text-white/50">
              Shared client-safe metadata plus internal release controls live on the same line-item model.
            </p>
          </div>
        </div>
        <div className="mt-4">
          <RfqLineItemMetadataFields
            idPrefix={`internal-${part.id}`}
            value={{
              shipping: currentDraft.shipping,
              certifications: currentDraft.certifications,
              sourcing: currentDraft.sourcing,
              release: currentDraft.release,
            }}
            mode="internal"
            disabled={disabled}
            onChange={(next) =>
              onDraftChange((current) =>
                normalizeApprovedRequirementDraft({
                  ...current,
                  ...next,
                }),
              )
            }
          />
        </div>
      </div>

      <div className="mt-5">
        <Label>Applicable vendors</Label>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {INTERNAL_JOB_DETAIL_VENDORS.map((vendor) => {
            const checked = currentDraft.applicableVendors.includes(vendor);

            return (
              <label
                key={vendor}
                className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/5 px-4 py-3 text-sm"
              >
                <Checkbox
                  checked={checked}
                  disabled={disabled}
                  onCheckedChange={(nextChecked) =>
                    onDraftChange((current) => ({
                      ...current,
                      applicableVendors: nextChecked
                        ? [...current.applicableVendors, vendor]
                        : current.applicableVendors.filter((item) => item !== vendor),
                    }))
                  }
                />
                <span>{formatVendorName(vendor)}</span>
              </label>
            );
          })}
        </div>
      </div>

      {extraction.evidence.length > 0 ? (
        <div className="mt-5 rounded-2xl border border-white/8 bg-white/5 p-4">
          <p className="text-sm font-medium">Evidence highlights</p>
          <div className="mt-3 space-y-2 text-sm text-white/55">
            {extraction.evidence.slice(0, 3).map((item, index) => (
              <div key={`${item.field}-${index}`}>
                <span className="font-medium text-white/75">{item.field}</span>
                {`: page ${item.page}, confidence ${(item.confidence * 100).toFixed(0)}%, "${item.snippet}"`}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {extraction.warnings.length > 0 ? (
        <div className="mt-5 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-200">
          {extraction.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
