// @vitest-environment node
// Review holds depend on this part's approval, independently of the job-wide
// RPC count. A held extract_part task still completes and records its outcome.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createWorkerRuntimeState } from "./httpServer";
import { processClaimedTask } from "./index";
import { finalizeExtractionApproval } from "./extraction/extractionApproval";
import { markTaskCompleted, markTaskFailed, markTaskQueuedForRetry } from "./queue";
import { ExportControlLookupError, ExportControlScanRecordError, ExportControlStepScanRetryableError } from "./exportControl";
import { VENDOR_TASK_RETRY_DELAYS_MS } from "./vendorTaskRetry";
import type { QueueTaskRecord, WorkerConfig } from "./types";

vi.mock("./queue.js", async (original) => ({
  ...await original<typeof import("./queue.js")>(),
  markTaskCompleted: vi.fn(async () => undefined),
  markTaskFailed: vi.fn(async () => undefined),
  markTaskQueuedForRetry: vi.fn(async () => true),
}));
vi.mock("./files.js", async (original) => ({
  ...await original<typeof import("./files.js")>(),
  createRunDir: vi.fn(async () => "/tmp/owned-fake-stage"),
  stageStorageObject: vi.fn(async (_db, file) => file ? ({ originalName: file.original_name, localPath: "/tmp/fake.pdf",
    storageBucket: file.storage_bucket, storagePath: file.storage_path, trustedContentSha256: "c".repeat(64) }) : null),
  cleanupPaths: vi.fn(async () => undefined),
}));
vi.mock("./exportControl.js", async (original) => ({
  ...await original<typeof import("./exportControl.js")>(),
  scanPartStepHeaderForExtraction: vi.fn(async () => undefined),
  scanStagedDrawingForExportMarkings: vi.fn(async () => undefined),
  scanDrawingForExtraction: vi.fn(async () => undefined),
  assertExportControlExtractionAllowed: vi.fn(async () => undefined),
  exportControlModelAttemptGuard: vi.fn(() => async () => undefined),
}));
vi.mock("./extraction/pdfDrawing.js", () => ({
  extractPdfText: vi.fn(async () => ({ pageCount: 1, text: "TITLE BLOCK" })),
  renderPdfPreviewAssets: vi.fn(async () => []),
  renderPdfFirstPagePreview: vi.fn(async () => null),
}));
vi.mock("./cadPreviewPersistence.js", () => ({
  ensurePersistentCadPreview: vi.fn(async () => ({ status: "current" })),
  enqueueCadPreviewGenerationTask: vi.fn(async () => undefined),
}));
vi.mock("./extraction/geometryProjection.js", () => ({ buildGeometryProjectionArtifact: vi.fn(() => null) }));
vi.mock("./extraction/hybridExtraction.js", () => ({ runHybridExtraction: vi.fn() }));

const { runHybridExtraction } = await import("./extraction/hybridExtraction.js");

const part = { id: "part", job_id: "job", organization_id: "org", name: "part", normalized_key: "part",
  cad_file_id: null, drawing_file_id: "drawing", quantity: 1 };
const drawing = { id: "drawing", job_id: "job", storage_bucket: "bucket", storage_path: "p/part.pdf",
  original_name: "part.pdf", file_kind: "drawing" };

// Title-block-backed fields flagged for review because the approval switch is off.
const titleBlockRaw = (value: string) => ({ value, confidence: 0.9, reviewNeeded: true,
  reasons: ["title_block_approval_disabled"], sourceRegion: { page: 1, line: 1, columnStart: 0, columnEnd: value.length, label: "TITLE" } });
const extraction = {
  partId: "part", description: "BRACKET", partNumber: "PN-1", revision: "A",
  extractedDescriptionRaw: titleBlockRaw("BRACKET"), extractedPartNumberRaw: titleBlockRaw("PN-1"),
  extractedRevisionRaw: titleBlockRaw("A"), extractedFinishRaw: titleBlockRaw("ANODIZE"),
  quoteDescription: "BRACKET", quoteFinish: "Anodize",
  generalTolerance: { raw: "±.010", confidence: 0.9 }, notes: [], threads: [],
  material: { raw: "6061-T6", normalized: "6061-T6", confidence: 0.9, reviewNeeded: false, reasons: [] },
  finish: { raw: "ANODIZE", normalized: "Anodize", confidence: 0.9, reviewNeeded: true, reasons: ["title_block_approval_disabled"] },
  tightestTolerance: { raw: "±.005", valueInch: 0.005, unit: "in", confidence: 0.9 },
  evidence: [{ field: "partNumber", page: 1, snippet: "PN-1", confidence: 0.9, source: "title_block" }],
  warnings: [], reviewFields: ["description", "partNumber", "revision", "finish"], status: "needs_review",
};

