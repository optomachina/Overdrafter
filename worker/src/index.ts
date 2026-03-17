import "dotenv/config";
import path from "node:path";
import type { PostgrestResponse, SupabaseClient } from "@supabase/supabase-js";
import { buildAdapterRegistry } from "./adapters/index.js";
import { autoApproveJobRequirements } from "./autoApprove.js";
import { XOMETRY_AUTOMATION_VERSION } from "./adapters/xometry.js";
import { loadConfig } from "./config.js";
import { runHybridExtraction } from "./extraction/hybridExtraction.js";
import { extractPdfText, renderPdfPreviewAssets } from "./extraction/pdfDrawing.js";
import {
  cleanupPaths,
  createRunDir,
  stageStorageObject,
  uploadArtifact,
} from "./files.js";
import {
  claimNextTask,
  createServiceClient,
  markTaskCompleted,
  markTaskFailed,
  markTaskQueuedForRetry,
} from "./queue.js";
import {
  createWorkerRuntimeState,
  recordRuntimeEvent,
  startHealthServer,
  type WorkerRuntimeState,
} from "./httpServer.js";
import { suggestLocatorUpdate } from "./repair/suggestLocatorUpdate.js";
import { prepareRuntimeSecrets, validateWorkerReadiness } from "./runtimeSecrets.js";
import {
  ApprovedRequirementRecord,
  JobFileRecord,
  PartRecord,
  QueueTaskRecord,
  VendorArtifact,
  VendorAutomationError,
  VendorName,
  WorkerConfig,
} from "./types.js";
import {
  failureCodeForError,
  isRetryableVendorTaskError,
  nextRetryAt,
  retryCountForAttempts,
} from "./vendorTaskRetry.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTaskContext(task: QueueTaskRecord) {
  return {
    taskId: task.id,
    taskType: task.task_type,
    attempts: task.attempts,
    organizationId: task.organization_id,
    jobId: task.job_id,
    partId: task.part_id,
    quoteRequestId:
      typeof task.payload.quoteRequestId === "string" ? task.payload.quoteRequestId : null,
    quoteRunId: task.quote_run_id,
    packageId: task.package_id,
    vendor: typeof task.payload.vendor === "string" ? task.payload.vendor : null,
    vendorQuoteResultId:
      typeof task.payload.vendorQuoteResultId === "string" ? task.payload.vendorQuoteResultId : null,
    requestedQuantity:
      typeof task.payload.requestedQuantity === "number"
        ? task.payload.requestedQuantity
        : typeof task.payload.requestedQuantity === "string"
          ? Number.parseInt(task.payload.requestedQuantity, 10)
          : null,
  };
}

function logWorkerEvent(
  runtimeState: WorkerRuntimeState,
  input: {
    level: "info" | "warn" | "error";
    source: string;
    message: string;
    context?: Record<string, unknown>;
    error?: unknown;
  },
) {
  const event = recordRuntimeEvent(runtimeState, input);
  const payload = {
    service: "overdrafter-cad-worker",
    workerStatus: runtimeState.status,
    timestamp: event.timestamp,
    level: event.level,
    source: event.source,
    message: event.message,
    context: event.context,
    error: event.error,
  };
  const serialized = JSON.stringify(payload);

  if (input.level === "error") {
    console.error(serialized);
    return;
  }

  if (input.level === "warn") {
    console.warn(serialized);
    return;
  }

  console.log(serialized);
}

function summarizeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function summarizeExtractionOutcome(extraction: Awaited<ReturnType<typeof runHybridExtraction>>) {
  const missingFields = [
    extraction.description ? null : "description",
    extraction.partNumber ? null : "partNumber",
    extraction.revision ? null : "revision",
    extraction.material.normalized || extraction.material.raw ? null : "material",
    extraction.finish.normalized || extraction.finish.raw ? null : "finish",
    extraction.tightestTolerance.valueInch ?? extraction.tightestTolerance.raw ? null : "tightestToleranceInch",
  ].filter((value): value is string => Boolean(value));
  const reviewFields = extraction.reviewFields.filter((field) => !missingFields.includes(field));

  return {
    missingFields,
    reviewFields,
    lifecycle:
      missingFields.length > 0 || reviewFields.length > 0 || extraction.warnings.length > 0
        ? "partial"
        : "succeeded",
  };
}

