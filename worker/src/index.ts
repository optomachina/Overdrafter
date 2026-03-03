import "dotenv/config";
import path from "node:path";
import type { PostgrestResponse, SupabaseClient } from "@supabase/supabase-js";
import { buildAdapterRegistry } from "./adapters/index.js";
import { loadConfig } from "./config.js";
import { runHybridExtraction } from "./extraction/hybridExtraction.js";
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
} from "./queue.js";
import { createWorkerRuntimeState, startHealthServer } from "./httpServer.js";
import { suggestLocatorUpdate } from "./repair/suggestLocatorUpdate.js";
import { prepareRuntimeSecrets } from "./runtimeSecrets.js";
import type {
  ApprovedRequirementRecord,
  JobFileRecord,
  PartRecord,
  QueueTaskRecord,
  VendorArtifact,
  VendorAutomationError,
  VendorName,
  WorkerConfig,
} from "./types.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      errorMessage: error.message,
      nearbyAttributes: error.payload.nearbyAttributes ?? [],
      failureCode: error.code,
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
  const { data: results, error } = await supabase
    .from("vendor_quote_results")
    .select("status")
    .eq("quote_run_id", quoteRunId);

  if (error || !results) {
    throw error ?? new Error("Unable to refresh job status.");
  }

  const statuses = results.map((row) => row.status);
  const hasPending = statuses.some((status) => status === "queued" || status === "running");
  const hasManual = statuses.some(
    (status) => status === "manual_review_pending" || status === "manual_vendor_followup",
  );
  const hasSuccess = statuses.some(
    (status) => status === "instant_quote_received" || status === "official_quote_received",
  );

  await supabase
    .from("quote_runs")
    .update({
      status: hasPending ? "running" : hasSuccess || hasManual ? "completed" : "failed",
    })
    .eq("id", quoteRunId);

  await supabase
    .from("jobs")
    .update({
      status: hasPending
        ? "quoting"
        : hasManual
          ? "awaiting_vendor_manual_review"
          : hasSuccess
            ? "internal_review"
            : "quoting",
    })
    .eq("id", jobId);
}

async function handleExtractTask(supabase: SupabaseClient, task: QueueTaskRecord) {
  if (!task.part_id || !task.job_id) {
    throw new Error("extract_part task is missing job_id or part_id.");
  }

  const context = await fetchPartContext(supabase, task.part_id);
  const extraction = await runHybridExtraction({
    part: context.part,
    cadFile: context.cadFile,
    drawingFile: context.drawingFile,
  });

  const { error } = await supabase.from("drawing_extractions").upsert(
    {
      part_id: context.part.id,
      organization_id: context.part.organization_id,
      extractor_version: "worker-sim-v1",
      extraction: {
        description: extraction.description,
        partNumber: extraction.partNumber,
        revision: extraction.revision,
        material: extraction.material,
        finish: extraction.finish,
        tolerances: {
          tightest: extraction.tightestTolerance.raw,
          valueInch: extraction.tightestTolerance.valueInch,
          confidence: extraction.tightestTolerance.confidence,
        },
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

  await supabase.from("jobs").update({ status: "needs_spec_review" }).eq("id", task.job_id);
  await markTaskCompleted(supabase, task.id, {
    ...task.payload,
    extractionStatus: extraction.status,
    warningCount: extraction.warnings.length,
  });
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

  if (!vendor) {
    throw new Error("run_vendor_quote task is missing vendor in payload.");
  }

  const context = await fetchPartContext(supabase, task.part_id);

  if (!context.requirement) {
    throw new Error(`No approved requirement found for part ${task.part_id}.`);
  }

  const { data: currentResult, error: currentResultError } = await supabase
    .from("vendor_quote_results")
    .select("id")
    .eq("quote_run_id", task.quote_run_id)
    .eq("part_id", task.part_id)
    .eq("vendor", vendor)
    .single();

  if (currentResultError || !currentResult) {
    throw currentResultError ?? new Error("Vendor quote result row was not found.");
  }

  const stageDir = await createRunDir(config, ["staging", task.quote_run_id, task.part_id]);
  const stagedCadFile = await stageStorageObject(supabase, context.cadFile, stageDir);
  const stagedDrawingFile = await stageStorageObject(supabase, context.drawingFile, stageDir);

  const adapters = buildAdapterRegistry(config);
  const adapter = adapters[vendor];
  const artifactDirs = new Set<string>();

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
    const result = await adapter.quote({
      organizationId: task.organization_id,
      quoteRunId: task.quote_run_id,
      part: context.part,
      cadFile: context.cadFile,
      drawingFile: context.drawingFile,
      stagedCadFile,
      stagedDrawingFile,
      requirement: context.requirement,
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
    const isVendorError =
      error instanceof Error && error.name === "VendorAutomationError";
    const vendorError = isVendorError ? (error as VendorAutomationError) : null;
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

    await supabase
      .from("vendor_quote_results")
      .update({
        status: "failed",
        notes: [
          vendorError?.message ?? (error instanceof Error ? error.message : "Vendor quote task failed."),
        ],
        raw_payload: {
          failureCode: vendorError?.code ?? "task_failure",
          ...vendorError?.payload,
          artifactStoragePaths: failureArtifactStoragePaths,
        },
      })
      .eq("id", currentResult.id);

    await syncJobStatusAfterVendorUpdate(supabase, task.job_id, task.quote_run_id);
    throw error;
  } finally {
    await cleanupPaths([stageDir, ...artifactDirs]);
  }
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
      await handleExtractTask(supabase, task);
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
  const config = await prepareRuntimeSecrets(loadConfig());
  const supabase = createServiceClient(config);
  const runtimeState = createWorkerRuntimeState();
  const healthServer = await startHealthServer(config, runtimeState);
  let stopping = false;

  const requestShutdown = (signal: string) => {
    if (stopping) {
      return;
    }

    stopping = true;
    runtimeState.status = "shutting_down";
    console.log(`[worker] received ${signal}, shutting down after the current cycle`);
  };

  process.on("SIGTERM", () => requestShutdown("SIGTERM"));
  process.on("SIGINT", () => requestShutdown("SIGINT"));

  console.log(
    `[worker] starting in ${config.workerMode} mode as ${config.workerName}`,
  );
  console.log(`[worker] health server listening on ${healthServer.url}`);

  runtimeState.status = "running";

  while (!stopping) {
    runtimeState.lastLoopAt = new Date().toISOString();
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

    try {
      await processTask(supabase, task, config);
      runtimeState.lastTaskCompletedAt = new Date().toISOString();
      runtimeState.lastCompletedTask = taskSummary;
      runtimeState.lastError = null;
      console.log(`[worker] completed ${task.task_type} ${task.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markTaskFailed(supabase, task.id, message, {
        ...task.payload,
        failureMessage: message,
      });
      runtimeState.lastTaskFailedAt = new Date().toISOString();
      runtimeState.lastFailedTask = taskSummary;
      runtimeState.lastError = message;
      console.error(`[worker] failed ${task.task_type} ${task.id}: ${message}`);
    } finally {
      runtimeState.currentTask = null;
    }
  }

  await healthServer.close();
}

main().catch((error) => {
  console.error("[worker] fatal startup error", error);
  process.exit(1);
});
