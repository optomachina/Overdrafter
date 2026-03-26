import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Eye,
  ImageIcon,
  Loader2,
  RefreshCw,
  ScanSearch,
  Save,
  UploadCloud,
} from "lucide-react";
import { toast } from "sonner";
import {
  fetchExtractionModelCatalog,
  fetchWorkerReadiness,
  previewStoredPartExtraction,
  requestDebugExtraction,
  requestExtraction,
  requestExtractionModelCatalogRefresh,
} from "@/features/quotes/api/internal-review";
import type {
  DebugExtractionRunRecord,
  DrawingPreviewAssetRecord,
  PartAggregate,
  PreviewExtractionResult,
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type ExtractionLabCardProps = {
  jobId: string;
  parts: PartAggregate[];
  debugExtractionRuns: DebugExtractionRunRecord[];
  drawingPreviewAssets: DrawingPreviewAssetRecord[];
  disabled?: boolean;
};

type ActiveInspection =
  | { kind: "debug"; id: string }
  | { kind: "preview"; id: string }
  | null;

type ConfirmAction =
  | { kind: "save-debug"; partId: string; modelId: string }
  | { kind: "queue-canonical" }
  | null;

type PreviewRun = {
  id: string;
  createdAt: string;
  result: PreviewExtractionResult;
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

function formatDuration(ms: number | null | undefined) {
  if (typeof ms !== "number" || Number.isNaN(ms)) {
    return "Unknown";
  }

  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(value: number | null | undefined) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "Unknown";
  }

  return `$${value.toFixed(5)}`;
}

function summaryBadgeClass(status: string) {
  switch (status) {
    case "completed":
    case "approved":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-300";
    case "running":
      return "border-sky-500/20 bg-sky-500/10 text-sky-200";
    case "queued":
    case "needs_review":
      return "border-amber-500/20 bg-amber-500/10 text-amber-200";
    case "failed":
      return "border-rose-500/20 bg-rose-500/10 text-rose-200";
    default:
      return "border-white/10 bg-white/5 text-white/70";
  }
}

function LightStatus({
  tone,
  label,
}: {
  tone: "pending" | "ready" | "error";
  label: string;
}) {
  const palette =
    tone === "ready"
      ? "bg-emerald-400 shadow-[0_0_16px_rgba(52,211,153,0.55)]"
      : tone === "error"
        ? "bg-rose-400 shadow-[0_0_16px_rgba(251,113,133,0.55)]"
        : "bg-amber-300 shadow-[0_0_16px_rgba(253,224,71,0.55)]";

  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-white/80">
      <span className={`h-2.5 w-2.5 rounded-full ${palette}`} />
      {label}
    </span>
  );
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
        <p className="mt-4 text-sm text-white/50">No extraction payload is available.</p>
      )}

      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        {reviewFields.length > 0 ? (
          <Badge className="border border-amber-500/20 bg-amber-500/10 text-amber-200">
            Review: {reviewFields.join(", ")}
          </Badge>
        ) : (
          <Badge className="border border-emerald-500/20 bg-emerald-500/10 text-emerald-300">
            Review clear
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

function providerLabel(provider: string) {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
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
  const [activeInspection, setActiveInspection] = useState<ActiveInspection>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [previewRunsByPart, setPreviewRunsByPart] = useState<Record<string, PreviewRun[]>>({});
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [isPreviewImageLoading, setIsPreviewImageLoading] = useState(false);

  const workerReadinessQuery = useQuery({
    queryKey: ["worker-readiness"],
    queryFn: () => fetchWorkerReadiness(),
  });

  const modelCatalogQuery = useQuery({
    queryKey: ["extraction-model-catalog"],
    queryFn: () => fetchExtractionModelCatalog(),
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    if (!modelCatalogQuery.data?.refreshing) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ["extraction-model-catalog"] });
    }, 2500);

    return () => window.clearTimeout(timeoutId);
  }, [modelCatalogQuery.data?.refreshing, queryClient]);

  const refreshCatalogMutation = useMutation({
    mutationFn: () => requestExtractionModelCatalogRefresh(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["extraction-model-catalog"] });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to refresh models.");
    },
  });

  const catalogModels = modelCatalogQuery.data?.models ?? [];
  const previewModelOptions = useMemo(
    () => catalogModels.filter((model) => model.previewRunnable),
    [catalogModels],
  );
  const writeRunnableModelIds = useMemo(
    () => new Set(catalogModels.filter((model) => model.debugRunnable).map((model) => model.modelId)),
    [catalogModels],
  );
  const modelOptions = useMemo(() => {
    if (previewModelOptions.length > 0) {
      return previewModelOptions;
    }

    const fallback = workerReadinessQuery.data?.drawingExtractionDebugAllowedModels ?? [];
    return fallback.map((modelId, index) => ({
      provider: modelId.includes("/") ? "openrouter" : modelId.startsWith("claude-") ? "anthropic" : "openai",
      modelId,
      displayLabel: modelId,
      sourceFreshness: "fallback" as const,
      previewRunnable: true,
      debugRunnable: true,
      defaultHint: index === 0,
      stale: true,
    }));
  }, [previewModelOptions, workerReadinessQuery.data?.drawingExtractionDebugAllowedModels]);

  useEffect(() => {
    setSelectedModelsByPart((current) => {
      const next = { ...current };
      let didChange = false;

      parts.forEach((part) => {
        const existing = next[part.id];
        const hasUserSelection = Boolean(userSelectedModelsByPart[part.id]);
        const recommended = modelOptions.find((model) => model.defaultHint)?.modelId ?? modelOptions[0]?.modelId ?? "gpt-5.4";

        if (!existing || !modelOptions.some((model) => model.modelId === existing) || (!hasUserSelection && existing !== recommended)) {
          if (next[part.id] !== recommended) {
            next[part.id] = recommended;
            didChange = true;
          }
        }
      });

      return didChange ? next : current;
    });
  }, [modelOptions, parts, userSelectedModelsByPart]);

  const latestRunByPartId = useMemo(() => {
    const next = new Map<string, DebugExtractionRunRecord>();

    debugExtractionRuns.forEach((run) => {
      if (!next.has(run.part_id)) {
        next.set(run.part_id, run);
      }
    });

    return next;
  }, [debugExtractionRuns]);

  const previewMutation = useMutation({
    mutationFn: async (input: { partId: string; modelId: string }) =>
      previewStoredPartExtraction(input.partId, input.modelId),
    onSuccess: (result) => {
      const previewRun: PreviewRun = {
        id: `${result.partId}:${result.effectiveModel}:${Date.now()}`,
        createdAt: new Date().toISOString(),
        result,
      };

      setPreviewRunsByPart((current) => ({
        ...current,
        [result.partId]: [previewRun, ...(current[result.partId] ?? [])].slice(0, 6),
      }));
      setActiveInspection({ kind: "preview", id: previewRun.id });
      toast.success("Preview ready.");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Preview failed.");
    },
  });

  const requestDebugExtractionMutation = useMutation({
    mutationFn: async (input: { partId: string; modelId: string }) =>
      requestDebugExtraction(input.partId, input.modelId),
    onSuccess: async (runId) => {
      toast.success("Debug run queued.");
      setActiveInspection({ kind: "debug", id: runId });
      await queryClient.invalidateQueries({ queryKey: ["job", jobId] });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to queue debug extraction.");
    },
  });

  const queueExtractionMutation = useMutation({
    mutationFn: () => requestExtraction(jobId),
    onSuccess: async () => {
      toast.success("Canonical extraction queued.");
      await queryClient.invalidateQueries({ queryKey: ["job", jobId] });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to queue canonical extraction.");
    },
  });

  const activeDebugRun = activeInspection?.kind === "debug"
    ? debugExtractionRuns.find((run) => run.id === activeInspection.id) ?? null
    : null;
  const activePreviewRun = activeInspection?.kind === "preview"
    ? Object.values(previewRunsByPart).flat().find((run) => run.id === activeInspection.id) ?? null
    : null;
  const activePartId = activeDebugRun?.part_id ?? activePreviewRun?.result.partId ?? null;
  const activePart = activePartId
    ? parts.find((part) => part.id === activePartId) ?? null
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
  const normalizedDebugRun = activeDebugRun && activePart
    ? normalizeDebugExtractionRun(activeDebugRun, activePart.id)
    : { summary: null, extraction: null };
  const previewExtraction = activePreviewRun && activePart
    ? normalizeDrawingExtraction(
        {
          id: `preview-${activePreviewRun.id}`,
          part_id: activePreviewRun.result.partId,
          organization_id: activePart.organization_id,
          extractor_version: activePreviewRun.result.extractorVersion,
          extraction: activePreviewRun.result.extraction as never,
          confidence: 1,
          warnings: activePreviewRun.result.warnings as never,
          evidence: activePreviewRun.result.evidence as never,
          status: activePreviewRun.result.status,
          created_at: activePreviewRun.createdAt,
          updated_at: activePreviewRun.createdAt,
        },
        activePart.id,
      )
    : null;
  const debugResultObject = normalizedDebugRun.summary ? asObject(normalizedDebugRun.summary.result) : {};
  const debugWarnings = asStringArray(debugResultObject.warnings);
  const debugReviewFields = asStringArray(asObject(debugResultObject.extraction).reviewFields);

  useEffect(() => {
    if (!activePartPreviewAsset) {
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
  }, [activePartPreviewAsset]);

  const catalogTone =
    modelCatalogQuery.isError || modelCatalogQuery.data?.error
      ? "error"
      : modelCatalogQuery.data?.refreshing || modelCatalogQuery.isLoading || refreshCatalogMutation.isPending
        ? "pending"
        : "ready";

  return (
    <>
      <Card className="border-white/10 bg-white/5">
        <CardHeader className="gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Extraction Lab</CardTitle>
            <div className="flex flex-wrap gap-2">
              <LightStatus
                tone={catalogTone}
                label={catalogTone === "ready" ? "Done" : catalogTone === "error" ? "Failed" : "Pending"}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="border-white/10 bg-white/5"
                onClick={() => refreshCatalogMutation.mutate()}
                disabled={refreshCatalogMutation.isPending}
              >
                {refreshCatalogMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Refresh models
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="border-white/10 bg-white/5"
                onClick={() => setConfirmAction({ kind: "queue-canonical" })}
                disabled={disabled || queueExtractionMutation.isPending}
              >
                {queueExtractionMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <UploadCloud className="mr-2 h-4 w-4" />
                )}
                Queue canonical
              </Button>
            </div>
          </div>
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
                Default model: {workerReadinessQuery.data?.drawingExtractionModel ?? "Unknown"}
              </Badge>
              {modelCatalogQuery.data?.updatedAt ? (
                <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                  Catalog: {formatDateTime(modelCatalogQuery.data.updatedAt)}
                </Badge>
              ) : null}
            </div>
            {workerReadinessQuery.data?.reachable === false ? (
              <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-100">
                {workerReadinessQuery.data.message ?? "Worker readiness probe is unavailable."}
              </div>
            ) : null}
            {modelCatalogQuery.data?.error ? (
              <div className="mt-3 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-100">
                {modelCatalogQuery.data.error}
              </div>
            ) : null}
          </div>

          {parts.map((part) => {
            const latestRun = latestRunByPartId.get(part.id) ?? null;
            const canonicalExtraction = normalizeDrawingExtraction(part.extraction, part.id);
            const selectedModelId = selectedModelsByPart[part.id] ?? modelOptions[0]?.modelId ?? "gpt-5.4";
            const selectedModel = modelOptions.find((model) => model.modelId === selectedModelId) ?? null;
            const previewRuns = previewRunsByPart[part.id] ?? [];
            const isPreviewPending =
              previewMutation.isPending && previewMutation.variables?.partId === part.id;
            const isDebugPending =
              requestDebugExtractionMutation.isPending &&
              requestDebugExtractionMutation.variables?.partId === part.id;
            const debugRunnable = selectedModel ? writeRunnableModelIds.has(selectedModel.modelId) : true;

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
                      <Badge className={summaryBadgeClass(latestRun?.status ?? "neutral")}>
                        Latest debug run: {latestRun ? formatStatusLabel(latestRun.status) : "None"}
                      </Badge>
                      {selectedModel ? (
                        <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                          {providerLabel(selectedModel.provider)}
                        </Badge>
                      ) : null}
                      {!debugRunnable ? (
                        <Badge className="border border-amber-500/20 bg-amber-500/10 text-amber-200">
                          Preview-only
                        </Badge>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {previewRuns[0] ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="border-white/10 bg-white/5"
                        onClick={() => setActiveInspection({ kind: "preview", id: previewRuns[0]!.id })}
                      >
                        <Eye className="mr-2 h-4 w-4" />
                        Inspect preview
                      </Button>
                    ) : null}
                    {latestRun ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="border-white/10 bg-white/5"
                        onClick={() => setActiveInspection({ kind: "debug", id: latestRun.id })}
                      >
                        <Eye className="mr-2 h-4 w-4" />
                        Inspect debug
                      </Button>
                    ) : null}
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-end">
                  <div className="space-y-2">
                    <Label htmlFor={`debug-model-${part.id}`}>Model</Label>
                    <Select
                      value={selectedModelId}
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
                          <SelectItem key={`${option.provider}:${option.modelId}`} value={option.modelId}>
                            {providerLabel(option.provider)} · {option.displayLabel}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <Button
                    type="button"
                    className="rounded-full"
                    disabled={disabled || isPreviewPending}
                    onClick={() =>
                      previewMutation.mutate({
                        partId: part.id,
                        modelId: selectedModelId,
                      })
                    }
                  >
                    {isPreviewPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <ScanSearch className="mr-2 h-4 w-4" />
                    )}
                    Preview
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                    disabled={disabled || isDebugPending || !debugRunnable}
                    onClick={() => setConfirmAction({ kind: "save-debug", partId: part.id, modelId: selectedModelId })}
                  >
                    {isDebugPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    Save debug run
                  </Button>
                </div>

                {previewRuns.length > 0 ? (
                  <div className="mt-4 space-y-2">
                    {previewRuns.map((run) => (
                      <button
                        key={run.id}
                        type="button"
                        className="flex w-full items-center justify-between rounded-xl border border-white/8 bg-white/[0.04] px-3 py-3 text-left transition hover:bg-white/[0.08]"
                        onClick={() => setActiveInspection({ kind: "preview", id: run.id })}
                      >
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <Badge className={summaryBadgeClass(run.result.status)}>{formatStatusLabel(run.result.status)}</Badge>
                          <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                            {providerLabel(run.result.provider)}
                          </Badge>
                          <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                            {run.result.effectiveModel}
                          </Badge>
                          <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                            {formatDuration(run.result.durationMs)}
                          </Badge>
                        </div>
                        <span className="text-xs text-white/45">{formatDateTime(run.createdAt)}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Dialog open={Boolean(activeInspection)} onOpenChange={(open) => !open && setActiveInspection(null)}>
        <DialogContent className="h-[88vh] w-[min(96vw,72rem)] max-w-[72rem] overflow-y-auto border-white/10 bg-[#1f1f1f] p-0 text-white">
          <DialogHeader className="border-b border-white/8 px-6 py-5">
            <DialogTitle>Extraction inspection</DialogTitle>
            <DialogDescription className="text-white/55">
              Compare canonical output with the selected preview or persisted debug run.
            </DialogDescription>
          </DialogHeader>

          {activePart ? (
            <div className="space-y-5 px-6 py-5">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {activePreviewRun ? (
                  <>
                    <Badge className={summaryBadgeClass(activePreviewRun.result.status)}>
                      {formatStatusLabel(activePreviewRun.result.status)}
                    </Badge>
                    <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                      Provider: {providerLabel(activePreviewRun.result.provider)}
                    </Badge>
                    <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                      Model: {activePreviewRun.result.effectiveModel}
                    </Badge>
                    <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                      Duration: {formatDuration(activePreviewRun.result.durationMs)}
                    </Badge>
                    <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                      Cost: {formatCost(activePreviewRun.result.estimatedCostUsd)}
                    </Badge>
                  </>
                ) : null}
                {activeDebugRun ? (
                  <>
                    <Badge className={summaryBadgeClass(activeDebugRun.status)}>
                      {formatStatusLabel(activeDebugRun.status)}
                    </Badge>
                    <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                      Requested model: {activeDebugRun.requested_model}
                    </Badge>
                    <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                      Effective model: {activeDebugRun.effective_model ?? "Pending"}
                    </Badge>
                  </>
                ) : null}
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
                    {activePreviewRun ? (
                      <ExtractionFieldTable
                        title="Preview"
                        sourceLabel="Read-only worker preview"
                        workerBuildVersion={activePreviewRun.result.workerBuildVersion}
                        extractorVersion={activePreviewRun.result.extractorVersion}
                        requestedModel={activePreviewRun.result.requestedModel}
                        effectiveModel={activePreviewRun.result.effectiveModel}
                        extraction={previewExtraction}
                        reviewFields={activePreviewRun.result.summary.reviewFields}
                        warnings={activePreviewRun.result.warnings}
                      />
                    ) : (
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
                    )}
                  </div>

                  {activePreviewRun ? (
                    <>
                      <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                        <p className="text-sm font-medium text-white">Parser context</p>
                        <pre className="mt-3 max-h-64 overflow-auto rounded-xl border border-white/8 bg-[#111111] p-3 text-xs text-white/70">
                          {activePreviewRun.result.parserContext}
                        </pre>
                      </div>

                      <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                        <p className="text-sm font-medium text-white">Model attempts</p>
                        <div className="mt-3 space-y-3">
                          {activePreviewRun.result.modelAttempts.map((attempt) => (
                            <div key={attempt.attempt} className="rounded-xl border border-white/8 bg-[#111111] p-3">
                              <div className="flex flex-wrap gap-2 text-xs">
                                <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                                  {attempt.attempt}
                                </Badge>
                                <Badge className={summaryBadgeClass(attempt.titleBlockSufficient ? "approved" : "needs_review")}>
                                  {attempt.titleBlockSufficient ? "Sufficient" : "Escalated"}
                                </Badge>
                              </div>
                              <pre className="mt-3 max-h-64 overflow-auto text-xs text-white/70">
                                {JSON.stringify(attempt.rawResponse, null, 2)}
                              </pre>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                      <p className="text-sm font-medium text-white">Raw debug payload</p>
                      <pre className="mt-3 max-h-80 overflow-auto rounded-xl border border-white/8 bg-[#111111] p-3 text-xs text-white/70">
                        {JSON.stringify(activeDebugRun?.result, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>

                <div className="space-y-5">
                  <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                    <div className="flex items-center gap-2">
                      <ImageIcon className="h-4 w-4 text-white/60" />
                      <p className="text-sm font-medium text-white">Preview image</p>
                    </div>
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
                          <p>No persisted page preview is available.</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {activePreviewRun ? (
                    <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                      <p className="text-sm font-medium text-white">Preview run</p>
                      <div className="mt-3 grid gap-3 text-sm text-white/65">
                        <div>
                          <p className="text-xs uppercase tracking-[0.2em] text-white/40">Created</p>
                          <p className="mt-2">{formatDateTime(activePreviewRun.createdAt)}</p>
                        </div>
                        <div>
                          <p className="text-xs uppercase tracking-[0.2em] text-white/40">Tokens</p>
                          <p className="mt-2">
                            {activePreviewRun.result.inputTokens ?? "?"} in / {activePreviewRun.result.outputTokens ?? "?"} out
                          </p>
                        </div>
                        <div>
                          <p className="text-xs uppercase tracking-[0.2em] text-white/40">Preview assets</p>
                          <p className="mt-2">{activePreviewRun.result.preview.previewAssetCount}</p>
                        </div>
                      </div>
                    </div>
                  ) : activeDebugRun ? (
                    <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                      <p className="text-sm font-medium text-white">Debug run timing</p>
                      <div className="mt-3 grid gap-3 text-sm text-white/65">
                        <div>
                          <p className="text-xs uppercase tracking-[0.2em] text-white/40">Created</p>
                          <p className="mt-2">{formatDateTime(activeDebugRun.created_at)}</p>
                        </div>
                        <div>
                          <p className="text-xs uppercase tracking-[0.2em] text-white/40">Started</p>
                          <p className="mt-2">{formatDateTime(activeDebugRun.started_at)}</p>
                        </div>
                        <div>
                          <p className="text-xs uppercase tracking-[0.2em] text-white/40">Completed</p>
                          <p className="mt-2">{formatDateTime(activeDebugRun.completed_at)}</p>
                        </div>
                      </div>
                      {activeDebugRun.error ? (
                        <div className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-100">
                          {activeDebugRun.error}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div className="px-6 py-8 text-sm text-white/55">Select a preview or debug run.</div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(confirmAction)} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <AlertDialogContent className="border-white/10 bg-[#1f1f1f] text-white">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction?.kind === "queue-canonical" ? "Queue canonical extraction?" : "Save debug run?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-white/60">
              {confirmAction?.kind === "queue-canonical"
                ? "This will write to the job-backed extraction pipeline."
                : "This will create a persisted debug run."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/10 bg-transparent text-white hover:bg-white/6">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-white text-black hover:bg-white/90"
              onClick={() => {
                if (!confirmAction) {
                  return;
                }

                if (confirmAction.kind === "queue-canonical") {
                  queueExtractionMutation.mutate();
                } else {
                  requestDebugExtractionMutation.mutate({
                    partId: confirmAction.partId,
                    modelId: confirmAction.modelId,
                  });
                }

                setConfirmAction(null);
              }}
            >
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
