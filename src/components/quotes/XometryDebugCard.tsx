import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, PlayCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { enqueueDebugVendorQuote, fetchWorkerReadiness } from "@/features/quotes/api/internal-review";
import type {
  PartAggregate,
  QuoteRunAggregate,
  VendorQuoteAggregate,
  WorkerReadinessSnapshot,
  WorkQueueRecord,
} from "@/features/quotes/types";
import { formatStatusLabel, formatVendorName } from "@/features/quotes/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

type XometryDebugCardProps = {
  jobId: string;
  latestQuoteRun: QuoteRunAggregate | null;
  parts: PartAggregate[];
  workQueue: WorkQueueRecord[];
  disabled?: boolean;
};

type DebugTone = "green" | "sky" | "amber" | "red";

type DebugState = {
  label: string;
  tone: DebugTone;
  description: string;
};

type RawPayload = Record<string, unknown>;

function asObject(value: unknown): RawPayload {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RawPayload)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "Not available";
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString();
}

function buildDebugPartOptions(parts: PartAggregate[]) {
  return parts
    .filter(
      (part) =>
        Boolean(part.approvedRequirement) &&
        (part.approvedRequirement?.applicable_vendors ?? []).includes("xometry"),
    )
    .map((part) => ({
      id: part.id,
      label: part.name,
    }));
}

function getMatchingQueueTask(
  workQueue: WorkQueueRecord[],
  input: {
    quoteRunId: string | null;
    partId: string | null;
    requestedQuantity: number | null;
  },
) {
  return workQueue.find((task) => {
    if (
      task.task_type !== "run_vendor_quote" ||
      task.quote_run_id !== input.quoteRunId ||
      task.part_id !== input.partId
    ) {
      return false;
    }

    const payload = asObject(task.payload);

    return (
      payload.vendor === "xometry" &&
      Number(payload.requestedQuantity ?? 0) === input.requestedQuantity
    );
  });
}

function deriveDebugState(input: {
  workerReadiness: WorkerReadinessSnapshot | undefined;
  latestQuoteRun: QuoteRunAggregate | null;
  selectedQuote: VendorQuoteAggregate | null;
  selectedPartHasXometry: boolean;
  selectedQueueTask: WorkQueueRecord | undefined;
}): DebugState {
  if (!input.latestQuoteRun) {
    return {
      label: "Blocked: start quote run",
      tone: "amber",
      description: "Create a normal quote run first so the Xometry lane exists.",
    };
  }

  if (!input.selectedPartHasXometry) {
    return {
      label: "Blocked: missing Xometry requirement mapping",
      tone: "amber",
      description: "The selected part is not currently approved for Xometry.",
    };
  }

  if (!input.selectedQuote) {
    return {
      label: "Blocked: missing quote lane",
      tone: "amber",
      description: "No Xometry lane exists for the selected part and quantity in this quote run.",
    };
  }

  if (input.workerReadiness && input.workerReadiness.ready === false) {
    return {
      label: "Blocked: worker not ready",
      tone: "red",
      description:
        input.workerReadiness.readinessIssues[0] ??
        input.workerReadiness.message ??
        "The worker readiness probe reported that Xometry is not ready.",
    };
  }

  if (input.selectedQueueTask?.status === "queued") {
    const payload = asObject(input.selectedQuote.raw_payload);
    return {
      label: payload.retryScheduledFor ? "Retry scheduled" : "Queued",
      tone: "sky",
      description: payload.retryScheduledFor
        ? `Retry scheduled for ${formatDateTime(String(payload.retryScheduledFor))}.`
        : "A worker task is queued for this Xometry lane.",
    };
  }

  if (input.selectedQueueTask?.status === "running" || input.selectedQuote.status === "running") {
    return {
      label: "Running",
      tone: "sky",
      description: "The Xometry worker is processing this lane now.",
    };
  }

  if (input.selectedQuote.status === "manual_review_pending") {
    return {
      label: "Manual review",
      tone: "amber",
      description: "Xometry accepted the submission but routed it to manual review.",
    };
  }

  if (input.selectedQuote.status === "failed") {
    return {
      label: "Failed",
      tone: "red",
      description: "The last Xometry attempt failed. Expand diagnostics for details.",
    };
  }

  return {
    label: "Ready",
    tone: "green",
    description: "This Xometry lane is ready to be submitted manually.",
  };
}

