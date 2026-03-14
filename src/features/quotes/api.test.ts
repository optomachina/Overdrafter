import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FunctionsHttpError } from "@supabase/supabase-js";

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

const supabaseMock = vi.hoisted(() => {
  const storageUpload = vi.fn();
  const storageFrom = vi.fn(() => ({
    upload: storageUpload,
  }));
  const rpc = vi.fn();
  const functionsInvoke = vi.fn();
  const authGetUser = vi.fn();

  const membershipsOrder = vi.fn();
  const membershipsEq = vi.fn(() => ({ order: membershipsOrder }));
  const membershipsSelect = vi.fn(() => ({ eq: membershipsEq }));

  const projectsOrder = vi.fn();
  const projectsIs = vi.fn();
  const projectsNot = vi.fn();
  const projectsEq = vi.fn();
  const projectsIn = vi.fn();
  const projectsSingle = vi.fn();
  const projectsMaybeSingle = vi.fn();
  const projectsQuery = {
    eq: projectsEq,
    in: projectsIn,
    is: projectsIs,
    maybeSingle: projectsMaybeSingle,
    not: projectsNot,
    order: projectsOrder,
    single: projectsSingle,
  };
  projectsOrder.mockImplementation(() => projectsQuery);
  projectsIs.mockImplementation(() => projectsQuery);
  projectsNot.mockImplementation(() => projectsQuery);
  projectsEq.mockImplementation(() => projectsQuery);
  projectsIn.mockImplementation(() => projectsQuery);
  const projectsSelect = vi.fn(() => projectsQuery);

  const jobsOrder = vi.fn();
  const jobsIs = vi.fn();
  const jobsNot = vi.fn();
  const jobsEq = vi.fn();
  const jobsIn = vi.fn();
  const jobsSingle = vi.fn();
  const jobsQuery = {
    eq: jobsEq,
    in: jobsIn,
    is: jobsIs,
    not: jobsNot,
    order: jobsOrder,
    single: jobsSingle,
  };
  jobsOrder.mockImplementation(() => jobsQuery);
  jobsIs.mockImplementation(() => jobsQuery);
  jobsNot.mockImplementation(() => jobsQuery);
  jobsEq.mockImplementation(() => jobsQuery);
  jobsIn.mockImplementation(() => jobsQuery);
  const jobsSelect = vi.fn(() => jobsQuery);

  const pinnedProjectsOrder = vi.fn();
  const pinnedProjectsEq = vi.fn(() => ({ order: pinnedProjectsOrder }));
  const pinnedProjectsSelect = vi.fn(() => ({ eq: pinnedProjectsEq }));

  const pinnedProjectsDeleteEqSecond = vi.fn();
  const pinnedProjectsDeleteEqFirst = vi.fn(() => ({ eq: pinnedProjectsDeleteEqSecond }));
  const pinnedProjectsDelete = vi.fn(() => ({ eq: pinnedProjectsDeleteEqFirst }));
  const pinnedProjectsUpsert = vi.fn();

  const pinnedJobsOrder = vi.fn();
  const pinnedJobsEq = vi.fn(() => ({ order: pinnedJobsOrder }));
  const pinnedJobsSelect = vi.fn(() => ({ eq: pinnedJobsEq }));

  const pinnedJobsDeleteEqSecond = vi.fn();
  const pinnedJobsDeleteEqFirst = vi.fn(() => ({ eq: pinnedJobsDeleteEqSecond }));
  const pinnedJobsDelete = vi.fn(() => ({ eq: pinnedJobsDeleteEqFirst }));
  const pinnedJobsUpsert = vi.fn();

  const vendorQuoteResultsMaybeSingle = vi.fn();
  const vendorQuoteResultsEqRequestedQuantity = vi.fn(() => ({
    maybeSingle: vendorQuoteResultsMaybeSingle,
  }));
  const vendorQuoteResultsEqVendor = vi.fn(() => ({ eq: vendorQuoteResultsEqRequestedQuantity }));
  const vendorQuoteResultsEqPartId = vi.fn(() => ({ eq: vendorQuoteResultsEqVendor }));
  const vendorQuoteResultsEqQuoteRunId = vi.fn(() => ({ eq: vendorQuoteResultsEqPartId }));
  const vendorQuoteResultsSelect = vi.fn(() => ({ eq: vendorQuoteResultsEqQuoteRunId }));

  const workQueueIn = vi.fn();
  const workQueueEqTaskType = vi.fn(() => ({ in: workQueueIn }));
  const workQueueEqPartId = vi.fn(() => ({ eq: workQueueEqTaskType }));
  const workQueueEqQuoteRunId = vi.fn(() => ({ eq: workQueueEqPartId }));
  const workQueueEqJobId = vi.fn(() => ({ eq: workQueueEqQuoteRunId }));
  const workQueueSelect = vi.fn(() => ({ eq: workQueueEqJobId }));
  const workQueueInsertSingle = vi.fn();
  const workQueueInsertSelect = vi.fn(() => ({ single: workQueueInsertSingle }));
  const workQueueInsert = vi.fn(() => ({ select: workQueueInsertSelect }));

  const from = vi.fn((table: string) => {
    if (table === "organization_memberships") {
      return {
        select: membershipsSelect,
      };
    }

    if (table === "projects") {
      return {
        select: projectsSelect,
      };
    }

    if (table === "jobs") {
      return {
        select: jobsSelect,
      };
    }

    if (table === "user_pinned_projects") {
      return {
        select: pinnedProjectsSelect,
        delete: pinnedProjectsDelete,
        upsert: pinnedProjectsUpsert,
      };
    }

    if (table === "user_pinned_jobs") {
      return {
        select: pinnedJobsSelect,
        delete: pinnedJobsDelete,
        upsert: pinnedJobsUpsert,
      };
    }

    if (table === "vendor_quote_results") {
      return {
        select: vendorQuoteResultsSelect,
      };
    }

    if (table === "work_queue") {
      return {
        select: workQueueSelect,
        insert: workQueueInsert,
      };
    }

    throw new Error(`Unexpected table: ${table}`);
  });

  return {
    authGetUser,
    from,
    membershipsEq,
    membershipsOrder,
    membershipsSelect,
    jobsEq,
    jobsIn,
    jobsIs,
    jobsNot,
    jobsOrder,
    jobsQuery,
    jobsSelect,
    jobsSingle,
    projectsOrder,
    projectsEq,
    projectsIn,
    projectsIs,
    projectsNot,
    projectsQuery,
    projectsSelect,
    projectsMaybeSingle,
    projectsSingle,
    pinnedJobsDelete,
    pinnedJobsDeleteEqFirst,
    pinnedJobsDeleteEqSecond,
    pinnedJobsEq,
    pinnedJobsOrder,
    pinnedJobsSelect,
    pinnedJobsUpsert,
    pinnedProjectsDelete,
    pinnedProjectsDeleteEqFirst,
    pinnedProjectsDeleteEqSecond,
    pinnedProjectsEq,
    pinnedProjectsOrder,
    pinnedProjectsSelect,
    pinnedProjectsUpsert,
    rpc,
    functionsInvoke,
    storageFrom,
    storageUpload,
    vendorQuoteResultsMaybeSingle,
    vendorQuoteResultsEqRequestedQuantity,
    vendorQuoteResultsEqVendor,
    vendorQuoteResultsEqPartId,
    vendorQuoteResultsEqQuoteRunId,
    vendorQuoteResultsSelect,
    workQueueEqJobId,
    workQueueEqQuoteRunId,
    workQueueEqPartId,
    workQueueEqTaskType,
    workQueueIn,
    workQueueSelect,
    workQueueInsert,
    workQueueInsertSelect,
    workQueueInsertSingle,
  };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: supabaseMock.authGetUser,
    },
    from: supabaseMock.from,
    storage: {
      from: supabaseMock.storageFrom,
    },
    functions: {
      invoke: supabaseMock.functionsInvoke,
    },
    rpc: supabaseMock.rpc,
  },
}));