async function logWorkerAuditEvent(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    jobId: string;
    packageId?: string | null;
    eventType: string;
    payload?: Record<string, unknown>;
  },
) {
  const { error } = await supabase.from("audit_events").insert({
    organization_id: input.organizationId,
    actor_user_id: null,
    job_id: input.jobId,
    package_id: input.packageId ?? null,
    event_type: input.eventType,
    payload: input.payload ?? {},
  });

  if (error) {
    throw error;
  }
}

function buildFailureRawPayload(
  vendor: VendorName,
  retryCount: number,
  failureCode: string,
  payload: Record<string, unknown>,
  artifactStoragePaths: string[],
) {
  if (vendor !== "xometry") {
    return {
      failureCode,
      retryCount,
      requestedQuantity:
        typeof payload.requestedQuantity === "number" ? payload.requestedQuantity : null,
      ...payload,
      artifactStoragePaths,
    };
  }

  return {
    automationVersion: XOMETRY_AUTOMATION_VERSION,
    detectedFlow:
      typeof payload.detectedFlow === "string" ? payload.detectedFlow : "quote_home",
    uploadSelector:
      typeof payload.uploadSelector === "string" ? payload.uploadSelector : null,
    drawingUploadMode:
      typeof payload.drawingUploadMode === "string" ? payload.drawingUploadMode : null,
    selectedMaterial:
      typeof payload.selectedMaterial === "string" ? payload.selectedMaterial : null,
    selectedFinish:
      typeof payload.selectedFinish === "string" ? payload.selectedFinish : null,
    priceSource:
      typeof payload.priceSource === "string" ? payload.priceSource : "none",
    leadTimeSource:
      typeof payload.leadTimeSource === "string" ? payload.leadTimeSource : "none",
    bodyExcerpt: typeof payload.bodyExcerpt === "string" ? payload.bodyExcerpt : "",
    artifactStoragePaths,
    requestedQuantity:
      typeof payload.requestedQuantity === "number" ? payload.requestedQuantity : null,
    retryCount,
    failureCode,
    url: typeof payload.url === "string" ? payload.url : null,
    ...payload,
  };
}

async function refreshRuntimeReadiness(
  config: WorkerConfig,
  runtimeState: WorkerRuntimeState,
  logIssueChange: (issues: string[]) => void,
) {
  const issues = await validateWorkerReadiness(config);
  const previousSignature = runtimeState.readinessIssues.join("\n");
  const nextSignature = issues.join("\n");

  runtimeState.readinessIssues = issues;

  if (issues.length > 0) {
    runtimeState.lastError = issues.join(" ");
  } else if (previousSignature.length > 0) {
    runtimeState.lastError = null;
  }

  if (previousSignature !== nextSignature) {
    logIssueChange(issues);
  }

  return issues.length === 0;
}

function emptyResponse<T>(): Promise<PostgrestResponse<T>> {
  return Promise.resolve({
    data: [],
    error: null,
    count: null,
    status: 200,
    statusText: "OK",
  });
}

async function fetchPartContext(supabase: SupabaseClient, partId: string) {
  const { data: part, error: partError } = await supabase
    .from("parts")
    .select("*")
    .eq("id", partId)
    .single();

  if (partError || !part) {
    throw partError ?? new Error(`Part ${partId} not found.`);
  }

  const fileIds = [part.cad_file_id, part.drawing_file_id].filter(Boolean) as string[];
  const [{ data: files, error: fileError }, { data: requirement, error: requirementError }] =
    await Promise.all([
      fileIds.length
        ? supabase.from("job_files").select("*").in("id", fileIds)
        : emptyResponse<JobFileRecord>(),
      supabase.from("approved_part_requirements").select("*").eq("part_id", partId).maybeSingle(),
    ]);

  if (fileError) {
    throw fileError;
  }

  if (requirementError && requirementError.code !== "PGRST116") {
    throw requirementError;
  }

  const cadFile =
    (files as JobFileRecord[]).find((file) => file.id === part.cad_file_id) ?? null;
  const drawingFile =
    (files as JobFileRecord[]).find((file) => file.id === part.drawing_file_id) ?? null;

  return {
    part: part as PartRecord,
    cadFile,
    drawingFile,
    requirement: (requirement as ApprovedRequirementRecord | null) ?? null,
  };
}