function stateBadgeClass(tone: DebugTone) {
  switch (tone) {
    case "green":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-300";
    case "sky":
      return "border-sky-500/20 bg-sky-500/10 text-sky-200";
    case "amber":
      return "border-amber-500/20 bg-amber-500/10 text-amber-200";
    case "red":
    default:
      return "border-rose-500/20 bg-rose-500/10 text-rose-200";
  }
}

export function XometryDebugCard({
  jobId,
  latestQuoteRun,
  parts,
  workQueue,
  disabled = false,
}: XometryDebugCardProps) {
  const queryClient = useQueryClient();
  const partOptions = useMemo(() => buildDebugPartOptions(parts), [parts]);
  const [selectedPartId, setSelectedPartId] = useState(partOptions[0]?.id ?? "");
  const [selectedRequestedQuantity, setSelectedRequestedQuantity] = useState<string>("");

  useEffect(() => {
    if (!partOptions.length) {
      setSelectedPartId("");
      return;
    }

    if (!partOptions.some((option) => option.id === selectedPartId)) {
      setSelectedPartId(partOptions[0].id);
    }
  }, [partOptions, selectedPartId]);

  const selectedPart = useMemo(
    () => parts.find((part) => part.id === selectedPartId) ?? null,
    [parts, selectedPartId],
  );

  const selectedPartXometryQuotes = useMemo(
    () =>
      (latestQuoteRun?.vendorQuotes ?? []).filter(
        (quote) => quote.part_id === selectedPartId && quote.vendor === "xometry",
      ),
    [latestQuoteRun?.vendorQuotes, selectedPartId],
  );

  const quantityOptions = useMemo(
    () =>
      [...selectedPartXometryQuotes]
        .map((quote) => quote.requested_quantity)
        .sort((left, right) => left - right)
        .map(String),
    [selectedPartXometryQuotes],
  );

  useEffect(() => {
    if (!quantityOptions.length) {
      setSelectedRequestedQuantity("");
      return;
    }

    if (!quantityOptions.includes(selectedRequestedQuantity)) {
      setSelectedRequestedQuantity(quantityOptions[0]);
    }
  }, [quantityOptions, selectedRequestedQuantity]);

  const selectedQuote = useMemo(
    () =>
      selectedPartXometryQuotes.find(
        (quote) => String(quote.requested_quantity) === selectedRequestedQuantity,
      ) ?? null,
    [selectedPartXometryQuotes, selectedRequestedQuantity],
  );

  const selectedQueueTask = useMemo(
    () =>
      getMatchingQueueTask(workQueue, {
        quoteRunId: latestQuoteRun?.id ?? null,
        partId: selectedPartId || null,
        requestedQuantity: selectedRequestedQuantity ? Number(selectedRequestedQuantity) : null,
      }),
    [latestQuoteRun?.id, selectedPartId, selectedRequestedQuantity, workQueue],
  );

  const readinessQuery = useQuery({
    queryKey: ["worker-readiness", "xometry-debug"],
    queryFn: () => fetchWorkerReadiness(),
    refetchInterval: 15000,
  });

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!latestQuoteRun?.id || !selectedPartId || !selectedRequestedQuantity) {
        throw new Error("Select a part and quantity lane before submitting to Xometry.");
      }

      return enqueueDebugVendorQuote({
        jobId,
        quoteRunId: latestQuoteRun.id,
        partId: selectedPartId,
        vendor: "xometry",
        requestedQuantity: Number(selectedRequestedQuantity),
      });
    },
    onSuccess: async () => {
      toast.success("Queued the selected Xometry lane for debugging.");
      await queryClient.invalidateQueries({ queryKey: ["job", jobId] });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Unable to queue the Xometry debug lane.");
    },
  });

  const selectedPartHasXometry = Boolean(
    selectedPart?.approvedRequirement?.applicable_vendors?.includes("xometry"),
  );
  const debugState = deriveDebugState({
    workerReadiness: readinessQuery.data,
    latestQuoteRun,
    selectedQuote,
    selectedPartHasXometry,
    selectedQueueTask,
  });
  const rawPayload = asObject(selectedQuote?.raw_payload);
  const artifacts = selectedQuote?.artifacts ?? [];
  const notes = asStringArray(selectedQuote?.notes);
  const screenshotArtifacts = artifacts.filter((artifact) => artifact.artifact_type === "screenshot");
  const htmlArtifacts = artifacts.filter((artifact) => artifact.artifact_type === "html_snapshot");
  const traceArtifacts = artifacts.filter((artifact) => artifact.artifact_type === "trace");
  const diagnosticFields: Array<{ label: string; value: string }> = [
    { label: "Failure code", value: String(rawPayload.failureCode ?? "None") },
    { label: "Detected flow", value: String(rawPayload.detectedFlow ?? "Unknown") },
    { label: "Selected material", value: String(rawPayload.selectedMaterial ?? "Not selected") },
    { label: "Selected finish", value: String(rawPayload.selectedFinish ?? "Not selected") },
    { label: "Price source", value: String(rawPayload.priceSource ?? "Unknown") },
    { label: "Lead time source", value: String(rawPayload.leadTimeSource ?? "Unknown") },
    { label: "URL", value: String(rawPayload.url ?? selectedQuote?.quote_url ?? "Not available") },
    {
      label: "Attempted selectors",
      value: Array.isArray(rawPayload.attemptedSelectors) ? rawPayload.attemptedSelectors.join(", ") : "None",
    },
  ];
  const artifactGroups: Array<{ label: string; items: typeof artifacts }> = [
    { label: "Screenshots", items: screenshotArtifacts },
    { label: "HTML snapshots", items: htmlArtifacts },
    { label: "Trace", items: traceArtifacts },
  ];
  const submitBlocked =
    disabled ||
    !latestQuoteRun ||
    !selectedQuote ||
    debugState.label === "Blocked: worker not ready" ||
    debugState.label === "Blocked: start quote run" ||
    debugState.label === "Blocked: missing Xometry requirement mapping" ||
    debugState.label === "Blocked: missing quote lane" ||
    selectedQueueTask?.status === "queued" ||
    selectedQueueTask?.status === "running" ||
    submitMutation.isPending;

  const handleDownloadArtifact = async (artifact: NonNullable<typeof selectedQuote>["artifacts"][number]) => {
    try {
      const { data, error } = await supabase.storage
        .from(artifact.storage_bucket)
        .download(artifact.storage_path);

      if (error || !data) {
        throw error ?? new Error(`Unable to download ${artifact.storage_path}.`);
      }

      const url = URL.createObjectURL(data);
      const link = document.createElement("a");
      link.href = url;
      link.download = artifact.storage_path.split("/").pop() || "artifact";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Artifact download failed.");
    }
  };

  return (
    <Card className="border-white/10 bg-white/5" data-testid="xometry-debug-card">
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>Xometry Debug</CardTitle>
            <p className="mt-2 text-sm text-white/55">
              Submit one existing Xometry lane to the worker and inspect queue state, retries, and raw diagnostics.
            </p>
          </div>
          <Badge className={cn("border", stateBadgeClass(debugState.tone))}>{debugState.label}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Part</Label>
            <Select value={selectedPartId} onValueChange={setSelectedPartId}>
              <SelectTrigger className="border-white/10 bg-black/20">
                <SelectValue placeholder="Select part" />
              </SelectTrigger>
              <SelectContent>
                {partOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Requested quantity lane</Label>
            <Select value={selectedRequestedQuantity} onValueChange={setSelectedRequestedQuantity}>
              <SelectTrigger className="border-white/10 bg-black/20">
                <SelectValue placeholder="Select quantity" />
              </SelectTrigger>
              <SelectContent>
                {quantityOptions.map((quantity) => (
                  <SelectItem key={quantity} value={quantity}>
                    Qty {quantity}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm">
          <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/75">
            Run {latestQuoteRun?.id ?? "Not started"}
          </Badge>
          <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/75">
            {selectedQuote ? formatVendorName(selectedQuote.vendor) : "Xometry"}
          </Badge>
          <span className="text-white/55">{debugState.description}</span>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/40">Worker readiness</p>
            <div className="mt-2 flex items-center gap-2">
              {readinessQuery.isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin text-white/55" />
              ) : readinessQuery.data?.ready ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-300" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-amber-300" />
              )}
              <p className="text-sm font-medium">
                {readinessQuery.data?.ready === true
                  ? "Ready"
                  : readinessQuery.data?.ready === false
                    ? "Blocked"
                    : "Unavailable"}
              </p>
            </div>
            <p className="mt-2 text-xs text-white/45">
              {readinessQuery.data?.readinessIssues[0] ??
                readinessQuery.data?.message ??
                "Readiness probe not configured."}
            </p>
          </div>
          <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/40">Queue task</p>
            <p className="mt-2 text-sm font-medium">
              {selectedQueueTask ? formatStatusLabel(selectedQueueTask.status) : "Idle"}
            </p>
            <p className="mt-2 text-xs text-white/45">
              Updated {formatDateTime(selectedQueueTask?.updated_at ?? selectedQueueTask?.created_at)}
            </p>
          </div>
          <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/40">Vendor result</p>
            <p className="mt-2 text-sm font-medium">
              {selectedQuote ? formatStatusLabel(selectedQuote.status) : "Missing"}
            </p>
            <p className="mt-2 text-xs text-white/45">
              Retry count {Number(rawPayload.retryCount ?? 0)}
            </p>
          </div>
          <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-white/40">Next retry</p>
            <p className="mt-2 text-sm font-medium">
              {formatDateTime(
                typeof rawPayload.retryScheduledFor === "string"
                  ? rawPayload.retryScheduledFor
                  : null,
              )}
            </p>
            <p className="mt-2 text-xs text-white/45">
              Last quote update {formatDateTime(selectedQuote?.updated_at)}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button
            className="rounded-full"
            onClick={() => submitMutation.mutate()}
            disabled={submitBlocked}
          >
            {submitMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <PlayCircle className="mr-2 h-4 w-4" />
            )}
            Quote in Xometry
          </Button>
          <Button
            variant="outline"
            className="rounded-full border-white/10 bg-white/5"
            onClick={() => {
              void Promise.all([
                queryClient.invalidateQueries({ queryKey: ["job", jobId] }),
                readinessQuery.refetch(),
              ]);
            }}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh debug state
          </Button>
        </div>

        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="w-full justify-between rounded-2xl border border-white/8 bg-black/20">
              Expanded diagnostics
              <ChevronDown className="h-4 w-4" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pt-4">
            <div className="grid gap-3 md:grid-cols-2">
              {diagnosticFields.map(({ label, value }) => (
                <div key={label} className="rounded-2xl border border-white/8 bg-black/20 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-white/40">{label}</p>
                  <p className="mt-2 break-words text-sm text-white/80">{value}</p>
                </div>
              ))}
            </div>

            <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-white/40">Body excerpt</p>
              <pre className="mt-3 whitespace-pre-wrap break-words text-xs text-white/70">
                {typeof rawPayload.bodyExcerpt === "string" && rawPayload.bodyExcerpt.trim().length > 0
                  ? rawPayload.bodyExcerpt
                  : "No body excerpt captured."}
              </pre>
            </div>

            <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-white/40">Notes</p>
              <div className="mt-3 space-y-2 text-sm text-white/70">
                {notes.length > 0 ? (
                  notes.map((note) => <p key={note}>{note}</p>)
                ) : (
                  <p>No notes recorded.</p>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
              <div className="flex items-center justify-between gap-4">
                <p className="text-xs uppercase tracking-[0.2em] text-white/40">Artifacts</p>
                <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                  {artifacts.length} files
                </Badge>
              </div>
              <Separator className="my-4 bg-white/10" />
              {artifactGroups.map(({ label, items }) => (
                <div key={label} className="mb-4 last:mb-0">
                  <p className="text-sm font-medium text-white">{label}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {items.length > 0 ? (
                      items.map((artifact) => (
                        <Button
                          key={artifact.id}
                          type="button"
                          variant="outline"
                          className="border-white/10 bg-white/5"
                          onClick={() => void handleDownloadArtifact(artifact)}
                        >
                          {artifact.metadata && typeof artifact.metadata === "object" && !Array.isArray(artifact.metadata)
                            ? String((artifact.metadata as Record<string, unknown>).label ?? artifact.storage_path.split("/").pop() ?? artifact.id)
                            : artifact.storage_path.split("/").pop() ?? artifact.id}
                        </Button>
                      ))
                    ) : (
                      <p className="text-sm text-white/45">None captured.</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}
