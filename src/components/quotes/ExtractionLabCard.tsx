import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Eye,
  ImageIcon,
  Loader2,
  ScanSearch,
} from "lucide-react";
import { toast } from "sonner";
import { fetchWorkerReadiness, requestDebugExtraction } from "@/features/quotes/api";
import type {
  DebugExtractionRunRecord,
  DrawingPreviewAssetRecord,
  PartAggregate,
} from "@/features/quotes/types";
import {
  formatStatusLabel,
  normalizeDebugExtractionRun,
  normalizeDrawingExtraction,
} from "@/features/quotes/utils";
import { downloadStoredFileBlob } from "@/lib/stored-file";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type ExtractionLabCardProps = {
  jobId: string;
  parts: PartAggregate[];
  debugExtractionRuns: DebugExtractionRunRecord[];
  drawingPreviewAssets: DrawingPreviewAssetRecord[];
  disabled?: boolean;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
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

function summaryBadgeClass(status: string) {
  switch (status) {
    case "completed":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-300";
    case "running":
      return "border-sky-500/20 bg-sky-500/10 text-sky-200";
    case "queued":
      return "border-amber-500/20 bg-amber-500/10 text-amber-200";
    case "failed":
      return "border-rose-500/20 bg-rose-500/10 text-rose-200";
    default:
      return "border-white/10 bg-white/5 text-white/70";
  }
}

function ExtractionFieldTable({
  title,
  sourceLabel,
  workerBuildVersion,
  extractorVersion,
  requestedModel,
  effectiveModel,
  extraction,
  reviewFields,
  warnings,
}: {
  title: string;
  sourceLabel: string;
  workerBuildVersion: string | null;
  extractorVersion: string | null;
  requestedModel?: string | null;
  effectiveModel?: string | null;
  extraction: ReturnType<typeof normalizeDrawingExtraction> | null;
  reviewFields: string[];
  warnings: string[];
}) {
  const rows = extraction
    ? [
        ["Part number", extraction.rawFields.partNumber.raw ?? extraction.partNumber ?? "Not found"],
        ["Revision", extraction.rawFields.revision.raw ?? extraction.revision ?? "Not found"],
        ["Description", extraction.rawFields.description.raw ?? extraction.description ?? "Not found"],
        ["Material", extraction.material.raw ?? extraction.material.normalized ?? "Not found"],
        ["Finish", extraction.rawFields.finish.raw ?? extraction.finish.raw ?? "Not found"],
        ["Quote description", extraction.quoteDescription ?? "Not set"],
        ["Quote finish", extraction.quoteFinish ?? "Not set"],
      ]
    : [];

  return (
    <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-white">{title}</p>
          <p className="mt-1 text-xs text-white/50">{sourceLabel}</p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
            Build: {workerBuildVersion ?? "Unknown"}
          </Badge>
          <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
            Extractor: {extractorVersion ?? "Unknown"}
          </Badge>
          {requestedModel ? (
            <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
              Requested: {requestedModel}
            </Badge>
          ) : null}
          {effectiveModel ? (
            <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
              Effective: {effectiveModel}
            </Badge>
          ) : null}
        </div>
      </div>

      {rows.length > 0 ? (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="rounded-xl border border-white/8 bg-white/5 p-3">
              <p className="text-xs uppercase tracking-[0.2em] text-white/40">{label}</p>
              <p className="mt-2 text-sm text-white">{value}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-sm text-white/50">No extracted payload is available yet.</p>
      )}

      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        {reviewFields.length > 0 ? (
          <Badge className="border border-amber-500/20 bg-amber-500/10 text-amber-200">
            Review fields: {reviewFields.join(", ")}
          </Badge>
        ) : (
          <Badge className="border border-emerald-500/20 bg-emerald-500/10 text-emerald-300">
            No review fields
          </Badge>
        )}
        <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
          Warnings: {warnings.length}
        </Badge>
      </div>

      {warnings.length > 0 ? (
        <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-100">
          {warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ExtractionLabCard({
  jobId,
  parts,
  debugExtractionRuns,
  drawingPreviewAssets,
  disabled = false,
}: ExtractionLabCardProps) {
  const queryClient = useQueryClient();
  const [selectedModelsByPart, setSelectedModelsByPart] = useState<Record<string, string>>({});
  const [userSelectedModelsByPart, setUserSelectedModelsByPart] = useState<Record<string, true>>({});
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [isPreviewImageLoading, setIsPreviewImageLoading] = useState(false);

  const workerReadinessQuery = useQuery({
    queryKey: ["worker-readiness"],
    queryFn: () => fetchWorkerReadiness(),
  });

  const modelOptions = useMemo(() => {
    const options = workerReadinessQuery.data?.drawingExtractionDebugAllowedModels ?? [];

    if (options.length > 0) {
      return options;
    }

    return [workerReadinessQuery.data?.drawingExtractionModel ?? "gpt-5.4"];
  }, [
    workerReadinessQuery.data?.drawingExtractionDebugAllowedModels,
    workerReadinessQuery.data?.drawingExtractionModel,
  ]);

  const latestRunByPartId = useMemo(() => {
    const next = new Map<string, DebugExtractionRunRecord>();

    debugExtractionRuns.forEach((run) => {
      if (!next.has(run.part_id)) {
        next.set(run.part_id, run);
      }
    });

    return next;
  }, [debugExtractionRuns]);

  const activeRun = activeRunId
    ? debugExtractionRuns.find((run) => run.id === activeRunId) ?? null
    : null;
  const activePart = activeRun
    ? parts.find((part) => part.id === activeRun.part_id) ?? null
    : null;
  const activePartPreviewAsset =
    activePart
      ? [...drawingPreviewAssets]
          .filter((asset) => asset.part_id === activePart.id && asset.kind === "page")
          .sort((left, right) => left.page_number - right.page_number)[0] ?? null
      : null;
  const normalizedCanonicalExtraction = activePart
    ? normalizeDrawingExtraction(activePart.extraction, activePart.id)
    : null;
  const normalizedDebugRun = activeRun && activePart
    ? normalizeDebugExtractionRun(activeRun, activePart.id)
    : { summary: null, extraction: null };
  const debugResultObject = normalizedDebugRun.summary ? asObject(normalizedDebugRun.summary.result) : {};
  const debugWarnings = asStringArray(debugResultObject.warnings);
  const debugReviewFields = asStringArray(asObject(debugResultObject.extraction).reviewFields);

  useEffect(() => {
    if (!activeRun || !activePartPreviewAsset) {
      setPreviewImageUrl((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }
        return null;
      });
      setIsPreviewImageLoading(false);
      return;
    }

    let isCancelled = false;
    let objectUrl: string | null = null;
    setIsPreviewImageLoading(true);

    void downloadStoredFileBlob(activePartPreviewAsset)
      .then((blob) => {
        if (isCancelled) {
          return;
        }

        objectUrl = URL.createObjectURL(blob);
        setPreviewImageUrl((current) => {
          if (current) {
            URL.revokeObjectURL(current);
          }
          return objectUrl;
        });
      })
      .catch(() => {
        if (!isCancelled) {
          setPreviewImageUrl((current) => {
            if (current) {
              URL.revokeObjectURL(current);
            }
            return null;
          });
        }
      })
      .finally(() => {
        if (!isCancelled) {
          setIsPreviewImageLoading(false);
        }
      });

    return () => {
      isCancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [activePartPreviewAsset, activeRun]);

  useEffect(() => {
    setSelectedModelsByPart((current) => {
      const next = { ...current };

      parts.forEach((part) => {
        const hasUserSelection = Boolean(userSelectedModelsByPart[part.id]);

        if (
          !next[part.id] ||
          !modelOptions.includes(next[part.id]) ||
          (!hasUserSelection && next[part.id] !== (modelOptions[0] ?? "gpt-5.4"))
        ) {
          next[part.id] = modelOptions[0] ?? "gpt-5.4";
        }
      });

      return next;
    });
  }, [modelOptions, parts, userSelectedModelsByPart]);

  const requestDebugExtractionMutation = useMutation({
    mutationFn: async (input: { partId: string; model: string }) =>
      requestDebugExtraction(input.partId, input.model),
    onSuccess: async (runId, variables) => {
      setActiveRunId(runId);
      toast.success(`Debug extraction queued for ${variables.partId}.`);
      await queryClient.invalidateQueries({ queryKey: ["job", jobId] });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to queue debug extraction.");
    },
  });

  return (
    <>
      <Card className="border-white/10 bg-white/5">
        <CardHeader>
          <CardTitle>Extraction Lab</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-2xl border border-white/8 bg-black/20 p-4 text-sm text-white/60">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                Worker: {workerReadinessQuery.data?.workerName ?? "Unknown"}
              </Badge>
              <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                Build: {workerReadinessQuery.data?.workerBuildVersion ?? "Unknown"}
              </Badge>
              <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                Default model: {workerReadinessQuery.data?.drawingExtractionModel ?? "gpt-5.4"}
              </Badge>
            </div>
            <p className="mt-3 text-xs text-white/45">
              Preview-only debug runs use the worker queue and do not overwrite canonical extraction or approved requirements.
            </p>
            {workerReadinessQuery.data?.reachable === false ? (
              <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-100">
                {workerReadinessQuery.data.message ?? "Worker readiness probe is unavailable."}
              </div>
            ) : null}
          </div>

          {parts.map((part) => {
            const latestRun = latestRunByPartId.get(part.id) ?? null;
            const canonicalExtraction = normalizeDrawingExtraction(part.extraction, part.id);
            const selectedModel = selectedModelsByPart[part.id] ?? modelOptions[0] ?? "gpt-5.4";
            const isPendingForPart =
              requestDebugExtractionMutation.isPending &&
              requestDebugExtractionMutation.variables?.partId === part.id;

            return (
              <div key={part.id} className="rounded-2xl border border-white/8 bg-black/20 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-white">{part.name}</p>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                        Canonical extractor: {part.extraction?.extractor_version ?? "None"}
                      </Badge>
                      <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                        Canonical build: {canonicalExtraction.workerBuildVersion ?? "Unknown"}
                      </Badge>
                      <Badge className={summaryBadgeClass(latestRun?.status ?? "queued")}>
                        Latest debug run: {latestRun ? formatStatusLabel(latestRun.status) : "None"}
                      </Badge>
                    </div>
                  </div>

                  {latestRun ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="border-white/10 bg-white/5"
                      onClick={() => setActiveRunId(latestRun.id)}
                    >
                      <Eye className="mr-2 h-4 w-4" />
                      Inspect latest
                    </Button>
                  ) : null}
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                  <div className="space-y-2">
                    <Label htmlFor={`debug-model-${part.id}`}>Debug model</Label>
                    <Select
                      value={selectedModel}
                      onValueChange={(value) => {
                        setSelectedModelsByPart((current) => ({
                          ...current,
                          [part.id]: value,
                        }));
                        setUserSelectedModelsByPart((current) => ({
                          ...current,
                          [part.id]: true,
                        }));
                      }}
                    >
                      <SelectTrigger id={`debug-model-${part.id}`} className="border-white/10 bg-black/20">
                        <SelectValue placeholder="Select model" />
                      </SelectTrigger>
                      <SelectContent>
                        {modelOptions.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <Button
                    type="button"
                    className="rounded-full"
                    disabled={disabled || isPendingForPart}
                    onClick={() =>
                      requestDebugExtractionMutation.mutate({
                        partId: part.id,
                        model: selectedModel,
                      })
                    }
                  >
                    {isPendingForPart ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <ScanSearch className="mr-2 h-4 w-4" />
                    )}
                    Run debug extraction
                  </Button>
                </div>

                {latestRun ? (
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-white/55">
                    <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                      Requested: {latestRun.requested_model}
                    </Badge>
                    <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                      Effective: {latestRun.effective_model ?? "Pending"}
                    </Badge>
                    <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                      Debug build: {latestRun.worker_build_version ?? "Pending"}
                    </Badge>
                    <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                      Updated: {formatDateTime(latestRun.updated_at)}
                    </Badge>
                  </div>
                ) : null}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Dialog open={Boolean(activeRunId)} onOpenChange={(open) => !open && setActiveRunId(null)}>
        <DialogContent className="h-[88vh] w-[min(96vw,72rem)] max-w-[72rem] overflow-y-auto border-white/10 bg-[#1f1f1f] p-0 text-white">
          <DialogHeader className="border-b border-white/8 px-6 py-5">
            <DialogTitle>Debug extraction run</DialogTitle>
            <DialogDescription className="text-white/55">
              Inspect the preview-only extraction run alongside the canonical stored extraction.
            </DialogDescription>
          </DialogHeader>

          {activeRun && activePart ? (
            <div className="space-y-5 px-6 py-5">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge className={summaryBadgeClass(activeRun.status)}>
                  {formatStatusLabel(activeRun.status)}
                </Badge>
                <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                  Requested model: {activeRun.requested_model}
                </Badge>
                <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                  Effective model: {activeRun.effective_model ?? "Pending"}
                </Badge>
                <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                  Worker build: {activeRun.worker_build_version ?? "Pending"}
                </Badge>
              </div>

              <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
                <div className="space-y-5">
                  <div className="grid gap-5 lg:grid-cols-2">
                    <ExtractionFieldTable
                      title="Canonical extraction"
                      sourceLabel="Persisted drawing_extractions row"
                      workerBuildVersion={normalizedCanonicalExtraction?.workerBuildVersion ?? null}
                      extractorVersion={normalizedCanonicalExtraction?.extractorVersion ?? activePart.extraction?.extractor_version ?? null}
                      extraction={normalizedCanonicalExtraction}
                      reviewFields={normalizedCanonicalExtraction?.reviewFields ?? []}
                      warnings={normalizedCanonicalExtraction?.warnings ?? []}
                    />
                    <ExtractionFieldTable
                      title="Debug run"
                      sourceLabel="Preview-only debug_extraction_runs row"
                      workerBuildVersion={normalizedDebugRun.summary?.workerBuildVersion ?? null}
                      extractorVersion={normalizedDebugRun.summary?.extractorVersion ?? null}
                      requestedModel={normalizedDebugRun.summary?.requestedModel ?? null}
                      effectiveModel={normalizedDebugRun.summary?.effectiveModel ?? null}
                      extraction={normalizedDebugRun.extraction}
                      reviewFields={debugReviewFields}
                      warnings={debugWarnings}
                    />
                  </div>

                  <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                    <p className="text-sm font-medium text-white">Run timing</p>
                    <div className="mt-3 grid gap-3 md:grid-cols-3 text-sm text-white/65">
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-white/40">Created</p>
                        <p className="mt-2">{formatDateTime(activeRun.created_at)}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-white/40">Started</p>
                        <p className="mt-2">{formatDateTime(activeRun.started_at)}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-white/40">Completed</p>
                        <p className="mt-2">{formatDateTime(activeRun.completed_at)}</p>
                      </div>
                    </div>
                    {activeRun.error ? (
                      <div className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-100">
                        {activeRun.error}
                      </div>
                    ) : null}
                  </div>

                  <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                    <p className="text-sm font-medium text-white">Raw debug payload</p>
                    <pre className="mt-3 max-h-80 overflow-auto rounded-xl border border-white/8 bg-[#111111] p-3 text-xs text-white/70">
                      {JSON.stringify(activeRun.result, null, 2)}
                    </pre>
                  </div>
                </div>

                <div className="space-y-5">
                  <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                    <div className="flex items-center gap-2">
                      <ImageIcon className="h-4 w-4 text-white/60" />
                      <p className="text-sm font-medium text-white">Preview image used for debugging</p>
                    </div>
                    <p className="mt-2 text-xs text-white/50">
                      Uses the persisted first-page preview when one is available for this part.
                    </p>
                    <div className="mt-4 overflow-hidden rounded-xl border border-white/8 bg-[#111111]">
                      {isPreviewImageLoading ? (
                        <div className="flex h-64 items-center justify-center text-white/50">
                          <Loader2 className="h-5 w-5 animate-spin" />
                        </div>
                      ) : previewImageUrl ? (
                        <img
                          src={previewImageUrl}
                          alt={`${activePart.name} drawing preview`}
                          className="h-auto w-full object-contain"
                        />
                      ) : (
                        <div className="flex h-64 flex-col items-center justify-center gap-3 px-4 text-center text-sm text-white/45">
                          <AlertTriangle className="h-5 w-5 text-white/35" />
                          <p>No persisted page preview is available for this part yet.</p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                    <p className="text-sm font-medium text-white">Lab guidance</p>
                    <div className="mt-3 space-y-2 text-xs text-white/55">
                      <p>Preview-only runs do not modify `drawing_extractions` or approved requirements.</p>
                      <p>Use the requested model selector above to compare expensive and cheaper fallback models.</p>
                      <p>Queue a normal extraction separately when you want canonical data to be refreshed.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="px-6 py-8 text-sm text-white/55">Select a debug extraction run to inspect it.</div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
