import "dotenv/config";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { captureOperationalJevConsumer, observeBoundOperationalFailure, type OperationalJevTaskCapability } from "./jev/operationalSession.js";
import type { PostgrestResponse, SupabaseClient } from "@supabase/supabase-js";
import { buildAdapterRegistry } from "./adapters/index.js";
import { autoApproveJobRequirements } from "./autoApprove.js";
import { XOMETRY_AUTOMATION_VERSION } from "./adapters/xometry.js";
import { loadConfig } from "./config.js";
import { runHybridExtraction } from "./extraction/hybridExtraction.js";
import { buildGeometryProjectionArtifact } from "./extraction/geometryProjection.js";
import {
  buildStoredExtractionPayload,
  currentExtractorVersion,
  summarizeExtractionOutcome,
} from "./extraction/sharedResult.js";
import {
  ExtractionModelCatalogManager,
  previewStoredPartExtraction,
} from "./extraction/debugLab.js";
import {
  extractPdfText,
  renderPdfFirstPagePreview,
  renderPdfPreviewAssets,
} from "./extraction/pdfDrawing.js";
import {
  cleanupPaths,
  createRunDir,
  stageStorageObject,
  uploadArtifact,
} from "./files.js";
import { buildQuoteLaneScopeSnapshot, parseWorkerSourcingIntent } from "./quoteScope.js";
import {
  claimNextTask,
  createServiceClient,
  markTaskCancelled,
  markTaskCompleted,
  markTaskFailed,
  markTaskQueuedForRetry,
  reapStaleTasks,
} from "./queue.js";
import {
  createWorkerRuntimeState,
  getXometrySessionAgeDays,
  recordRuntimeEvent,
  startHealthServer,
  type WorkerRuntimeState,
} from "./httpServer.js";
import {
  buildWorkerTaskFailureEvidence,
  summarizeWorkerError,
  summarizeWorkerErrorName,
} from "./errorSummary.js";
import { suggestLocatorUpdate } from "./repair/suggestLocatorUpdate.js";
import { prepareRuntimeSecrets, validateWorkerReadiness } from "./runtimeSecrets.js";
import { fetchPartContext } from "./partContext.js";
import {
  ApprovedRequirementRecord,
  DrawingExtractionPayload,
  JobFileRecord,
  PartRecord,
  QueueTaskRecord,
  VendorArtifact,
  VendorAutomationError,
  VendorName,
  VendorQuoteAdapterInput,
  WorkerConfig,
} from "./types.js";
import { buildExtractionCompletionPayload } from "./extractionObservability.js";
import { createSpendGuard, SpendCapExceededError } from "./spendGuard.js";
import {
  ExportMarkingRescanTaskInvalidError,
  failureCodeForError,
  isRetryableExportRescanError,
  isRetryableVendorTaskError,
  nextRetryAt,
  retryCountForAttempts,
} from "./vendorTaskRetry.js";
import {
  createProviderMutationPhase,
  currentProviderMutationPhase,
  markProviderMutationStarted,
  providerMutationEvidence,
  runInProviderMutationPhase,
} from "./providerMutationPhase.js";
import { aggregateQuoteRunStatus } from "./quoteRunStatus.js";
import { isProductionEnvironment, shouldWarnSimulateModeInProduction } from "./runtimeEnvironment.js";
import { computeAndStoreRoutingScores } from "./scoringIntegration.js";
import {
  assertExportControlExtractionAllowed,
  enforceAndRecordStepHeaderScan,
  ExportControlDrawingUnreadError,
  ExportControlLookupError,
  exportControlModelAttemptGuard,
  exportScanOutcomesPayload,
  type ExportScanOutcomes,
  isStepFileName,
  readStagedStepHeaderPrefix,
  runExportMarkingRescan,
  scanDrawingForExtraction,
  scanPartStepHeaderForExtraction,
  ExportControlStepScanRetryableError,
  scanStagedDrawingForExportMarkings,
} from "./exportControl.js";
import { buildVendorQuoteOfferPayloads } from "./vendorQuoteOffer.js";
import { finalizeVendorQuoteResult } from "./vendorQuoteOfferPersistence.js";
import {
  enqueueCadPreviewGenerationTask,
  ensurePersistentCadPreview,
} from "./cadPreviewPersistence.js";
import { isRetryableCadPreviewError } from "./cadPreview.js";
import { isDirectExtractionModelId } from "./extraction/modelRegistry.js";
import {
  assertExportControlDispatchAllowed,
  dispatchAuthorizationFailure,
  exportControlHoldNote,
  exportControlHoldReason,
  providerDispatchClaimFromTask,
  quoteWithRoutedDispatchPreflight,
  withExportControlDispatchRecheck,
} from "./dispatchRouting.js";
import {
  cancelVendorTaskForDisabledProvider,
  checkProviderKillSwitchAtClaim,
  guardProviderDispatch,
  markTaskCancelledForDisabledProvider,
  failVendorResultForUnavailableKillSwitch,
  PROVIDER_DAILY_CAP_REACHED,
  ProviderKillSwitchError,
  isProviderKillSwitchEngaged,
  providerKillSwitchSweepWarnings,
  providerDispatchCapMode,
  supabaseProviderSettingsPort,
  sweepProviderDisabledTasks,
} from "./providerSettings.js";
import { createProviderAuthorizationConsumer } from "./providerExecutionSeam.js";
import {
  createProviderDaySwitch,
  PROVIDER_PAUSED_FIXTURE_HEAL,
  providerPackageId,
  type ProviderTaskOutcome,
} from "./providerTaskPipeline.js";
import {
  createFixtureSanityGate,
  failClosedSanityOutput,
  type FixtureSanityContext,
  type FixtureSanityGate,
  type FixtureSanityGateResult,
} from "./fixtureHeal/gate.js";
import { createSupplierPauseSwitch, internalTestQuotePolicyFromEnv, isInternalTestQuote } from "./fixtureHeal/pause.js";
import { createSupabaseSanityHistoryReader } from "./fixtureHeal/sanityHistory.js";
import {
  preserveDerivedValiditySource,
  providerTaskFailureRecord,
  providerTaskOutcomeNote,
  runGenericProviderTask,
} from "./providerTaskRoute.js";
import { createSupabaseProviderTaskLeasePort } from "./providerTaskLeasePort.js";

// OVD-464: process wide state for the generic provider route. The replay
// record is keyed by permit and fingerprint, so one permit dispatches at most
// once in this process; the day switch turns a provider off until the next
// UTC midnight after a block or ban.
const providerAuthorizationConsumer = createProviderAuthorizationConsumer();
const providerDaySwitch = createProviderDaySwitch();
/**
 * OVD-813: process-local drift pause (no timer release; durable engage is
 * OVD-771 / slice 2). Exported so tests and the later re-verify/heal flow can
 * read and release it.
 */
export const fixtureHealSupplierPause = createSupplierPauseSwitch();

function fixtureSanityGateFor(supabase: SupabaseClient): FixtureSanityGate {
  return createFixtureSanityGate({ history: createSupabaseSanityHistoryReader(supabase), pause: fixtureHealSupplierPause });
}