async function enqueueRepairCandidate(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
  error: VendorAutomationError,
) {
  if (error.code !== "selector_failure" || !task.job_id || !task.part_id || !task.quote_run_id) {
    return;
  }

  const { error: insertError } = await supabase.from("work_queue").insert({
    organization_id: task.organization_id,
    job_id: task.job_id,
    part_id: task.part_id,
    quote_run_id: task.quote_run_id,
    task_type: "repair_adapter_candidate",
    status: "queued",
    payload: {
      vendor: task.payload.vendor,
      failedSelector: error.payload.failedSelector ?? null,
      attemptedSelectors: error.payload.attemptedSelectors ?? [],
      errorMessage: error.message,
      nearbyAttributes: error.payload.nearbyAttributes ?? [],
      failureCode: error.code,
      url: error.payload.url ?? null,
    },
  });

  if (insertError) {
    throw insertError;
  }
}

async function persistVendorArtifacts(
  supabase: SupabaseClient,
  config: WorkerConfig,
  input: {
    vendorQuoteResultId: string;
    organizationId: string;
    quoteRunId: string;
    partId: string;
    vendor: VendorName;
    artifacts: VendorArtifact[];
  },
) {
  const storagePaths: string[] = [];

  for (const artifact of input.artifacts) {
    storagePaths.push(
      await uploadArtifact(supabase, config, {
        vendorQuoteResultId: input.vendorQuoteResultId,
        organizationId: input.organizationId,
        quoteRunId: input.quoteRunId,
        partId: input.partId,
        vendor: input.vendor,
        artifact,
      }),
    );
  }

  return storagePaths;
}

async function syncJobStatusAfterVendorUpdate(
  supabase: SupabaseClient,
  jobId: string,
  quoteRunId: string,
) {
  const [
    { data: results, error: resultsError },
    { data: job, error: jobError },
    { data: quoteRun, error: quoteRunError },
  ] = await Promise.all([
    supabase.from("vendor_quote_results").select("status").eq("quote_run_id", quoteRunId),
    supabase.from("jobs").select("organization_id, status").eq("id", jobId).single(),
    supabase.from("quote_runs").select("status").eq("id", quoteRunId).single(),
  ]);

  if (resultsError || !results) {
    throw resultsError ?? new Error("Unable to refresh job status.");
  }

  if (jobError || !job) {
    throw jobError ?? new Error("Unable to load job status.");
  }

  if (quoteRunError || !quoteRun) {
    throw quoteRunError ?? new Error("Unable to load quote run status.");
  }

  const statuses = results.map((row) => row.status);
  const hasPending = statuses.some((status) => status === "queued" || status === "running");
  const hasManual = statuses.some(
    (status) => status === "manual_review_pending" || status === "manual_vendor_followup",
  );
  const hasSuccess = statuses.some(
    (status) => status === "instant_quote_received" || status === "official_quote_received",
  );
  const successfulVendorQuotes = statuses.filter(
    (status) => status === "instant_quote_received" || status === "official_quote_received",
  ).length;
  const manualReviewVendorQuotes = statuses.filter(
    (status) => status === "manual_review_pending" || status === "manual_vendor_followup",
  ).length;
  const failedVendorQuotes = statuses.filter((status) => status === "failed").length;
  const nextQuoteRunStatus = hasPending ? "running" : hasSuccess || hasManual ? "completed" : "failed";
  const nextJobStatus = hasPending
    ? "quoting"
    : hasManual
      ? "awaiting_vendor_manual_review"
      : hasSuccess
        ? "internal_review"
        : "quoting";

  await supabase
    .from("quote_runs")
    .update({
      status: nextQuoteRunStatus,
    })
    .eq("id", quoteRunId);

  await supabase
    .from("jobs")
    .update({
      status: nextJobStatus,
    })
    .eq("id", jobId);

  if (quoteRun.status === nextQuoteRunStatus && job.status === nextJobStatus) {
    return;
  }

  const basePayload = {
    quoteRunId,
    successfulVendorQuotes,
    manualReviewVendorQuotes,
    failedVendorQuotes,
  };

  if (nextQuoteRunStatus === "failed") {
    await logWorkerAuditEvent(supabase, {
      organizationId: job.organization_id,
      jobId,
      eventType: "worker.quote_run_failed",
      payload: basePayload,
    });
    return;
  }

  if (nextJobStatus === "awaiting_vendor_manual_review") {
    await logWorkerAuditEvent(supabase, {
      organizationId: job.organization_id,
      jobId,
      eventType: "worker.quote_run_attention_needed",
      payload: basePayload,
    });
    return;
  }

  if (nextJobStatus === "internal_review") {
    await logWorkerAuditEvent(supabase, {
      organizationId: job.organization_id,
      jobId,
      eventType: "worker.quote_run_completed",
      payload: basePayload,
    });
  }
}