const task = { id: "task", organization_id: "org", quote_run_id: null, part_id: "part", job_id: "job",
  task_type: "extract_part", attempts: 1, locked_at: "2026-10-24T00:00:00Z", payload: {} } as unknown as QueueTaskRecord;
const config = { workerMode: "simulate", workerName: "worker", workerLiveAdapters: [], workerTempDir: "/tmp/owned-fake-stage",
  workerBuildVersion: "test-build", drawingExtractionModel: "test-model", titleBlockApprovalEnabled: false,
} as unknown as WorkerConfig;

type QueueRow = { status: string; attempt_id: string | null } | null;
type DatabaseOptions = {
  trustedReuse: boolean;
  approvedCount: unknown;
  partApproved?: boolean;
  approvalReadError?: { message: string };
  approvalError?: Error;
  artifactsPending?: boolean;
  artifactsReady?: boolean;
  auditInsertError?: { message: string };
  refreshFailure?: "response" | "throw";
  queueRow?: QueueRow;
};

function database(options: DatabaseOptions) {
  const rpcCalls: string[] = [];
  const auditEvents: Record<string, unknown>[] = [];
  const extractionWrites: Record<string, unknown>[] = [];
  const auditInsert = vi.fn((value: Record<string, unknown>) => auditEvents.push(value));
  const approvals = [{ id: "other-approval", part_id: "other-part" },
    ...(options.partApproved ? [{ id: "this-approval", part_id: part.id }] : [])];
  const from = (table: string) => {
    let inserted: Record<string, unknown> | null = null;
    const filters: Record<string, unknown> = {};
    let selected: string | null = null;
    const response = () => {
      if (inserted) return { data: null, error: table === "audit_events" ? options.auditInsertError ?? null : null };
      if (table === "approved_part_requirements") {
        // Keyed by the query shape, not call order: only the per-part approval
        // read (select "id", scoped to the organization) sees the read error.
        const isPartApprovalRead = selected === "id" && filters.organization_id === part.organization_id;
        return { data: approvals.find((row) => row.part_id === filters.part_id) ?? null,
          error: isPartApprovalRead ? options.approvalReadError ?? null : null };
      }
      // work_queue: the claimed task's current row (default: still this running, legacy-null attempt).
      const queueRow = options.queueRow === undefined ? { status: "running", attempt_id: null } : options.queueRow;
      const data = table === "parts" ? part : table === "job_files" ? [drawing] : table === "work_queue" ? queueRow : null;
      return { data, error: null };
    };
    const query: Record<string, unknown> = {};
    query.select = (columns: string) => { selected ??= columns; return query; };
    for (const name of ["neq", "in", "is", "order", "limit", "update", "delete"]) query[name] = () => query;
    query.eq = (column: string, value: unknown) => { filters[column] = value; return query; };
    query.upsert = (value: Record<string, unknown>) => {
      inserted = value;
      if (table === "drawing_extractions") extractionWrites.push(value);
      return query;
    };
    query.insert = (value: Record<string, unknown>) => {
      inserted = value;
      if (table === "audit_events") auditInsert(value);
      return query;
    };
    query.single = async () => response();
    query.maybeSingle = async () => response();
    query.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(response()).then(resolve, reject);
    return query;
  };
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    rpcCalls.push(name);
    if (name === "api_resolve_trusted_part_intake") {
      return { data: options.trustedReuse
        ? { result: "existing_version", partVersionId: "version", sourcePartId: "source-part" }
        : { result: "new_version" }, error: null };
    }
    if (name === "api_reuse_trusted_part_version_artifacts") {
      return { data: { artifactsReady: options.artifactsReady ?? !options.artifactsPending }, error: null };
    }
    if (name === "api_auto_approve_job_requirements") {
      if (options.approvalError) throw options.approvalError;
      return { data: options.approvedCount, error: null };
    }
    if (name === "api_refresh_job_extraction_status") {
      expect(args).toEqual({ p_job_id: "job" });
      if (options.refreshFailure === "throw") throw new Error("Refresh transport failed");
      return { data: "needs_spec_review", error: options.refreshFailure === "response" ? { message: "Refresh unavailable" } : null };
    }
    return { data: null, error: null };
  });
  return { client: { from, rpc } as unknown as SupabaseClient, rpc, rpcCalls, auditEvents, auditInsert, extractionWrites };
}

