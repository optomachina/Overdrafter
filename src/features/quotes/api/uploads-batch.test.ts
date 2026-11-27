import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcTimeoutError } from "./shared/rpc";
import { createJobsFromUploadFiles } from "./uploads-api";
import {
  getUploadBatchSnapshot,
  resetUploadBatchStoreForTests,
} from "@/features/quotes/upload-batch-store";

const { rpcMock, storageUpload } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  storageUpload: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: rpcMock,
    storage: { from: () => ({ upload: storageUpload }) },
    functions: { invoke: vi.fn() },
  },
}));

const cleanDeclaration = {
  data: { declarationId: "declaration-1", uploadAllowed: true, reasonCode: null },
  error: null,
};

function stepFile(name: string): File {
  const bytes = new TextEncoder().encode(`solid ${name}`);
  return {
    name,
    size: bytes.byteLength,
    type: "model/step",
    lastModified: 0,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File;
}

function rpcCalls(name: string): Array<Record<string, unknown>> {
  return rpcMock.mock.calls
    .filter(([called]) => called === name)
    .map(([, args]) => (args ?? {}) as Record<string, unknown>);
}

describe("createJobsFromUploadFiles batch isolation", () => {
  let failUploadForJobId: string | null = null;
  let failReconcileForJobId: string | null = null;
  let timeoutFinalizeForJobId: string | null = null;
  let rejectFinalizeForJobId: string | null = null;
  let holdSecondDraft: Promise<void> | null = null;
  let releaseSecondDraft: (() => void) | null = null;
  let draftCount = 0;

  beforeEach(() => {
    resetUploadBatchStoreForTests();
    failUploadForJobId = null;
    failReconcileForJobId = null;
    timeoutFinalizeForJobId = null;
    rejectFinalizeForJobId = null;
    holdSecondDraft = null;
    releaseSecondDraft = null;
    draftCount = 0;
    storageUpload.mockResolvedValue({ error: null });
    rpcMock.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === "api_create_project" || name === "api_update_project" || name === "api_archive_job") {
        return { data: name === "api_create_project" ? "project-1" : args?.p_project_id ?? args?.p_job_id ?? "ok", error: null };
      }
      if (name === "api_create_client_draft") {
        draftCount += 1;
        const count = draftCount;
        if (count === 2 && holdSecondDraft) {
          await holdSecondDraft;
        }
        return { data: `job-${count}`, error: null };
      }
      if (name === "api_declare_job_export_status") {
        return cleanDeclaration;
      }
      if (name === "api_prepare_job_file_upload") {
        if (args?.p_job_id === failUploadForJobId) {
          return { data: null, error: { message: "synthetic_mid_batch_failure", code: "P0001" } };
        }
        return {
          data: { status: "upload_required", storageBucket: "job-files", storagePath: "p" },
          error: null,
        };
      }
      if (name === "api_finalize_job_file_upload") {
        if (args?.p_job_id === timeoutFinalizeForJobId) {
          throw new RpcTimeoutError("api_finalize_job_file_upload", 30_000);
        }
        if (args?.p_job_id === rejectFinalizeForJobId) {
          return { data: null, error: { message: "finalize_rejected", code: "P0001" } };
        }
        return { data: "file-1", error: null };
      }
      if (name === "api_reconcile_job_parts") {
        if (args?.p_job_id === failReconcileForJobId) {
          return { data: null, error: { message: "reconcile_unavailable", code: "P0001" } };
        }
        return { data: {}, error: null };
      }
      if (name === "api_request_extraction") {
        return { data: 1, error: null };
      }
      return { data: null, error: null };
    });
  });

  afterEach(() => {
    resetUploadBatchStoreForTests();
  });

  it("continues after a mid-batch upload failure, archives the empty draft, and renames from the groups that finished", async () => {
    failUploadForJobId = "job-2";

    const result = await createJobsFromUploadFiles({
      files: [stepFile("a.step"), stepFile("b.step"), stepFile("c.step")],
      exportControlAnswer: "not_controlled",
    });

    expect(result).toEqual({
      jobIds: ["job-1", "job-3"],
      projectId: "project-1",
      failed: [{ fileNames: ["b.step"], reason: "synthetic_mid_batch_failure" }],
      warnings: [],
    });
    expect(rpcCalls("api_create_client_draft").map((args) => args.p_title)).toEqual(["a", "b", "c"]);
    expect(rpcCalls("api_archive_job")).toEqual([{ p_job_id: "job-2" }]);
    expect(rpcCalls("api_create_project")[0]?.p_name).toBe("a + 2 parts");
    expect(rpcCalls("api_update_project")).toEqual([
      { p_project_id: "project-1", p_name: "a + 1 parts", p_description: null },
    ]);
    expect(getUploadBatchSnapshot()).toMatchObject({ phase: "complete", result });
  });

  it("keeps a draft whose finalize timed out, and archives one whose finalize was rejected", async () => {
    timeoutFinalizeForJobId = "job-1";
    rejectFinalizeForJobId = "job-2";

    const result = await createJobsFromUploadFiles({
      files: [stepFile("a.step"), stepFile("b.step")],
      exportControlAnswer: "not_controlled",
    });

    expect(result.jobIds).toEqual([]);
    expect(result.failed.map((failure) => failure.fileNames)).toEqual([["a.step"], ["b.step"]]);
    expect(rpcCalls("api_archive_job")).toEqual([{ p_job_id: "job-2" }]);
  });

  it("keeps a part whose files uploaded when reconcile fails, and still uploads the next group", async () => {
    failReconcileForJobId = "job-1";

    const result = await createJobsFromUploadFiles({
      files: [stepFile("a.step"), stepFile("b.step")],
      exportControlAnswer: "not_controlled",
    });

    expect(result.jobIds).toEqual(["job-1", "job-2"]);
    expect(result.failed).toEqual([]);
    expect(rpcCalls("api_archive_job")).toEqual([]);
    expect(rpcCalls("api_request_extraction").map((args) => args.p_job_id)).toEqual(["job-1", "job-2"]);
  });

  it("holds the running batch in the store before the loop finishes", async () => {
    let release!: () => void;
    holdSecondDraft = new Promise<void>((resolve) => {
      release = resolve;
    });
    releaseSecondDraft = release;

    const pending = createJobsFromUploadFiles({
      files: [stepFile("a.step"), stepFile("b.step")],
      exportControlAnswer: "not_controlled",
    });

    await vi.waitFor(() => {
      expect(getUploadBatchSnapshot()).toMatchObject({
        phase: "running",
        finishedGroups: 1,
        result: { jobIds: ["job-1"], failed: [] },
      });
    });

    releaseSecondDraft?.();
    await expect(pending).resolves.toMatchObject({ jobIds: ["job-1", "job-2"], failed: [] });
  });

  it("uploads assembly files first and warns when they share a stem with another CAD file", async () => {
    const result = await createJobsFromUploadFiles({
      files: [stepFile("zeta.step"), stepFile("bracket.STEP"), stepFile("bracket.SLDASM")],
      exportControlAnswer: "not_controlled",
    });

    expect(rpcCalls("api_create_client_draft").map((args) => args.p_title)).toEqual(["bracket", "zeta"]);
    expect(rpcCalls("api_prepare_job_file_upload").map((args) => args.p_original_name)).toEqual([
      "bracket.SLDASM",
      "bracket.STEP",
      "zeta.step",
    ]);
    expect(result.warnings).toEqual([
      "bracket.SLDASM and bracket.STEP share a name and were grouped into one part.",
    ]);
    expect(result.jobIds).toEqual(["job-1", "job-2"]);
    expect(rpcCalls("api_update_project")[0]?.p_name).toBe("bracket + 1 parts");
  });

  it("does not rename a project the caller already chose", async () => {
    failUploadForJobId = "job-2";

    const result = await createJobsFromUploadFiles({
      files: [stepFile("a.step"), stepFile("b.step")],
      projectId: "project-existing",
      exportControlAnswer: "not_controlled",
    });

    expect(result.projectId).toBe("project-existing");
    expect(result.jobIds).toEqual(["job-1"]);
    expect(rpcCalls("api_create_project")).toEqual([]);
    expect(rpcCalls("api_update_project")).toEqual([]);
  });
});