async function persistDrawingPreviewAssets(
  supabase: SupabaseClient,
  config: WorkerConfig,
  input: {
    organizationId: string;
    partId: string;
    jobId: string;
    previewAssets: Awaited<ReturnType<typeof renderPdfPreviewAssets>>;
  },
) {
  if (input.previewAssets.length === 0) {
    await supabase.from("drawing_preview_assets").delete().eq("part_id", input.partId);
    return;
  }

  const rows = [] as Array<{
    part_id: string;
    organization_id: string;
    page_number: number;
    kind: string;
    storage_bucket: string;
    storage_path: string;
    width: number | null;
    height: number | null;
  }>;

  for (const asset of input.previewAssets) {
    const fileBuffer = await pathToBuffer(asset.localPath);
    const storagePath = `${input.organizationId}/drawing-previews/${input.jobId}/${input.partId}/${asset.kind}-${asset.pageNumber}.png`;
    const { error: uploadError } = await supabase.storage.from(config.artifactBucket).upload(storagePath, fileBuffer, {
      contentType: asset.contentType,
      upsert: true,
    });

    if (uploadError) {
      throw uploadError;
    }

    rows.push({
      part_id: input.partId,
      organization_id: input.organizationId,
      page_number: asset.pageNumber,
      kind: asset.kind,
      storage_bucket: config.artifactBucket,
      storage_path: storagePath,
      width: asset.width,
      height: asset.height,
    });
  }

  await supabase.from("drawing_preview_assets").delete().eq("part_id", input.partId);

  const { error: insertError } = await supabase.from("drawing_preview_assets").insert(rows);

  if (insertError) {
    throw insertError;
  }
}

async function pathToBuffer(filePath: string) {
  const { readFile } = await import("node:fs/promises");
  return readFile(filePath);
}