async function run(options: DatabaseOptions, runTask: QueueTaskRecord = task) {
  const db = database(options);
  await expect(processClaimedTask(db.client, runTask, config, createWorkerRuntimeState())).resolves.toBeUndefined();
  return db;
}

function expectReuseAudit(db: ReturnType<typeof database>, reviewRequired: boolean, approvedCount: number) {
  const completed = db.auditEvents.filter((event) => event.event_type === "worker.extraction_completed");
  expect(completed).toEqual([expect.objectContaining({
    organization_id: part.organization_id,
    job_id: part.job_id,
    payload: { partId: part.id, reusedCanonicalPartVersion: true, sourcePartId: "source-part",
      autoApprovedPartCount: approvedCount, reviewRequired },
  })]);
  const auditIndex = db.auditEvents.indexOf(completed[0]);
  expect(db.auditInsert.mock.invocationCallOrder[auditIndex]).toBeLessThan(
    vi.mocked(markTaskCompleted).mock.invocationCallOrder[0],
  );
}

beforeEach(() => {
  vi.mocked(markTaskCompleted).mockReset().mockResolvedValue(undefined);
  vi.mocked(markTaskFailed).mockReset().mockResolvedValue(undefined);
  vi.mocked(markTaskQueuedForRetry).mockReset().mockResolvedValue(true);
  vi.mocked(runHybridExtraction).mockReset();
  vi.mocked(runHybridExtraction).mockResolvedValue(extraction as never);
});

describe("extract_part review hold without this part's approval", () => {
  it.each([0, 1])("normal path: completes with reviewRequired when RPC returns %i", async (approvedCount) => {
    const db = await run({ trustedReuse: false, approvedCount });

    expect(db.rpcCalls).toContain("api_auto_approve_job_requirements");
    expect(markTaskFailed).not.toHaveBeenCalled();
    expect(markTaskQueuedForRetry).not.toHaveBeenCalled();
    expect(markTaskCompleted).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markTaskCompleted).mock.calls[0][2]).toMatchObject({
      autoApprovedPartCount: approvedCount,
      reviewRequired: true,
      extractionStatus: "needs_review",
    });
    const completed = db.auditEvents.find((event) => event.event_type === "worker.extraction_completed");
    expect(completed?.payload).toMatchObject({ autoApprovedPartCount: approvedCount, reviewRequired: true });
    expect(db.auditEvents.some((event) => event.event_type === "worker.extraction_failed")).toBe(false);
  });

  it.each([0, 1])("trusted-reuse path: audits the hold then completes when RPC returns %i", async (approvedCount) => {
    const db = await run({ trustedReuse: true, approvedCount });

    expect(db.rpcCalls).toContain("api_reuse_trusted_part_version_artifacts");
    expect(db.rpcCalls).toContain("api_auto_approve_job_requirements");
    expect(runHybridExtraction).not.toHaveBeenCalled();
    expect(markTaskFailed).not.toHaveBeenCalled();
    expect(markTaskQueuedForRetry).not.toHaveBeenCalled();
    expect(markTaskCompleted).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markTaskCompleted).mock.calls[0][2]).toMatchObject({
      reusedCanonicalPartVersion: true,
      autoApprovedPartCount: approvedCount,
      reviewRequired: true,
    });
    expectReuseAudit(db, true, approvedCount);
    expect(db.auditEvents.some((event) => event.event_type === "worker.extraction_failed")).toBe(false);
  });
});

describe("RPC returns >=1 and this part has approved requirements", () => {
  it("normal path: reports the approved count with reviewRequired false", async () => {
    vi.mocked(runHybridExtraction).mockResolvedValue({ ...extraction, reviewFields: [], status: "approved" } as never);
    const db = await run({ trustedReuse: false, approvedCount: 1, partApproved: true });

    expect(markTaskFailed).not.toHaveBeenCalled();
    expect(vi.mocked(markTaskCompleted).mock.calls[0][2]).toMatchObject({
      autoApprovedPartCount: 1,
      reviewRequired: false,
      autoApproved: true,
    });
    const completed = db.auditEvents.find((event) => event.event_type === "worker.extraction_completed");
    expect(completed?.payload).toMatchObject({ autoApprovedPartCount: 1, reviewRequired: false });
  });

  it("trusted-reuse path: reports the approved count with reviewRequired false", async () => {
    const db = await run({ trustedReuse: true, approvedCount: 1, partApproved: true });

    expect(markTaskFailed).not.toHaveBeenCalled();
    expect(vi.mocked(markTaskCompleted).mock.calls[0][2]).toMatchObject({
      autoApprovedPartCount: 1,
      reviewRequired: false,
    });
    expect(markTaskCompleted).toHaveBeenCalledTimes(1);
    expectReuseAudit(db, false, 1);
  });
});

