import { AlertTriangle, CheckCircle2, FileUp } from "lucide-react";
import { CadModelThumbnail } from "@/components/CadModelThumbnail";
import { RequestServiceIntentFields } from "@/components/quotes/RequestServiceIntentFields";
import { RequestSummaryBadges } from "@/components/quotes/RequestSummaryBadges";
import { RfqLineItemMetadataFields } from "@/components/quotes/RfqLineItemMetadataFields";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getInternalJobDraftSourceLabel,
  getInternalJobExtractionSourceLabel,
  INTERNAL_JOB_VENDORS,
  type InternalJobPartViewModel,
} from "@/features/quotes/internal-job-detail";
import { formatRequestedQuoteQuantitiesInput } from "@/features/quotes/request-intake";
import { normalizeApprovedRequirementDraft } from "@/features/quotes/request-scenarios";
import type { ApprovedPartRequirement } from "@/features/quotes/types";
import { formatStatusLabel, formatVendorName } from "@/features/quotes/utils";

type InternalJobPartRequirementsPanelProps = {
  partViewModels: InternalJobPartViewModel[];
  disabled: boolean;
  updateDraft: (
    partId: string,
    updater: (current: ApprovedPartRequirement) => ApprovedPartRequirement,
  ) => void;
  setQuoteQuantityInput: (partId: string, value: string) => void;
  commitQuoteQuantityInput: (partId: string) => void;
};

type PartRequirementCardProps = {
  partViewModel: InternalJobPartViewModel;
  disabled: boolean;
  updateDraft: (
    partId: string,
    updater: (current: ApprovedPartRequirement) => ApprovedPartRequirement,
  ) => void;
  setQuoteQuantityInput: (partId: string, value: string) => void;
  commitQuoteQuantityInput: (partId: string) => void;
};