async function handleExtractTask(supabase: SupabaseClient, task: QueueTaskRecord, config: WorkerConfig) {
  if (!task.part_id || !task.job_id) {
    throw new Error("extract_part task is missing job_id or part_id.");
  }

  const context = await fetchPartContext(supabase, task.part_id);
  const runDir = await createRunDir(config, ["extract", task.id]);
  const stagedDrawingFile = await stageStorageObject(supabase, context.drawingFile, runDir);

  try {
    const pdfText = stagedDrawingFile ? await extractPdfText(stagedDrawingFile.localPath) : null;
    const previewAssets =
      stagedDrawingFile && pdfText ? await renderPdfPreviewAssets(stagedDrawingFile.localPath, runDir, pdfText.pageCount) : [];
    const firstPagePreviewPath =
      previewAssets.find((asset) => asset.kind === "page" && asset.pageNumber === 1)?.localPath ?? null;
    const extraction = await runHybridExtraction({
      part: context.part,
      cadFile: context.cadFile,
      drawingFile: context.drawingFile,
      pdfText,
      drawingPath: stagedDrawingFile?.localPath ?? null,
      previewPagePath: firstPagePreviewPath,
      runDir,
      config,
    });
    const extractionOutcome = summarizeExtractionOutcome(extraction);

    if (process.env.EXTRACTION_DEBUG === "true" && extraction.debugCandidates) {
      console.log(
        JSON.stringify({
          service: "overdrafter-cad-worker",
          source: "extract_part",
          message: "drawing extraction candidate ranking",
          partId: context.part.id,
          reviewFields: extraction.reviewFields,
          candidates: extraction.debugCandidates,
        }),
      );
    }

    const { error } = await supabase.from("drawing_extractions").upsert(
      {
        part_id: context.part.id,
        organization_id: context.part.organization_id,
        extractor_version: stagedDrawingFile ? "worker-pdf-v2" : "worker-sim-v1",
        extraction: {
          pageCount: pdfText?.pageCount ?? 0,
          description: extraction.description,
          partNumber: extraction.partNumber,
          revision: extraction.revision,
          extractedDescriptionRaw: extraction.extractedDescriptionRaw,
          extractedPartNumberRaw: extraction.extractedPartNumberRaw,
          extractedRevisionRaw: extraction.extractedRevisionRaw,
          extractedFinishRaw: extraction.extractedFinishRaw,
          quoteDescription: extraction.quoteDescription,
          quoteFinish: extraction.quoteFinish,
          reviewFields: extraction.reviewFields,
          debugCandidates: extraction.debugCandidates,
          modelFallbackUsed: extraction.modelFallbackUsed,
          modelName: extraction.modelName,
          modelPromptVersion: extraction.modelPromptVersion,
          fieldSelections: extraction.fieldSelections,
          modelCandidates: extraction.modelCandidates,
          material: extraction.material,
          finish: extraction.finish,
          generalTolerance: extraction.generalTolerance,
          tolerances: {
            general: extraction.generalTolerance.raw,
            tightest: extraction.tightestTolerance.raw,
            valueInch: extraction.tightestTolerance.valueInch,
            confidence: extraction.tightestTolerance.confidence,
          },
          notes: extraction.notes,
          threads: extraction.threads,
        },
        confidence: extraction.material.confidence,
        warnings: extraction.warnings,
        evidence: extraction.evidence,
        status: extraction.status,
      },
      {
        onConflict: "part_id",
      },
    );

    if (error) {
      throw error;
    }

    await persistDrawingPreviewAssets(supabase, config, {
      organizationId: context.part.organization_id,
      partId: context.part.id,
      jobId: task.job_id,
      previewAssets,
    });
    const autoApprovedPartCount = await autoApproveJobRequirements(supabase, task.job_id);
    await logWorkerAuditEvent(supabase, {
      organizationId: context.part.organization_id,
      jobId: task.job_id,
        eventType: "worker.extraction_completed",
      payload: {
        partId: context.part.id,
        extractionStatus: extraction.status,
        extractionLifecycle: extractionOutcome.lifecycle,
        warningCount: extraction.warnings.length,
        missingFields: extractionOutcome.missingFields,
        reviewFields: extractionOutcome.reviewFields,
        previewAssetCount: previewAssets.length,
        autoApprovedPartCount,
      },
    });
    await markTaskCompleted(supabase, task.id, {
      ...task.payload,
      extractionStatus: extraction.status,
      extractionLifecycle: extractionOutcome.lifecycle,
      warningCount: extraction.warnings.length,
      missingFields: extractionOutcome.missingFields,
      reviewFields: extractionOutcome.reviewFields,
      previewAssetCount: previewAssets.length,
      autoApprovedPartCount,
    });
  } catch (error) {
    await logWorkerAuditEvent(supabase, {
      organizationId: context.part.organization_id,
      jobId: task.job_id,
      eventType: "worker.extraction_failed",
      payload: {
        partId: context.part.id,
        failureCode: failureCodeForError(error),
        failureMessage: summarizeError(error),
      },
    });
    throw error;
  } finally {
    await cleanupPaths([runDir]);
  }
}