/** Package identity of the staged files, matching `providerPackageId` on the generic route; null without a CAD digest. */
function stagedPackageId(files: { cad: { trustedContentSha256?: string | null } | null; drawing: { trustedContentSha256?: string | null } | null }) {
  const cadSha = files.cad?.trustedContentSha256;
  if (!cadSha) return null;
  const drawingSha = files.drawing?.trustedContentSha256;
  return providerPackageId([{ role: "cad", sha256: cadSha }, ...(drawingSha ? [{ role: "drawing", sha256: drawingSha }] : [])]);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Booked per model attempt before the call, then replaced by the observed cost.
 *
 * Deliberately generous relative to a typical extraction: the reservation has to
 * be made before token counts are known, and over-booking briefly is the safe
 * direction. Under-booking would let a burst of concurrent calls collectively
 * overshoot the ceiling.
 */
const MODEL_CALL_SPEND_ESTIMATE_USD = 0.25;

/** Booked per vendor automation lane, covering its browser container time. */
const VENDOR_RUN_SPEND_ESTIMATE_USD = 0.05;

class CanonicalArtifactsPendingError extends Error {
  constructor(sourcePartId: string) {
    super(`Canonical part artifacts are still being prepared by source part ${sourcePartId}.`);
    this.name = "CanonicalArtifactsPendingError";
  }
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
    serviceRequestLineItemId:
      typeof task.payload.serviceRequestLineItemId === "string" ? task.payload.serviceRequestLineItemId : null,
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

function logPreviewRenderWarning(task: QueueTaskRecord, stage: "all_pages" | "first_page", error: unknown) {
  console.warn(
    JSON.stringify({
      service: "overdrafter-cad-worker",
      level: "warn",
      source: "worker.preview.render",
      message: `Failed to render ${stage === "all_pages" ? "all page previews" : "the first-page preview"} for ${task.task_type} ${task.id}: ${summarizeWorkerError(error)}`,
      context: {
        ...buildTaskContext(task),
        stage,
      },
      error: {
        name: summarizeWorkerErrorName(error),
        message: summarizeWorkerError(error),
      },
    }),
  );
}

function logCadPreviewWarning(task: QueueTaskRecord, error: unknown) {
  console.warn(
    JSON.stringify({
      service: "overdrafter-cad-worker",
      level: "warn",
      source: "worker.cad-preview.render",
      message: `Failed to generate the persistent CAD preview for ${task.task_type} ${task.id}: ${summarizeWorkerError(error)}`,
      context: buildTaskContext(task),
      error: {
        name: summarizeWorkerErrorName(error),
        message: summarizeWorkerError(error),
      },
    }),
  );
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
  const {
    nextQuoteRunStatus,
    nextJobStatus,
    successfulVendorQuotes,
    manualReviewVendorQuotes,
    failedVendorQuotes,
  } = aggregateQuoteRunStatus(statuses);

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

function resolveDebugExtractionModel(config: WorkerConfig, requestedModel: unknown) {
  const requested =
    typeof requestedModel === "string" && requestedModel.trim().length > 0
      ? requestedModel.trim()
      : config.drawingExtractionModel;

  if (!isDirectExtractionModelId(requested)) {
    throw new Error("Debug extraction requires a direct OpenAI or Anthropic model.");
  }

  if (!config.drawingExtractionDebugAllowedModels.includes(requested)) {
    throw new Error(
      `Debug extraction model "${requested}" is not allowlisted. Allowed models: ${config.drawingExtractionDebugAllowedModels.join(", ")}`,
    );
  }

  return requested;
}

async function runDrawingExtractionForTask(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
  config: WorkerConfig,
  requestedModel: string | null = null,
) {
  if (!task.part_id || !task.job_id) {
    throw new Error(`${task.task_type} task is missing job_id or part_id.`);
  }

  const context = await fetchPartContext(supabase, task.part_id);
  const runDir = await createRunDir(config, ["extract", task.id]);
  const stagedDrawingFile = await stageStorageObject(supabase, context.drawingFile, runDir);

  try {
    const pdfText = stagedDrawingFile ? await extractPdfText(stagedDrawingFile.localPath) : null;
    // OVD-723: a marking hit records a blocked_pending_review block and fails
    // the task before any model call; a clean result records a clean scan,
    // which dispatch requires. A failed record also fails the task.
    // The clean scan is bound to the hash of the staged bytes; without a
    // staged file there is no hash, and a record attempt fails closed. A
    // drawing with any unread page gets no clean scan and the task stops
    // before any model call.
    await scanDrawingForExtraction(supabase, {
      jobId: task.job_id,
      partId: task.part_id,
      drawingFile: context.drawingFile,
      contentSha256: stagedDrawingFile?.trustedContentSha256 ?? "",
      pdfText,
    });
    let previewAssets = [] as Awaited<ReturnType<typeof renderPdfPreviewAssets>>;

    if (stagedDrawingFile && pdfText) {
      try {
        previewAssets = await renderPdfPreviewAssets(stagedDrawingFile.localPath, runDir, pdfText.pageCount);
      } catch (error) {
        logPreviewRenderWarning(task, "all_pages", error);
        previewAssets = [];
      }
    }

    let firstPagePreviewPath =
      previewAssets.find((asset) => asset.kind === "page" && asset.pageNumber === 1)?.localPath ?? null;

    if (stagedDrawingFile && !firstPagePreviewPath) {
      let fallbackPreviewAsset = null;

      try {
        fallbackPreviewAsset = await renderPdfFirstPagePreview(
          stagedDrawingFile.localPath,
          path.join(runDir, "drawing-page-1.png"),
        );
      } catch (error) {
        logPreviewRenderWarning(task, "first_page", error);
      }

      if (fallbackPreviewAsset) {
        previewAssets = [
          ...previewAssets.filter(
            (asset) => !(asset.kind === "page" && asset.pageNumber === fallbackPreviewAsset.pageNumber),
          ),
          fallbackPreviewAsset,
        ];
        firstPagePreviewPath = fallbackPreviewAsset.localPath;
      }
    }

    const effectiveModel = requestedModel
      ? resolveDebugExtractionModel(config, requestedModel)
      : config.drawingExtractionModel;
    const extractionConfig =
      effectiveModel === config.drawingExtractionModel
        ? config
        : {
            ...config,
            drawingExtractionModel: effectiveModel,
          };
    // OVD-723: no CAD or drawing content reaches a model unless the job's
    // latest declaration is not_controlled with no open or confirmed block.
    await assertExportControlExtractionAllowed(supabase, { jobId: task.job_id });
    const extraction = await runHybridExtraction({
      part: context.part,
      cadFile: context.cadFile,
      drawingFile: context.drawingFile,
      pdfText,
      drawingPath: stagedDrawingFile?.localPath ?? null,
      previewPagePath: firstPagePreviewPath,
      runDir,
      config: extractionConfig,
      // OVD-723: asked again before each model attempt (title block crop,
      // full page), so a declaration or block that lands after the check
      // above stops the next attempt before any content is sent.
      beforeModelAttempt: exportControlModelAttemptGuard(supabase, { jobId: task.job_id }),
      // Budget is enforced here rather than at request admission: a ceiling
      // checked when a user clicks something cannot stop a retry storm or a
      // stuck loop, which is the shape a runaway actually takes.
      spend: {
        guard: createSpendGuard(supabase, task.organization_id),
        estimatedUsd: MODEL_CALL_SPEND_ESTIMATE_USD,
        context: { jobId: task.job_id, partId: task.part_id, taskId: task.id },
      },
    });
    const extractionOutcome = summarizeExtractionOutcome(extraction);
    const extractorVersion = currentExtractorVersion(Boolean(stagedDrawingFile));
    const geometryProjection = buildGeometryProjectionArtifact({
      extraction,
      requirement: context.requirement,
      extractorVersion,
    });

    if (process.env.EXTRACTION_DEBUG === "true" && extraction.debugCandidates) {
      console.log(
        JSON.stringify({
          service: "overdrafter-cad-worker",
          source: task.task_type,
          message: "drawing extraction candidate ranking",
          partId: context.part.id,
          reviewFields: extraction.reviewFields,
          candidates: extraction.debugCandidates,
        }),
      );
    }

    return {
      context,
      runDir,
      stagedDrawingFile,
      pdfText,
      previewAssets,
      firstPagePreviewPath,
      extraction,
      extractionOutcome,
      extractorVersion,
      geometryProjection,
      effectiveModel,
    };
  } catch (error) {
    await cleanupPaths([runDir]);
    throw error;
  }
}

// Keep in sync with the extract_part cases in processClaimedTask's shouldRetry.
function isRetryableExtractError(error: unknown): boolean {
  return (
    error instanceof CanonicalArtifactsPendingError ||
    error instanceof ExportControlLookupError ||
    error instanceof ExportControlStepScanRetryableError
  );
}

async function handleExtractTask(supabase: SupabaseClient, task: QueueTaskRecord, config: WorkerConfig) {
  let runDir: string | null = null;
  let organizationIdForError: string | null = null;
  let partIdForError: string | null = task.part_id;
  // OVD-723: per file scan outcomes, recorded in the task payload on
  // completion and on an unread drawing failure (exportScanOutcomes).
  const exportScanOutcomes: ExportScanOutcomes = {};
  try {
    const identityContext = await fetchPartContext(supabase, task.part_id!);
    organizationIdForError = identityContext.part.organization_id;
    partIdForError = identityContext.part.id;
    const identityStageDir = await createRunDir(config, ["identity", task.id]);
    runDir = identityStageDir;
    const identityStagedCad = await stageStorageObject(supabase, identityContext.cadFile, identityStageDir);
    const identityStagedDrawing = await stageStorageObject(supabase, identityContext.drawingFile, identityStageDir);
    // OVD-723 review round 5: scan the STEP header here, on both the reuse and
    // the extraction path, so a new STEP part has its scan of record (or a
    // held outcome) before any quote is requested. No model is called.
    await scanPartStepHeaderForExtraction(supabase, {
      jobId: task.job_id!,
      partId: task.part_id,
      cadFile: identityContext.cadFile,
      stagedCad: identityStagedCad,
      readPrefix: readStagedStepHeaderPrefix,
    }, exportScanOutcomes);

    const { data: trustedIntake, error: trustedIntakeError } = await supabase.rpc(
      "api_resolve_trusted_part_intake",
      { p_part_id: task.part_id },
    );
    if (trustedIntakeError) {
      throw trustedIntakeError;
    }

    const trustedResult = trustedIntake && typeof trustedIntake === "object"
      ? trustedIntake as {
          result?: unknown;
          partVersionId?: unknown;
          sourcePartId?: unknown;
        }
      : null;
    const sourcePartId = typeof trustedResult?.sourcePartId === "string"
      ? trustedResult.sourcePartId
      : null;
    const partVersionId = typeof trustedResult?.partVersionId === "string"
      ? trustedResult.partVersionId
      : null;

    if (trustedResult?.result === "existing_version" && sourcePartId && partVersionId) {
      const { data: reuseResult, error: reuseError } = await supabase.rpc(
        "api_reuse_trusted_part_version_artifacts",
        {
          p_target_part_id: task.part_id,
          p_source_part_id: sourcePartId,
          p_part_version_id: partVersionId,
        },
      );
      if (reuseError) {
        throw reuseError;
      }
      const artifactsReady = reuseResult && typeof reuseResult === "object"
        ? (reuseResult as { artifactsReady?: unknown }).artifactsReady === true
        : false;
      const extractTargetIndependently = reuseResult && typeof reuseResult === "object"
        ? (reuseResult as { extractTargetIndependently?: unknown }).extractTargetIndependently === true
        : false;
      if (!artifactsReady) {
        if (!extractTargetIndependently) {
          throw new CanonicalArtifactsPendingError(sourcePartId);
        }
      } else {
        // OVD-723: reuse skips extraction, so this part's own drawing has not
        // been scanned in this job. Scan it here; a hit blocks this job, and
        // without a clean scan dispatch is denied (export_scan_missing).
        await scanStagedDrawingForExportMarkings(supabase, {
          jobId: task.job_id!,
          partId: task.part_id,
          drawingFile:
            identityContext.drawingFile && identityStagedDrawing
              ? {
                  id: identityContext.drawingFile.id,
                  localPath: identityStagedDrawing.localPath,
                  contentSha256: identityStagedDrawing.trustedContentSha256 ?? "",
                }
              : null,
          extractText: extractPdfText,
        }, exportScanOutcomes);
        // A missing approval for this part is a review hold, even when the
        // job-wide RPC count includes approvals for other parts.
        const autoApproval = await autoApproveJobRequirements(
          supabase,
          task.job_id!,
          identityContext.part.id,
          identityContext.part.organization_id,
        );
        await logWorkerAuditEvent(supabase, {
          organizationId: identityContext.part.organization_id,
          jobId: task.job_id!,
          eventType: "worker.extraction_completed",
          payload: {
            partId: identityContext.part.id,
            reusedCanonicalPartVersion: true,
            sourcePartId,
            autoApprovedPartCount: autoApproval.approvedCount,
            reviewRequired: autoApproval.reviewHold,
          },
        });
        await markTaskCompleted(supabase, task, {
          canonicalPartVersionId: partVersionId,
          reusedCanonicalPartVersion: true,
          sourcePartId,
          autoApprovedPartCount: autoApproval.approvedCount,
          reviewRequired: autoApproval.reviewHold,
          exportScanOutcomes,
        });
        return;
      }
    }

    await cleanupPaths([identityStageDir]);
    runDir = null;
    const extractionRun = await runDrawingExtractionForTask(supabase, task, config);
    runDir = extractionRun.runDir;
    const { context, extraction, extractionOutcome, pdfText, previewAssets, extractorVersion, geometryProjection } =
      extractionRun;
    organizationIdForError = context.part.organization_id;
    partIdForError = context.part.id;

    const { error } = await supabase.from("drawing_extractions").upsert(
      {
        part_id: context.part.id,
        organization_id: context.part.organization_id,
        extractor_version: extractorVersion,
        extraction: buildStoredExtractionPayload(
          extraction,
          pdfText?.pageCount ?? 0,
          config.workerBuildVersion,
          geometryProjection,
        ),
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
      jobId: task.job_id!,
      previewAssets,
    });
    let cadPreviewStatus: "current" | "generated" | "skipped" | "failed" = "skipped";
    try {
      const cadPreviewResult = await ensurePersistentCadPreview(supabase, config, {
        organizationId: context.part.organization_id,
        jobId: task.job_id!,
        partId: context.part.id,
        cadFile: context.cadFile,
        runDir: extractionRun.runDir,
      });
      cadPreviewStatus = cadPreviewResult.status;
    } catch (error) {
      cadPreviewStatus = "failed";
      logCadPreviewWarning(task, error);
      try {
        await enqueueCadPreviewGenerationTask(supabase, {
          organizationId: context.part.organization_id,
          jobId: task.job_id!,
          partId: context.part.id,
          cadFileId: context.cadFile?.id ?? null,
          source: "extract_part_retry",
        });
      } catch (enqueueError) {
        logCadPreviewWarning(task, enqueueError);
      }
    }
    // A missing approval for this part is a review hold, not a failure.
    const autoApproval = await autoApproveJobRequirements(
      supabase,
      task.job_id!,
      context.part.id,
      context.part.organization_id,
    );
    const completedAt = new Date().toISOString();
    const completionPayload = buildExtractionCompletionPayload({
      extraction,
      extractionOutcome,
      extractorVersion,
      workerBuildVersion: config.workerBuildVersion,
      previewAssetCount: previewAssets.length,
      autoApprovedPartCount: autoApproval.approvedCount,
      reviewRequired: autoApproval.reviewHold,
      completedAt,
    });
    await logWorkerAuditEvent(supabase, {
      organizationId: context.part.organization_id,
      jobId: task.job_id!,
      eventType: "worker.extraction_completed",
      payload: {
        partId: context.part.id,
        cadPreviewStatus,
        ...completionPayload,
      },
    });
    await markTaskCompleted(supabase, task, {
      cadPreviewStatus,
      ...completionPayload,
      exportScanOutcomes,
    });
  } catch (error) {
    if (error instanceof ExportControlDrawingUnreadError) {
      // The failed task records the STEP outcome with the unread drawing.
      error.exportScanOutcomes = { ...exportScanOutcomes, ...error.exportScanOutcomes };
    }
    // A retryable error requeues the task, so it is not an extraction failure.
    if (organizationIdForError && task.job_id && !isRetryableExtractError(error)) {
      try {
        await logWorkerAuditEvent(supabase, {
          organizationId: organizationIdForError,
          jobId: task.job_id,
          eventType: "worker.extraction_failed",
          payload: {
            partId: partIdForError,
            failureCode: failureCodeForError(error),
            failureMessage: summarizeWorkerError(error),
          },
        });
      } catch (auditError) {
        // Never let a failed audit write mask the original extraction error.
        console.warn(`extract_part ${task.id}: extraction_failed audit write failed: ${summarizeWorkerError(auditError)}`);
      }
    }
    throw error;
  } finally {
    await cleanupPaths(runDir ? [runDir] : []);
  }
}

async function handleGenerateCadPreviewTask(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
  config: WorkerConfig,
) {
  if (!task.part_id || !task.job_id) {
    throw new Error("generate_cad_preview task is missing job_id or part_id.");
  }

  const runDir = await createRunDir(config, ["cad-preview", task.id]);

  try {
    const context = await fetchPartContext(supabase, task.part_id);
    const result = await ensurePersistentCadPreview(supabase, config, {
      organizationId: context.part.organization_id,
      jobId: task.job_id,
      partId: context.part.id,
      cadFile: context.cadFile,
      runDir,
    });

    await logWorkerAuditEvent(supabase, {
      organizationId: context.part.organization_id,
      jobId: task.job_id,
      eventType: "worker.cad_preview_completed",
      payload: {
        partId: context.part.id,
        cadFileId: context.cadFile?.id ?? null,
        status: result.status,
        triangleCount: result.triangleCount,
        featureEdgeCount: result.featureEdgeCount,
      },
    });
    await markTaskCompleted(supabase, task, {
      cadPreviewStatus: result.status,
      triangleCount: result.triangleCount,
      featureEdgeCount: result.featureEdgeCount,
    });
  } finally {
    await cleanupPaths([runDir]);
  }
}

async function handleDebugExtractTask(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
  config: WorkerConfig,
) {
  const debugRunId =
    typeof task.payload.debugRunId === "string" && task.payload.debugRunId.length > 0
      ? task.payload.debugRunId
      : null;

  if (!debugRunId) {
    throw new Error("debug_extract_part task is missing debugRunId.");
  }

  const requestedModel =
    typeof task.payload.requestedModel === "string" && task.payload.requestedModel.trim().length > 0
      ? task.payload.requestedModel.trim()
      : null;

  await supabase
    .from("debug_extraction_runs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      error: null,
    })
    .eq("id", debugRunId);

  let runDir: string | null = null;

  try {
    const extractionRun = await runDrawingExtractionForTask(
      supabase,
      task,
      config,
      requestedModel,
    );
    runDir = extractionRun.runDir;
    const {
      context,
      extraction,
      extractionOutcome,
      pdfText,
      previewAssets,
      effectiveModel,
      extractorVersion,
      geometryProjection,
    } =
      extractionRun;
    const result = {
      extraction: buildStoredExtractionPayload(
        extraction,
        pdfText?.pageCount ?? 0,
        config.workerBuildVersion,
        geometryProjection,
      ),
      status: extraction.status,
      warnings: extraction.warnings,
      evidence: extraction.evidence,
      summary: extractionOutcome,
      preview: {
        pageCount: pdfText?.pageCount ?? 0,
        previewAssetCount: previewAssets.length,
        hasPreviewImage: previewAssets.some((asset) => asset.kind === "page" && asset.pageNumber === 1),
      },
    };

    const { error: debugRunError } = await supabase
      .from("debug_extraction_runs")
      .update({
        status: "completed",
        effective_model: effectiveModel,
        worker_build_version: config.workerBuildVersion,
        extractor_version: extractorVersion,
        model_fallback_used: extraction.modelFallbackUsed ?? false,
        model_prompt_version: extraction.modelPromptVersion ?? null,
        result,
        error: null,
        completed_at: new Date().toISOString(),
      })
      .eq("id", debugRunId);

    if (debugRunError) {
      throw debugRunError;
    }

    await logWorkerAuditEvent(supabase, {
      organizationId: context.part.organization_id,
      jobId: task.job_id!,
      eventType: "worker.debug_extraction_completed",
      payload: {
        partId: context.part.id,
        debugRunId,
        requestedModel,
        effectiveModel,
        workerBuildVersion: config.workerBuildVersion,
        extractorVersion,
        extractionStatus: extraction.status,
        extractionLifecycle: extractionOutcome.lifecycle,
        warningCount: extraction.warnings.length,
        missingFields: extractionOutcome.missingFields,
        reviewFields: extractionOutcome.reviewFields,
      },
    });

    await markTaskCompleted(supabase, task, {
      debugRunId,
      requestedModel,
      effectiveModel,
      workerBuildVersion: config.workerBuildVersion,
      extractorVersion,
      extractionStatus: extraction.status,
      extractionLifecycle: extractionOutcome.lifecycle,
      warningCount: extraction.warnings.length,
      missingFields: extractionOutcome.missingFields,
      reviewFields: extractionOutcome.reviewFields,
    });
  } catch (error) {
    await supabase
      .from("debug_extraction_runs")
      .update({
        status: "failed",
        effective_model: requestedModel ?? config.drawingExtractionModel,
        worker_build_version: config.workerBuildVersion,
        error: summarizeWorkerError(error),
        completed_at: new Date().toISOString(),
      })
      .eq("id", debugRunId);

    throw error;
  } finally {
    await cleanupPaths(runDir ? [runDir] : []);
  }
}

/**
 * Runs vendor automation while moving the quote result through running and terminal states.
 * Retryable automation or persistence failures are rethrown for queue retry; terminal
 * failures are recorded on the result before the task completes.
 */
export async function handleVendorQuoteTask(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
  config: WorkerConfig,
  operationalJev?: OperationalJevTaskCapability,
) {
  const advisory = operationalJev ? Object.freeze({ ...operationalJev,
    session: captureOperationalJevConsumer(operationalJev.session) }) : undefined;
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

  const requestStatusAtStart = await fetchQuoteRequestStatusForTask(supabase, task);

  if (requestStatusAtStart === "canceled") {
    await markTaskCancelled(supabase, task, "Canceled before vendor automation started.", {
      ignoredDueToCanceledRequest: true,
    });
    return;
  }

  const context = await fetchPartContext(supabase, task.part_id);

  if (!context.requirement) {
    throw new Error(`No approved requirement found for part ${task.part_id}.`);
  }
  const requirementCapturedAt = context.requirement.updated_at;
  if (!requirementCapturedAt) {
    throw new Error(
      `Approved requirement ${context.requirement.id} is missing its update timestamp.`,
    );
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

  // OVD-722: a switched-off provider's queued task ends truthfully at claim,
  // before the lane is marked running or anything is staged.
  if (config.workerMode === "live") {
    let claimCheck: "proceed" | "cancelled";
    try {
      claimCheck = await checkProviderKillSwitchAtClaim({
        supabase,
        task,
        vendor,
        vendorQuoteResultId: currentResult.id,
        requestedQuantity: currentResult.requested_quantity,
      });
    } catch (error) {
      // An unreadable switch is retried by the queue loop. When its retries are
      // spent the loop fails the task, so the lane must settle visibly too;
      // otherwise it would stay queued with no task left to run it.
      if (error instanceof ProviderKillSwitchError && nextRetryAt(task.attempts) === null) {
        // A database error while settling must not replace the kill switch
        // error: the queue loop needs it to fail the task with the right code.
        try {
          await failVendorResultForUnavailableKillSwitch(supabase, {
            vendorQuoteResultId: currentResult.id,
            error,
            retryCount,
            requestedQuantity: currentResult.requested_quantity,
          });
          await syncJobStatusAfterVendorUpdate(supabase, task.job_id, task.quote_run_id);
        } catch (settleError) {
          console.warn(
            JSON.stringify({
              service: "overdrafter-cad-worker",
              level: "warn",
              source: "worker.kill_switch",
              message: `Could not settle the lane after the kill switch read failed: ${summarizeWorkerError(settleError)}`,
              context: { taskId: task.id, vendorQuoteResultId: currentResult.id },
            }),
          );
        }
      }
      throw error;
    }
    if (claimCheck === "cancelled") {
      await syncJobStatusAfterVendorUpdate(supabase, task.job_id, task.quote_run_id);
      return;
    }
  }

  // OVD-813: a supplier the sanity gate paused runs only verified internal
  // test quotes. Checked after the kill switch, which always wins, and before
  // anything is staged or sent.
  const internalTestQuote = isInternalTestQuote(
    { marker: task.payload.fixtureHeal, organizationId: task.organization_id, partId: task.part_id },
    internalTestQuotePolicyFromEnv(process.env),
  );
  if (config.workerMode === "live" && !fixtureHealSupplierPause.admits(vendor, { internalTestQuote })) {
    // Compare and set like every other terminal lane write: a lane already
    // settled elsewhere is left as is and the task fails with a stable code.
    const pauseWrite = await writeUnsettledVendorQuoteResult(supabase, currentResult.id, {
      status: "manual_vendor_followup",
      notes: [`${vendor} is paused while its quoting is re-verified; manual vendor follow-up is required.`],
      raw_payload: {
        requiresManualVendorFollowUp: true,
        manualFollowUpReason: PROVIDER_PAUSED_FIXTURE_HEAL,
        failureCode: PROVIDER_PAUSED_FIXTURE_HEAL,
        requestedQuantity: currentResult.requested_quantity,
        retryCount,
      },
    });
    if (pauseWrite !== "written") {
      await settleUnwrittenProviderOutcome(supabase, task, pauseWrite, false);
      return;
    }
    await syncJobStatusAfterVendorUpdate(supabase, task.job_id, task.quote_run_id);
    await markTaskCompleted(supabase, task, {
      vendorStatus: "manual_vendor_followup",
      manualVendor: true,
      manualReasonCode: PROVIDER_PAUSED_FIXTURE_HEAL,
    });
    return;
  }

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

  const operationalScope = Object.freeze({ organizationId: task.organization_id, taskId: task.id,
    quoteRunId: task.quote_run_id, provider: vendor, sourceRevision: advisory?.sourceRevision ?? "" });
  const adapters = buildAdapterRegistry(config, advisory ? { session: advisory.session, scope: operationalScope,
    observations: advisory.observations, freshBrowserRecovery: advisory.freshBrowserRecovery, engineeringCatalog: advisory.engineeringCatalog,
  } : undefined);
  const adapter = adapters[vendor];
  const artifactDirs = new Set<string>();
  let stageDir: string | null = null;

  let stagedCadFile: Awaited<ReturnType<typeof stageStorageObject>> = null;
  let stagedDrawingFile: Awaited<ReturnType<typeof stageStorageObject>> = null;
  // Only container time actually consumed should be charged. Staging can fail
  // before the browser ever launches, and settling the full estimate for a lane
  // that never started would hold budget for spend that did not happen.
  let vendorAutomationStarted = false;
  // OVD-723: the export stop the generic route raised while the pipeline's own
  // mutation phase was still unmarked (no upload yet). The lane is held either
  // way; this only picks the note that says nothing was sent.
  let exportStopBeforeProviderMutation: unknown = null;
  // Set once vendor_quote_results and its offers are written atomically. From
  // then on a bookkeeping failure must never overwrite that result.
  let resultPersisted = false;

  // Every failure of this lane, before or after the spend reservation, ends
  // here: an export-control hold closes the lane, a denied dispatch becomes
  // manual follow-up, anything else is recorded and rethrown for retry.
  // The task's ids were checked non-null at entry; the closure below keeps them narrowed.
  const laneJobId = task.job_id;
  const lanePartId = task.part_id;
  const laneQuoteRunId = task.quote_run_id;
  const handleLaneFailure = async (error: unknown): Promise<void> => {
    if (advisory) await observeBoundOperationalFailure({ ...advisory, scope: operationalScope }, operationalScope, error);
    if (resultPersisted) {
      await settlePostPersistBookkeepingFailure(supabase, task, error);
      return;
    }
    // OVD-722: an engaged switch at any checkpoint (before launch, or inside
    // the adapter before navigation/upload/configure) ends the task as
    // cancelled_provider_disabled, never as a provider failure or a retry.
    if (isProviderKillSwitchEngaged(error)) {
      await cancelVendorTaskForDisabledProvider(supabase, task, {
        vendorQuoteResultId: currentResult.id,
        error,
        requestedQuantity: currentResult.requested_quantity,
        providerMutationPossible: providerMutationEvidence().providerMutationPossible === true,
      });
      await syncJobStatusAfterVendorUpdate(supabase, laneJobId, laneQuoteRunId);
      return;
    }
    const vendorError =
      error instanceof VendorAutomationError ? error : null;
    const dispatchAuthorizationError = dispatchAuthorizationFailure(error);
    const failureArtifacts = vendorError?.artifacts ?? [];
    failureArtifacts.forEach((artifact) => artifactDirs.add(path.dirname(artifact.localPath)));
    const failureArtifactStoragePaths =
      failureArtifacts.length > 0
        ? await persistVendorArtifacts(supabase, config, {
            vendorQuoteResultId: currentResult.id,
            organizationId: task.organization_id,
            quoteRunId: laneQuoteRunId,
            partId: lanePartId,
            vendor,
            artifacts: failureArtifacts,
          })
        : [];

    if (vendorError) {
      await enqueueRepairCandidate(supabase, task, vendorError);
    }

    // OVD-723: an export-control hold (a gate denial, a marking hit while
    // staging, or a lookup that failed through every retry) is terminal and
    // never becomes manual vendor follow-up: quoting held files by hand would
    // send them to the vendor the gate refused. The lane is closed as failed,
    // so it stays out of the manual quote queue, and the task completes so it
    // is never retried (a retry would only rescan and refuse again). A lookup
    // that failed after the adapter started is held too: the provider may
    // already hold an upload, so the task is never requeued.
    const providerMutationStarted = currentProviderMutationPhase()?.started === true;
    const exportControlHold =
      exportControlHoldReason(error)
      ?? (error instanceof ExportControlLookupError
        && (providerMutationStarted || nextRetryAt(task.attempts) === null) ? error.reasonCode : null);
    if (exportControlHold) {
      const holdWrite = await writeUnsettledVendorQuoteResult(supabase, currentResult.id, {
        status: "failed",
        notes: [exportControlHoldNote({
          providerMutationStarted,
          stopBeforeProviderMutation: error === exportStopBeforeProviderMutation,
          lookupFailed: error instanceof ExportControlLookupError,
        })],
        raw_payload: {
          ...buildFailureRawPayload(vendor, retryCount, exportControlHold, {}, failureArtifactStoragePaths),
          ...providerMutationEvidence(),
          requestedQuantity: currentResult.requested_quantity,
          retryScheduledFor: null,
          requiresManualVendorFollowUp: false,
          manualFollowUpReason: null,
          exportControlHold: true,
          exportControlReasonCode: exportControlHold,
        },
      });
      if (holdWrite !== "written") {
        await settleUnwrittenProviderOutcome(supabase, task, holdWrite, providerMutationStarted);
        return;
      }
      await syncJobStatusAfterVendorUpdate(supabase, laneJobId, laneQuoteRunId);
      await markTaskCompleted(supabase, task, {
        vendorStatus: "failed",
        exportControlHold: true,
        failureCode: exportControlHold,
      });
      return;
    }

    const failureCode = dispatchAuthorizationError
      ? dispatchAuthorizationError.reasonCode
      : failureCodeForError(error);
    const failureMessage = summarizeWorkerError(error);
    // An unreadable kill switch is retryable only before any provider mutation.
    const retryableDispatchAuthorizationError =
      dispatchAuthorizationError?.retryable === true &&
      (dispatchAuthorizationError.boundary !== "kill_switch" || isRetryableVendorTaskError(error));
    const requiresManualVendorFollowUp =
      vendorError?.code === "not_implemented" ||
      Boolean(dispatchAuthorizationError && !retryableDispatchAuthorizationError);
    const retryAt =
      requiresManualVendorFollowUp ||
      !(retryableDispatchAuthorizationError || isRetryableVendorTaskError(error))
        ? null
        : nextRetryAt(task.attempts);
    let manualReasonCode: string | null = null;
    if (dispatchAuthorizationError && !retryableDispatchAuthorizationError) {
      manualReasonCode = dispatchAuthorizationError.reasonCode;
    } else if (requiresManualVendorFollowUp) {
      manualReasonCode = "adapter_not_implemented";
    }
    let resultStatus: "queued" | "manual_vendor_followup" | "failed" = "failed";
    if (requiresManualVendorFollowUp) {
      resultStatus = "manual_vendor_followup";
    } else if (retryAt) {
      resultStatus = "queued";
    }
    let failureNote = failureMessage;
    if (dispatchAuthorizationError?.boundary === "kill_switch") {
      // After a provider mutation may have started the read failure is not
      // retryable and the lane goes to manual follow up; the note must not say
      // nothing was sent.
      if (requiresManualVendorFollowUp) {
        failureNote = `${vendor} kill switch state could not be confirmed after the upload started, so the provider may already hold the upload. Automation stopped and manual follow-up is required.`;
      } else if (retryableDispatchAuthorizationError && retryAt) {
        failureNote = `${vendor} kill switch state could not be confirmed, so nothing was sent. Retry scheduled for ${retryAt}.`;
      } else {
        failureNote = `${vendor} kill switch state could not be confirmed, so nothing was sent and automation stopped. It will not retry automatically.`;
      }
    } else if (dispatchAuthorizationError?.boundary === "provider_settings") {
      // OVD-829: refused by the supplier settings gate before launch.
      if (dispatchAuthorizationError.reasonCode === PROVIDER_DAILY_CAP_REACHED) {
        failureNote = `${vendor} reached its daily quote cap, so nothing was sent. Manual follow-up is required.`;
      } else if (retryAt) {
        failureNote = `${vendor} dispatch could not be counted against its daily quote cap, so nothing was sent. Retry scheduled for ${retryAt}.`;
      } else {
        failureNote = `${vendor} dispatch could not be counted against its daily quote cap, so nothing was sent and automation stopped. It will not retry automatically.`;
      }
    } else if (dispatchAuthorizationError?.boundary === "provider") {
      failureNote = retryableDispatchAuthorizationError && retryAt
        ? `${vendor} dispatch authorization is temporarily unavailable. Retry scheduled for ${retryAt}.`
        : `Automatic ${vendor} dispatch authorization was denied before adapter launch; manual follow-up is required.`;
    } else if (retryableDispatchAuthorizationError && retryAt) {
      failureNote = `Xometry dispatch authorization is temporarily unavailable. Retry scheduled for ${retryAt}.`;
    } else if (dispatchAuthorizationError) {
      failureNote =
        "Automatic Xometry dispatch authorization was denied before browser launch; manual follow-up is required.";
    } else if (requiresManualVendorFollowUp) {
      failureNote = `${vendor} live automation is not implemented; manual vendor follow-up is required.`;
    } else if (error instanceof ExportControlLookupError && retryAt) {
      failureNote = `The export-control check is temporarily unavailable. Nothing was sent to ${vendor}. Retry scheduled for ${retryAt}.`;
    } else if (retryAt) {
      failureNote = `Transient vendor automation failure. Retry scheduled for ${retryAt}. ${failureMessage}`;
    }

    const laneWrite = await writeUnsettledVendorQuoteResult(supabase, currentResult.id, {
      status: resultStatus,
      notes: [failureNote],
      raw_payload: {
        ...buildFailureRawPayload(
          vendor,
          retryCount,
          failureCode,
          vendorError?.payload ?? {},
          failureArtifactStoragePaths,
        ),
        ...providerMutationEvidence(),
        requestedQuantity: currentResult.requested_quantity,
        retryScheduledFor: retryAt,
        requiresManualVendorFollowUp,
        manualFollowUpReason: manualReasonCode,
      },
    }).catch(() => "written" as const); // The failure write was never checked here; an error keeps the old flow.
    if (laneWrite === "persisted") {
      // The atomic write committed but its acknowledgement was lost: the result
      // and offers stand, and the task must not be retried into a second quote.
      await settlePersistedResultTask(supabase, task, error, "persist_ack_lost");
      return;
    }

    await syncJobStatusAfterVendorUpdate(supabase, laneJobId, laneQuoteRunId);

    if (requiresManualVendorFollowUp) {
      await markTaskCompleted(supabase, task, {
          vendorStatus: "manual_vendor_followup",
        manualVendor: true,
        manualReasonCode,
        failureCode,
      });
      return;
    }

    throw error;
  };

  // OVD-723: the export-control gate runs before any route that could make
  // this lane manual work (an adapter not enabled in WORKER_LIVE_ADAPTERS, an
  // exhausted spend cap). A held job closes the lane as held here and never
  // becomes a manual quote task. The STEP header is scanned first, on every
  // quote, so the gate sees this file's scan of record; it is recorded clean
  // only when the whole header was read.
  try {
    stageDir = await createRunDir(config, ["staging", task.quote_run_id, task.part_id]);
    stagedCadFile = await stageStorageObject(supabase, context.cadFile, stageDir);
    stagedDrawingFile = await stageStorageObject(supabase, context.drawingFile, stageDir);
    if (stagedCadFile && context.cadFile && isStepFileName(context.cadFile.original_name)) {
      await enforceAndRecordStepHeaderScan(supabase, {
        jobId: task.job_id,
        partId: context.part.id,
        jobFileId: context.cadFile.id,
        localPath: stagedCadFile.localPath,
        contentSha256: stagedCadFile.trustedContentSha256 ?? "",
        readPrefix: readStagedStepHeaderPrefix,
      });
    }
    await assertExportControlDispatchAllowed(supabase, { taskId: task.id, vendor });
  } catch (error) {
    try {
      await handleLaneFailure(error);
    } finally {
      await cleanupPaths([stageDir, ...artifactDirs]);
    }
    return;
  }

  if (!adapter) {
    await cleanupPaths([stageDir]);
    const manualReasonCode = "adapter_not_enabled";

    await supabase
      .from("vendor_quote_results")
      .update({
        status: "manual_vendor_followup",
        notes: [
          config.workerMode === "live"
            ? `${vendor} is disabled by WORKER_LIVE_ADAPTERS and requires manual vendor follow-up.`
            : `${vendor} is configured as a manual/import quote source in this environment.`,
        ],
        raw_payload: {
          mode: config.workerMode,
          source: "manual-import-vendor",
          requiresManualVendorFollowUp: true,
          manualFollowUpReason: manualReasonCode,
          requestedQuantity: currentResult.requested_quantity,
          retryCount,
          failureCode: manualReasonCode,
          configuredLiveAdapters: config.workerLiveAdapters,
        },
      })
      .eq("id", currentResult.id);

    await syncJobStatusAfterVendorUpdate(supabase, task.job_id, task.quote_run_id);
    await markTaskCompleted(supabase, task, {
      vendorStatus: "manual_vendor_followup",
      manualVendor: true,
      manualReasonCode,
    });
    return;
  }

  // Browser automation bills as container time, so a lane is reserved before it
  // starts. Unlike the extraction path there is no degraded mode to fall back
  // to, so a refusal requeues the lane rather than failing it: the work is still
  // wanted, just not at this moment's price.
  const vendorSpendGuard = createSpendGuard(supabase, task.organization_id);
  let vendorReservation;
  try {
    vendorReservation = await vendorSpendGuard.reserve("vendor_automation", VENDOR_RUN_SPEND_ESTIMATE_USD, {
      jobId: task.job_id,
      partId: task.part_id,
      quoteRunId: task.quote_run_id,
      taskId: task.id,
    });
  } catch (error) {
    await cleanupPaths([stageDir]);
    if (error instanceof SpendCapExceededError) {
      const retryAt = nextRetryAt(task.attempts);

      // The result row was set to "running" before this point. Every other
      // terminal path here moves it on; without this it would sit reporting
      // "running" forever on a lane that was never going to run -- a
      // customer-facing quote that silently never resolves.
      const writeSpendCapLane = () =>
        supabase
          .from("vendor_quote_results")
          .update({
            status: retryAt ? "queued" : "manual_vendor_followup",
            notes: [
              retryAt
                ? `Spend cap reached; this lane will retry. ${error.message}`
                : `Spend cap reached and retries are exhausted; this lane needs manual vendor follow-up. ${error.message}`,
            ],
            raw_payload: {
              mode: config.workerMode,
              requiresManualVendorFollowUp: !retryAt,
              manualFollowUpReason: "spend_cap_reached",
              spendCapReasonCode: error.reasonCode,
              requestedQuantity: currentResult.requested_quantity,
              failureCode: "spend_cap_reached",
            },
          })
          .eq("id", currentResult.id);

      if (retryAt) {
        // Requeue first: the lane may only advertise a retry that is actually
        // scheduled. False means the task was settled elsewhere (cancelled,
        // say); queue.ts logs that and the lane is left as it is.
        const requeued = await markTaskQueuedForRetry(supabase, task, `Spend cap reached: ${error.message}`, retryAt, {
          spendCapReasonCode: error.reasonCode,
        });
        if (requeued) await writeSpendCapLane();
      } else {
        await writeSpendCapLane();
        // Retries are exhausted, but nothing about this lane is broken -- it was
        // priced out. Cancelling rather than failing keeps the distinction, so it
        // reads as "not run" instead of "tried and defective" and can simply be
        // requested again once budget is available.
        await markTaskCancelled(supabase, task, `Spend cap reached: ${error.message}`, {
          spendCapReasonCode: error.reasonCode,
        });
      }
      return;
    }
    throw error;
  }

  try {
    const { data: sourcingIntentData, error: sourcingIntentError } = await supabase.rpc(
      "api_get_worker_sourcing_intent",
      { p_job_id: task.job_id, p_part_id: context.part.id },
    );
    if (sourcingIntentError) {
      throw sourcingIntentError;
    }
    const sourcingIntent = parseWorkerSourcingIntent(sourcingIntentData);
    const scopeSnapshot = buildQuoteLaneScopeSnapshot({
      part: context.part,
      cadFile: context.cadFile,
      drawingFile: context.drawingFile,
      stagedCadFile,
      stagedDrawingFile,
      requirement: context.requirement,
      sourcingIntent,
      vendor,
      requestedQuantity: currentResult.requested_quantity,
    });
    const { error: laneRegistrationError } = await supabase.rpc(
      "api_register_quote_request_lane",
      {
        p_vendor_quote_result_id: currentResult.id,
        p_scope_snapshot: scopeSnapshot,
      },
    );
    if (laneRegistrationError) {
      throw laneRegistrationError;
    }
    if (advisory) {
      try { advisory.observations.enqueueFallback("clarification", advisory.session.captureClarification(operationalScope, context.requirement)); }
      catch { /* Local advisory capture cannot affect dispatch authority. */ }
    }
    // OVD-723: the export-control gate runs again before the preflight; a
    // denial ends the task like a preflight denial, before any adapter
    // launches.
    await assertExportControlDispatchAllowed(supabase, { taskId: task.id, vendor });
    // OVD-464: a live non Xometry task carrying a generic permit runs the
    // ordered provider pipeline and records its own finite outcome. Xometry
    // and simulate mode keep the path below unchanged.
    const genericClaim =
      config.workerMode === "live"
        ? providerDispatchClaimFromTask({ task, vendorQuoteResultId: currentResult.id, vendor })
        : null;
    if (genericClaim) {
      const { quote_run_id: quoteRunId, part_id: partId } = task;
      // OVD-723: the generic route asks the export-control gate again right
      // before adapter.quote and before each upload. A hold or failed lookup
      // raised in there is rethrown to handleLaneFailure once the pipeline
      // returns, so the lane is closed as held (or retried, for a lookup),
      // never recorded as a provider failure or manual follow-up.
      let exportControlStop: unknown = null;
      // Vendor automation counts as started (full spend estimate) only once
      // both the kill switch read and this recheck passed.
      const exportCheckedAdapter = withExportControlDispatchRecheck(adapter, supabase, {
        taskId: task.id,
        vendor,
        onAllowed: () => {
          vendorAutomationStarted = true;
        },
      });
      const approvedRequirement = context.requirement;
      const quoteInput: VendorQuoteAdapterInput = {
        organizationId: task.organization_id,
        quoteRunId: task.quote_run_id,
        part: context.part,
        cadFile: context.cadFile,
        drawingFile: context.drawingFile,
        stagedCadFile,
        stagedDrawingFile,
        requirement: context.requirement,
        requestedQuantity: currentResult.requested_quantity,
      };
      const outcome = await runGenericProviderTask({
        supabase,
        workerName: config.workerName,
        claimedAt: task.locked_at ?? "",
        task: { id: task.id, attempts: task.attempts, organizationId: task.organization_id, quoteRunId: task.quote_run_id },
        claim: genericClaim,
        scopeSnapshot,
        requestedQuantity: currentResult.requested_quantity,
        environment: isProductionEnvironment() ? "production" : "development",
        adapterRevision: `${vendor}@${config.workerBuildVersion}`.slice(0, 80),
        leaseSetting: config.providerSessionLease ?? "off",
        // OVD-381: with the setting on, the OVD-462 lease is held around the
        // adapter call. Without a namespace key no port is built, so the
        // pipeline stops with session_lease_unavailable before the preflight.
        lease:
          config.providerSessionLease === "on" && config.providerSessionNamespaceKey
            ? createSupabaseProviderTaskLeasePort(supabase, config.providerSessionNamespaceKey)
            : undefined,
        quoteInput,
        // OVD-722: the kill switch is read again immediately before the
        // launch, inside the pipeline's adapter step, and the same guard goes
        // to the adapter for its own checkpoints. An engaged switch comes back
        // as the cancelled_provider_disabled outcome. Never marks a provider
        // mutation here: the pipeline runs the adapter in its own mutation
        // phase, which the adapter marks itself.
        // OVD-723: inside that guard the export-control recheck runs before
        // adapter.quote. Both gates must pass before any provider call; the
        // kill switch is read first, so an engaged switch ends the lane as
        // cancelled_provider_disabled even when the job is also held.
        // OVD-829: that before-launch read is the universal supplier settings
        // gate (kill switch, then one durable reservation against the daily
        // cap); a spent cap ends the lane provider_daily_cap_reached.
        adapter: {
          provider: vendor,
          quote: guardProviderDispatch({
            provider: vendor,
            port: supabaseProviderSettingsPort(supabase),
            capMode: providerDispatchCapMode(config.providerDurableDispatchCap),
            quote: async (input) => {
              try {
                return await exportCheckedAdapter.quote(input);
              } catch (error) {
                if (exportControlHoldReason(error) || error instanceof ExportControlLookupError) {
                  exportControlStop = error;
                  // The pipeline runs this call in its own mutation phase, which
                  // adapters mark right before their first upload.
                  if (currentProviderMutationPhase()?.started !== true) exportStopBeforeProviderMutation = error;
                }
                throw error;
              }
            },
          }),
        },
        consumer: providerAuthorizationConsumer,
        daySwitch: providerDaySwitch,
        // OVD-813: the sanity gate between validate and persist, and the pause
        // rechecked at launch (another lane in this process may have paused it).
        internalTestQuote,
        pause: fixtureHealSupplierPause,
        sanity: (output, sanityContext) =>
          fixtureSanityGateFor(supabase)(output, { ...sanityContext, requirement: approvedRequirement }),
        persist: async (output) => {
          output.artifacts.forEach((artifact: VendorArtifact) => artifactDirs.add(path.dirname(artifact.localPath)));
          const artifactStoragePaths = await persistVendorArtifacts(supabase, config, {
            vendorQuoteResultId: currentResult.id,
            organizationId: task.organization_id,
            quoteRunId,
            partId,
            vendor,
            artifacts: output.artifacts,
          });
          await finalizeVendorQuoteResult(
            supabase,
            currentResult.id,
            {
              status: output.status,
              unit_price_usd: output.unitPriceUsd,
              total_price_usd: output.totalPriceUsd,
              lead_time_business_days: output.leadTimeBusinessDays,
              quote_url: output.quoteUrl,
              dfm_issues: output.dfmIssues,
              notes: output.notes,
              raw_payload: {
                ...output.rawPayload,
                offers: output.offers ?? [],
                artifactStoragePaths,
                requestedQuantity: currentResult.requested_quantity,
                requirementCapturedAt,
                retryCount,
                failureCode: null,
              },
            },
            preserveDerivedValiditySource(
              output,
              buildVendorQuoteOfferPayloads({
                vendorQuoteResultId: currentResult.id,
                organizationId: task.organization_id,
                vendor,
                requestedQuantity: currentResult.requested_quantity,
                requirement: approvedRequirement,
                requirementCapturedAt,
                result: output,
              }),
            ),
          );
          resultPersisted = true;
          return { artifactCount: artifactStoragePaths.length };
        },
      });
      // Once the adapter ran, nothing later in this task may be retried by the
      // generic task retry: the provider may hold an upload or a quote. This
      // is marked before an export stop is rethrown, so a lookup that failed
      // after an upload closes the lane as held instead of requeueing it.
      if (outcome.adapterStarted) markProviderMutationStarted();
      if (exportControlStop) throw exportControlStop;
      const failureArtifactStoragePaths = await keepGenericProviderFailureEvidence(supabase, config, task, {
        vendor,
        vendorQuoteResultId: currentResult.id,
        outcome,
        artifactDirs,
      });
      await recordGenericProviderOutcome(supabase, task, {
        vendor,
        vendorQuoteResultId: currentResult.id,
        requestedQuantity: currentResult.requested_quantity,
        retryCount,
        outcome,
        failureArtifactStoragePaths,
      });
      return;
    }

    const result = await quoteWithRoutedDispatchPreflight({
      supabase,
      config,
      task,
      vendorQuoteResultId: currentResult.id,
      claimedAt: task.locked_at ?? "",
      vendor,
      scopeSnapshot,
      // OVD-723 point in time check: after the preflight authorizes and
      // immediately before adapter.quote, the gate is asked once more. Vendor
      // automation counts as started (full spend estimate) only once it passes,
      // so a lane denied here settles nothing.
      adapter: withExportControlDispatchRecheck(adapter, supabase, {
        taskId: task.id,
        vendor,
        onAllowed: () => {
          vendorAutomationStarted = true;
        },
      }),
      quoteInput: {
        organizationId: task.organization_id,
        quoteRunId: task.quote_run_id,
        part: context.part,
        cadFile: context.cadFile,
        drawingFile: context.drawingFile,
        stagedCadFile,
        stagedDrawingFile,
        requirement: context.requirement,
        requestedQuantity: currentResult.requested_quantity,
      },
    });

    // OVD-813: Xometry bypasses runProviderTaskPipeline, so the same sanity
    // gate runs here, before finalizeVendorQuoteResult and before routing
    // scores. Live results only; simulate output is not a supplier price.
    // A gate that throws never lets the unchecked price through: the result is
    // held (fixture_sanity_failed) and persisted, so the task is not retried.
    let sanity: FixtureSanityGateResult | null = null;
    if (config.workerMode === "live") {
      const sanityContext: FixtureSanityContext = {
        provider: vendor,
        vendorQuoteResultId: currentResult.id,
        quoteRunId: task.quote_run_id,
        requestedQuantity: currentResult.requested_quantity,
        requirement: context.requirement,
        // Computed before the gate runs, so a fail-closed hold keeps the package identity too.
        packageId: stagedPackageId({ cad: stagedCadFile, drawing: stagedDrawingFile }),
        internalTestQuote,
      };
      try {
        sanity = await fixtureSanityGateFor(supabase)(result, sanityContext);
      } catch (sanityError) {
        console.warn(
          JSON.stringify({
            service: "overdrafter-cad-worker",
            level: "warn",
            source: "fixture_heal.sanity",
            message: `Fixture sanity gate failed; the result is held: ${summarizeWorkerError(sanityError)}`,
            context: { taskId: task.id, vendorQuoteResultId: currentResult.id, failureCode: "fixture_sanity_failed" },
          }),
        );
        sanity = failClosedSanityOutput(result, sanityContext, new Date().toISOString());
      }
    }
    const gatedResult = sanity?.output ?? result;

    gatedResult.artifacts.forEach((artifact: VendorArtifact) =>
      artifactDirs.add(path.dirname(artifact.localPath)),
    );
    const artifactStoragePaths = await persistVendorArtifacts(supabase, config, {
      vendorQuoteResultId: currentResult.id,
      organizationId: task.organization_id,
      quoteRunId: task.quote_run_id,
      partId: task.part_id,
      vendor,
      artifacts: gatedResult.artifacts,
    });

    const offerPayloads = buildVendorQuoteOfferPayloads({
      vendorQuoteResultId: currentResult.id,
      organizationId: task.organization_id,
      vendor,
      requestedQuantity: currentResult.requested_quantity,
      requirement: context.requirement,
      requirementCapturedAt,
      result: gatedResult,
    });

    await finalizeVendorQuoteResult(
      supabase,
      currentResult.id,
      {
        status: gatedResult.status,
        unit_price_usd: gatedResult.unitPriceUsd,
        total_price_usd: gatedResult.totalPriceUsd,
        lead_time_business_days: gatedResult.leadTimeBusinessDays,
        quote_url: gatedResult.quoteUrl,
        dfm_issues: gatedResult.dfmIssues,
        notes: gatedResult.notes,
        raw_payload: {
          ...gatedResult.rawPayload,
          offers: gatedResult.offers ?? [],
          artifactStoragePaths,
          requestedQuantity: currentResult.requested_quantity,
          requirementCapturedAt,
          retryCount,
          failureCode: null,
        },
      },
      offerPayloads,
    );
    resultPersisted = true;

    // Compute and store routing scores for this quote run.
    // This is a best-effort operation — it will only succeed once all
    // vendor quotes for the run are in a terminal state.
    // OVD-813: a held result has no price to score, so it is skipped.
    try {
      if (!sanity?.held) {
        await computeAndStoreRoutingScores(
          supabase,
          task.quote_run_id,
          task.organization_id,
        );
      }
    } catch (scoringError) {
      // Non-fatal: do not fail the task if scoring fails
      console.warn(
        JSON.stringify({
          service: "overdrafter-cad-worker",
          level: "warn",
          source: "worker.scoring",
          message: `Routing score computation failed: ${summarizeWorkerError(scoringError)}`,
          context: { quoteRunId: task.quote_run_id },
        }),
      );
    }

    const requestStatusAfterResult = await fetchQuoteRequestStatusForTask(supabase, task);

    if (requestStatusAfterResult === "canceled") {
      await markTaskCancelled(supabase, task, "Canceled while vendor automation was in flight.", {
          vendorStatus: gatedResult.status,
        artifactCount: artifactStoragePaths.length,
        ignoredDueToCanceledRequest: true,
      });
      return;
    }

    await syncJobStatusAfterVendorUpdate(supabase, task.job_id, task.quote_run_id);
    await markTaskCompleted(supabase, task, {
      vendorStatus: gatedResult.status,
      artifactCount: artifactStoragePaths.length,
    });
  } catch (error) {
    await handleLaneFailure(error);
  } finally {
    // Settle regardless of outcome: an estimate left booked for a lane that
    // never ran would hold budget for the rest of the window.
    await vendorSpendGuard.settle(
      vendorReservation,
      vendorAutomationStarted ? VENDOR_RUN_SPEND_ESTIMATE_USD : 0,
    );
    await cleanupPaths([stageDir, ...artifactDirs]);
  }
}

/**
 * OVD-723 scan only rescan of one job file (`export_marking_rescan`), queued
 * after a clean declaration for files with no clean scan of their current
 * bytes. It records a clean scan or opens a block and never calls a model
 * (`runExportMarkingRescan`). A blocked, unread, or incomplete result is an
 * outcome, not a failure: the task completes and dispatch stays denied.
 */
export async function handleExportMarkingRescanTask(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
  config: WorkerConfig,
) {
  const jobFileId = typeof task.payload.jobFileId === "string" ? task.payload.jobFileId : null;
  if (!task.job_id || !jobFileId) {
    throw new ExportMarkingRescanTaskInvalidError();
  }

  const { data: file, error } = await supabase
    .from("job_files")
    .select("*")
    .eq("id", jobFileId)
    .maybeSingle();
  if (error) throw error;
  if (!file || file.job_id !== task.job_id) {
    // The row was deleted or moved: nothing in this job to vouch for.
    await markTaskCompleted(supabase, task, { exportScanOutcome: "file_not_in_job" });
    return;
  }

  const jobFile = file as JobFileRecord;
  let runDir: string | null = null;
  try {
    runDir = await createRunDir(config, ["export-rescan", task.id]);
    const stageDir = runDir;
    const outcome = await runExportMarkingRescan(supabase, {
      jobId: task.job_id,
      partId: task.part_id,
      file: jobFile,
      stage: () => stageStorageObject(supabase, jobFile, stageDir),
      extractText: extractPdfText,
      readStepPrefix: readStagedStepHeaderPrefix,
    });
    await markTaskCompleted(supabase, task, { exportScanOutcome: outcome, jobFileId });
  } finally {
    await cleanupPaths([runDir]);
  }
}

/**
 * A failure after the atomic result write (request status read, job status
 * sync, task completion). The persisted result and its offers stay as they
 * are; the task is marked failed with a stable code, best effort, and the
 * failure is logged. Never rethrown, so the generic catch cannot overwrite the
 * result and the generic task retry cannot rerun a completed provider quote.
 */
async function settlePostPersistBookkeepingFailure(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
  error: unknown,
) {
  await settlePersistedResultTask(supabase, task, error, "post_persist_bookkeeping_failed");
}

/**
 * Settles the task of a run whose result is persisted, without touching the
 * result row: syncs the job status and marks the task failed with a stable
 * code. Best effort and never rethrown.
 */
async function settlePersistedResultTask(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
  error: unknown,
  failureCode: "post_persist_bookkeeping_failed" | "persist_ack_lost",
) {
  console.error(
    JSON.stringify({
      service: "overdrafter-cad-worker",
      level: "error",
      source: "worker.vendor_quote.post_persist",
      message: `${failureCode}: the vendor quote result was persisted; ${summarizeWorkerError(error)}`,
      context: { taskId: task.id, quoteRunId: task.quote_run_id },
    }),
  );
  try {
    if (failureCode === "persist_ack_lost" && task.job_id && task.quote_run_id) {
      await syncJobStatusAfterVendorUpdate(supabase, task.job_id, task.quote_run_id);
    }
  } catch {
    // The job status catches up on the next lane update; the task is still settled below.
  }
  try {
    const note = failureCode === "persist_ack_lost"
      ? "The vendor quote result was persisted but its acknowledgement was lost."
      : "Bookkeeping failed after the vendor quote result was persisted.";
    await markTaskFailed(supabase, task, note, { failureCode, vendorQuoteResultPersisted: true });
  } catch {
    // The stale task reaper settles a task left running; the persisted result is untouched either way.
  }
}

const UNSETTLED_VENDOR_QUOTE_RESULT_STATUSES = ["queued", "running"] as const;
const PERSISTED_VENDOR_QUOTE_RESULT_STATUSES: ReadonlySet<unknown> = new Set([
  "instant_quote_received",
  "official_quote_received",
]);

/**
 * Writes a non persisted outcome to the lane as a compare and set: only while
 * the row is still queued or running. If no row matched, the row is read back:
 * `persisted` means `reconcile_vendor_quote_offers` committed even though its
 * response was lost, so the result and its live offers must stand; `settled`
 * means something else already settled the lane. Neither is ever overwritten.
 */
async function writeUnsettledVendorQuoteResult(
  supabase: SupabaseClient,
  vendorQuoteResultId: string,
  patch: Record<string, unknown>,
): Promise<"written" | "persisted" | "settled"> {
  const { data, error } = await supabase
    .from("vendor_quote_results")
    .update(patch)
    .eq("id", vendorQuoteResultId)
    .in("status", [...UNSETTLED_VENDOR_QUOTE_RESULT_STATUSES])
    .select("id");
  if (error) throw error;
  if (Array.isArray(data) && data.length > 0) return "written";
  const { data: row, error: readError } = await supabase
    .from("vendor_quote_results")
    .select("status")
    .eq("id", vendorQuoteResultId)
    .maybeSingle();
  if (readError) throw readError;
  const status = (row as { status?: unknown } | null)?.status;
  return PERSISTED_VENDOR_QUOTE_RESULT_STATUSES.has(status) ? "persisted" : "settled";
}

/**
 * OVD-464: the generic lane could not take the outcome. A persisted result
 * stands and the task is settled without a retry; a lane settled elsewhere is
 * left as is and the task is failed with a stable code, never requeued.
 */
async function settleUnwrittenProviderOutcome(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
  laneWrite: "persisted" | "settled",
  adapterStarted: boolean,
) {
  if (laneWrite === "persisted") {
    await settlePersistedResultTask(supabase, task, new Error("The result write acknowledgement was lost."), "persist_ack_lost");
    return;
  }
  await markTaskFailed(supabase, task, "The vendor quote result was already settled; the outcome was not recorded on it.", {
    failureCode: "lane_already_settled",
    adapterStarted,
  });
}

/**
 * OVD-464: keeps the evidence of a failed or refused generic provider run as
 * the legacy path did: artifact directories join the cleanup set, the
 * artifacts are stored, and a selector failure becomes a repair candidate.
 * Best effort; evidence handling never changes the outcome.
 */
async function keepGenericProviderFailureEvidence(
  supabase: SupabaseClient,
  config: WorkerConfig,
  task: QueueTaskRecord,
  input: { vendor: VendorName; vendorQuoteResultId: string; outcome: ProviderTaskOutcome; artifactDirs: Set<string> },
): Promise<string[]> {
  const { adapterError, artifacts } = input.outcome.evidence;
  artifacts.forEach((artifact) => input.artifactDirs.add(path.dirname(artifact.localPath)));
  let storagePaths: string[] = [];
  try {
    if (artifacts.length > 0 && task.part_id && task.quote_run_id) {
      storagePaths = await persistVendorArtifacts(supabase, config, {
        vendorQuoteResultId: input.vendorQuoteResultId,
        organizationId: task.organization_id,
        quoteRunId: task.quote_run_id,
        partId: task.part_id,
        vendor: input.vendor,
        artifacts,
      });
    }
    if (adapterError) await enqueueRepairCandidate(supabase, task, adapterError);
  } catch (error) {
    console.warn(
      JSON.stringify({
        service: "overdrafter-cad-worker",
        level: "warn",
        source: "worker.vendor_quote.failure_evidence",
        message: `Provider failure evidence was not stored: ${summarizeWorkerError(error)}`,
        context: { taskId: task.id, quoteRunId: task.quote_run_id },
      }),
    );
  }
  return storagePaths;
}

/**
 * OVD-464: writes one finite visible state for a generic provider outcome.
 * The pipeline already decided retry; this never rethrows a provider failure
 * into the generic task retry.
 */
async function recordGenericProviderOutcome(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
  input: {
    vendor: VendorName;
    vendorQuoteResultId: string;
    requestedQuantity: number;
    retryCount: number;
    outcome: ProviderTaskOutcome;
    failureArtifactStoragePaths?: string[];
  },
) {
  const { vendor, outcome } = input;
  const { job_id: jobId, quote_run_id: quoteRunId } = task;
  if (!jobId || !quoteRunId) throw new Error("run_vendor_quote task is missing part_id, quote_run_id, or job_id.");
  if (outcome.disposition === "persisted") {
    try {
      // OVD-813: a result the sanity gate held carries no price to score.
      if (!outcome.persisted?.held) await computeAndStoreRoutingScores(supabase, quoteRunId, task.organization_id);
    } catch (scoringError) {
      console.warn(
        JSON.stringify({
          service: "overdrafter-cad-worker",
          level: "warn",
          source: "worker.scoring",
          message: `Routing score computation failed: ${summarizeWorkerError(scoringError)}`,
          context: { quoteRunId: task.quote_run_id },
        }),
      );
    }
    const requestStatusAfterResult = await fetchQuoteRequestStatusForTask(supabase, task);
    if (requestStatusAfterResult === "canceled") {
      await markTaskCancelled(supabase, task, "Canceled while vendor automation was in flight.", {
        vendorStatus: outcome.persisted?.status ?? null,
        artifactCount: outcome.persisted?.artifactCount ?? 0,
        ignoredDueToCanceledRequest: true,
      });
      return;
    }
    await syncJobStatusAfterVendorUpdate(supabase, jobId, quoteRunId);
    await markTaskCompleted(supabase, task, {
      vendorStatus: outcome.persisted?.status ?? null,
      artifactCount: outcome.persisted?.artifactCount ?? 0,
      offerCount: outcome.persisted?.offerCount ?? 0,
    });
    return;
  }

  const record = providerTaskFailureRecord(vendor, outcome, {
    retryCount: input.retryCount,
    requestedQuantity: input.requestedQuantity,
    artifactStoragePaths: input.failureArtifactStoragePaths ?? [],
  });
  const note = providerTaskOutcomeNote(vendor, outcome);
  const taskPatch = {
    failureCode: outcome.code,
    failureStage: outcome.stage,
    adapterStarted: outcome.adapterStarted,
    providerDisabledForDay: outcome.providerDisabledForDay,
  };
  // A requeue is scheduled before the lane says "queued", so the lane never
  // advertises a retry that did not happen. False means the task was settled
  // elsewhere (cancelled, say); queue.ts logs that and the lane is left as it is.
  const retryAt = outcome.disposition === "requeue" ? outcome.retryAt : null;
  if (retryAt && !(await markTaskQueuedForRetry(supabase, task, note, retryAt, { ...taskPatch, nextRetryAt: retryAt }))) {
    return;
  }

  const laneWrite = await writeUnsettledVendorQuoteResult(supabase, input.vendorQuoteResultId, record);
  if (laneWrite !== "written") {
    await settleUnwrittenProviderOutcome(supabase, task, laneWrite, outcome.adapterStarted);
    return;
  }
  await syncJobStatusAfterVendorUpdate(supabase, jobId, quoteRunId);

  if (outcome.disposition === "cancelled_provider_disabled" && outcome.killSwitch) {
    await markTaskCancelledForDisabledProvider(supabase, task, outcome.killSwitch.error);
    return;
  }
  if (retryAt) {
    return;
  } else if (outcome.disposition === "manual_follow_up") {
    await markTaskCompleted(supabase, task, {
      ...taskPatch,
      vendorStatus: "manual_vendor_followup",
      manualVendor: true,
      manualReasonCode: outcome.code,
    });
  } else {
    await markTaskFailed(supabase, task, note, taskPatch);
  }
}

async function fetchQuoteRequestStatusForTask(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
): Promise<"queued" | "requesting" | "received" | "failed" | "canceled" | null> {
  const requestId =
    typeof task.payload.quoteRequestId === "string" ? task.payload.quoteRequestId : null;

  if (requestId) {
    const { data, error } = await supabase
      .from("quote_requests")
      .select("status")
      .eq("id", requestId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return (data?.status as "queued" | "requesting" | "received" | "failed" | "canceled" | null) ?? null;
  }

  if (!task.quote_run_id) {
    return null;
  }

  const { data, error } = await supabase
    .from("quote_runs")
    .select("quote_request_id, quote_requests(status)")
    .eq("id", task.quote_run_id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const quoteRequest = data && typeof data === "object" && "quote_requests" in data
    ? (data.quote_requests as { status?: string } | { status?: string }[] | null)
    : null;

  if (!quoteRequest || Array.isArray(quoteRequest)) {
    return null;
  }

  return (quoteRequest.status as "queued" | "requesting" | "received" | "failed" | "canceled" | null) ?? null;
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

  await markTaskCompleted(supabase, task, {
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

  await markTaskCompleted(supabase, task, {
    repairSuggestion: suggestion,
  });
}

async function processTask(
  supabase: SupabaseClient,
  task: QueueTaskRecord,
  config: WorkerConfig,
  operationalJev?: OperationalJevTaskCapability,
) {
  switch (task.task_type) {
    case "extract_part":
      await handleExtractTask(supabase, task, config);
      return;
    case "debug_extract_part":
      await handleDebugExtractTask(supabase, task, config);
      return;
    case "generate_cad_preview":
      await handleGenerateCadPreviewTask(supabase, task, config);
      return;
    case "run_vendor_quote":
      await handleVendorQuoteTask(supabase, task, config, operationalJev);
      return;
    case "publish_package":
      await handlePublishTask(supabase, task);
      return;
    case "repair_adapter_candidate":
      await handleRepairTask(supabase, task);
      return;
    case "poll_vendor_quote":
      await markTaskCompleted(supabase, task, {
          pollSkipped: true,
      });
      return;
    case "export_marking_rescan":
      await handleExportMarkingRescanTask(supabase, task, config);
      return;
    default:
      throw new Error(`Unhandled task type: ${task.task_type}`);
  }
}

export type OperationalJevHost = Readonly<{
  /** Trusted local selection only: no model, ledger or network work in this callback. */
  captureTask(scope: Readonly<{ organizationId: string; taskId: string; quoteRunId: string | null; provider: unknown }>): OperationalJevTaskCapability | undefined;
}>;

/** The real worker loop uses this same acknowledgement boundary. Drain is owned, post-ack,
 * and may add up to six bounded seven-second callbacks of next-task latency. */
export async function processClaimedTask(supabase: SupabaseClient, task: QueueTaskRecord, config: WorkerConfig,
  runtimeState: WorkerRuntimeState, host?: OperationalJevHost, advisorySignal?: AbortSignal): Promise<void> {
  let advisory: OperationalJevTaskCapability | undefined;
  if (host && task.task_type === "run_vendor_quote") {
    try { advisory = host.captureTask(Object.freeze({ organizationId: task.organization_id, taskId: task.id,
      quoteRunId: task.quote_run_id, provider: task.payload.vendor })); } catch { /* Optional host selection cannot fail the task. */ }
  }
  let drain: (() => Promise<void>) | undefined;
  let cancelAdvisory = () => undefined;
  try {
    drain = advisory?.observations.drain.bind(advisory.observations);
    const cancel = advisory?.session.cancel.bind(advisory.session);
    cancelAdvisory = () => { try { cancel?.(); } catch { /* Advisory host bugs cannot fail the task. */ } return undefined; };
  } catch { advisory = undefined; drain = undefined; }
  if (advisorySignal?.aborted) cancelAdvisory();
  advisorySignal?.addEventListener("abort", cancelAdvisory, { once: true });
  let acknowledged = false;
  const providerMutationPhase = createProviderMutationPhase();
  try {
    const taskSummary = {
      id: task.id,
      type: task.task_type,
    };
    runtimeState.currentTask = taskSummary;
    runtimeState.lastTaskStartedAt = new Date().toISOString();
    const taskStartMs = Date.now();
    logWorkerEvent(runtimeState, {
      level: "info",
      source: "worker.task.start",
      message: `Starting ${task.task_type} ${task.id}.`,
      context: buildTaskContext(task),
    });

    try {
      await runInProviderMutationPhase(providerMutationPhase, () =>
        processTask(supabase, task, config, advisory),
      );
      acknowledged = true;
      runtimeState.lastTaskCompletedAt = new Date().toISOString();
      runtimeState.lastCompletedTask = taskSummary;
      runtimeState.lastError = null;
      logWorkerEvent(runtimeState, {
        level: "info",
        source: "worker.task.complete",
        message: `Completed ${task.task_type} ${task.id}.`,
        context: {
          ...buildTaskContext(task),
          task_duration_ms: Date.now() - taskStartMs,
        },
      });
    } catch (error) {
      let retryAt: string | null = null;
      const shouldRetry =
        (task.task_type === "generate_cad_preview" && isRetryableCadPreviewError(error)) ||
        (task.task_type === "extract_part" && error instanceof CanonicalArtifactsPendingError) ||
        (task.task_type === "extract_part" && error instanceof ExportControlLookupError) ||
        (task.task_type === "extract_part" && error instanceof ExportControlStepScanRetryableError) ||
        (task.task_type === "export_marking_rescan" && isRetryableExportRescanError(error)) ||
        (task.task_type === "run_vendor_quote" &&
          isRetryableVendorTaskError(error, providerMutationPhase));
      if (shouldRetry) {
        retryAt = nextRetryAt(task.attempts);
      }
      const retryCount = retryCountForAttempts(task.attempts);
      const failureEvidence = buildWorkerTaskFailureEvidence(
        error,
        failureCodeForError(error),
        retryCount,
      );
      const message = failureEvidence.failureMessage;
      let settledElsewhere = false;

      if (retryAt) {
        // False when the row was already settled elsewhere (cancelled, say):
        // it stays as it is, nothing is scheduled, and queue.ts logs it.
        settledElsewhere = !(await markTaskQueuedForRetry(supabase, task, failureEvidence.failureMessage, retryAt, {
          ...failureEvidence.payload,
          nextRetryAt: retryAt,
        }));
      } else {
        await markTaskFailed(
          supabase,
          task,
          failureEvidence.failureMessage,
          { ...failureEvidence.payload, ...exportScanOutcomesPayload(error) },
        );
      }

      acknowledged = true;
      runtimeState.lastTaskFailedAt = new Date().toISOString();
      runtimeState.lastFailedTask = taskSummary;
      runtimeState.lastError = message;
      if (!settledElsewhere) {
        logWorkerEvent(runtimeState, {
          level: retryAt ? "warn" : "error",
          source: retryAt ? "worker.task.retry" : "worker.task.failure",
          message: retryAt
            ? `Retrying ${task.task_type} ${task.id} at ${retryAt}: ${message}`
            : `Failed ${task.task_type} ${task.id}: ${message}`,
          context: {
            ...buildTaskContext(task),
            task_duration_ms: Date.now() - taskStartMs,
            retryCount,
            nextRetryAt: retryAt,
          },
          error: failureEvidence.runtimeError,
        });
      }
    } finally {
      runtimeState.currentTask = null;
    }

    // Rejected/unknown authoritative persistence exits above; it must never start a drain.
    if (acknowledged && !advisorySignal?.aborted && drain) {
      try { await drain(); } catch { /* Both synchronous and asynchronous advisory failures are contained after ack. */ }
    }
  } finally {
    advisorySignal?.removeEventListener("abort", cancelAdvisory);
    if (!acknowledged) cancelAdvisory();
  }
}

export async function main(operationalHost?: OperationalJevHost) {
  const baseConfig = loadConfig();
  const runtimeState = createWorkerRuntimeState();
  let config = baseConfig;
  let startupReadinessIssue: string | null = null;

  try {
    config = await prepareRuntimeSecrets(baseConfig);
  } catch (error) {
    startupReadinessIssue = summarizeWorkerError(error);
  }

  const supabase = createServiceClient(config);
  const modelCatalogManager = new ExtractionModelCatalogManager(config);
  const healthServer = await startHealthServer(config, runtimeState, {
    getExtractionModels: async () => modelCatalogManager.getCatalog(),
    refreshExtractionModels: async () => ({
      accepted: true,
      catalog: await modelCatalogManager.refreshNow(),
    }),
    previewExtraction: async ({ partId, modelId }) =>
      previewStoredPartExtraction(config, { partId, modelId }),
  });
  let stopping = false;
  const advisoryShutdown = new AbortController();

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
    advisoryShutdown.abort();
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
    message:
      config.workerMode === "live"
        ? "Starting worker in live mode."
        : `Starting worker ${config.workerName} in ${config.workerMode} mode.`,
    context: {
      workerName: config.workerName,
      workerMode: config.workerMode,
      healthUrl: healthServer.url,
      pollIntervalMs: config.pollIntervalMs,
      quantityPricingLadder: config.quantityPricingLadder,
      vendorRateLimitMs: config.vendorRateLimitMs,
      drawingExtractionModelFallback: config.drawingExtractionEnableModelFallback,
      drawingExtractionModel: config.drawingExtractionModel,
    },
  });

  const xometrySessionAgeDays = await getXometrySessionAgeDays(config);
  if (
    xometrySessionAgeDays !== null &&
    xometrySessionAgeDays > config.xometrySessionFreshnessWarnDays
  ) {
    const ageDaysRounded = Math.floor(xometrySessionAgeDays);
    logWorkerEvent(runtimeState, {
      level: "warn",
      source: "worker.session_freshness",
      message: `Xometry session is ${ageDaysRounded} days old — consider re-authenticating.`,
      context: {
        xometrySessionAgeDays,
        thresholdDays: config.xometrySessionFreshnessWarnDays,
      },
    });
  }

  if (shouldWarnSimulateModeInProduction(config)) {
    logWorkerEvent(runtimeState, {
      level: "warn",
      source: "worker.configuration",
      message:
        "WORKER_MODE=simulate detected in production-like environment; vendor quotes will not run live automation.",
      context: {
        workerMode: config.workerMode,
        nodeEnv: process.env.NODE_ENV ?? null,
        vercelEnv: process.env.VERCEL_ENV ?? null,
        appEnv: process.env.APP_ENV ?? null,
      },
    });
  }

  runtimeState.status = "running";

  if (startupReadinessIssue) {
    runtimeState.readinessIssues = [startupReadinessIssue];
    runtimeState.lastError = startupReadinessIssue;
    logReadinessChange(runtimeState.readinessIssues);
  } else {
    await refreshRuntimeReadiness(config, runtimeState, logReadinessChange);
  }

  // Reap stale tasks once at startup, then every 60 seconds.
  let lastReapAt = 0;
  const REAP_INTERVAL_MS = 60_000;

  while (!stopping) {
    runtimeState.lastLoopAt = new Date().toISOString();
    const ready = startupReadinessIssue
      ? false
      : await refreshRuntimeReadiness(config, runtimeState, logReadinessChange);

    if (!ready) {
      await sleep(config.pollIntervalMs);
      continue;
    }

    const now = Date.now();
    if (now - lastReapAt >= REAP_INTERVAL_MS) {
      lastReapAt = now;
      try {
        const reaped = await reapStaleTasks(supabase);
        if (reaped > 0) {
          logWorkerEvent(runtimeState, {
            level: "warn",
            source: "worker.reaper",
            message: `Reaped ${reaped} stale task(s) stuck in running state.`,
            context: { reaped },
          });
        }
      } catch (reaperError) {
        logWorkerEvent(runtimeState, {
          level: "error",
          source: "worker.reaper",
          message: `Dead-task reaper failed: ${summarizeWorkerError(reaperError)}`,
          error: reaperError,
        });
      }
      // OVD-722: cancel queued lanes for switched-off providers so none stay
      // parked. Claim-time and pre-launch checks still refuse on their own.
      if (config.workerMode === "live") {
        try {
          const sweep = await sweepProviderDisabledTasks(supabase);
          for (const run of sweep.quoteRuns) {
            await syncJobStatusAfterVendorUpdate(supabase, run.jobId, run.quoteRunId);
          }
          for (const warning of providerKillSwitchSweepWarnings(sweep)) {
            logWorkerEvent(runtimeState, {
              level: "warn",
              source: "worker.kill_switch",
              message: warning.message,
              context: warning.context,
            });
          }
        } catch (sweepError) {
          logWorkerEvent(runtimeState, {
            level: "error",
            source: "worker.kill_switch",
            message: `Kill-switch sweep failed: ${summarizeWorkerError(sweepError)}`,
            error: sweepError,
          });
        }
      }
    }

    const task = await claimNextTask(supabase, config.workerName);

    if (!task) {
      await sleep(config.pollIntervalMs);
      continue;
    }

    await processClaimedTask(supabase, task, config, runtimeState, operationalHost, advisoryShutdown.signal);

    if (!stopping && task.task_type === "run_vendor_quote" && config.vendorRateLimitMs > 0) {
      await sleep(config.vendorRateLimitMs);
    }
  }

  await healthServer.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => {
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