describe("part approval read errors fail closed", () => {
  it.each([false, true])("fails the task and audits extraction_failed (trusted reuse=%s)", async (trustedReuse) => {
    const db = await run({ trustedReuse, approvedCount: 1, partApproved: true,
      approvalReadError: { message: "approval read failed" } });

    expect(markTaskCompleted).not.toHaveBeenCalled();
    expect(markTaskQueuedForRetry).not.toHaveBeenCalled();
    expect(markTaskFailed).toHaveBeenCalledExactlyOnceWith(db.client, task, "approval read failed", expect.any(Object));
    expect(db.auditEvents).toEqual([expect.objectContaining({
      organization_id: part.organization_id,
      event_type: "worker.extraction_failed",
      payload: expect.objectContaining({ partId: part.id, failureMessage: "approval read failed" }),
    })]);
  });
});

describe("extraction_failed audit on errors", () => {
  it("a retryable failure (canonical artifacts pending) requeues and writes no failed audit", async () => {
    const db = await run({ trustedReuse: true, approvedCount: 1, artifactsPending: true });

    expect(markTaskQueuedForRetry).toHaveBeenCalledTimes(1);
    expect(markTaskFailed).not.toHaveBeenCalled();
    expect(db.auditEvents.some((event) => event.event_type === "worker.extraction_failed")).toBe(false);
  });

  it("a non-retryable failure writes one failed audit", async () => {
    const db = await run({ trustedReuse: false, approvedCount: 1, approvalReadError: { message: "approval read failed" } });

    expect(markTaskQueuedForRetry).not.toHaveBeenCalled();
    expect(db.auditEvents.filter((event) => event.event_type === "worker.extraction_failed")).toHaveLength(1);
  });

  it("a failing audit write does not mask the original error", async () => {
    const db = await run({ trustedReuse: false, approvedCount: 1,
      approvalReadError: { message: "approval read failed" }, auditInsertError: { message: "audit insert failed" } });

    expect(markTaskFailed).toHaveBeenCalledExactlyOnceWith(db.client, task, "approval read failed", expect.any(Object));
    expect(markTaskCompleted).not.toHaveBeenCalled();
  });
});

// isRetryableExtractError (skips the failed audit) must agree with the
// extract_part cases of shouldRetry (requeues): a requeued task writes no
// extraction_failed audit, and a failed task writes exactly one.
describe("retry and failed-audit decisions agree for each extract error class", () => {
  it.each([
    ["CanonicalArtifactsPendingError", null, true],
    ["ExportControlLookupError", () => new ExportControlLookupError("extraction"), true],
    ["ExportControlStepScanRetryableError", () => new ExportControlStepScanRetryableError(), true],
    ["ExportControlScanRecordError", () => new ExportControlScanRecordError(), false],
    ["Error", () => new Error("extraction blew up"), false],
  ] as const)("%s", async (_name, makeError, retryable) => {
    if (makeError) vi.mocked(runHybridExtraction).mockRejectedValue(makeError());
    const db = await run({ trustedReuse: !makeError, approvedCount: 1, artifactsPending: !makeError });

    const failedAudits = db.auditEvents.filter((event) => event.event_type === "worker.extraction_failed");
    expect(vi.mocked(markTaskQueuedForRetry).mock.calls).toHaveLength(retryable ? 1 : 0);
    expect(vi.mocked(markTaskFailed).mock.calls).toHaveLength(retryable ? 0 : 1);
    expect(failedAudits).toHaveLength(retryable ? 0 : 1);
  });

  // The retry schedule has VENDOR_TASK_RETRY_DELAYS_MS.length slots. Past
  // them a retryable error class fails the task, so it is audited as failed.
  it("audits a retryable error class as failed once the retry schedule is exhausted", async () => {
    vi.mocked(runHybridExtraction).mockRejectedValue(new ExportControlLookupError("extraction"));
    const exhaustedTask = { ...task, attempts: VENDOR_TASK_RETRY_DELAYS_MS.length + 1 } as QueueTaskRecord;
    const db = await run({ trustedReuse: false, approvedCount: 1 }, exhaustedTask);

    const failedAudits = db.auditEvents.filter((event) => event.event_type === "worker.extraction_failed");
    expect(vi.mocked(markTaskQueuedForRetry)).not.toHaveBeenCalled();
    expect(vi.mocked(markTaskFailed)).toHaveBeenCalledOnce();
    expect(failedAudits).toEqual([expect.objectContaining({ payload: expect.objectContaining({ partId: part.id }) })]);
  });
});