async function handleVendorQuoteTask(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
  config: WorkerConfig,
) {
  if (!task.part_id || !task.quote_run_id || !task.job_id) {
    throw new Error("run_vendor_quote task is missing part_id, quote_run_id, or job_id.");
  }

  const vendor = task.payload.vendor as VendorName | undefined;
  const vendorQuoteResultId =
    typeof task.payload.vendorQuoteResultId === "string" ? task.payload.vendorQuoteResultId : null;
  const requestedQuantity =
    typeof task.payload.requestedQuantity === "number"
      ? task.payload.requestedQuantity
      : typeof task.payload.requestedQuantity === "string"
        ? Number.parseInt(task.payload.requestedQuantity, 10)
        : requestedQuantityFallback(task);

  if (!vendor) {
    throw new Error("run_vendor_quote task is missing vendor in payload.");
  }

  const context = await fetchPartContext(supabase, task.part_id);

  if (!context.requirement) {
    throw new Error(`No approved requirement found for part ${task.part_id}.`);
  }

  const currentResultRequest = vendorQuoteResultId
    ? supabase
        .from("vendor_quote_results")
        .select("id, requested_quantity")
        .eq("id", vendorQuoteResultId)
        .single()
    : supabase
        .from("vendor_quote_results")
        .select("id, requested_quantity")
        .eq("quote_run_id", task.quote_run_id)
        .eq("part_id", task.part_id)
        .eq("vendor", vendor)
        .eq("requested_quantity", Math.max(1, requestedQuantity))
        .single();

  const { data: currentResult, error: currentResultError } = await currentResultRequest;

  if (currentResultError || !currentResult) {
    throw currentResultError ?? new Error("Vendor quote result row was not found.");
  }

  const retryCount = retryCountForAttempts(task.attempts);

  await supabase
    .from("vendor_quote_results")
    .update({
      status: "running",
      notes:
        retryCount > 0
          ? [`Retry attempt ${retryCount + 1} is in progress.`]
          : ["Vendor automation is in progress."],
      raw_payload: {
        retryCount,
        failureCode: null,
        retryScheduledFor: null,
        requestedQuantity: currentResult.requested_quantity,
      },
    })
    .eq("id", currentResult.id);

  const adapters = buildAdapterRegistry(config);
  const adapter = adapters[vendor];
  const artifactDirs = new Set<string>();
  let stageDir: string | null = null;

  if (!adapter) {
    await supabase
      .from("vendor_quote_results")
      .update({
        status: "manual_vendor_followup",
        notes: [
          `${vendor} is configured as a manual/import quote source in this environment.`,
        ],
        raw_payload: {
          mode: config.workerMode,
          source: "manual-import-vendor",
          requiresManualVendorFollowUp: true,
          requestedQuantity: currentResult.requested_quantity,
          retryCount,
          failureCode: null,
        },
      })
      .eq("id", currentResult.id);

    await syncJobStatusAfterVendorUpdate(supabase, task.job_id, task.quote_run_id);
    await markTaskCompleted(supabase, task.id, {
      ...task.payload,
      vendorStatus: "manual_vendor_followup",
      manualVendor: true,
    });
    return;
  }

  try {
    stageDir = await createRunDir(config, ["staging", task.quote_run_id, task.part_id]);
    const stagedCadFile = await stageStorageObject(supabase, context.cadFile, stageDir);
    const stagedDrawingFile = await stageStorageObject(supabase, context.drawingFile, stageDir);
    const result = await adapter.quote({
      organizationId: task.organization_id,
      quoteRunId: task.quote_run_id,
      part: context.part,
      cadFile: context.cadFile,
      drawingFile: context.drawingFile,
      stagedCadFile,
      stagedDrawingFile,
      requirement: context.requirement,
      requestedQuantity: currentResult.requested_quantity,
    });

    result.artifacts.forEach((artifact: VendorArtifact) =>
      artifactDirs.add(path.dirname(artifact.localPath)),
    );
    const artifactStoragePaths = await persistVendorArtifacts(supabase, config, {
      vendorQuoteResultId: currentResult.id,
      organizationId: task.organization_id,
      quoteRunId: task.quote_run_id,
      partId: task.part_id,
      vendor,
      artifacts: result.artifacts,
    });

    const { error } = await supabase
      .from("vendor_quote_results")
      .update({
        status: result.status,
        unit_price_usd: result.unitPriceUsd,
        total_price_usd: result.totalPriceUsd,
        lead_time_business_days: result.leadTimeBusinessDays,
        quote_url: result.quoteUrl,
        dfm_issues: result.dfmIssues,
        notes: result.notes,
        raw_payload: {
          ...result.rawPayload,
          artifactStoragePaths,
          requestedQuantity: currentResult.requested_quantity,
          retryCount,
          failureCode: null,
        },
      })
      .eq("id", currentResult.id);

    if (error) {
      throw error;
    }

    await syncJobStatusAfterVendorUpdate(supabase, task.job_id, task.quote_run_id);
    await markTaskCompleted(supabase, task.id, {
      ...task.payload,
      vendorStatus: result.status,
      artifactCount: artifactStoragePaths.length,
    });
  } catch (error) {
    const vendorError =
      error instanceof VendorAutomationError ? error : null;
    const failureArtifacts = vendorError?.artifacts ?? [];
    failureArtifacts.forEach((artifact) => artifactDirs.add(path.dirname(artifact.localPath)));
    const failureArtifactStoragePaths =
      failureArtifacts.length > 0
        ? await persistVendorArtifacts(supabase, config, {
            vendorQuoteResultId: currentResult.id,
            organizationId: task.organization_id,
            quoteRunId: task.quote_run_id,
            partId: task.part_id,
            vendor,
            artifacts: failureArtifacts,
          })
        : [];

    if (vendorError) {
      await enqueueRepairCandidate(supabase, task, vendorError);
    }

    const failureCode = failureCodeForError(error);
    const failureMessage = summarizeError(error);
    const retryAt =
      isRetryableVendorTaskError(error) ? nextRetryAt(task.attempts) : null;

    await supabase
      .from("vendor_quote_results")
      .update({
        status: retryAt ? "queued" : "failed",
        notes: [
          retryAt
            ? `Transient vendor automation failure. Retry scheduled for ${retryAt}. ${failureMessage}`
            : failureMessage,
        ],
        raw_payload: {
          ...buildFailureRawPayload(
            vendor,
            retryCount,
            failureCode,
            vendorError?.payload ?? {},
            failureArtifactStoragePaths,
          ),
          requestedQuantity: currentResult.requested_quantity,
          retryScheduledFor: retryAt,
        },
      })
      .eq("id", currentResult.id);

    await syncJobStatusAfterVendorUpdate(supabase, task.job_id, task.quote_run_id);
    throw error;
  } finally {
    await cleanupPaths([stageDir, ...artifactDirs]);
  }
}

