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

type DatabaseOptions = {
  trustedReuse: boolean;
  approvedCount: unknown;
  partApproved?: boolean;
  approvalReadError?: { message: string };
  artifactsPending?: boolean;
  auditInsertError?: { message: string };
};

function database(options: DatabaseOptions) {
  const rpcCalls: string[] = [];
  const auditEvents: Record<string, unknown>[] = [];
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
      const data = table === "parts" ? part : table === "job_files" ? [drawing] : null;
      return { data, error: null };
    };
    const query: Record<string, unknown> = {};
    query.select = (columns: string) => { selected ??= columns; return query; };
    for (const name of ["neq", "in", "is", "order", "limit", "update", "delete"]) query[name] = () => query;
    query.eq = (column: string, value: unknown) => { filters[column] = value; return query; };
    query.upsert = () => { inserted = {}; return query; };
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
  const rpc = async (name: string) => {
    rpcCalls.push(name);
    if (name === "api_resolve_trusted_part_intake") {
      return { data: options.trustedReuse
        ? { result: "existing_version", partVersionId: "version", sourcePartId: "source-part" }
        : { result: "new_version" }, error: null };
    }
    if (name === "api_reuse_trusted_part_version_artifacts") {
      return { data: { artifactsReady: !options.artifactsPending }, error: null };
    }
    if (name === "api_auto_approve_job_requirements") {
      return { data: options.approvedCount, error: null };
    }
    return { data: null, error: null };
  };
  return { client: { from, rpc } as unknown as SupabaseClient, rpcCalls, auditEvents, auditInsert };
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
  vi.mocked(markTaskCompleted).mockClear();
  vi.mocked(markTaskFailed).mockClear();
  vi.mocked(markTaskQueuedForRetry).mockClear();
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
    expect(vi.mocked(markTaskQueuedForRetry).mock.calls.length).toBe(retryable ? 1 : 0);
    expect(vi.mocked(markTaskFailed).mock.calls.length).toBe(retryable ? 0 : 1);
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