vi.mock("sonner", () => ({
  toast: toastMock,
}));

function createMockFile(contents: string, name: string, options: { type?: string } = {}): File {
  const bytes = new TextEncoder().encode(contents);

  return {
    name,
    size: bytes.byteLength,
    type: options.type ?? "",
    lastModified: Date.now(),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File;
}

import {
  ClientIntakeCompatibilityError,
  checkClientIntakeCompatibility,
  createClientDraft,
  createJob,
  createJobsFromUploadFiles,
  createProject,
  deleteArchivedJob,
  enqueueDebugVendorQuote,
  fetchAccessibleProjects,
  fetchAppSessionData,
  fetchProject,
  fetchWorkerReadiness,
  findDuplicateUploadSelections,
  fetchSidebarPins,
  getClientIntakeCompatibilityMessage,
  inferFileKind,
  pinJob,
  pinProject,
  resetClientIntakeSchemaAvailabilityForTests,
  resetProjectCollaborationSchemaAvailabilityForTests,
  unarchiveJob,
  unpinJob,
  unpinProject,
  uploadFilesToJob,
  uploadManualQuoteEvidence,
} from "./api";

describe("quotes api helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-03T12:34:56.000Z"));
    resetClientIntakeSchemaAvailabilityForTests();
    resetProjectCollaborationSchemaAvailabilityForTests();
    supabaseMock.projectsOrder.mockImplementation(() => supabaseMock.projectsQuery);
    supabaseMock.projectsIs.mockImplementation(() => supabaseMock.projectsQuery);
    supabaseMock.projectsNot.mockImplementation(() => supabaseMock.projectsQuery);
    supabaseMock.projectsEq.mockImplementation(() => supabaseMock.projectsQuery);
    supabaseMock.projectsIn.mockImplementation(() => supabaseMock.projectsQuery);
    supabaseMock.projectsSelect.mockImplementation(() => supabaseMock.projectsQuery);
    supabaseMock.jobsOrder.mockImplementation(() => supabaseMock.jobsQuery);
    supabaseMock.jobsIs.mockImplementation(() => supabaseMock.jobsQuery);
    supabaseMock.jobsNot.mockImplementation(() => supabaseMock.jobsQuery);
    supabaseMock.jobsEq.mockImplementation(() => supabaseMock.jobsQuery);
    supabaseMock.jobsIn.mockImplementation(() => supabaseMock.jobsQuery);
    supabaseMock.jobsSelect.mockImplementation(() => supabaseMock.jobsQuery);
    supabaseMock.authGetUser.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
        },
      },
      error: null,
    });
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => "uuid-default"),
      subtle: {
        digest: vi.fn(async (_algorithm: string, data: BufferSource) => {
          const isArrayBuffer =
            Object.prototype.toString.call(data) === "[object ArrayBuffer]" ||
            data?.constructor?.name === "ArrayBuffer";
          const bytes =
            isArrayBuffer
              ? Buffer.from(new Uint8Array(data as ArrayBuffer))
              : ArrayBuffer.isView(data)
                ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
                : Buffer.alloc(0);
          const digest = createHash("sha256").update(Buffer.from(bytes)).digest();
          return Uint8Array.from(digest).buffer;
        }),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("infers CAD, drawing, and other file kinds case-insensitively", () => {
    expect(inferFileKind("assembly.STEP")).toBe("cad");
    expect(inferFileKind("print.PDF")).toBe("drawing");
    expect(inferFileKind("notes.txt")).toBe("other");
  });

  it("unarchives a job through the dedicated RPC", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({ data: "job-123", error: null });

    await expect(unarchiveJob("job-123")).resolves.toBe("job-123");

    expect(supabaseMock.rpc).toHaveBeenCalledWith("api_unarchive_job", {
      p_job_id: "job-123",
    });
  });

  it("surfaces the project-collaboration compatibility message when the unarchive RPC is missing from schema cache", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find the function public.api_unarchive_job(p_job_id) in the schema cache",
        details: null,
        hint: null,
      },
    });

    await expect(unarchiveJob("job-123")).rejects.toThrow(
      "Projects are unavailable in this environment until the shared workspace schema is applied.",
    );
  });

  it("deletes an archived job through the dedicated RPC", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({ data: "job-123", error: null });

    await expect(deleteArchivedJob("job-123")).resolves.toBe("job-123");

    expect(supabaseMock.rpc).toHaveBeenCalledWith("api_delete_archived_job", {
      p_job_id: "job-123",
    });
  });

  it("uploads job files through prepare/finalize RPCs and returns a summary", async () => {
    supabaseMock.storageUpload.mockResolvedValue({ error: null });
    supabaseMock.rpc
      .mockResolvedValueOnce({
        data: {
          status: "upload_required",
          storageBucket: "job-files",
          storagePath: "org-sha256/org-1/hash-a/bracket.step",
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: "file-1", error: null })
      .mockResolvedValueOnce({
        data: {
          status: "upload_required",
          storageBucket: "job-files",
          storagePath: "org-sha256/org-1/hash-b/bracket.pdf",
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: "file-2", error: null });

    const files = [
      createMockFile("step", "bracket.step", { type: "model/step" }),
      createMockFile("drawing", "bracket.pdf", { type: "application/pdf" }),
    ];

    await expect(uploadFilesToJob("job-123", files)).resolves.toEqual({
      uploadedCount: 2,
      reusedCount: 0,
      duplicateNames: [],
    });

    expect(supabaseMock.storageFrom).toHaveBeenNthCalledWith(1, "job-files");
    expect(supabaseMock.storageFrom).toHaveBeenNthCalledWith(2, "job-files");
    expect(supabaseMock.storageUpload).toHaveBeenNthCalledWith(
      1,
      "org-sha256/org-1/hash-a/bracket.step",
      files[0],
      { upsert: false },
    );
    expect(supabaseMock.storageUpload).toHaveBeenNthCalledWith(
      2,
      "org-sha256/org-1/hash-b/bracket.pdf",
      files[1],
      { upsert: false },
    );
    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(1, "api_prepare_job_file_upload", {
      p_job_id: "job-123",
      p_original_name: "bracket.step",
      p_file_kind: "cad",
      p_mime_type: "model/step",
      p_size_bytes: files[0].size,
      p_content_sha256: expect.any(String),
    });
    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(2, "api_finalize_job_file_upload", {
      p_job_id: "job-123",
      p_storage_bucket: "job-files",
      p_storage_path: "org-sha256/org-1/hash-a/bracket.step",
      p_original_name: "bracket.step",
      p_file_kind: "cad",
      p_mime_type: "model/step",
      p_size_bytes: files[0].size,
      p_content_sha256: expect.any(String),
    });
    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(3, "api_prepare_job_file_upload", {
      p_job_id: "job-123",
      p_original_name: "bracket.pdf",
      p_file_kind: "drawing",
      p_mime_type: "application/pdf",
      p_size_bytes: files[1].size,
      p_content_sha256: expect.any(String),
    });
    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(4, "api_finalize_job_file_upload", {
      p_job_id: "job-123",
      p_storage_bucket: "job-files",
      p_storage_path: "org-sha256/org-1/hash-b/bracket.pdf",
      p_original_name: "bracket.pdf",
      p_file_kind: "drawing",
      p_mime_type: "application/pdf",
      p_size_bytes: files[1].size,
      p_content_sha256: expect.any(String),
    });
  });

  it("stops when file storage upload fails", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: {
        status: "upload_required",
        storageBucket: "job-files",
        storagePath: "org-sha256/org-1/hash-a/bad.step",
      },
      error: null,
    });
    supabaseMock.storageUpload.mockResolvedValueOnce({
      error: new Error("Storage down"),
    });

    await expect(
      uploadFilesToJob("job-123", [createMockFile("x", "bad.step", { type: "model/step" })]),
    ).rejects.toThrow("Storage down");

    expect(supabaseMock.rpc).toHaveBeenCalledTimes(1);
  });

  it("skips same-job duplicates reported by the prepare RPC", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: {
        status: "duplicate_in_job",
      },
      error: null,
    });

    await expect(
      uploadFilesToJob("job-123", [createMockFile("x", "duplicate.step", { type: "model/step" })]),
    ).resolves.toEqual({
      uploadedCount: 0,
      reusedCount: 0,
      duplicateNames: ["duplicate.step"],
    });

    expect(supabaseMock.storageUpload).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith("duplicate.step is already attached to this part.");
  });

  it("reuses org-scoped duplicates without uploading the blob again", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: {
        status: "reused",
        fileId: "file-reused-1",
      },
      error: null,
    });

    await expect(
      uploadFilesToJob("job-123", [createMockFile("x", "reused.step", { type: "model/step" })]),
    ).resolves.toEqual({
      uploadedCount: 0,
      reusedCount: 1,
      duplicateNames: [],
    });

    expect(supabaseMock.storageUpload).not.toHaveBeenCalled();
    expect(toastMock.success).toHaveBeenCalledWith("Reused 1 existing file from your workspace.");
  });

  it("skips duplicate content within a selected batch before hitting the network twice", async () => {
    supabaseMock.rpc
      .mockResolvedValueOnce({
        data: {
          status: "upload_required",
          storageBucket: "job-files",
          storagePath: "org-sha256/org-1/hash-a/first.step",
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: "file-1", error: null });
    supabaseMock.storageUpload.mockResolvedValue({ error: null });

    const duplicateContent = "same-content";
    await expect(
      uploadFilesToJob("job-123", [
        createMockFile(duplicateContent, "first.step", { type: "model/step" }),
        createMockFile(duplicateContent, "second.step", { type: "model/step" }),
      ]),
    ).resolves.toEqual({
      uploadedCount: 1,
      reusedCount: 0,
      duplicateNames: ["second.step"],
    });

    expect(supabaseMock.rpc).toHaveBeenCalledTimes(2);
    expect(toastMock.error).toHaveBeenCalledWith("second.step is duplicated in this upload batch and was skipped.");
  });

  it("finds duplicate file selections by content hash", async () => {
    await expect(
      findDuplicateUploadSelections([
        createMockFile("a", "first.step", { type: "model/step" }),
        createMockFile("b", "second.step", { type: "model/step" }),
        createMockFile("a", "third.step", { type: "model/step" }),
      ]),
    ).resolves.toEqual(["third.step"]);
  });

  it("uploads manual quote evidence with sanitized artifact paths and metadata", async () => {
    supabaseMock.storageUpload.mockResolvedValue({ error: null });
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => "uuid-123"),
    });

    const file = createMockFile("quote", "RFQ #12.PDF", { type: "application/pdf" });
    const now = Date.now();
    const uploadedAt = new Date(now).toISOString();

    await expect(uploadManualQuoteEvidence("job-321", [file])).resolves.toEqual([
      {
        artifactType: "uploaded_evidence",
        storageBucket: "quote-artifacts",
        storagePath: `manual-quotes/job-321/${now}-uuid-123-rfq-12.pdf`,
        metadata: {
          originalName: "RFQ #12.PDF",
          mimeType: "application/pdf",
          sizeBytes: file.size,
          uploadedAt,
        },
      },
    ]);

    expect(supabaseMock.storageFrom).toHaveBeenCalledWith("quote-artifacts");
    expect(supabaseMock.storageUpload).toHaveBeenCalledWith(
      `manual-quotes/job-321/${now}-uuid-123-rfq-12.pdf`,
      file,
      {
        upsert: false,
        contentType: "application/pdf",
      },
    );
  });

  it("enqueues a single debug vendor quote task for an existing Xometry lane", async () => {
    supabaseMock.vendorQuoteResultsMaybeSingle.mockResolvedValue({
      data: {
        id: "vendor-quote-1",
        organization_id: "org-1",
        status: "failed",
      },
      error: null,
    });
    supabaseMock.workQueueIn.mockResolvedValue({
      data: [],
      error: null,
    });
    supabaseMock.workQueueInsertSingle.mockResolvedValue({
      data: {
        id: "task-1",
      },
      error: null,
    });

    await expect(
      enqueueDebugVendorQuote({
        jobId: "job-1",
        quoteRunId: "run-1",
        partId: "part-1",
        vendor: "xometry",
        requestedQuantity: 25,
      }),
    ).resolves.toBe("task-1");

    expect(supabaseMock.vendorQuoteResultsSelect).toHaveBeenCalledWith("id, organization_id, status");
    expect(supabaseMock.workQueueInsert).toHaveBeenCalledWith({
      organization_id: "org-1",
      job_id: "job-1",
      part_id: "part-1",
      quote_run_id: "run-1",
      task_type: "run_vendor_quote",
      status: "queued",
      payload: {
        quoteRunId: "run-1",
        partId: "part-1",
        vendor: "xometry",
        vendorQuoteResultId: "vendor-quote-1",
        requestedQuantity: 25,
        source: "xometry-debug-submit",
      },
    });
  });

  it("rejects duplicate queued or running debug submissions for the same Xometry lane", async () => {
    supabaseMock.vendorQuoteResultsMaybeSingle.mockResolvedValue({
      data: {
        id: "vendor-quote-1",
        organization_id: "org-1",
        status: "failed",
      },
      error: null,
    });
    supabaseMock.workQueueIn.mockResolvedValue({
      data: [
        {
          id: "task-queued",
          status: "queued",
          payload: {
            vendor: "xometry",
            requestedQuantity: 10,
          },
        },
      ],
      error: null,
    });

    await expect(
      enqueueDebugVendorQuote({
        jobId: "job-1",
        quoteRunId: "run-1",
        partId: "part-1",
        vendor: "xometry",
        requestedQuantity: 10,
      }),
    ).rejects.toThrow("A Xometry quote task is already queued or running for this part and quantity.");
  });

  it("returns worker readiness data when the probe is configured", async () => {
    vi.stubEnv("VITE_WORKER_BASE_URL", "https://worker.example.com");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ready: true,
          workerName: "worker-1",
          workerMode: "live",
          status: "running",
          readinessIssues: [],
        }),
      }),
    );

    await expect(fetchWorkerReadiness()).resolves.toEqual({
      reachable: true,
      ready: true,
      workerName: "worker-1",
      workerMode: "live",
      status: "running",
      readinessIssues: [],
      message: null,
      url: "https://worker.example.com/readyz",
    });
  });

  it("falls back to api_create_job when api_create_client_draft is unavailable", async () => {
    supabaseMock.rpc.mockImplementation((fn: string) => {
      if (fn === "api_create_client_draft") {
        const attempt = supabaseMock.rpc.mock.calls.filter(([name]) => name === "api_create_client_draft").length;

        if (attempt === 1) {
          return Promise.resolve({
            data: null,
            error: {
              code: "42883",
              message: "function public.api_create_client_draft does not exist",
              details: null,
              hint: null,
            },
          });
        }

        return Promise.resolve({
          data: null,
          error: {
            code: "42883",
            message: "function public.api_create_client_draft does not exist",
            details: null,
            hint: null,
          },
        });
      }

      if (fn === "api_create_job") {
        return Promise.resolve({
          data: "job-fallback-1",
          error: null,
        });
      }

      return Promise.resolve({ data: null, error: null });
    });

    supabaseMock.membershipsOrder.mockResolvedValue({
      data: [
        {
          id: "membership-1",
          organization_id: "org-123",
          role: "client",
          organizations: {
            id: "org-123",
            name: "Acme",
            slug: "acme",
          },
        },
      ],
      error: null,
    });

    await expect(
      createClientDraft({
        title: "Bracket",
        description: "Upload test",
        tags: [],
      }),
    ).resolves.toBe("job-fallback-1");

    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(1, "api_create_client_draft", {
      p_title: "Bracket",
      p_description: "Upload test",
      p_project_id: null,
      p_tags: [],
      p_requested_service_kinds: [],
      p_primary_service_kind: null,
      p_service_notes: null,
      p_requested_quote_quantities: [],
      p_requested_by_date: null,
    });
    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(2, "api_create_client_draft", {
      p_title: "Bracket",
      p_description: "Upload test",
      p_project_id: null,
      p_tags: [],
      p_requested_quote_quantities: [],
      p_requested_by_date: null,
    });
    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(3, "api_create_client_draft", {
      p_title: "Bracket",
      p_description: "Upload test",
      p_project_id: null,
      p_tags: [],
    });
    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(4, "api_create_job", {
      p_organization_id: "org-123",
      p_title: "Bracket",
      p_description: "Upload test",
      p_source: "client_home",
      p_tags: [],
      p_requested_service_kinds: [],
      p_primary_service_kind: null,
      p_service_notes: null,
      p_requested_quote_quantities: [],
      p_requested_by_date: null,
    });
  });

  it("reports legacy intake compatibility when the probe RPC is missing", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "42883",
        message: "function public.api_get_client_intake_compatibility does not exist",
        details: null,
        hint: null,
      },
    });

    await expect(checkClientIntakeCompatibility()).resolves.toBe("legacy");
    expect(getClientIntakeCompatibilityMessage()).toContain("20260313143000_add_request_service_intent.sql");
  });

  it("reports available intake compatibility when the probe RPC confirms the current schema", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: {
        supportsCurrentCreateJob: true,
        supportsLegacyCreateJobV2: true,
        supportsLegacyCreateJobV1: true,
        supportsLegacyCreateJobV0: true,
        supportsCurrentCreateClientDraft: true,
        supportsLegacyCreateClientDraftV1: true,
        supportsLegacyCreateClientDraftV0: true,
        hasRequestedServiceKindsColumn: true,
        hasPrimaryServiceKindColumn: true,
        hasServiceNotesColumn: true,
        missing: [],
      },
      error: null,
    });

    await expect(checkClientIntakeCompatibility()).resolves.toBe("available");
    expect(supabaseMock.rpc).toHaveBeenCalledWith("api_get_client_intake_compatibility", {});
  });

  it("throws a compatibility error when job creation is blocked by client intake schema drift", async () => {
    supabaseMock.rpc
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "PGRST202",
          message:
            "Could not find the function public.api_create_job(p_description, p_organization_id, p_primary_service_kind, p_requested_by_date, p_requested_quote_quantities, p_requested_service_kinds, p_service_notes, p_source, p_tags, p_title) in the schema cache",
          details: null,
          hint: null,
        },
      })
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "42703",
          message: 'column "primary_service_kind" of relation "jobs" does not exist',
          details: null,
          hint: null,
        },
      });

    const promise = createJob({
      organizationId: "org-123",
      title: "Bracket",
      description: "Upload test",
      source: "client_home",
      tags: [],
      requestedServiceKinds: ["manufacturing_quote"],
      primaryServiceKind: "manufacturing_quote",
      serviceNotes: "Need options",
      requestedQuoteQuantities: [1, 10],
      requestedByDate: "2026-04-15",
    });

    await expect(promise).rejects.toBeInstanceOf(ClientIntakeCompatibilityError);
    await expect(promise).rejects.toMatchObject({
      message: expect.stringContaining("20260313143000_add_request_service_intent.sql"),
    });
    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(1, "api_create_job", {
      p_organization_id: "org-123",
      p_title: "Bracket",
      p_description: "Upload test",
      p_source: "client_home",
      p_tags: [],
      p_requested_service_kinds: ["manufacturing_quote"],
      p_primary_service_kind: "manufacturing_quote",
      p_service_notes: "Need options",
      p_requested_quote_quantities: [1, 10],
      p_requested_by_date: "2026-04-15",
    });
    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(2, "api_create_job", {
      p_organization_id: "org-123",
      p_title: "Bracket",
      p_description: "Upload test",
      p_source: "client_home",
      p_tags: [],
      p_requested_quote_quantities: [1, 10],
      p_requested_by_date: "2026-04-15",
    });
  });

  it("passes structured request fields to api_create_client_draft", async () => {
    supabaseMock.rpc.mockResolvedValue({
      data: "job-structured-1",
      error: null,
    });

    await expect(
      createClientDraft({
        title: "Bracket",
        description: "I need 10 of these by April 15",
        tags: [],
        requestedQuoteQuantities: [10],
        requestedByDate: "2026-04-15",
      }),
    ).resolves.toBe("job-structured-1");

    expect(supabaseMock.rpc).toHaveBeenCalledWith("api_create_client_draft", {
      p_title: "Bracket",
      p_description: "I need 10 of these by April 15",
      p_project_id: null,
      p_tags: [],
      p_requested_service_kinds: [],
      p_primary_service_kind: null,
      p_service_notes: null,
      p_requested_quote_quantities: [10],
      p_requested_by_date: "2026-04-15",
    });
  });

  it("creates upload drafts from file stems and reuses parsed request metadata for each upload group", async () => {
    supabaseMock.storageUpload.mockResolvedValue({ error: null });
    supabaseMock.rpc.mockImplementation((fn: string) => {
      if (fn === "api_create_project") {
        return Promise.resolve({ data: "project-1", error: null });
      }

      if (fn === "api_create_client_draft") {
        const jobId = supabaseMock.rpc.mock.calls.filter(([name]) => name === "api_create_client_draft").length;
        return Promise.resolve({ data: `job-${jobId}`, error: null });
      }

      if (fn === "api_prepare_job_file_upload") {
        const originalName = supabaseMock.rpc.mock.calls.at(-1)?.[1]?.p_original_name;
        return Promise.resolve({
          data: {
            status: "upload_required",
            storageBucket: "job-files",
            storagePath: `org-sha256/project-1/${originalName}`,
          },
          error: null,
        });
      }

      if (fn === "api_finalize_job_file_upload") {
        return Promise.resolve({ data: "file-1", error: null });
      }

      if (fn === "api_reconcile_job_parts") {
        return Promise.resolve({ data: {}, error: null });
      }

      if (fn === "api_request_extraction") {
        return Promise.resolve({ data: 1, error: null });
      }

      return Promise.resolve({ data: null, error: null });
    });

    const files = [
      createMockFile("a", "alpha.step", { type: "model/step" }),
      createMockFile("b", "beta.step", { type: "model/step" }),
    ];

    await expect(
      createJobsFromUploadFiles({
        files,
        prompt: "I need 10 of these by April 15",
      }),
    ).resolves.toEqual({
      jobIds: ["job-1", "job-2"],
      projectId: "project-1",
    });

    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(1, "api_create_project", {
      p_name: "alpha + 1 parts",
      p_description: null,
    });
    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(2, "api_create_client_draft", {
      p_title: "alpha",
      p_description: "I need 10 of these by April 15",
      p_project_id: "project-1",
      p_tags: [],
      p_requested_service_kinds: ["manufacturing_quote"],
      p_primary_service_kind: "manufacturing_quote",
      p_service_notes: null,
      p_requested_quote_quantities: [10],
      p_requested_by_date: "2026-04-15",
    });
    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(7, "api_create_client_draft", {
      p_title: "beta",
      p_description: "I need 10 of these by April 15",
      p_project_id: "project-1",
      p_tags: [],
      p_requested_service_kinds: ["manufacturing_quote"],
      p_primary_service_kind: "manufacturing_quote",
      p_service_notes: null,
      p_requested_quote_quantities: [10],
      p_requested_by_date: "2026-04-15",
    });
  });

  it("retries project creation against the legacy one-argument RPC signature", async () => {
    supabaseMock.rpc
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "PGRST202",
          message: "Could not find the function public.api_create_project(p_description, p_name) in the schema cache",
          details: null,
          hint: null,
        },
      })
      .mockResolvedValueOnce({
        data: "project-fallback-1",
        error: null,
      });

    await expect(createProject({ name: "Fixture project" })).resolves.toBe("project-fallback-1");

    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(1, "api_create_project", {
      p_name: "Fixture project",
      p_description: null,
    });
    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(2, "api_create_project", {
      p_name: "Fixture project",
    });
  });

  it("falls back to the edge function when project creation RPCs are unavailable", async () => {
    supabaseMock.rpc
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "PGRST202",
          message: "Could not find the function public.api_create_project(p_description, p_name) in the schema cache",
          details: null,
          hint: null,
        },
      })
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "PGRST202",
          message: "Could not find the function public.api_create_project(p_name) in the schema cache",
          details: null,
          hint: null,
        },
      });
    supabaseMock.functionsInvoke.mockResolvedValue({
      data: {
        projectId: "project-edge-1",
      },
      error: null,
    });

    await expect(createProject({ name: "Fixture project" })).resolves.toBe("project-edge-1");

    expect(supabaseMock.functionsInvoke).toHaveBeenCalledWith("create-project-fallback", {
      body: {
        name: "Fixture project",
        description: null,
      },
    });
  });

  it("surfaces a compatibility message when the project schema is unavailable", async () => {
    supabaseMock.rpc
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "PGRST202",
          message: "Could not find the function public.api_create_project(p_description, p_name) in the schema cache",
          details: null,
          hint: null,
        },
      })
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "PGRST202",
          message: "Could not find the function public.api_create_project(p_name) in the schema cache",
          details: null,
          hint: null,
        },
      });
    supabaseMock.functionsInvoke.mockResolvedValue({
      data: null,
      error: new Error('relation "public.projects" does not exist'),
    });

    await expect(createProject({ name: "Fixture project" })).rejects.toThrow(
      "Projects are unavailable in this environment until the shared workspace schema is applied.",
    );
  });

  it("surfaces edge function error bodies during project creation fallback", async () => {
    supabaseMock.rpc
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "PGRST202",
          message: "Could not find the function public.api_create_project(p_description, p_name) in the schema cache",
          details: null,
          hint: null,
        },
      })
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "PGRST202",
          message: "Could not find the function public.api_create_project(p_name) in the schema cache",
          details: null,
          hint: null,
        },
      });
    supabaseMock.functionsInvoke.mockResolvedValue({
      data: null,
      error: new FunctionsHttpError(
        new Response(JSON.stringify({ error: "A home workspace is still being prepared for this account." }), {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }),
      ),
    });

    await expect(createProject({ name: "Fixture project" })).rejects.toThrow(
      "A home workspace is still being prepared for this account.",
    );
  });

  it("fetches pinned project and job ids for the current user", async () => {
    supabaseMock.pinnedProjectsOrder.mockResolvedValue({
      data: [
        {
          id: "pin-project-1",
          user_id: "user-1",
          project_id: "project-1",
          created_at: "2026-03-03T00:00:00.000Z",
        },
      ],
      error: null,
    });
    supabaseMock.pinnedJobsOrder.mockResolvedValue({
      data: [
        {
          id: "pin-job-1",
          user_id: "user-1",
          job_id: "job-1",
          created_at: "2026-03-03T00:00:00.000Z",
        },
        {
          id: "pin-job-2",
          user_id: "user-1",
          job_id: "job-2",
          created_at: "2026-03-03T00:00:01.000Z",
        },
      ],
      error: null,
    });

    await expect(fetchSidebarPins()).resolves.toEqual({
      projectIds: ["project-1"],
      jobIds: ["job-1", "job-2"],
    });

    expect(supabaseMock.from).toHaveBeenCalledWith("user_pinned_projects");
    expect(supabaseMock.from).toHaveBeenCalledWith("user_pinned_jobs");
    expect(supabaseMock.pinnedProjectsEq).toHaveBeenCalledWith("user_id", "user-1");
    expect(supabaseMock.pinnedJobsEq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("returns an empty project list when the project schema has not been applied", async () => {
    supabaseMock.projectsOrder.mockResolvedValue({
      data: null,
      error: {
        code: "PGRST205",
        message: "Could not find the table 'public.projects' in the schema cache",
        details: null,
        hint: null,
      },
    });

    await expect(fetchAccessibleProjects()).resolves.toEqual([]);

    expect(supabaseMock.from).toHaveBeenCalledWith("projects");
  });

  it("returns an anonymous app session when the stored JWT references a deleted user", async () => {
    supabaseMock.authGetUser.mockResolvedValue({
      data: { user: null },
      error: {
        code: "user_not_found",
        message: "User from sub claim in JWT does not exist",
        name: "AuthApiError",
      },
    });

    await expect(fetchAppSessionData()).resolves.toEqual({
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "invalid_session",
    });
  });

  it("returns an anonymous app session without invalid-session state when no auth session exists", async () => {
    supabaseMock.authGetUser.mockResolvedValue({
      data: { user: null },
      error: {
        name: "AuthSessionMissingError",
        message: "Auth session missing!",
      },
    });

    await expect(fetchAppSessionData()).resolves.toEqual({
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "anonymous",
    });
  });

  it("returns an invalid session when Supabase reports an invalid refresh token", async () => {
    supabaseMock.authGetUser.mockResolvedValue({
      data: { user: null },
      error: {
        name: "AuthApiError",
        message: "Invalid Refresh Token: Refresh Token Not Found",
      },
    });

    await expect(fetchAppSessionData()).resolves.toEqual({
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "invalid_session",
    });
  });

  it("surfaces a clean not-found error when a project row is missing", async () => {
    supabaseMock.projectsMaybeSingle.mockResolvedValue({
      data: null,
      error: null,
    });

    await expect(fetchProject("project-missing")).rejects.toThrow("Project not found.");
  });

  it("still returns pinned jobs when project pin tables are unavailable", async () => {
    supabaseMock.pinnedProjectsOrder.mockResolvedValue({
      data: null,
      error: {
        code: "PGRST205",
        message: "Could not find the table 'public.user_pinned_projects' in the schema cache",
        details: null,
        hint: null,
      },
    });
    supabaseMock.pinnedJobsOrder.mockResolvedValue({
      data: [
        {
          id: "pin-job-1",
          user_id: "user-1",
          job_id: "job-1",
          created_at: "2026-03-03T00:00:00.000Z",
        },
      ],
      error: null,
    });

    await expect(fetchSidebarPins()).resolves.toEqual({
      projectIds: [],
      jobIds: ["job-1"],
    });
  });

  it("pins and unpins projects for the current user", async () => {
    supabaseMock.pinnedProjectsUpsert.mockResolvedValue({ error: null });
    supabaseMock.pinnedProjectsDeleteEqSecond.mockResolvedValue({ error: null });

    await pinProject("project-123");
    await unpinProject("project-123");

    expect(supabaseMock.pinnedProjectsUpsert).toHaveBeenCalledWith(
      {
        user_id: "user-1",
        project_id: "project-123",
      },
      {
        onConflict: "user_id,project_id",
        ignoreDuplicates: true,
      },
    );

    expect(supabaseMock.pinnedProjectsDelete).toHaveBeenCalled();
    expect(supabaseMock.pinnedProjectsDeleteEqFirst).toHaveBeenCalledWith("user_id", "user-1");
    expect(supabaseMock.pinnedProjectsDeleteEqSecond).toHaveBeenCalledWith("project_id", "project-123");
  });

  it("pins and unpins jobs for the current user", async () => {
    supabaseMock.pinnedJobsUpsert.mockResolvedValue({ error: null });
    supabaseMock.pinnedJobsDeleteEqSecond.mockResolvedValue({ error: null });

    await pinJob("job-123");
    await unpinJob("job-123");

    expect(supabaseMock.pinnedJobsUpsert).toHaveBeenCalledWith(
      {
        user_id: "user-1",
        job_id: "job-123",
      },
      {
        onConflict: "user_id,job_id",
        ignoreDuplicates: true,
      },
    );

    expect(supabaseMock.pinnedJobsDelete).toHaveBeenCalled();
    expect(supabaseMock.pinnedJobsDeleteEqFirst).toHaveBeenCalledWith("user_id", "user-1");
    expect(supabaseMock.pinnedJobsDeleteEqSecond).toHaveBeenCalledWith("job_id", "job-123");
  });
});
