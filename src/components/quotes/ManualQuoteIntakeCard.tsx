import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, Mail, Plus, Trash2, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  completeAdminManualQuoteRequest,
  type AdminManualQuoteRequest,
} from "@/features/quotes/api/manual-quote-admin-api";
import {
  recordManualVendorQuote,
  removeUnregisteredManualQuoteEvidence,
  uploadManualQuoteEvidence,
} from "@/features/quotes/api/internal-review";
import type {
  ManualQuoteOfferInput,
  PartAggregate,
} from "@/features/quotes/types";
import { formatStatusLabel, formatVendorName } from "@/features/quotes/utils";
import type { VendorName, VendorStatus } from "@/integrations/supabase/types";

const EVIDENCE_ACCEPT = [
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".heic",
  ".tif",
  ".tiff",
  ".bmp",
  ".txt",
  ".html",
  ".eml",
  ".msg",
].join(",");

const MANUAL_QUOTE_VENDORS: VendorName[] = [
  "xometry",
  "fictiv",
  "protolabs",
  "sendcutsend",
  "partsbadger",
  "fastdms",
];

const MANUAL_QUOTE_STATUSES: VendorStatus[] = [
  "official_quote_received",
  "instant_quote_received",
  "manual_review_pending",
  "manual_vendor_followup",
];

const COMPLETION_STATUSES: VendorStatus[] = [
  "official_quote_received",
  "instant_quote_received",
];

export type ManualQuoteCompletionTarget = Pick<
  AdminManualQuoteRequest,
  "requestId" | "quoteRunId" | "jobId"
> & {
  requestStatus: AdminManualQuoteRequest["requestStatus"] | null;
  quoteRunStatus: AdminManualQuoteRequest["quoteRunStatus"] | null;
  jobStatus: AdminManualQuoteRequest["jobStatus"] | null;
  partIds: string[];
  isStale: boolean;
  staleReason: string | null;
  hasAal2: boolean;
};

type ManualQuoteIntakeCardProps = {
  jobId: string;
  parts: PartAggregate[];
  disabled?: boolean;
  completionTarget?: ManualQuoteCompletionTarget | null;
};

type OfferDraft = {
  id: string;
  laneLabel: string;
  totalPriceUsd: string;
  leadTimeBusinessDays: string;
  unitPriceUsd: string;
  quoteRef: string;
  quoteDateIso: string;
  sourcing: string;
  tier: string;
  process: string;
  material: string;
  finish: string;
  notes: string;
};

function createOfferDraft(index: number): OfferDraft {
  return {
    id: crypto.randomUUID(),
    laneLabel: index === 0 ? "Primary offer" : "",
    totalPriceUsd: "",
    leadTimeBusinessDays: "",
    unitPriceUsd: "",
    quoteRef: "",
    quoteDateIso: "",
    sourcing: "",
    tier: "",
    process: "",
    material: "",
    finish: "",
    notes: "",
  };
}