it("real title-block approval changes reviewNeeded only when config enables approval", () => {
  const fixture = { partNumber: { ...titleBlockRaw("PN-1"), snippet: "PART NUMBER PN-1",
    reviewNeeded: false, reasons: ["title_block_cell_proven"] } };
  const applyApproval = (workerConfig: WorkerConfig) => {
    const fields = structuredClone(fixture);
    finalizeExtractionApproval({ fields, titleBlockApprovalEnabled: workerConfig.titleBlockApprovalEnabled });
    return fields.partNumber;
  };
  const flagOff = applyApproval({ ...config, titleBlockApprovalEnabled: false });
  const flagOn = applyApproval({ ...config, titleBlockApprovalEnabled: true });

  expect(flagOff).toMatchObject({ value: "PN-1", reviewNeeded: true });
  expect(flagOff.reasons).toContain("title_block_approval_disabled");
  expect(flagOn).toMatchObject({ value: "PN-1", reviewNeeded: false });
  expect(flagOn.reasons).not.toContain("title_block_approval_disabled");
});

describe("OVD-1067: a malformed auto-approval result still fails the task", () => {
  it.each([null, Number.NaN, -1, "abc"])("fails on %s", async (approvedCount) => {
    await run({ trustedReuse: false, approvedCount });

    expect(markTaskCompleted).not.toHaveBeenCalled();
    expect(markTaskFailed).toHaveBeenCalledTimes(1);
  });
});


