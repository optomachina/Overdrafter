import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, FileText, Loader2, LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getVendorDisplayName } from "@/features/quotes/vendor-colors";
import type { VendorName } from "@/integrations/supabase/types";
import type { QuoteLaneEligibility } from "@/features/quotes/types";

export type QuoteDisclosureFile = {
  kind: "CAD" | "Drawing";
  name: string;
  sizeBytes: number | null;
};

export type QuoteDisclosureField = {
  label: string;
  value: string;
};

type ClientQuoteRequestFlowProps = {
  availableVendors: readonly VendorName[];
  blockerReasons?: readonly string[];
  canSubmit: boolean;
  disclosureFields: readonly QuoteDisclosureField[];
  files: readonly QuoteDisclosureFile[];
  initialSelectedVendors: readonly VendorName[];
  laneEligibility?: readonly QuoteLaneEligibility[];
  isLoading?: boolean;
  isSubmitting?: boolean;
  loadError?: string | null;
  open: boolean;
  partLabel: string;
  onConfirm: (selectedVendors: VendorName[]) => Promise<boolean>;
  onOpenChange: (open: boolean) => void;
};

function formatFileSize(sizeBytes: number | null) {
  if (sizeBytes === null) {
    return null;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ClientQuoteRequestFlow({
  availableVendors,
  blockerReasons = [],
  canSubmit,
  disclosureFields,
  files,
  initialSelectedVendors,
  laneEligibility = [],
  isLoading = false,
  isSubmitting = false,
  loadError = null,
  open,
  partLabel,
  onConfirm,
  onOpenChange,
}: ClientQuoteRequestFlowProps) {
  const [step, setStep] = useState<"scope" | "review">("scope");
  const [selectedVendors, setSelectedVendors] = useState<VendorName[]>(
    [...initialSelectedVendors],
  );
  const [submissionError, setSubmissionError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setStep("scope");
    setSelectedVendors([...initialSelectedVendors]);
    setSubmissionError(null);
  }, [initialSelectedVendors, open]);

  const selectedVendorSet = useMemo(
    () => new Set(selectedVendors),
    [selectedVendors],
  );
  const hasBlockingRequirement = blockerReasons.length > 0;

  const toggleVendor = (vendor: VendorName) => {
    if (!canSubmit || isSubmitting) {
      return;
    }

    setSubmissionError(null);
    setSelectedVendors((current) => {
      if (current.includes(vendor)) {
        return current.filter((candidate) => candidate !== vendor);
      }

      return [...current, vendor];
    });
  };

  const eligibilityByVendor = useMemo(() => {
    const byVendor = new Map<VendorName, QuoteLaneEligibility[]>();
    laneEligibility.forEach((lane) => {
      const current = byVendor.get(lane.vendor) ?? [];
      current.push(lane);
      byVendor.set(lane.vendor, current);
    });
    return byVendor;
  }, [laneEligibility]);
  const requestableSelectedVendors = selectedVendors.filter((vendor) => {
    const lanes = eligibilityByVendor.get(vendor) ?? [];
    return lanes.length === 0 || lanes.some((lane) => lane.state === "requestable");
  });
  const selectionIsFullyCoveredByValidQuotes =
    selectedVendors.length > 0 &&
    laneEligibility.length > 0 &&
    selectedVendors.every((vendor) => {
      const lanes = eligibilityByVendor.get(vendor) ?? [];
      return lanes.length > 0 && lanes.every((lane) => lane.state === "valid_quote");
    });
  const reviewVendors = selectionIsFullyCoveredByValidQuotes
    ? selectedVendors
    : requestableSelectedVendors;
  const canContinue =
    canSubmit &&
    !isLoading &&
    !loadError &&
    !hasBlockingRequirement &&
    (requestableSelectedVendors.length > 0 || selectionIsFullyCoveredByValidQuotes);

  const confirmRequest = async () => {
    setSubmissionError(null);
    const accepted = await onConfirm(reviewVendors);

    if (!accepted) {
      setSubmissionError(
        "The request was not started. Your vendor selection is still here so you can retry.",
      );
    }
  };

  const vendorAvailability = (vendor: VendorName) => {
    const lanes = eligibilityByVendor.get(vendor) ?? [];
    const requestable = lanes.some((lane) => lane.state === "requestable");
    if (requestable || lanes.length === 0) {
      return { disabled: false, message: "Current integration" };
    }

    const validUntil = lanes
      .filter((lane) => lane.state === "valid_quote" && lane.validUntil)
      .map((lane) => lane.validUntil as string)
      .sort()
      .at(-1);
    if (validUntil) {
      return {
        disabled: true,
        message: `Valid through ${new Date(validUntil).toLocaleDateString()}`,
      };
    }

    const retryAt = lanes
      .filter((lane) => lane.state === "cooldown" && lane.retryAt)
      .map((lane) => lane.retryAt as string)
      .sort()
      .at(-1);
    if (retryAt) {
      return {
        disabled: true,
        message: `Try again after ${new Date(retryAt).toLocaleString()}`,
      };
    }

    return { disabled: true, message: "Request already in progress" };
  };

  let title = "Choose where to request quotes";
  let description =
    "Select the vendor integrations that should receive this part package.";

  if (step === "review") {
    title = "Confirm what will be shared";
    description =
      "Review the recipients, files, and manufacturing requirements before anything leaves OverDrafter.";
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto border-paper-hairline bg-paper-surface p-0 text-paper-ink sm:rounded-[4px]">
        <DialogHeader className="border-b border-paper-hairline px-5 pb-5 pt-6 text-left sm:px-7">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-paper-red">
            Part quote · {step === "scope" ? "1 of 2" : "2 of 2"}
          </p>
          <DialogTitle className="font-display text-2xl font-bold tracking-[-0.035em]">
            {title}
          </DialogTitle>
          <DialogDescription className="max-w-xl text-sm leading-6 text-paper-muted">
            {description}
          </DialogDescription>
        </DialogHeader>

        {step === "scope" ? (
          <div className="px-5 py-5 sm:px-7">
            {!canSubmit ? (
              <div className="mb-5 flex gap-3 border-y border-paper-hairline bg-paper-inset px-4 py-3 text-sm">
                <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-paper-red" aria-hidden="true" />
                <div>
                  <p className="font-semibold">Automatic quote access required</p>
                  <p className="mt-1 leading-5 text-paper-muted">
                    Automatic quote collection is not enabled for this organization. The Founding Beta is free and invitation-only. No payment card, order, or supplier commitment is created.
                  </p>
                </div>
              </div>
            ) : null}

            {blockerReasons.length > 0 ? (
              <div className="mb-5 border-y border-paper-hairline px-4 py-3">
                <p className="text-sm font-semibold">Finish the part requirements first</p>
                <ul className="mt-2 space-y-1 text-sm text-paper-muted">
                  {blockerReasons.map((reason) => (
                    <li key={reason}>· {reason}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {loadError ? (
              <p role="alert" className="border-y border-destructive/40 px-4 py-3 text-sm text-destructive">
                {loadError}
              </p>
            ) : null}

            {isLoading ? (
              <div className="flex min-h-40 items-center justify-center gap-3 text-sm text-paper-muted">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Loading vendor scope…
              </div>
            ) : (
              <fieldset disabled={!canSubmit || isSubmitting}>
                <legend className="sr-only">Vendor integrations</legend>
                <div className="divide-y divide-paper-hairline border-y border-paper-hairline">
                  {availableVendors.map((vendor) => {
                    const checked = selectedVendorSet.has(vendor);
                    const availability = vendorAvailability(vendor);

                    return (
                      <label
                        key={vendor}
                        className="flex min-h-14 cursor-pointer items-center gap-3 px-2 py-3 transition-colors hover:bg-paper-inset has-[:disabled]:cursor-default has-[:disabled]:opacity-65"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleVendor(vendor)}
                          disabled={availability.disabled}
                          aria-label={`Send to ${getVendorDisplayName(vendor)}`}
                          className="h-5 w-5 rounded-[2px] border-paper-ink data-[state=checked]:bg-paper-red data-[state=checked]:text-white"
                        />
                        <span className="font-medium">{getVendorDisplayName(vendor)}</span>
                        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.08em] text-paper-muted">
                          {availability.message}
                        </span>
                      </label>
                    );
                  })}
                  {availableVendors.length === 0 ? (
                    <p className="px-2 py-6 text-sm text-paper-muted">
                      No quote integrations are enabled for this workspace yet.
                    </p>
                  ) : null}
                </div>
              </fieldset>
            )}
          </div>
        ) : (
          <div className="space-y-6 px-5 py-5 sm:px-7">
            <section aria-labelledby="quote-recipients-heading">
              <h3 id="quote-recipients-heading" className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-paper-muted">
                Recipients
              </h3>
              <div className="mt-2 divide-y divide-paper-hairline border-y border-paper-hairline">
                {reviewVendors.map((vendor) => (
                  <div key={vendor} className="flex min-h-11 items-center gap-3 py-2 text-sm">
                    <Check className="h-4 w-4 text-paper-red" aria-hidden="true" />
                    {getVendorDisplayName(vendor)}
                  </div>
                ))}
              </div>
            </section>

            <section aria-labelledby="quote-files-heading">
              <h3 id="quote-files-heading" className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-paper-muted">
                Files
              </h3>
              <div className="mt-2 divide-y divide-paper-hairline border-y border-paper-hairline">
                {files.map((file) => (
                  <div key={`${file.kind}:${file.name}`} className="flex min-h-12 items-center gap-3 py-2 text-sm">
                    <FileText className="h-4 w-4 text-paper-muted" aria-hidden="true" />
                    <span className="min-w-0 truncate font-medium">{file.name}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] text-paper-muted">
                      {[file.kind, formatFileSize(file.sizeBytes)].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section aria-labelledby="quote-requirements-heading">
              <h3 id="quote-requirements-heading" className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-paper-muted">
                Part requirements
              </h3>
              <dl className="mt-2 grid border-y border-paper-hairline sm:grid-cols-2">
                <div className="border-b border-paper-hairline py-3 sm:col-span-2">
                  <dt className="text-[11px] text-paper-muted">Part</dt>
                  <dd className="mt-1 text-sm font-semibold">{partLabel}</dd>
                </div>
                {disclosureFields.map((field, index) => (
                  <div
                    key={field.label}
                    className={`border-b border-paper-hairline py-3 ${index % 2 === 0 ? "sm:pr-5" : "sm:border-l sm:pl-5"}`}
                  >
                    <dt className="text-[11px] text-paper-muted">{field.label}</dt>
                    <dd className="mt-1 text-sm font-medium">{field.value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            {submissionError ? (
              <p role="alert" className="border-y border-destructive/40 py-3 text-sm text-destructive">
                {submissionError}
              </p>
            ) : null}

            <p className="text-xs leading-5 text-paper-muted">
              Sending confirms that these vendors may use the listed files and requirements to prepare this quote.
            </p>
          </div>
        )}

        <DialogFooter className="gap-2 border-t border-paper-hairline bg-paper-inset px-5 py-4 sm:px-7">
          {step === "review" ? (
            <Button
              type="button"
              variant="outline"
              className="rounded-[2px] border-paper-hairline bg-transparent"
              onClick={() => setStep("scope")}
              disabled={isSubmitting}
            >
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
              Back
            </Button>
          ) : null}
          {step === "scope" ? (
            <Button
              type="button"
              className="rounded-[2px]"
              disabled={!canContinue}
              onClick={() => setStep("review")}
            >
              Review what will be shared
            </Button>
          ) : (
            <Button
              type="button"
              className="rounded-[2px]"
              disabled={isSubmitting}
              onClick={() => void confirmRequest()}
            >
              {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {selectionIsFullyCoveredByValidQuotes
                ? "View current comparison"
                : `Send to ${requestableSelectedVendors.length} ${requestableSelectedVendors.length === 1 ? "vendor" : "vendors"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
