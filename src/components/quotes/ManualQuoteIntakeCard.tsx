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
  recordManualVendorQuote,
  uploadManualQuoteEvidence,
} from "@/features/quotes/api";
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

type ManualQuoteIntakeCardProps = {
  jobId: string;
  parts: PartAggregate[];
  disabled?: boolean;
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

export function ManualQuoteIntakeCard({
  jobId,
  parts,
  disabled = false,
}: ManualQuoteIntakeCardProps) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedPartId, setSelectedPartId] = useState(parts[0]?.id ?? "");
  const [vendor, setVendor] = useState<VendorName>("xometry");
  const [status, setStatus] = useState<VendorStatus>("official_quote_received");
  const [quoteUrl, setQuoteUrl] = useState("");
  const [summaryNote, setSummaryNote] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([]);
  const [offers, setOffers] = useState<OfferDraft[]>([createOfferDraft(0)]);

  useEffect(() => {
    if (!parts.length) {
      setSelectedPartId("");
      return;
    }

    const selectionStillExists = parts.some((part) => part.id === selectedPartId);

    if (!selectionStillExists) {
      setSelectedPartId(parts[0].id);
    }
  }, [parts, selectedPartId]);

  const selectedPart = useMemo(
    () => parts.find((part) => part.id === selectedPartId) ?? null,
    [parts, selectedPartId],
  );

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPartId) {
        throw new Error("Select a part before recording a quote.");
      }

      const offerPayloads = buildOfferPayloads(offers);
      const artifacts =
        evidenceFiles.length > 0
          ? await uploadManualQuoteEvidence(jobId, evidenceFiles)
          : [];

      return recordManualVendorQuote({
        jobId,
        partId: selectedPartId,
        vendor,
        status,
        quoteUrl: quoteUrl.trim() || undefined,
        summaryNote: summaryNote.trim() || undefined,
        sourceText: sourceText.trim() || undefined,
        offers: offerPayloads,
        artifacts,
      });
    },
    onSuccess: async (result) => {
      toast.success(
        result.createdNewQuoteRun
          ? "Manual quote saved and a new quote run was created."
          : "Manual quote saved to the current quote run.",
      );

      setQuoteUrl("");
      setSummaryNote("");
      setSourceText("");
      setEvidenceFiles([]);
      setOffers([createOfferDraft(0)]);

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }

      await queryClient.invalidateQueries({ queryKey: ["job", jobId] });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to record the manual quote.");
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
    <Card className="border-white/10 bg-white/5">
      <CardHeader>
        <CardTitle>Manual quote intake</CardTitle>
        <p className="text-sm text-white/55">
          Record a quote from pasted email text, screenshot/PDF evidence, or a forwarded manual supplier reply.
          This writes normalized offer lanes directly into the compare view without using browser automation.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2 md:col-span-1">
            <Label>Part</Label>
            <Select value={selectedPartId} onValueChange={setSelectedPartId} disabled={disabled || !parts.length}>
              <SelectTrigger className="border-white/10 bg-black/20 text-white">
                <SelectValue placeholder="Select part" />
              </SelectTrigger>
              <SelectContent>
                {parts.map((part) => (
                  <SelectItem key={part.id} value={part.id}>
                    {part.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 md:col-span-1">
            <Label>Vendor</Label>
            <Select value={vendor} onValueChange={(value) => setVendor(value as VendorName)} disabled={disabled}>
              <SelectTrigger className="border-white/10 bg-black/20 text-white">
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
            <Select value={status} onValueChange={(value) => setStatus(value as VendorStatus)} disabled={disabled}>
              <SelectTrigger className="border-white/10 bg-black/20 text-white">
                <SelectValue placeholder="Select status" />
              </SelectTrigger>
              <SelectContent>
                {MANUAL_QUOTE_STATUSES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {formatStatusLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {selectedPart ? (
          <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm text-white/60">
            <p className="font-medium text-white">Target part</p>
            <p className="mt-1">
              {selectedPart.name}
              {selectedPart.approvedRequirement?.part_number
                ? ` • ${selectedPart.approvedRequirement.part_number}`
                : ""}
              {selectedPart.approvedRequirement?.revision
                ? ` • Rev ${selectedPart.approvedRequirement.revision}`
                : ""}
            </p>
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Quote URL</Label>
            <Input
              className="border-white/10 bg-black/20"
              value={quoteUrl}
              disabled={disabled}
              onChange={(event) => setQuoteUrl(event.target.value)}
              placeholder="https://vendor.example/quote/123"
            />
          </div>
          <div className="space-y-2">
            <Label>Internal note</Label>
            <Input
              className="border-white/10 bg-black/20"
              value={summaryNote}
              disabled={disabled}
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
              className="border-white/10 bg-white/5"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
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
          <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 p-4 text-sm text-white/50">
            Supported intake evidence: PDF quotes, screenshots, photos, email exports, and OCR text files.
          </div>
          {evidenceFiles.length > 0 ? (
            <div className="grid gap-2">
              {evidenceFiles.map((file, index) => (
                <div
                  key={`${file.name}-${index}`}
                  className="flex items-center justify-between rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-white">{file.name}</p>
                    <p className="text-xs text-white/45">{(file.size / (1024 * 1024)).toFixed(2)} MB</p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-white/55 hover:text-white"
                    onClick={() => setEvidenceFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))}
                    disabled={disabled}
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
            className="min-h-32 border-white/10 bg-black/20"
            value={sourceText}
            disabled={disabled}
            onChange={(event) => setSourceText(event.target.value)}
            placeholder="Paste the vendor email, OCR output, or quote body here."
          />
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
              <Mail className="mr-1 h-3.5 w-3.5" />
              Email copy/paste
            </Badge>
            <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
              <FileText className="mr-1 h-3.5 w-3.5" />
              OCR or PDF text
            </Badge>
          </div>
        </div>

        <div className="space-y-4 rounded-3xl border border-white/8 bg-black/20 p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-white">Offer lanes</p>
              <p className="text-sm text-white/50">
                Capture each vendor option exactly as offered so publication can choose from normalized lanes later.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              className="border-white/10 bg-white/5"
              onClick={() => setOffers((current) => [...current, createOfferDraft(current.length)])}
              disabled={disabled}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add lane
            </Button>
          </div>

          <div className="grid gap-4">
            {offers.map((offer, index) => (
              <div key={offer.id} className="rounded-2xl border border-white/8 bg-white/5 p-4">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <p className="font-medium text-white">Offer lane {index + 1}</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-white/55 hover:text-white"
                    onClick={() => removeOffer(offer.id)}
                    disabled={disabled || offers.length === 1}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Remove
                  </Button>
                </div>

                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div className="space-y-2 xl:col-span-2">
                    <Label>Lane label</Label>
                    <Input
                      className="border-white/10 bg-black/20"
                      value={offer.laneLabel}
                      disabled={disabled}
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
                      className="border-white/10 bg-black/20"
                      value={offer.totalPriceUsd}
                      disabled={disabled}
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
                      className="border-white/10 bg-black/20"
                      value={offer.leadTimeBusinessDays}
                      disabled={disabled}
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
                      className="border-white/10 bg-black/20"
                      value={offer.unitPriceUsd}
                      disabled={disabled}
                      onChange={(event) => updateOffer(offer.id, { unitPriceUsd: event.target.value })}
                      placeholder="125.00"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Quote reference</Label>
                    <Input
                      className="border-white/10 bg-black/20"
                      value={offer.quoteRef}
                      disabled={disabled}
                      onChange={(event) => updateOffer(offer.id, { quoteRef: event.target.value })}
                      placeholder="Q-10459"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Quote date</Label>
                    <Input
                      type="date"
                      className="border-white/10 bg-black/20"
                      value={offer.quoteDateIso}
                      disabled={disabled}
                      onChange={(event) => updateOffer(offer.id, { quoteDateIso: event.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Sourcing</Label>
                    <Input
                      className="border-white/10 bg-black/20"
                      value={offer.sourcing}
                      disabled={disabled}
                      onChange={(event) => updateOffer(offer.id, { sourcing: event.target.value })}
                      placeholder="Domestic"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Tier</Label>
                    <Input
                      className="border-white/10 bg-black/20"
                      value={offer.tier}
                      disabled={disabled}
                      onChange={(event) => updateOffer(offer.id, { tier: event.target.value })}
                      placeholder="Economy"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Process</Label>
                    <Input
                      className="border-white/10 bg-black/20"
                      value={offer.process}
                      disabled={disabled}
                      onChange={(event) => updateOffer(offer.id, { process: event.target.value })}
                      placeholder="CNC Milling"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Material</Label>
                    <Input
                      className="border-white/10 bg-black/20"
                      value={offer.material}
                      disabled={disabled}
                      onChange={(event) => updateOffer(offer.id, { material: event.target.value })}
                      placeholder="6061-T6 Aluminum"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Finish</Label>
                    <Input
                      className="border-white/10 bg-black/20"
                      value={offer.finish}
                      disabled={disabled}
                      onChange={(event) => updateOffer(offer.id, { finish: event.target.value })}
                      placeholder="Black anodize"
                    />
                  </div>
                  <div className="space-y-2 xl:col-span-4">
                    <Label>Offer notes</Label>
                    <Textarea
                      className="min-h-24 border-white/10 bg-black/20"
                      value={offer.notes}
                      disabled={disabled}
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
          disabled={disabled || !selectedPartId || submitMutation.isPending}
        >
          {submitMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <UploadCloud className="mr-2 h-4 w-4" />
          )}
          Record manual quote
        </Button>
      </CardContent>
    </Card>
  );
}
