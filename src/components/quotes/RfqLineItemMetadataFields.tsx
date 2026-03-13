import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  formatDelimitedStringList,
  parseDelimitedStringList,
  RFQ_INSPECTION_LEVEL_OPTIONS,
  RFQ_MATERIAL_PROVISIONING_OPTIONS,
  RFQ_REGION_PREFERENCE_OPTIONS,
  RFQ_RELEASE_STATUS_OPTIONS,
  RFQ_REVIEW_DISPOSITION_OPTIONS,
} from "@/features/quotes/rfq-metadata";
import type { RfqLineItemExtendedMetadata } from "@/features/quotes/types";

const NONE_VALUE = "__none__";

type RfqLineItemMetadataFieldsProps = {
  idPrefix: string;
  value: RfqLineItemExtendedMetadata;
  onChange: (next: Partial<RfqLineItemExtendedMetadata>) => void;
  disabled?: boolean;
  mode?: "client" | "internal";
};

function selectValue(value: string | null | undefined): string {
  return value ?? NONE_VALUE;
}

export function RfqLineItemMetadataFields({
  idPrefix,
  value,
  onChange,
  disabled = false,
  mode = "client",
}: RfqLineItemMetadataFieldsProps) {
  const showInternalFields = mode === "internal";

  const updateShipping = (next: Partial<RfqLineItemExtendedMetadata["shipping"]>) =>
    onChange({ shipping: { ...value.shipping, ...next } });
  const updateCertifications = (next: Partial<RfqLineItemExtendedMetadata["certifications"]>) =>
    onChange({ certifications: { ...value.certifications, ...next } });
  const updateSourcing = (next: Partial<RfqLineItemExtendedMetadata["sourcing"]>) =>
    onChange({ sourcing: { ...value.sourcing, ...next } });
  const updateRelease = (next: Partial<RfqLineItemExtendedMetadata["release"]>) =>
    onChange({ release: { ...value.release, ...next } });

  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2">
        {showInternalFields ? (
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-requested-date-override`}>Shipping date override</Label>
            <Input
              id={`${idPrefix}-requested-date-override`}
              type="date"
              value={value.shipping.requestedByDateOverride ?? ""}
              disabled={disabled}
              className="border-white/10 bg-black/20 text-white"
              onChange={(event) =>
                updateShipping({ requestedByDateOverride: event.target.value || null })
              }
            />
          </div>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-packaging-notes`}>Packaging notes</Label>
          <Textarea
            id={`${idPrefix}-packaging-notes`}
            value={value.shipping.packagingNotes ?? ""}
            disabled={disabled}
            className="min-h-[96px] border-white/10 bg-black/20 text-white"
            placeholder="Bagging, labeling, tray, or special handling requests."
            onChange={(event) => updateShipping({ packagingNotes: event.target.value || null })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-shipping-notes`}>Shipping notes</Label>
          <Textarea
            id={`${idPrefix}-shipping-notes`}
            value={value.shipping.shippingNotes ?? ""}
            disabled={disabled}
            className="min-h-[96px] border-white/10 bg-black/20 text-white"
            placeholder="Delivery constraints, dock notes, or shipment handling details."
            onChange={(event) => updateShipping({ shippingNotes: event.target.value || null })}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor={`${idPrefix}-required-certifications`}>Required certifications</Label>
          <Input
            id={`${idPrefix}-required-certifications`}
            value={formatDelimitedStringList(value.certifications.requiredCertifications)}
            disabled={disabled}
            className="border-white/10 bg-black/20 text-white"
            placeholder="ITAR, AS9100, material certs"
            onChange={(event) =>
              updateCertifications({
                requiredCertifications: parseDelimitedStringList(event.target.value),
              })
            }
          />
        </div>
        <div className="space-y-2">
          <Label>Inspection level</Label>
          <Select
            value={selectValue(value.certifications.inspectionLevel)}
            onValueChange={(next) =>
              updateCertifications({
                inspectionLevel: next === NONE_VALUE ? null : (next as typeof value.certifications.inspectionLevel),
              })
            }
            disabled={disabled}
          >
            <SelectTrigger className="border-white/10 bg-black/20 text-white">
              <SelectValue placeholder="Select inspection level" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>No specific level</SelectItem>
              {RFQ_INSPECTION_LEVEL_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-certification-notes`}>Certification notes</Label>
          <Textarea
            id={`${idPrefix}-certification-notes`}
            value={value.certifications.notes ?? ""}
            disabled={disabled}
            className="min-h-[96px] border-white/10 bg-black/20 text-white"
            placeholder="Traceability or inspection expectations."
            onChange={(event) => updateCertifications({ notes: event.target.value || null })}
          />
        </div>
        <label className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/5 px-4 py-3 text-sm text-white/80">
          <Checkbox
            checked={value.certifications.materialCertificationRequired === true}
            disabled={disabled}
            onCheckedChange={(next) =>
              updateCertifications({ materialCertificationRequired: next === true ? true : false })
            }
          />
          <span>Material certification required</span>
        </label>
        <label className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/5 px-4 py-3 text-sm text-white/80">
          <Checkbox
            checked={value.certifications.certificateOfConformanceRequired === true}
            disabled={disabled}
            onCheckedChange={(next) =>
              updateCertifications({
                certificateOfConformanceRequired: next === true ? true : false,
              })
            }
          />
          <span>Certificate of conformance required</span>
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label>Sourcing preference</Label>
          <Select
            value={selectValue(value.sourcing.regionPreferenceOverride)}
            onValueChange={(next) =>
              updateSourcing({
                regionPreferenceOverride:
                  next === NONE_VALUE ? null : (next as typeof value.sourcing.regionPreferenceOverride),
              })
            }
            disabled={disabled}
          >
            <SelectTrigger className="border-white/10 bg-black/20 text-white">
              <SelectValue placeholder="Select sourcing preference" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>No preference</SelectItem>
              {RFQ_REGION_PREFERENCE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Material provisioning</Label>
          <Select
            value={selectValue(value.sourcing.materialProvisioning)}
            onValueChange={(next) =>
              updateSourcing({
                materialProvisioning:
                  next === NONE_VALUE ? null : (next as typeof value.sourcing.materialProvisioning),
              })
            }
            disabled={disabled}
          >
            <SelectTrigger className="border-white/10 bg-black/20 text-white">
              <SelectValue placeholder="Select provisioning" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>No provisioning note</SelectItem>
              {RFQ_MATERIAL_PROVISIONING_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor={`${idPrefix}-preferred-suppliers`}>Preferred suppliers</Label>
          <Input
            id={`${idPrefix}-preferred-suppliers`}
            value={formatDelimitedStringList(value.sourcing.preferredSuppliers)}
            disabled={disabled}
            className="border-white/10 bg-black/20 text-white"
            placeholder="Preferred shops or customer-nominated suppliers"
            onChange={(event) =>
              updateSourcing({
                preferredSuppliers: parseDelimitedStringList(event.target.value),
              })
            }
          />
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor={`${idPrefix}-sourcing-notes`}>Sourcing notes</Label>
          <Textarea
            id={`${idPrefix}-sourcing-notes`}
            value={value.sourcing.notes ?? ""}
            disabled={disabled}
            className="min-h-[96px] border-white/10 bg-black/20 text-white"
            placeholder="Domestic preference, approved supplier context, or special sourcing instructions."
            onChange={(event) => updateSourcing({ notes: event.target.value || null })}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label>Release status</Label>
          <Select
            value={selectValue(value.release.releaseStatus)}
            onValueChange={(next) =>
              updateRelease({
                releaseStatus: next === NONE_VALUE ? null : (next as typeof value.release.releaseStatus),
              })
            }
            disabled={disabled}
          >
            <SelectTrigger className="border-white/10 bg-black/20 text-white">
              <SelectValue placeholder="Select release status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>No release status</SelectItem>
              {RFQ_RELEASE_STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {showInternalFields ? (
          <div className="space-y-2">
            <Label>Review disposition</Label>
            <Select
              value={selectValue(value.release.reviewDisposition)}
              onValueChange={(next) =>
                updateRelease({
                  reviewDisposition:
                    next === NONE_VALUE ? null : (next as typeof value.release.reviewDisposition),
                })
              }
              disabled={disabled}
            >
              <SelectTrigger className="border-white/10 bg-black/20 text-white">
                <SelectValue placeholder="Select review disposition" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>No disposition</SelectItem>
                {RFQ_REVIEW_DISPOSITION_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor={`${idPrefix}-release-notes`}>Release notes</Label>
          <Textarea
            id={`${idPrefix}-release-notes`}
            value={value.release.notes ?? ""}
            disabled={disabled}
            className="min-h-[96px] border-white/10 bg-black/20 text-white"
            placeholder="Revision readiness, blockers, or release context."
            onChange={(event) => updateRelease({ notes: event.target.value || null })}
          />
        </div>
        {showInternalFields ? (
          <label className="md:col-span-2 flex items-center gap-3 rounded-2xl border border-white/8 bg-white/5 px-4 py-3 text-sm text-white/80">
            <Checkbox
              checked={value.release.quoteBlockedUntilRelease === true}
              disabled={disabled}
              onCheckedChange={(next) =>
                updateRelease({ quoteBlockedUntilRelease: next === true ? true : false })
              }
            />
            <span>Block quote publication until release is confirmed</span>
          </label>
        ) : null}
      </div>
    </div>
  );
}