function toNullableNumber(value: string): number | null {
  if (!value.trim()) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildOfferPayloads(offers: OfferDraft[]): ManualQuoteOfferInput[] {
  return offers.map((offer, index) => {
    const totalPriceUsd = toNullableNumber(offer.totalPriceUsd);

    if (totalPriceUsd === null) {
      throw new Error(`Offer lane ${index + 1} is missing a valid total price.`);
    }

    return {
      laneLabel: offer.laneLabel.trim() || `Offer ${index + 1}`,
      totalPriceUsd,
      leadTimeBusinessDays: toNullableNumber(offer.leadTimeBusinessDays),
      unitPriceUsd: toNullableNumber(offer.unitPriceUsd),
      quoteRef: offer.quoteRef.trim() || null,
      quoteDateIso: offer.quoteDateIso || null,
      sourcing: offer.sourcing.trim() || null,
      tier: offer.tier.trim() || null,
      process: offer.process.trim() || null,
      material: offer.material.trim() || null,
      finish: offer.finish.trim() || null,
      notes: offer.notes.trim() || null,
    };
  });
}

function ManualQuoteIntakeHeader({
  completionTarget,
}: Readonly<{
  completionTarget: ManualQuoteCompletionTarget | null;
}>) {
  if (completionTarget) {
    return (
      <CardHeader>
        <CardTitle>Complete manual quote request</CardTitle>
        <p className="text-sm text-muted-foreground">
          Record the supplier response against this exact customer request. The
          server will atomically complete the request and run, then move the job
          into internal review.
        </p>
      </CardHeader>
    );
  }

  return (
    <CardHeader>
      <CardTitle>Manual quote intake</CardTitle>
      <p className="text-sm text-muted-foreground">
        Record a quote from pasted email text, screenshot/PDF evidence, or a
        forwarded manual supplier reply. This writes normalized offer lanes
        directly into the compare view without using browser automation.
      </p>
    </CardHeader>
  );
}

function CompletionTargetNotice({
  completionTarget,
}: Readonly<{
  completionTarget: ManualQuoteCompletionTarget | null;
}>) {
  if (!completionTarget) {
    return null;
  }

  let followUpMessage = null;

  if (completionTarget.staleReason) {
    followUpMessage = <p className="mt-2">{completionTarget.staleReason}</p>;
  } else if (!completionTarget.hasAal2) {
    followUpMessage = (
      <p className="mt-2 text-amber-700 dark:text-amber-200">
        MFA is required before this completion can be submitted.
      </p>
    );
  }

  const stateClassName = completionTarget.isStale
    ? "border-destructive/30 bg-destructive/10 text-destructive"
    : "border-border bg-muted text-muted-foreground";

  return (
    <div
      className={`rounded-2xl border p-4 text-sm ${stateClassName}`}
      role={completionTarget.isStale ? "alert" : undefined}
    >
      <p className="font-medium text-foreground">
        Exact request {completionTarget.requestId.slice(0, 8)}
      </p>
      <p className="mt-1">
        Request {formatStatusLabel(completionTarget.requestStatus ?? "missing")}{" "}
        · Run {formatStatusLabel(completionTarget.quoteRunStatus ?? "missing")}{" "}
        · Job {formatStatusLabel(completionTarget.jobStatus ?? "missing")}
      </p>
      {followUpMessage}
    </div>
  );
}

function SelectedPartSummary({
  selectedPart,
}: Readonly<{
  selectedPart: PartAggregate | null;
}>) {
  if (!selectedPart) {
    return null;
  }

  const details: string[] = [];

  if (selectedPart.approvedRequirement?.part_number) {
    details.push(selectedPart.approvedRequirement.part_number);
  }

  if (selectedPart.approvedRequirement?.revision) {
    details.push(`Rev ${selectedPart.approvedRequirement.revision}`);
  }

  const detailText = details.length > 0 ? ` • ${details.join(" • ")}` : "";

  return (
    <div className="rounded-2xl border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
      <p className="font-medium text-foreground">Target part</p>
      <p className="mt-1">
        {selectedPart.name}
        {detailText}
      </p>
    </div>
  );
}

export function ManualQuoteIntakeCard({
  jobId,
  parts,
  disabled = false,
  completionTarget = null,
}: ManualQuoteIntakeCardProps) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedPartId, setSelectedPartId] = useState(parts[0]?.id ?? "");
  const [vendor, setVendor] = useState<VendorName>("xometry");
  const [status, setStatus] = useState<VendorStatus>("official_quote_received");
  const [quoteUrl, setQuoteUrl] = useState("");
  const [completionReason, setCompletionReason] = useState("");
  const [summaryNote, setSummaryNote] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([]);
  const [offers, setOffers] = useState<OfferDraft[]>([createOfferDraft(0)]);
  const availableParts = useMemo(() => {
    if (!completionTarget) {
      return parts;
    }

    return parts.filter((part) => completionTarget.partIds.includes(part.id));
  }, [completionTarget, parts]);
  const formDisabled =
    disabled ||
    Boolean(completionTarget?.isStale) ||
    Boolean(completionTarget && !completionTarget.hasAal2) ||
    Boolean(completionTarget && completionTarget.jobId !== jobId);

  useEffect(() => {
    if (!availableParts.length) {
      setSelectedPartId("");
      return;
    }

    const selectionStillExists = availableParts.some((part) => part.id === selectedPartId);

    if (!selectionStillExists) {
      setSelectedPartId(availableParts[0].id);
    }
  }, [availableParts, selectedPartId]);

  useEffect(() => {
    if (completionTarget && !COMPLETION_STATUSES.includes(status)) {
      setStatus("official_quote_received");
    }
  }, [completionTarget, status]);

  const selectedPart = useMemo(
    () => availableParts.find((part) => part.id === selectedPartId) ?? null,
    [availableParts, selectedPartId],
  );

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPartId) {
        throw new Error("Select a part before recording a quote.");
      }

      const offerPayloads = buildOfferPayloads(offers);
      const uploadScope = completionTarget?.quoteRunId
        ? {
            quoteRequestId: completionTarget.requestId,
            quoteRunId: completionTarget.quoteRunId,
          }
        : undefined;
      const artifacts = evidenceFiles.length > 0
        ? await uploadManualQuoteEvidence(jobId, evidenceFiles, uploadScope)
        : [];

      const input = {
        jobId,
        partId: selectedPartId,
        vendor,
        status,
        quoteUrl: quoteUrl.trim() || undefined,
        summaryNote: summaryNote.trim() || undefined,
        sourceText: sourceText.trim() || undefined,
        offers: offerPayloads,
        artifacts,
      };

      if (!completionTarget) {
        return recordManualVendorQuote(input);
      }

      if (!completionTarget.quoteRunId) {
        throw new Error("This manual request no longer has an active quote run.");
      }

      if (!completionReason.trim()) {
        throw new Error("Add an operator reason before completing this request.");
      }

      try {
        return await completeAdminManualQuoteRequest({
          ...input,
          quoteRequestId: completionTarget.requestId,
          quoteRunId: completionTarget.quoteRunId,
          reason: completionReason.trim(),
          idempotencyKey: `manual-quote-request:${completionTarget.requestId}`,
        });
      } catch (error) {
        try {
          await removeUnregisteredManualQuoteEvidence(artifacts);
        } catch {
          // The server protects registered evidence from deletion. Cleanup is
          // best-effort so the original completion error remains actionable.
        }

        throw error;
      }
    },
    onSuccess: async (result) => {
      if (completionTarget) {
        toast.success(
          "Manual quote received. The request and run are complete and the job is in internal review.",
        );
      } else {
        toast.success(
          "createdNewQuoteRun" in result && result.createdNewQuoteRun
            ? "Manual quote saved and a new quote run was created."
            : "Manual quote saved to the current quote run.",
        );
      }

      setQuoteUrl("");
      setCompletionReason("");
      setSummaryNote("");
      setSourceText("");
      setEvidenceFiles([]);
      setOffers([createOfferDraft(0)]);

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }

      await queryClient.invalidateQueries({ queryKey: ["job", jobId] });
      await queryClient.invalidateQueries({ queryKey: ["admin-manual-quote-requests"] });
    },
    onError: (error: Error) => {
      const message = error.message || "Failed to record the manual quote.";

      if (message.toLowerCase().includes("aal2")) {
        toast.error("MFA is required before completing a manual quote request.");
        return;
      }

      toast.error(message);
    },
  });

  const handleEvidenceUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);

    if (selectedFiles.length === 0) {
      return;
    }

    const validFiles = selectedFiles.filter((file) => {
      const maxSizeBytes = 50 * 1024 * 1024;

      if (file.size > maxSizeBytes) {
        toast.error(`${file.name} exceeds the 50 MB evidence file limit.`);
        return false;
      }

      return true;
    });

    setEvidenceFiles((current) => [...current, ...validFiles]);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const updateOffer = (offerId: string, updates: Partial<OfferDraft>) => {
    setOffers((current) =>
      current.map((offer) => (offer.id === offerId ? { ...offer, ...updates } : offer)),
    );
  };

  const removeOffer = (offerId: string) => {
    setOffers((current) => (current.length === 1 ? current : current.filter((offer) => offer.id !== offerId)));
  };

  return (
    <Card className="border-border bg-accent">
      <ManualQuoteIntakeHeader completionTarget={completionTarget} />
      <CardContent className="space-y-5">
        <CompletionTargetNotice completionTarget={completionTarget} />

        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2 md:col-span-1">
            <Label>Part</Label>
            <Select
              value={selectedPartId}
              onValueChange={setSelectedPartId}
              disabled={formDisabled || !availableParts.length}
            >
              <SelectTrigger className="border-border bg-muted text-foreground">
                <SelectValue placeholder="Select part" />
              </SelectTrigger>
              <SelectContent>
                {availableParts.map((part) => (
                  <SelectItem key={part.id} value={part.id}>
                    {part.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 md:col-span-1">
            <Label>Vendor</Label>
            <Select
              value={vendor}
              onValueChange={(value) => setVendor(value as VendorName)}
              disabled={formDisabled}
            >
              <SelectTrigger className="border-border bg-muted text-foreground">
                <SelectValue placeholder="Select vendor" />
              </SelectTrigger>
              <SelectContent>
                {MANUAL_QUOTE_VENDORS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {formatVendorName(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 md:col-span-1">
            <Label>Status</Label>
            <Select
              value={status}
              onValueChange={(value) => setStatus(value as VendorStatus)}
              disabled={formDisabled}
            >
              <SelectTrigger className="border-border bg-muted text-foreground">
                <SelectValue placeholder="Select status" />
              </SelectTrigger>
              <SelectContent>
                {(completionTarget ? COMPLETION_STATUSES : MANUAL_QUOTE_STATUSES).map((option) => (
                  <SelectItem key={option} value={option}>
                    {formatStatusLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {completionTarget ? (
          <div className="space-y-2">
            <Label htmlFor="manual-quote-completion-reason">Operator reason</Label>
            <Input
              id="manual-quote-completion-reason"
              className="border-border bg-muted"
              value={completionReason}
              disabled={formDisabled}
              onChange={(event) => setCompletionReason(event.target.value)}
              placeholder="Reviewed supplier response and normalized the offer"
            />
          </div>
        ) : null}

        <SelectedPartSummary selectedPart={selectedPart} />

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Quote URL</Label>
            <Input
              className="border-border bg-muted"
              value={quoteUrl}
              disabled={formDisabled}
              onChange={(event) => setQuoteUrl(event.target.value)}
              placeholder="https://vendor.example/quote/123"
            />
          </div>
          <div className="space-y-2">
            <Label>Internal note</Label>
            <Input
              className="border-border bg-muted"
              value={summaryNote}
              disabled={formDisabled}
              onChange={(event) => setSummaryNote(event.target.value)}
              placeholder="Imported from forwarded vendor reply"
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <Label>Evidence files</Label>
            <Button
              type="button"
              variant="outline"
              className="border-border bg-accent"
              onClick={() => fileInputRef.current?.click()}
              disabled={formDisabled}
            >
              <UploadCloud className="mr-2 h-4 w-4" />
              Add PDFs or images
            </Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={EVIDENCE_ACCEPT}
            className="hidden"
            onChange={handleEvidenceUpload}
          />
          <div className="rounded-2xl border border-dashed border-border bg-muted p-4 text-sm text-muted-foreground">
            Supported intake evidence: PDF quotes, screenshots, photos, email exports, and OCR text files.
          </div>
          {evidenceFiles.length > 0 ? (
            <div className="grid gap-2">
              {evidenceFiles.map((file, index) => (
                <div
                  key={`${file.name}-${index}`}
                  className="flex items-center justify-between rounded-2xl border border-border bg-muted px-4 py-3 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">{file.name}</p>
                    <p className="text-xs text-muted-foreground">{(file.size / (1024 * 1024)).toFixed(2)} MB</p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => setEvidenceFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))}
                    disabled={formDisabled}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label>Email body / OCR text</Label>
          <Textarea
            className="min-h-32 border-border bg-muted"
            value={sourceText}
            disabled={formDisabled}
            onChange={(event) => setSourceText(event.target.value)}
            placeholder="Paste the vendor email, OCR output, or quote body here."
          />
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary" className="border border-border bg-accent text-foreground/80">
              <Mail className="mr-1 h-3.5 w-3.5" />
              Email copy/paste
            </Badge>
            <Badge variant="secondary" className="border border-border bg-accent text-foreground/80">
              <FileText className="mr-1 h-3.5 w-3.5" />
              OCR or PDF text
            </Badge>
          </div>
        </div>

        <div className="space-y-4 rounded-3xl border border-border bg-muted p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-foreground">Offer lanes</p>
              <p className="text-sm text-muted-foreground">
                Capture each vendor option exactly as offered so publication can choose from normalized lanes later.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              className="border-border bg-accent"
              onClick={() => setOffers((current) => [...current, createOfferDraft(current.length)])}
              disabled={formDisabled}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add lane
            </Button>
          </div>

          <div className="grid gap-4">
            {offers.map((offer, index) => (
              <div key={offer.id} className="rounded-2xl border border-border bg-accent p-4">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <p className="font-medium text-foreground">Offer lane {index + 1}</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => removeOffer(offer.id)}
                    disabled={formDisabled || offers.length === 1}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Remove
                  </Button>
                </div>

                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div className="space-y-2 xl:col-span-2">
                    <Label>Lane label</Label>
                    <Input
                      className="border-border bg-muted"
                      value={offer.laneLabel}
                      disabled={formDisabled}
                      onChange={(event) => updateOffer(offer.id, { laneLabel: event.target.value })}
                      placeholder="North America / Economy"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Total price (USD)</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      className="border-border bg-muted"
                      value={offer.totalPriceUsd}
                      disabled={formDisabled}
                      onChange={(event) => updateOffer(offer.id, { totalPriceUsd: event.target.value })}
                      placeholder="1250.00"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Lead time (days)</Label>
                    <Input
                      type="number"
                      min="0"
                      step="1"
                      className="border-border bg-muted"
                      value={offer.leadTimeBusinessDays}
                      disabled={formDisabled}
                      onChange={(event) => updateOffer(offer.id, { leadTimeBusinessDays: event.target.value })}
                      placeholder="10"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Unit price (USD)</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      className="border-border bg-muted"
                      value={offer.unitPriceUsd}
                      disabled={formDisabled}
                      onChange={(event) => updateOffer(offer.id, { unitPriceUsd: event.target.value })}
                      placeholder="125.00"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Quote reference</Label>
                    <Input
                      className="border-border bg-muted"
                      value={offer.quoteRef}
                      disabled={formDisabled}
                      onChange={(event) => updateOffer(offer.id, { quoteRef: event.target.value })}
                      placeholder="Q-10459"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Quote date</Label>
                    <Input
                      type="date"
                      className="border-border bg-muted"
                      value={offer.quoteDateIso}
                      disabled={formDisabled}
                      onChange={(event) => updateOffer(offer.id, { quoteDateIso: event.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Sourcing</Label>
                    <Input
                      className="border-border bg-muted"
                      value={offer.sourcing}
                      disabled={formDisabled}
                      onChange={(event) => updateOffer(offer.id, { sourcing: event.target.value })}
                      placeholder="Domestic"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Tier</Label>
                    <Input
                      className="border-border bg-muted"
                      value={offer.tier}
                      disabled={formDisabled}
                      onChange={(event) => updateOffer(offer.id, { tier: event.target.value })}
                      placeholder="Economy"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Process</Label>
                    <Input
                      className="border-border bg-muted"
                      value={offer.process}
                      disabled={formDisabled}
                      onChange={(event) => updateOffer(offer.id, { process: event.target.value })}
                      placeholder="CNC Milling"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Material</Label>
                    <Input
                      className="border-border bg-muted"
                      value={offer.material}
                      disabled={formDisabled}
                      onChange={(event) => updateOffer(offer.id, { material: event.target.value })}
                      placeholder="6061-T6 Aluminum"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Finish</Label>
                    <Input
                      className="border-border bg-muted"
                      value={offer.finish}
                      disabled={formDisabled}
                      onChange={(event) => updateOffer(offer.id, { finish: event.target.value })}
                      placeholder="Black anodize"
                    />
                  </div>
                  <div className="space-y-2 xl:col-span-4">
                    <Label>Offer notes</Label>
                    <Textarea
                      className="min-h-24 border-border bg-muted"
                      value={offer.notes}
                      disabled={formDisabled}
                      onChange={(event) => updateOffer(offer.id, { notes: event.target.value })}
                      placeholder="Optional notes, thread assumptions, or exceptions."
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <Button
          type="button"
          className="w-full rounded-full"
          onClick={() => submitMutation.mutate()}
          disabled={
            formDisabled ||
            !selectedPartId ||
            Boolean(completionTarget && !completionReason.trim()) ||
            submitMutation.isPending
          }
        >
          {submitMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <UploadCloud className="mr-2 h-4 w-4" />
          )}
          {completionTarget ? "Complete exact request" : "Record manual quote"}
        </Button>
      </CardContent>
    </Card>
  );
}