function PartRequirementCard({
  partViewModel,
  disabled,
  updateDraft,
  setQuoteQuantityInput,
  commitQuoteQuantityInput,
}: PartRequirementCardProps) {
  const {
    part,
    draft,
    extraction,
    cadPreviewSource,
    cadPreviewable,
    quoteQuantityInput,
    showQuoteFields,
    descriptionResolution,
    partNumberResolution,
    revisionResolution,
    finishResolution,
    descriptionSelectedBy,
    partNumberSelectedBy,
    revisionSelectedBy,
    materialSelectedBy,
    finishSelectedBy,
    extractedFinishRaw,
    finishReviewNeeded,
    finishConfidence,
  } = partViewModel;

  return (
    <div key={part.id} className="rounded-3xl border border-white/8 bg-black/20 p-5">
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
            <Badge
              variant="secondary"
              className="border border-primary/20 bg-primary/10 text-primary"
            >
              Extraction: {formatStatusLabel(extraction.status)}
            </Badge>
          </div>
          <RequestSummaryBadges
            requestedServiceKinds={draft.requestedServiceKinds}
            quantity={draft.quantity}
            requestedQuoteQuantities={draft.quoteQuantities}
            requestedByDate={draft.requestedByDate}
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
              <p className="mt-2 text-xs text-white/45">
                Upload a STEP file to generate a reusable thumbnail.
              </p>
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
                requestedServiceKinds: draft.requestedServiceKinds,
                primaryServiceKind: draft.primaryServiceKind,
                serviceNotes: draft.serviceNotes,
              }}
              onChange={(next) =>
                updateDraft(part.id, (current) =>
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
            <Label>Description</Label>
            <Input
              className="border-white/10 bg-black/20"
              value={draft.description ?? ""}
              disabled={disabled}
              onChange={(event) =>
                updateDraft(part.id, (current) => ({
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
              {` • source: ${getInternalJobExtractionSourceLabel(descriptionSelectedBy)}`}
            </p>
            {descriptionResolution.staleAuto && descriptionResolution.approvedValue ? (
              <p className="text-xs text-amber-300">
                Showing {getInternalJobDraftSourceLabel(descriptionResolution.source)} instead of stale auto-approved value:{" "}
                {descriptionResolution.approvedValue}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label>Part number</Label>
            <Input
              className="border-white/10 bg-black/20"
              value={draft.partNumber ?? ""}
              disabled={disabled}
              onChange={(event) =>
                updateDraft(part.id, (current) => ({
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
              {` • source: ${getInternalJobExtractionSourceLabel(partNumberSelectedBy)}`}
            </p>
            {partNumberResolution.staleAuto && partNumberResolution.approvedValue ? (
              <p className="text-xs text-amber-300">
                Showing {getInternalJobDraftSourceLabel(partNumberResolution.source)} instead of stale auto-approved value:{" "}
                {partNumberResolution.approvedValue}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label>Revision</Label>
            <Input
              className="border-white/10 bg-black/20"
              value={draft.revision ?? ""}
              disabled={disabled}
              onChange={(event) =>
                updateDraft(part.id, (current) => ({
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
              {` • source: ${getInternalJobExtractionSourceLabel(revisionSelectedBy)}`}
            </p>
            {revisionResolution.staleAuto && revisionResolution.approvedValue ? (
              <p className="text-xs text-amber-300">
                Showing {getInternalJobDraftSourceLabel(revisionResolution.source)} instead of stale auto-approved value:{" "}
                {revisionResolution.approvedValue}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label>Quantity</Label>
            {showQuoteFields ? (
              <Input
                type="number"
                min={1}
                className="border-white/10 bg-black/20"
                value={draft.quantity}
                disabled={disabled}
                onChange={(event) => {
                  const nextDraft = normalizeApprovedRequirementDraft({
                    ...draft,
                    quantity: Number(event.target.value || 1),
                  });
                  setQuoteQuantityInput(
                    part.id,
                    formatRequestedQuoteQuantitiesInput(nextDraft.quoteQuantities),
                  );
                  updateDraft(part.id, () => nextDraft);
                }}
              />
            ) : (
              <p className="rounded-2xl border border-white/8 bg-white/5 px-4 py-3 text-sm text-white/45">
                Hidden for non-quote services.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>Quote quantities</Label>
            {showQuoteFields ? (
              <>
                <Input
                  className="border-white/10 bg-black/20"
                  value={quoteQuantityInput}
                  disabled={disabled}
                  placeholder="1/10/100"
                  onChange={(event) => setQuoteQuantityInput(part.id, event.target.value)}
                  onBlur={() => commitQuoteQuantityInput(part.id)}
                />
                <p className="text-xs text-white/45">
                  Use slash-delimited quantities like 1/10/100.
                </p>
              </>
            ) : (
              <p className="rounded-2xl border border-white/8 bg-white/5 px-4 py-3 text-sm text-white/45">
                Hidden for non-quote services.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>Requested by</Label>
            <Input
              type="date"
              className="border-white/10 bg-black/20"
              value={draft.requestedByDate ?? ""}
              disabled={disabled}
              onChange={(event) =>
                updateDraft(part.id, (current) => ({
                  ...current,
                  requestedByDate: event.target.value || null,
                }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label>Material</Label>
            <Input
              className="border-white/10 bg-black/20"
              value={draft.material ?? ""}
              disabled={disabled}
              onChange={(event) =>
                updateDraft(part.id, (current) => ({
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
              {` • source: ${getInternalJobExtractionSourceLabel(materialSelectedBy)}`}
            </p>
          </div>
          <div className="space-y-2">
            <Label>Finish</Label>
            <Input
              className="border-white/10 bg-black/20"
              value={draft.finish ?? ""}
              disabled={disabled}
              onChange={(event) =>
                updateDraft(part.id, (current) => ({
                  ...current,
                  finish: event.target.value || null,
                }))
              }
            />
            <p className="text-xs text-white/45">
              Extracted raw: {extractedFinishRaw || "Not found"}
              {finishReviewNeeded
                ? ` • review needed (${Math.round(finishConfidence * 100)}%)`
                : ""}
              {` • source: ${getInternalJobExtractionSourceLabel(finishSelectedBy)}`}
            </p>
            {finishResolution.staleAuto && finishResolution.approvedValue ? (
              <p className="text-xs text-amber-300">
                Showing {getInternalJobDraftSourceLabel(finishResolution.source)} instead of stale auto-approved value:{" "}
                {finishResolution.approvedValue}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label>Tightest tolerance (inches)</Label>
            <Input
              type="number"
              step="0.0001"
              className="border-white/10 bg-black/20"
              value={draft.tightestToleranceInch ?? ""}
              disabled={disabled}
              onChange={(event) =>
                updateDraft(part.id, (current) => ({
                  ...current,
                  tightestToleranceInch: event.target.value ? Number(event.target.value) : null,
                }))
              }
            />
            <p className="text-xs text-white/45">
              Extracted: {extraction.tightestTolerance.raw || "Not found"}
            </p>
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
              shipping: draft.shipping,
              certifications: draft.certifications,
              sourcing: draft.sourcing,
              release: draft.release,
            }}
            mode="internal"
            disabled={disabled}
            onChange={(next) =>
              updateDraft(part.id, (current) =>
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
          {INTERNAL_JOB_VENDORS.map((vendor) => {
            const checked = draft.applicableVendors.includes(vendor);

            return (
              <label
                key={vendor}
                className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/5 px-4 py-3 text-sm"
              >
                <Checkbox
                  checked={checked}
                  disabled={disabled}
                  onCheckedChange={(nextChecked) =>
                    updateDraft(part.id, (current) => ({
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

export function InternalJobPartRequirementsPanel({
  partViewModels,
  disabled,
  updateDraft,
  setQuoteQuantityInput,
  commitQuoteQuantityInput,
}: InternalJobPartRequirementsPanelProps) {
  return (
    <Card className="border-white/10 bg-white/5">
      <CardHeader>
        <CardTitle>Parts and approved requirements</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {partViewModels.map((partViewModel) => (
          <PartRequirementCard
            key={partViewModel.part.id}
            partViewModel={partViewModel}
            disabled={disabled}
            updateDraft={updateDraft}
            setQuoteQuantityInput={setQuoteQuantityInput}
            commitQuoteQuantityInput={commitQuoteQuantityInput}
          />
        ))}
      </CardContent>
    </Card>
  );
}