describe("OVD-1097: refresh at the real main-loop acknowledgement boundary (F2/F4)", () => {
  const refreshName = "api_refresh_job_extraction_status";
  const refreshEvents = (state: ReturnType<typeof createWorkerRuntimeState>) =>
    state.recentEvents.filter((event) => event.source === "worker.job.extraction_status_refresh");

  it.each(["completed", "failed", "retry", "settled elsewhere"] as const)(
    "awaits %s persistence before exactly one separate refresh",
    async (outcome) => {
      const db = database({ trustedReuse: true, approvedCount: 0,
        artifactsReady: outcome === "retry" || outcome === "settled elsewhere" ? false : true,
        approvalError: outcome === "failed" ? new Error("Auto-approval failed outright") : undefined });
      let release!: () => void;
      let entered!: () => void;
      const reachedUpdate = new Promise<void>((resolve) => { entered = resolve; });
      const persisted = new Promise<void>((resolve) => { release = resolve; });
      const update = async () => { entered(); await persisted; };
      if (outcome === "completed") vi.mocked(markTaskCompleted).mockImplementationOnce(update);
      else if (outcome === "failed") vi.mocked(markTaskFailed).mockImplementationOnce(update);
      else vi.mocked(markTaskQueuedForRetry).mockImplementationOnce(async () => {
        await update(); return outcome !== "settled elsewhere";
      });
      const state = createWorkerRuntimeState();
      const processing = processClaimedTask(db.client, task, config, state);
      await reachedUpdate;
      expect(db.rpcCalls).not.toContain(refreshName);
      release();
      await expect(processing).resolves.toBeUndefined();
      expect(db.rpcCalls.filter((name) => name === refreshName)).toHaveLength(1);
      expect(db.rpc).toHaveBeenCalledWith(refreshName, { p_job_id: task.job_id });
      expect(refreshEvents(state)).toMatchObject([{ level: "info", context: { jobId: "job", status: "needs_spec_review" } }]);
      if (outcome === "failed") {
        expect(markTaskFailed).toHaveBeenCalledTimes(1); // B9: auto-approval itself threw.
        expect(state.lastFailedTask?.id).toBe(task.id);
      }
    },
  );

  it("refreshes when completion is a no-op because the task was cancelled elsewhere", async () => {
    vi.mocked(markTaskCompleted).mockResolvedValueOnce(undefined);
    const db = await run({ trustedReuse: true, approvedCount: 0 });
    expect(db.rpcCalls.filter((name) => name === refreshName)).toHaveLength(1);
    expect(markTaskFailed).not.toHaveBeenCalled();
  });

  it.each(["response", "throw"] as const)("B12: %s refresh error warns without changing completion or failure", async (refreshFailure) => {
    for (const failTask of [false, true]) {
      const db = database({ trustedReuse: true, approvedCount: 0, refreshFailure,
        approvalError: failTask ? new Error("Original task failure") : undefined });
      const state = createWorkerRuntimeState();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await expect(processClaimedTask(db.client, task, config, state)).resolves.toBeUndefined();
      expect(refreshEvents(state)).toMatchObject([{ level: "warn", context: { jobId: "job" } }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"source":"worker.job.extraction_status_refresh"'));
      expect(state.lastCompletedTask?.id ?? null).toBe(failTask ? null : task.id);
      expect(state.lastFailedTask?.id ?? null).toBe(failTask ? task.id : null);
      expect(state.lastError).toBe(failTask ? "Original task failure" : null);
      warn.mockRestore();
    }
    expect(markTaskCompleted).toHaveBeenCalledTimes(1);
    expect(markTaskFailed).toHaveBeenCalledTimes(1);
    expect(markTaskQueuedForRetry).not.toHaveBeenCalled();
  });

  it("does not refresh when the authoritative failure update rejects", async () => {
    const db = database({ trustedReuse: true, approvedCount: 0, approvalError: new Error("Task failed") });
    vi.mocked(markTaskFailed).mockRejectedValueOnce(new Error("Failure update not acknowledged"));
    await expect(processClaimedTask(db.client, task, config, createWorkerRuntimeState()))
      .rejects.toThrow("Failure update not acknowledged");
    expect(db.rpcCalls).not.toContain(refreshName);
  });

  it("does not refresh non-extraction tasks", async () => {
    const db = database({ trustedReuse: true, approvedCount: 0 });
    await processClaimedTask(db.client, { ...task, task_type: "poll_vendor_quote" }, config, createWorkerRuntimeState());
    expect(markTaskCompleted).toHaveBeenCalledTimes(1);
    expect(db.rpcCalls).not.toContain(refreshName);
  });
});

describe("OVD-979 U3: extraction claim provenance", () => {
  it.each(["97900000-0000-4000-8000-000000000001", "97900000-0000-4000-8000-000000000002", null, undefined])(
    "persists the claimed attempt %s on the real extraction write path", async (attemptId) => {
      const db = database({ trustedReuse: false, approvedCount: 0, queueRow: { status: "running", attempt_id: attemptId ?? null } });
      await processClaimedTask(db.client, { ...task, attempt_id: attemptId }, config, createWorkerRuntimeState());
      expect(markTaskFailed).not.toHaveBeenCalled();
      expect(markTaskCompleted).toHaveBeenCalledTimes(1);
      expect(db.extractionWrites).toMatchObject([{ part_id: task.part_id, source_attempt_id: attemptId ?? null }]);
    },
  );
});

describe("OVD-979 U4: a reaped attempt cannot overwrite its successor", () => {
  const reaped = "97900000-0000-4000-8000-000000000001";
  const successor = "97900000-0000-4000-8000-000000000002";
  it.each<[string, QueueRow]>([
    ["reclaimed under a successor attempt", { status: "running", attempt_id: successor }],
    ["requeued and not yet reclaimed", { status: "queued", attempt_id: reaped }],
    ["settled by another actor", { status: "completed", attempt_id: successor }],
    ["no longer present", null],
  ])("drops a late extraction write when the task was %s", async (_case, queueRow) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = database({ trustedReuse: false, approvedCount: 1, queueRow });
    await processClaimedTask(db.client, { ...task, attempt_id: reaped }, config, createWorkerRuntimeState());
    expect(db.extractionWrites).toEqual([]);
    expect(db.rpcCalls).not.toContain("api_auto_approve_job_requirements");
    expect(markTaskCompleted).not.toHaveBeenCalled();
    expect(markTaskFailed).not.toHaveBeenCalled();
    expect(markTaskQueuedForRetry).not.toHaveBeenCalled();
  });

  it("still writes and auto-approves while the task is this running attempt", async () => {
    const db = database({ trustedReuse: false, approvedCount: 1, queueRow: { status: "running", attempt_id: reaped } });
    await processClaimedTask(db.client, { ...task, attempt_id: reaped }, config, createWorkerRuntimeState());
    expect(db.extractionWrites).toMatchObject([{ source_attempt_id: reaped }]);
    expect(db.rpcCalls).toContain("api_auto_approve_job_requirements");
    expect(markTaskCompleted).toHaveBeenCalledTimes(1);
  });
});