function requestedQuantityFallback(task: QueueTaskRecord) {
  if (typeof task.payload.requestedQuantity === "number") {
    return task.payload.requestedQuantity;
  }

  if (typeof task.payload.requestedQuantity === "string") {
    const parsed = Number.parseInt(task.payload.requestedQuantity, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 1;
}

async function handlePublishTask(supabase: SupabaseClient, task: QueueTaskRecord) {
  const jobId = task.job_id ?? (task.payload.jobId as string | undefined);
  const quoteRunId = task.quote_run_id ?? (task.payload.quoteRunId as string | undefined);

  if (!jobId || !quoteRunId) {
    throw new Error("publish_package task is missing jobId or quoteRunId.");
  }

  const { error } = await supabase.rpc("api_publish_quote_package", {
    p_job_id: jobId,
    p_quote_run_id: quoteRunId,
    p_client_summary: (task.payload.clientSummary as string | undefined) ?? null,
    p_force: false,
  });

  if (error) {
    throw error;
  }

  await markTaskCompleted(supabase, task.id, {
    ...task.payload,
    published: true,
  });
}

async function handleRepairTask(supabase: SupabaseClient, task: QueueTaskRecord) {
  const suggestion = suggestLocatorUpdate({
    failedSelector: String(task.payload.failedSelector ?? ""),
    errorMessage: String(task.payload.errorMessage ?? ""),
    nearbyAttributes: Array.isArray(task.payload.nearbyAttributes)
      ? (task.payload.nearbyAttributes as string[])
      : [],
  });

  await markTaskCompleted(supabase, task.id, {
    ...task.payload,
    repairSuggestion: suggestion,
  });
}

async function processTask(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
  config: WorkerConfig,
) {
  switch (task.task_type) {
    case "extract_part":
      await handleExtractTask(supabase, task, config);
      return;
    case "run_vendor_quote":
      await handleVendorQuoteTask(supabase, task, config);
      return;
    case "publish_package":
      await handlePublishTask(supabase, task);
      return;
    case "repair_adapter_candidate":
      await handleRepairTask(supabase, task);
      return;
    case "poll_vendor_quote":
      await markTaskCompleted(supabase, task.id, {
        ...task.payload,
        pollSkipped: true,
      });
      return;
    default:
      throw new Error(`Unhandled task type: ${task.task_type}`);
  }
}

async function main() {
  const baseConfig = loadConfig();
  const runtimeState = createWorkerRuntimeState();
  let config = baseConfig;
  let startupReadinessIssue: string | null = null;

  try {
    config = await prepareRuntimeSecrets(baseConfig);
  } catch (error) {
    startupReadinessIssue = summarizeError(error);
  }

  const supabase = createServiceClient(config);
  const healthServer = await startHealthServer(config, runtimeState);
  let stopping = false;

  const logReadinessChange = (issues: string[]) => {
    if (issues.length > 0) {
      logWorkerEvent(runtimeState, {
        level: "error",
        source: "worker.readiness",
        message: "Worker is not ready to process tasks.",
        context: {
          issues,
        },
      });
      return;
    }

    logWorkerEvent(runtimeState, {
      level: "info",
      source: "worker.readiness",
      message: "Worker readiness checks passed.",
    });
  };

  const requestShutdown = (signal: string) => {
    if (stopping) {
      return;
    }

    stopping = true;
    runtimeState.status = "shutting_down";
    logWorkerEvent(runtimeState, {
      level: "info",
      source: "worker.shutdown",
      message: `Received ${signal}; shutting down after the current cycle.`,
      context: {
        signal,
      },
    });
  };

  process.on("SIGTERM", () => requestShutdown("SIGTERM"));
  process.on("SIGINT", () => requestShutdown("SIGINT"));
  process.on("unhandledRejection", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    runtimeState.lastError = message;
    logWorkerEvent(runtimeState, {
      level: "error",
      source: "process.unhandledRejection",
      message,
      error,
    });
  });
  process.on("uncaughtExceptionMonitor", (error) => {
    runtimeState.lastError = error.message;
    logWorkerEvent(runtimeState, {
      level: "error",
      source: "process.uncaughtException",
      message: error.message,
      error,
    });
  });

  logWorkerEvent(runtimeState, {
    level: "info",
    source: "worker.startup",
    message: `Starting worker ${config.workerName} in ${config.workerMode} mode.`,
    context: {
      workerName: config.workerName,
      workerMode: config.workerMode,
      healthUrl: healthServer.url,
      pollIntervalMs: config.pollIntervalMs,
      drawingExtractionModelFallback: config.drawingExtractionEnableModelFallback,
      drawingExtractionModel: config.drawingExtractionEnableModelFallback
        ? config.drawingExtractionModel
        : null,
    },
  });

  runtimeState.status = "running";

  if (startupReadinessIssue) {
    runtimeState.readinessIssues = [startupReadinessIssue];
    runtimeState.lastError = startupReadinessIssue;
    logReadinessChange(runtimeState.readinessIssues);
  } else {
    await refreshRuntimeReadiness(config, runtimeState, logReadinessChange);
  }

  while (!stopping) {
    runtimeState.lastLoopAt = new Date().toISOString();
    const ready = startupReadinessIssue
      ? false
      : await refreshRuntimeReadiness(config, runtimeState, logReadinessChange);

    if (!ready) {
      await sleep(config.pollIntervalMs);
      continue;
    }

    const task = await claimNextTask(supabase, config.workerName);

    if (!task) {
      await sleep(config.pollIntervalMs);
      continue;
    }

    const taskSummary = {
      id: task.id,
      type: task.task_type,
    };
    runtimeState.currentTask = taskSummary;
    runtimeState.lastTaskStartedAt = new Date().toISOString();
    logWorkerEvent(runtimeState, {
      level: "info",
      source: "worker.task.start",
      message: `Starting ${task.task_type} ${task.id}.`,
      context: buildTaskContext(task),
    });

    try {
      await processTask(supabase, task, config);
      runtimeState.lastTaskCompletedAt = new Date().toISOString();
      runtimeState.lastCompletedTask = taskSummary;
      runtimeState.lastError = null;
      logWorkerEvent(runtimeState, {
        level: "info",
        source: "worker.task.complete",
        message: `Completed ${task.task_type} ${task.id}.`,
        context: buildTaskContext(task),
      });
    } catch (error) {
      const message = summarizeError(error);
      const retryAt =
        task.task_type === "run_vendor_quote" && isRetryableVendorTaskError(error)
          ? nextRetryAt(task.attempts)
          : null;
      const retryCount = retryCountForAttempts(task.attempts);

      if (retryAt) {
        await markTaskQueuedForRetry(supabase, task.id, message, retryAt, {
          ...task.payload,
          failureMessage: message,
          failureCode: failureCodeForError(error),
          retryCount,
          nextRetryAt: retryAt,
        });
      } else {
        await markTaskFailed(supabase, task.id, message, {
          ...task.payload,
          failureMessage: message,
          failureCode: failureCodeForError(error),
          retryCount,
        });
      }

      runtimeState.lastTaskFailedAt = new Date().toISOString();
      runtimeState.lastFailedTask = taskSummary;
      runtimeState.lastError = message;
      logWorkerEvent(runtimeState, {
        level: retryAt ? "warn" : "error",
        source: retryAt ? "worker.task.retry" : "worker.task.failure",
        message: retryAt
          ? `Retrying ${task.task_type} ${task.id} at ${retryAt}: ${message}`
          : `Failed ${task.task_type} ${task.id}: ${message}`,
        context: {
          ...buildTaskContext(task),
          retryCount,
          nextRetryAt: retryAt,
        },
        error,
      });
    } finally {
      runtimeState.currentTask = null;
    }
  }

  await healthServer.close();
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      service: "overdrafter-cad-worker",
      level: "error",
      source: "worker.startup.fatal",
      message: error instanceof Error ? error.message : String(error),
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack ?? null,
            }
          : null,
    }),
  );
  process.exit(1);
});
