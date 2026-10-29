// @vitest-environment node
// OVD-1067: with DRAWING_EXTRACTION_TITLE_BLOCK_APPROVAL off, a new drawing
// part's title-block fields need review, so api_auto_approve_job_requirements
// approves nothing (returns 0) and leaves the fields for review. That is
// a review hold, not a failure: the extract_part task must complete.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createWorkerRuntimeState } from "./httpServer";
import { processClaimedTask } from "./index";
import { markTaskCompleted, markTaskFailed, markTaskQueuedForRetry } from "./queue";
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

function database(options: { trustedReuse: boolean; approvedCount: unknown }) {
  const rpcCalls: string[] = [];
  const auditEvents: Record<string, unknown>[] = [];
  const from = (table: string) => {
    let inserted: Record<string, unknown> | null = null;
    const response = () => {
      if (inserted) return { data: null, error: null };
      const data = table === "parts" ? part : table === "job_files" ? [drawing] : null;
      return { data, error: null };
    };
    const query: Record<string, unknown> = {};
    for (const name of ["select", "eq", "neq", "in", "is", "order", "limit", "update", "delete"]) query[name] = () => query;
    query.upsert = () => { inserted = {}; return query; };
    query.insert = (value: Record<string, unknown>) => {
      inserted = value;
      if (table === "audit_events") auditEvents.push(value);
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
      return { data: { artifactsReady: true }, error: null };
    }
    if (name === "api_auto_approve_job_requirements") {
      return { data: options.approvedCount, error: null };
    }
    return { data: null, error: null };
  };
  return { client: { from, rpc } as unknown as SupabaseClient, rpcCalls, auditEvents };
}

const flagOnConfig = { ...config, titleBlockApprovalEnabled: true } as WorkerConfig;

async function run(options: { trustedReuse: boolean; approvedCount: unknown; titleBlockApproval?: boolean }) {
  const db = database(options);
  const runConfig = options.titleBlockApproval ? flagOnConfig : config;
  await expect(processClaimedTask(db.client, task, runConfig, createWorkerRuntimeState())).resolves.toBeUndefined();
  return db;
}

beforeEach(() => {
  vi.mocked(markTaskCompleted).mockClear();
  vi.mocked(markTaskFailed).mockClear();
  vi.mocked(markTaskQueuedForRetry).mockClear();
  vi.mocked(runHybridExtraction).mockReset();
  vi.mocked(runHybridExtraction).mockResolvedValue(extraction as never);
});

describe("OVD-1067: extract_part review hold when auto-approval returns 0", () => {
  it("normal path: completes the task with reviewRequired instead of failing", async () => {
    const db = await run({ trustedReuse: false, approvedCount: 0 });

    expect(db.rpcCalls).toContain("api_auto_approve_job_requirements");
    expect(markTaskFailed).not.toHaveBeenCalled();
    expect(markTaskQueuedForRetry).not.toHaveBeenCalled();
    expect(markTaskCompleted).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markTaskCompleted).mock.calls[0][2]).toMatchObject({
      autoApprovedPartCount: 0,
      reviewRequired: true,
      extractionStatus: "needs_review",
    });
    const completed = db.auditEvents.find((event) => event.event_type === "worker.extraction_completed");
    expect(completed?.payload).toMatchObject({ autoApprovedPartCount: 0, reviewRequired: true });
    expect(db.auditEvents.some((event) => event.event_type === "worker.extraction_failed")).toBe(false);
  });

  it("trusted-reuse path: completes the task with reviewRequired instead of failing", async () => {
    const db = await run({ trustedReuse: true, approvedCount: 0 });

    expect(db.rpcCalls).toContain("api_reuse_trusted_part_version_artifacts");
    expect(db.rpcCalls).toContain("api_auto_approve_job_requirements");
    expect(runHybridExtraction).not.toHaveBeenCalled();
    expect(markTaskFailed).not.toHaveBeenCalled();
    expect(markTaskQueuedForRetry).not.toHaveBeenCalled();
    expect(markTaskCompleted).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markTaskCompleted).mock.calls[0][2]).toMatchObject({
      reusedCanonicalPartVersion: true,
      autoApprovedPartCount: 0,
      reviewRequired: true,
    });
  });
});

describe("OVD-1067: flag on, approved requirements behave as before", () => {
  it("normal path: reports the approved count with reviewRequired false", async () => {
    vi.mocked(runHybridExtraction).mockResolvedValue({ ...extraction, reviewFields: [], status: "approved" } as never);
    const db = await run({ trustedReuse: false, approvedCount: 2, titleBlockApproval: true });

    expect(markTaskFailed).not.toHaveBeenCalled();
    expect(vi.mocked(markTaskCompleted).mock.calls[0][2]).toMatchObject({
      autoApprovedPartCount: 2,
      reviewRequired: false,
      autoApproved: true,
    });
    const completed = db.auditEvents.find((event) => event.event_type === "worker.extraction_completed");
    expect(completed?.payload).toMatchObject({ autoApprovedPartCount: 2, reviewRequired: false });
  });

  it("trusted-reuse path: reports the approved count with reviewRequired false", async () => {
    await run({ trustedReuse: true, approvedCount: 1, titleBlockApproval: true });

    expect(markTaskFailed).not.toHaveBeenCalled();
    expect(vi.mocked(markTaskCompleted).mock.calls[0][2]).toMatchObject({
      autoApprovedPartCount: 1,
      reviewRequired: false,
    });
  });
});

describe("OVD-1067: a malformed auto-approval result still fails the task", () => {
  it.each([null, Number.NaN, -1, "abc"])("fails on %s", async (approvedCount) => {
    await run({ trustedReuse: false, approvedCount });

    expect(markTaskCompleted).not.toHaveBeenCalled();
    expect(markTaskFailed).toHaveBeenCalledTimes(1);
  });
});
