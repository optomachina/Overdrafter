import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { getArchivedDeleteReporting } from "./archive-delete-errors";
import {
  getSupabaseAuthStorageKey,
  resetStartupAuthBootstrapForTests,
  STARTUP_AUTH_TIMEOUT_MS,
} from "./api/shared/startup-auth";

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
  const authGetSession = vi.fn();

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

  const partsOrder = vi.fn();
  const partsEq = vi.fn();
  const partsIn = vi.fn();
  const partsQuery = {
    eq: partsEq,
    in: partsIn,
    order: partsOrder,
  };
  partsEq.mockImplementation(() => partsQuery);
  partsIn.mockImplementation(() => partsQuery);
  const partsSelect = vi.fn(() => partsQuery);

  const jobFilesOrder = vi.fn();
  const jobFilesEq = vi.fn();
  const jobFilesIn = vi.fn();
  const jobFilesQuery = {
    eq: jobFilesEq,
    in: jobFilesIn,
    order: jobFilesOrder,
  };
  jobFilesEq.mockImplementation(() => jobFilesQuery);
  jobFilesIn.mockImplementation(() => jobFilesQuery);
  const jobFilesSelect = vi.fn(() => jobFilesQuery);

  const projectJobsOrder = vi.fn();
  const projectJobsEq = vi.fn();
  const projectJobsIn = vi.fn();
  const projectJobsQuery = {
    eq: projectJobsEq,
    in: projectJobsIn,
    order: projectJobsOrder,
  };
  projectJobsEq.mockImplementation(() => projectJobsQuery);
  projectJobsIn.mockImplementation(() => projectJobsQuery);
  const projectJobsSelect = vi.fn(() => projectJobsQuery);

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

    if (table === "parts") {
      return {
        select: partsSelect,
      };
    }

    if (table === "job_files") {
      return {
        select: jobFilesSelect,
      };
    }

    if (table === "project_jobs") {
      return {
        select: projectJobsSelect,
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
    authGetSession,
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
    jobFilesEq,
    jobFilesIn,
    jobFilesOrder,
    jobFilesQuery,
    jobFilesSelect,
    partsEq,
    partsIn,
    partsOrder,
    partsQuery,
    partsSelect,
    projectsOrder,
    projectsEq,
    projectsIn,
    projectsIs,
    projectsNot,
    projectsQuery,
    projectsSelect,
    projectsMaybeSingle,
    projectsSingle,
    projectJobsEq,
    projectJobsIn,
    projectJobsOrder,
    projectJobsQuery,
    projectJobsSelect,
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
      getSession: supabaseMock.authGetSession,
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

function createStorageMock() {
  const values = new Map<string, string>();

  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    clear: vi.fn(() => {
      values.clear();
    }),
  };
}

import {
  ClientIntakeCompatibilityError,
  checkClientIntakeCompatibility,
  createClientDraft,
  createJob,
  createJobsFromUploadFiles,
  createProject,
  archiveJob,
  deleteArchivedJobs,
  deleteArchivedJob,
  enqueueDebugVendorQuote,
  fetchAccessibleProjects,
  fetchAccessibleJobs,
  fetchArchivedJobs,
  fetchAppSessionData,
  fetchJobAggregate,
  fetchJobPartSummariesByJobIds,
  fetchProject,
  fetchWorkerReadiness,
  findDuplicateUploadSelections,
  fetchSidebarPins,
  getClientIntakeCompatibilityMessage,
  inferFileKind,
  pinJob,
  pinProject,
  requestDebugExtraction,
  requestQuote,
  requestQuotes,
  resetClientIntakeSchemaAvailabilityForTests,
  resetJobArchivingSchemaAvailabilityForTests,
  resetProjectCollaborationSchemaAvailabilityForTests,
  unarchiveJob,
  unpinJob,
  unpinProject,
  uploadFilesToJob,
  uploadManualQuoteEvidence,
} from "./api";

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stats = statSync(path);

    if (stats.isDirectory()) {
      return listSourceFiles(path);
    }

    if (!path.endsWith(".ts") && !path.endsWith(".tsx")) {
      return [];
    }

    if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) {
      return [];
    }

    return [path];
  });
}

function countRequestedServiceKindReads(content: string): number {
  const marker = 'from("jobs").select(';
  let count = 0;
  let index = content.indexOf(marker);

  while (index !== -1) {
    const window = content.slice(index, index + 500);

    if (window.includes("requested_service_kinds")) {
      count += 1;
    }

    index = content.indexOf(marker, index + marker.length);
  }

  return count;
}

describe("quotes api helpers", () => {
  let storageMock: ReturnType<typeof createStorageMock>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-03T12:34:56.000Z"));
    storageMock = createStorageMock();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storageMock,
    });
    resetStartupAuthBootstrapForTests();
    resetClientIntakeSchemaAvailabilityForTests();
    resetJobArchivingSchemaAvailabilityForTests();
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
    supabaseMock.partsEq.mockImplementation(() => supabaseMock.partsQuery);
    supabaseMock.partsIn.mockImplementation(() => supabaseMock.partsQuery);
    supabaseMock.partsSelect.mockImplementation(() => supabaseMock.partsQuery);
    supabaseMock.jobFilesEq.mockImplementation(() => supabaseMock.jobFilesQuery);
    supabaseMock.jobFilesIn.mockImplementation(() => supabaseMock.jobFilesQuery);
    supabaseMock.jobFilesSelect.mockImplementation(() => supabaseMock.jobFilesQuery);
    supabaseMock.projectJobsEq.mockImplementation(() => supabaseMock.projectJobsQuery);
    supabaseMock.projectJobsIn.mockImplementation(() => supabaseMock.projectJobsQuery);
    supabaseMock.projectJobsSelect.mockImplementation(() => supabaseMock.projectJobsQuery);
    supabaseMock.authGetSession.mockResolvedValue({
      data: {
        session: {
          access_token: "token-1",
          user: {
            id: "user-1",
          },
        },
      },
      error: null,
    });
    supabaseMock.authGetUser.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
        },
      },
      error: null,
    });
    supabaseMock.rpc.mockResolvedValue({
      data: false,
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
    storageMock.clear();
    resetStartupAuthBootstrapForTests();
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

  it("falls back to the archive edge function when the unarchive RPC is missing from schema cache", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find the function public.api_unarchive_job(p_job_id) in the schema cache",
        details: null,
        hint: null,
      },
    });
    supabaseMock.functionsInvoke.mockResolvedValueOnce({
      data: {
        jobId: "job-123",
      },
      error: null,
    });

    await expect(unarchiveJob("job-123")).resolves.toBe("job-123");

    expect(supabaseMock.functionsInvoke).toHaveBeenCalledWith("job-archive-fallback", {
      body: {
        action: "unarchive",
        jobId: "job-123",
      },
    });
  });

  it("deletes archived jobs through the shared cleanup RPC", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: {
        deletedJobIds: ["job-123", "job-456"],
        failures: [],
      },
      error: null,
    });

    await expect(deleteArchivedJobs(["job-123", "job-456"])).resolves.toEqual({
      deletedJobIds: ["job-123", "job-456"],
      failures: [],
    });

    expect(supabaseMock.rpc).toHaveBeenCalledWith("api_delete_archived_jobs", {
      p_job_ids: ["job-123", "job-456"],
    });
  });

  it("deletes a single archived job through the shared cleanup RPC", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: {
        deletedJobIds: ["job-123"],
        failures: [],
      },
      error: null,
    });

    await expect(deleteArchivedJob("job-123")).resolves.toBe("job-123");

    expect(supabaseMock.rpc).toHaveBeenCalledWith("api_delete_archived_jobs", {
      p_job_ids: ["job-123"],
    });
  });

  it("falls back to edge-backed archived delete when hosted storage rejects direct table deletes", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "42501",
        message: "Direct deletion from storage tables is not allowed. Use the Storage API instead.",
        details: null,
        hint: null,
      },
    });
    supabaseMock.functionsInvoke
      .mockResolvedValueOnce({
        data: {
          jobId: "job-123",
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          jobId: "job-456",
        },
        error: null,
      });

    await expect(deleteArchivedJobs(["job-123", "job-456"])).resolves.toEqual({
      deletedJobIds: ["job-123", "job-456"],
      failures: [],
    });

    expect(supabaseMock.rpc).toHaveBeenCalledWith("api_delete_archived_jobs", {
      p_job_ids: ["job-123", "job-456"],
    });
    expect(supabaseMock.functionsInvoke).toHaveBeenNthCalledWith(1, "job-archive-fallback", {
      body: {
        action: "delete",
        jobId: "job-123",
      },
    });
    expect(supabaseMock.functionsInvoke).toHaveBeenNthCalledWith(2, "job-archive-fallback", {
      body: {
        action: "delete",
        jobId: "job-456",
      },
    });
  });

  it("returns partial results when edge-backed archived delete fallback fails for one job", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "42501",
        message: "Direct deletion from storage tables is not allowed. Use the Storage API instead.",
        details: null,
        hint: null,
      },
    });
    supabaseMock.functionsInvoke
      .mockResolvedValueOnce({
        data: {
          jobId: "job-123",
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: new FunctionsHttpError(
          new Response(
            JSON.stringify({
              error: "Part not found, not archived, or you do not have permission to delete it.",
            }),
            {
              status: 403,
              headers: {
                "Content-Type": "application/json",
              },
            },
          ),
        ),
      });

    await expect(deleteArchivedJobs(["job-123", "job-999"])).resolves.toMatchObject({
      deletedJobIds: ["job-123"],
      failures: [
        {
          jobId: "job-999",
          message: "Part not found, not archived, or you do not have permission to delete it.",
          reporting: {
            operation: "archived_delete",
            fallbackPath: "job-archive-fallback",
            failureCategory: "edge_http_error",
            httpStatus: 403,
            hasResponseBody: true,
          },
        },
      ],
    });
  });

  it("classifies not-deployed edge fallback failures for archived delete errors", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://previewref.supabase.co");

    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "42501",
        message: "Direct deletion from storage tables is not allowed. Use the Storage API instead.",
        details: null,
        hint: null,
      },
    });
    supabaseMock.functionsInvoke.mockResolvedValueOnce({
      data: null,
      error: new FunctionsHttpError(
        new Response(
          JSON.stringify({
            error: "cleanup service is not deployed in this environment.",
          }),
          {
            status: 404,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      ),
    });

    const result = await deleteArchivedJobs(["job-123"]);

    expect(result).toMatchObject({
      deletedJobIds: [],
      failures: [
        {
          jobId: "job-123",
          message:
            "Archived part deletion is unavailable in this environment because the cleanup service is not deployed.",
          reporting: {
            operation: "archived_delete",
            fallbackPath: "job-archive-fallback",
            failureCategory: "edge_not_deployed",
            httpStatus: 404,
            hasResponseBody: true,
            functionUrl: "https://previewref.supabase.co/functions/v1/job-archive-fallback",
          },
        },
      ],
    });
  });

  it("classifies edge fallback reachability failures for archived delete errors", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://previewref.supabase.co");

    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "42501",
        message: "Direct deletion from storage tables is not allowed. Use the Storage API instead.",
        details: null,
        hint: null,
      },
    });
    supabaseMock.functionsInvoke.mockResolvedValueOnce({
      data: null,
      error: new Error("Failed to send a request to the Edge Function"),
    });

    const result = await deleteArchivedJobs(["job-123"]);

    expect(result).toMatchObject({
      deletedJobIds: [],
      failures: [
        {
          jobId: "job-123",
          message:
            "Archived part deletion is temporarily unavailable because the cleanup service could not be reached. Please try again.",
          reporting: {
            operation: "archived_delete",
            fallbackPath: "job-archive-fallback",
            failureCategory: "edge_unreachable",
            supabaseOrigin: "https://previewref.supabase.co",
            supabaseProjectRef: "previewref",
            functionPath: "/functions/v1/job-archive-fallback",
            functionUrl: "https://previewref.supabase.co/functions/v1/job-archive-fallback",
            rawErrorName: "Error",
            rawErrorMessage: "Failed to send a request to the Edge Function",
            hasResponseBody: false,
          },
        },
      ],
    });
  });

  it("annotates misconfigured edge fallback errors with archived delete reporting metadata", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "42501",
        message: "Direct deletion from storage tables is not allowed. Use the Storage API instead.",
        details: null,
        hint: null,
      },
    });
    supabaseMock.functionsInvoke.mockResolvedValueOnce({
      data: null,
      error: new FunctionsHttpError(
        new Response(
          JSON.stringify({
            error: "Archived part deletion requires SUPABASE_SERVICE_ROLE_KEY for storage cleanup.",
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      ),
    });

    try {
      await deleteArchivedJob("job-123");
      throw new Error("Expected archived delete to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Archived part deletion requires SUPABASE_SERVICE_ROLE_KEY for storage cleanup.",
      );
      expect(getArchivedDeleteReporting(error)).toMatchObject({
        failureCategory: "edge_misconfigured",
        fallbackPath: "job-archive-fallback",
        httpStatus: 500,
        hasResponseBody: true,
        functionName: "job-archive-fallback",
      });
    }
  });

  it("surfaces storage cleanup rollback failures from the archived delete edge fallback", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "42501",
        message: "Direct deletion from storage tables is not allowed. Use the Storage API instead.",
        details: null,
        hint: null,
      },
    });
    supabaseMock.functionsInvoke.mockResolvedValueOnce({
      data: null,
      error: new FunctionsHttpError(
        new Response(
          JSON.stringify({
            error: "Archived part deletion failed during storage cleanup. No records were deleted. Please retry.",
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      ),
    });

    const result = await deleteArchivedJobs(["job-123"]);

    expect(result).toMatchObject({
      deletedJobIds: [],
      failures: [
        {
          jobId: "job-123",
          message:
            "Archived part deletion failed during storage cleanup. No records were deleted. Please retry.",
          reporting: {
            operation: "archived_delete",
            fallbackPath: "job-archive-fallback",
            failureCategory: "edge_http_error",
            httpStatus: 500,
            hasResponseBody: true,
          },
        },
      ],
    });
  });

  it("falls back to the legacy single-delete RPC when the bulk delete RPC is unavailable", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find the function public.api_delete_archived_jobs(p_job_ids) in the schema cache",
        details: null,
        hint: null,
      },
    });
    supabaseMock.rpc.mockResolvedValueOnce({
      data: "job-123",
      error: null,
    });

    await expect(deleteArchivedJob("job-123")).resolves.toBe("job-123");

    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(2, "api_delete_archived_job", {
      p_job_id: "job-123",
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Archived delete capability unavailable",
      expect.objectContaining({
        operation: "single",
        reason: "api_delete_archived_jobs unavailable; falling back to legacy single-delete contract",
      }),
    );
  });

  it("falls back from the legacy single-delete RPC to the edge function when hosted storage rejects direct table deletes", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    supabaseMock.rpc
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "PGRST202",
          message: "Could not find the function public.api_delete_archived_jobs(p_job_ids) in the schema cache",
          details: null,
          hint: null,
        },
      })
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "42501",
          message: "Direct deletion from storage tables is not allowed. Use the Storage API instead.",
          details: null,
          hint: null,
        },
      });
    supabaseMock.functionsInvoke.mockResolvedValueOnce({
      data: {
        jobId: "job-123",
      },
      error: null,
    });

    await expect(deleteArchivedJob("job-123")).resolves.toBe("job-123");

    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(2, "api_delete_archived_job", {
      p_job_id: "job-123",
    });
    expect(supabaseMock.functionsInvoke).toHaveBeenCalledWith("job-archive-fallback", {
      body: {
        action: "delete",
        jobId: "job-123",
      },
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Archived delete capability unavailable",
      expect.objectContaining({
        operation: "single",
        reason: "api_delete_archived_jobs unavailable; falling back to legacy single-delete contract",
      }),
    );
  });

  it("falls back to the legacy single-delete contract for bulk deletes when the bulk RPC is unavailable", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find the function public.api_delete_archived_jobs(p_job_ids) in the schema cache",
        details: null,
        hint: null,
      },
    });
    supabaseMock.rpc
      .mockResolvedValueOnce({ data: "job-123", error: null })
      .mockResolvedValueOnce({ data: "job-456", error: null });

    await expect(deleteArchivedJobs(["job-123", "job-456"])).resolves.toEqual({
      deletedJobIds: ["job-123", "job-456"],
      failures: [],
    });

    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(2, "api_delete_archived_job", {
      p_job_id: "job-123",
    });
    expect(supabaseMock.rpc).toHaveBeenNthCalledWith(3, "api_delete_archived_job", {
      p_job_id: "job-456",
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Archived delete capability unavailable",
      expect.objectContaining({
        operation: "bulk",
        reason: "api_delete_archived_jobs unavailable; falling back to legacy single-delete contract",
      }),
    );
  });

  it("returns partial success results for bulk archived deletes", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: {
        deletedJobIds: ["job-123"],
        failures: [
          {
            jobId: "job-999",
            message: "Part not found, not archived, or you do not have permission to delete it.",
          },
        ],
      },
      error: null,
    });

    await expect(deleteArchivedJobs(["job-123", "job-999"])).resolves.toEqual({
      deletedJobIds: ["job-123"],
      failures: [
        {
          jobId: "job-999",
          message: "Part not found, not archived, or you do not have permission to delete it.",
        },
      ],
    });

    expect(supabaseMock.rpc).toHaveBeenCalledWith("api_delete_archived_jobs", {
      p_job_ids: ["job-123", "job-999"],
    });
  });

  it("filters malformed archived delete payload entries while preserving valid reporting", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: {
        deletedJobIds: ["job-123", 42, null],
        failures: [
          null,
          {
            jobId: "job-456",
            message: "Archived delete cleanup service missing.",
            reporting: {
              operation: "archived_delete",
              fallbackPath: "job-archive-fallback",
              failureCategory: "edge_not_deployed",
              failureSummary:
                "Archived part deletion is unavailable in this environment because the cleanup service is not deployed.",
              likelyCause:
                "The job-archive-fallback Edge Function is unavailable in the active Supabase project.",
              recommendedChecks: ["Verify that job-archive-fallback is deployed to the active Supabase project."],
              httpStatus: 404,
              hasResponseBody: true,
            },
          },
          {
            jobId: "job-789",
          },
          {
            message: "Missing job id",
          },
          {
            jobId: "job-999",
            message: 7,
          },
        ],
      },
      error: null,
    });

    await expect(deleteArchivedJobs(["job-123", "job-456"])).resolves.toEqual({
      deletedJobIds: ["job-123"],
      failures: [
        {
          jobId: "job-456",
          message: "Archived delete cleanup service missing.",
          reporting: {
            operation: "archived_delete",
            fallbackPath: "job-archive-fallback",
            failureCategory: "edge_not_deployed",
            failureSummary:
              "Archived part deletion is unavailable in this environment because the cleanup service is not deployed.",
            likelyCause:
              "The job-archive-fallback Edge Function is unavailable in the active Supabase project.",
            recommendedChecks: ["Verify that job-archive-fallback is deployed to the active Supabase project."],
            supabaseOrigin: null,
            supabaseProjectRef: null,
            functionName: null,
            functionPath: null,
            functionUrl: null,
            httpStatus: 404,
            hasResponseBody: true,
            rawErrorName: null,
            rawErrorMessage: null,
            rawErrorStatus: null,
            partIds: [],
            organizationId: null,
            userId: null,
          },
        },
      ],
    });
  });

  it("throws when the bulk delete RPC omits deletedJobIds", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: {
        failures: [],
      },
      error: null,
    });

    await expect(deleteArchivedJobs(["job-123"])).rejects.toThrow(
      "api_delete_archived_jobs returned an invalid deletedJobIds field.",
    );
  });

  it("throws when the bulk delete RPC omits failures", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: {
        deletedJobIds: ["job-123"],
      },
      error: null,
    });

    await expect(deleteArchivedJobs(["job-123"])).rejects.toThrow(
      "api_delete_archived_jobs returned an invalid failures field.",
    );
  });

  it("normalizes raw bulk delete RPC errors into readable messages", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "23503",
        message:
          'update or delete on table "vendor_quote_results" violates foreign key constraint "published_quote_options_source_vendor_quote_id_fkey" on table "published_quote_options"',
        details: 'Key (id)=(quote-result-1) is still referenced from table "published_quote_options".',
        hint: null,
      },
    });

    await expect(deleteArchivedJobs(["job-123"])).rejects.toThrow(
      "Failed to delete archived part because related records still exist.",
    );
  });

  it("surfaces authorization failures from the bulk delete payload for single deletes", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: {
        deletedJobIds: [],
        failures: [
          {
            jobId: "job-123",
            message: "Part not found, not archived, or you do not have permission to delete it.",
          },
        ],
      },
      error: null,
    });

    await expect(deleteArchivedJob("job-123")).rejects.toThrow(
      "Part not found, not archived, or you do not have permission to delete it.",
    );
  });

  it("throws a targeted migration error when both bulk and legacy delete RPCs are unavailable", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    supabaseMock.rpc
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "PGRST202",
          message: "Could not find the function public.api_delete_archived_jobs(p_job_ids) in the schema cache",
          details: null,
          hint: null,
        },
      })
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "PGRST202",
          message: "Could not find the function public.api_delete_archived_job(p_job_id) in the schema cache",
          details: null,
          hint: null,
        },
      });

    await expect(deleteArchivedJob("job-123")).rejects.toThrow(
      "Archived part deletion is unavailable until the latest archive delete migrations are applied and the PostgREST schema cache is refreshed.",
    );

    expect(supabaseMock.functionsInvoke).not.toHaveBeenCalledWith("job-archive-fallback", expect.anything());
    expect(consoleErrorSpy).toHaveBeenNthCalledWith(
      1,
      "Archived delete capability unavailable",
      expect.objectContaining({
        operation: "single",
        reason: "api_delete_archived_jobs unavailable; falling back to legacy single-delete contract",
      }),
    );
    expect(consoleErrorSpy).toHaveBeenNthCalledWith(
      2,
      "Archived delete capability unavailable",
      expect.objectContaining({
        operation: "single",
        reason: "api_delete_archived_job unavailable; archive delete migrations missing or schema cache is stale",
      }),
    );
  });

  it("throws the same targeted migration error for bulk deletes when both delete RPCs are unavailable", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    supabaseMock.rpc
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "PGRST202",
          message: "Could not find the function public.api_delete_archived_jobs(p_job_ids) in the schema cache",
          details: null,
          hint: null,
        },
      })
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "PGRST202",
          message: "Could not find the function public.api_delete_archived_job(p_job_id) in the schema cache",
          details: null,
          hint: null,
        },
      })
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "PGRST202",
          message: "Could not find the function public.api_delete_archived_job(p_job_id) in the schema cache",
          details: null,
          hint: null,
        },
      });

    await expect(deleteArchivedJobs(["job-123", "job-456"])).rejects.toThrow(
      "Archived part deletion is unavailable until the latest archive delete migrations are applied and the PostgREST schema cache is refreshed.",
    );

    expect(supabaseMock.functionsInvoke).not.toHaveBeenCalledWith("job-archive-fallback", expect.anything());
    expect(consoleErrorSpy).toHaveBeenNthCalledWith(
      1,
      "Archived delete capability unavailable",
      expect.objectContaining({
        operation: "bulk",
        reason: "api_delete_archived_jobs unavailable; falling back to legacy single-delete contract",
      }),
    );
    expect(consoleErrorSpy).toHaveBeenNthCalledWith(
      2,
      "Archived delete capability unavailable",
      expect.objectContaining({
        operation: "bulk",
        reason: "api_delete_archived_job unavailable; archive delete migrations missing or schema cache is stale",
      }),
    );
  });

  it("archives a job through the fallback when shared project tables are unavailable", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        code: "42P01",
        message: 'relation "public.project_jobs" does not exist',
        details: null,
        hint: null,
      },
    });
    supabaseMock.functionsInvoke.mockResolvedValueOnce({
      data: {
        jobId: "job-123",
      },
      error: null,
    });

    await expect(archiveJob("job-123")).resolves.toBe("job-123");

    expect(supabaseMock.functionsInvoke).toHaveBeenCalledWith("job-archive-fallback", {
      body: {
        action: "archive",
        jobId: "job-123",
      },
    });
  });

  it("falls back to legacy job selection columns when service-intent fields are absent", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: [],
      error: null,
    });
    supabaseMock.jobsIn
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "42703",
          message: 'column jobs.requested_service_kinds does not exist',
          details: null,
          hint: null,
        },
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "job-1",
            selected_vendor_quote_offer_id: null,
            requested_quote_quantities: [5],
            requested_by_date: "2026-04-01",
          },
        ],
        error: null,
      });
    supabaseMock.partsOrder.mockResolvedValueOnce({
      data: [
        {
          job_id: "job-1",
          quantity: 5,
          approved_part_requirements: null,
        },
      ],
      error: null,
    });
    supabaseMock.jobFilesOrder.mockResolvedValueOnce({
      data: [
        {
          job_id: "job-1",
          normalized_name: "1234-56789-A.step",
          original_name: "1234-56789-A.step",
          file_kind: "cad",
        },
      ],
      error: null,
    });

    await expect(fetchJobPartSummariesByJobIds(["job-1"])).resolves.toEqual([
      expect.objectContaining({
        jobId: "job-1",
        partNumber: "1234-56789",
        revision: null,
        requestedServiceKinds: ["manufacturing_quote"],
        primaryServiceKind: "manufacturing_quote",
        serviceNotes: null,
        requestedQuoteQuantities: [5],
        requestedByDate: "2026-04-01",
      }),
    ]);

    expect(supabaseMock.jobsSelect).toHaveBeenNthCalledWith(
      1,
      "id, selected_vendor_quote_offer_id, requested_service_kinds, primary_service_kind, service_notes, requested_quote_quantities, requested_by_date",
    );
    expect(supabaseMock.jobsSelect).toHaveBeenNthCalledWith(
      2,
      "id, selected_vendor_quote_offer_id, requested_quote_quantities, requested_by_date",
    );
  });

  it("uses the centralized selection accessor without fallback when service-intent columns are available", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: [],
      error: null,
    });
    supabaseMock.jobsIn.mockResolvedValueOnce({
      data: [
        {
          id: "job-1",
          selected_vendor_quote_offer_id: null,
          requested_service_kinds: ["manufacturing_quote"],
          primary_service_kind: "manufacturing_quote",
          service_notes: "Anodize after machining",
          requested_quote_quantities: [7],
          requested_by_date: "2026-04-03",
        },
      ],
      error: null,
    });
    supabaseMock.partsOrder.mockResolvedValueOnce({
      data: [
        {
          job_id: "job-1",
          quantity: 7,
          approved_part_requirements: null,
        },
      ],
      error: null,
    });
    supabaseMock.jobFilesOrder.mockResolvedValueOnce({
      data: [
        {
          job_id: "job-1",
          normalized_name: "1234-56789.step",
          original_name: "1234-56789.step",
          file_kind: "cad",
        },
      ],
      error: null,
    });

    await expect(fetchJobPartSummariesByJobIds(["job-1"])).resolves.toEqual([
      expect.objectContaining({
        jobId: "job-1",
        requestedServiceKinds: ["manufacturing_quote"],
        primaryServiceKind: "manufacturing_quote",
        serviceNotes: "Anodize after machining",
        requestedQuoteQuantities: [7],
        requestedByDate: "2026-04-03",
      }),
    ]);

    expect(supabaseMock.jobsSelect).toHaveBeenCalledTimes(1);
    expect(supabaseMock.jobsSelect).toHaveBeenCalledWith(
      "id, selected_vendor_quote_offer_id, requested_service_kinds, primary_service_kind, service_notes, requested_quote_quantities, requested_by_date",
    );
  });

  it("derives selected-offer summary data from the client quote workspace projection", async () => {
    supabaseMock.rpc.mockImplementation((fn: string) => {
      if (fn === "api_list_client_part_metadata") {
        return Promise.resolve({
          data: [
            {
              partId: "part-1",
              jobId: "job-1",
              organizationId: "org-1",
              hasCadFile: true,
              hasDrawingFile: false,
              description: "Bracket",
              partNumber: "1234-56789",
              revision: null,
              material: "6061-T6",
              finish: "Black anodize",
              tightestToleranceInch: 0.005,
              process: "CNC Machining",
              notes: null,
              quantity: 10,
              quoteQuantities: [10],
              requestedByDate: "2026-04-01",
              pageCount: 1,
              warningCount: 0,
              warnings: [],
              missingFields: [],
              reviewFields: [],
              lastFailureCode: null,
              lastFailureMessage: null,
              extractedAt: "2026-03-01T00:00:00Z",
              failedAt: null,
              updatedAt: "2026-03-01T00:00:00Z",
              lifecycle: "succeeded",
            },
          ],
          error: null,
        });
      }

      if (fn === "api_list_client_quote_workspace") {
        return Promise.resolve({
          data: [
            {
              jobId: "job-1",
              latestQuoteRun: null,
              selectedOffer: {
                id: "offer-1",
                vendor_quote_result_id: "quote-1",
                organization_id: "org-1",
                offer_key: "xometry-standard",
                supplier: "Xometry",
                lane_label: "USA / Standard",
                sourcing: "USA",
                tier: "Standard",
                quote_ref: "Q-1",
                quote_date: "2026-03-01",
                unit_price_usd: 10,
                total_price_usd: 100,
                lead_time_business_days: 7,
                ship_receive_by: "2026-03-10",
                due_date: "2026-04-01",
                process: "CNC Machining",
                material: "6061-T6",
                finish: "Black anodize",
                tightest_tolerance: "±.005\"",
                tolerance_source: "Drawing",
                thread_callouts: null,
                thread_match_notes: null,
                notes: null,
                sort_rank: 0,
                raw_payload: {},
                created_at: "2026-03-01T00:00:00Z",
                updated_at: "2026-03-01T00:00:00Z",
              },
              vendorQuotes: [],
            },
          ],
          error: null,
        });
      }

      throw new Error(`Unexpected rpc: ${fn}`);
    });
    supabaseMock.jobsIn.mockResolvedValueOnce({
      data: [
        {
          id: "job-1",
          selected_vendor_quote_offer_id: "offer-1",
          requested_service_kinds: ["manufacturing_quote"],
          primary_service_kind: "manufacturing_quote",
          service_notes: null,
          requested_quote_quantities: [10],
          requested_by_date: "2026-04-01",
        },
      ],
      error: null,
    });
    supabaseMock.partsOrder.mockResolvedValueOnce({
      data: [
        {
          job_id: "job-1",
          quantity: 10,
          approved_part_requirements: null,
        },
      ],
      error: null,
    });
    supabaseMock.jobFilesOrder.mockResolvedValueOnce({
      data: [
        {
          job_id: "job-1",
          normalized_name: "1234-56789.step",
          original_name: "1234-56789.step",
          file_kind: "cad",
        },
      ],
      error: null,
    });

    await expect(fetchJobPartSummariesByJobIds(["job-1"])).resolves.toEqual([
      expect.objectContaining({
        jobId: "job-1",
        selectedSupplier: "Xometry",
        selectedPriceUsd: 100,
        selectedLeadTimeBusinessDays: 7,
      }),
    ]);
  });

  it("falls back to unfiltered job reads when the archive column is missing", async () => {
    supabaseMock.jobsOrder
      .mockImplementationOnce(() => supabaseMock.jobsQuery)
      .mockResolvedValueOnce({
        data: [
          {
            id: "job-1",
            organization_id: "org-1",
            project_id: null,
            selected_vendor_quote_offer_id: null,
            created_by: "user-1",
            title: "Bracket",
            description: null,
            status: "uploaded",
            source: "client_home",
            active_pricing_policy_id: null,
            tags: [],
            requested_quote_quantities: [1],
            requested_by_date: null,
            archived_at: null,
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
          },
        ],
        error: null,
      });
    supabaseMock.jobsIs.mockResolvedValueOnce({
      data: null,
      error: {
        code: "42703",
        message: 'column jobs.archived_at does not exist',
        details: null,
        hint: null,
      },
    });

    await expect(fetchAccessibleJobs()).resolves.toEqual([
      expect.objectContaining({
        id: "job-1",
        title: "Bracket",
      }),
    ]);
  });

  it("keeps archived job summaries renderable when project tables are unavailable", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: [],
      error: null,
    });
    supabaseMock.jobsOrder.mockImplementationOnce(() => supabaseMock.jobsQuery);
    supabaseMock.jobsNot.mockResolvedValueOnce({
      data: [
        {
          id: "job-1",
          organization_id: "org-1",
          project_id: null,
          selected_vendor_quote_offer_id: null,
          created_by: "user-1",
          title: "Bracket",
          description: null,
          status: "uploaded",
          source: "client_home",
          active_pricing_policy_id: null,
          tags: [],
          requested_quote_quantities: [5],
          requested_by_date: "2026-04-01",
          archived_at: "2026-03-02T00:00:00Z",
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-02T00:00:00Z",
        },
      ],
      error: null,
    });
    supabaseMock.jobsIn
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "42703",
          message: 'column jobs.requested_service_kinds does not exist',
          details: null,
          hint: null,
        },
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "job-1",
            selected_vendor_quote_offer_id: null,
            requested_quote_quantities: [5],
            requested_by_date: "2026-04-01",
          },
        ],
        error: null,
      });
    supabaseMock.partsOrder.mockResolvedValueOnce({
      data: [
        {
          job_id: "job-1",
          quantity: 5,
          approved_part_requirements: null,
        },
      ],
      error: null,
    });
    supabaseMock.jobFilesOrder.mockResolvedValueOnce({
      data: [
        {
          job_id: "job-1",
          normalized_name: "1234-56789-A.step",
          original_name: "1234-56789-A.step",
          file_kind: "cad",
        },
      ],
      error: null,
    });
    supabaseMock.projectJobsIn.mockResolvedValueOnce({
      data: null,
      error: {
        code: "42P01",
        message: 'relation "public.project_jobs" does not exist',
        details: null,
        hint: null,
      },
    });

    await expect(fetchArchivedJobs()).resolves.toEqual([
      expect.objectContaining({
        job: expect.objectContaining({
          id: "job-1",
        }),
        summary: expect.objectContaining({
          jobId: "job-1",
          partNumber: "1234-56789",
          revision: null,
        }),
        projectNames: [],
      }),
    ]);
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
          workerBuildVersion: "build-123",
          workerMode: "live",
          drawingExtractionModel: "gpt-5.4",
          drawingExtractionDebugAllowedModels: ["gpt-5.4", "gpt-5.4-mini"],
          drawingExtractionModelFallbackEnabled: true,
          status: "running",
          readinessIssues: [],
        }),
      }),
    );

    await expect(fetchWorkerReadiness()).resolves.toEqual({
      reachable: true,
      ready: true,
      workerName: "worker-1",
      workerBuildVersion: "build-123",
      workerMode: "live",
      drawingExtractionModel: "gpt-5.4",
      drawingExtractionDebugAllowedModels: ["gpt-5.4", "gpt-5.4-mini"],
      drawingExtractionModelFallbackEnabled: true,
      status: "running",
      readinessIssues: [],
      message: null,
      url: "https://worker.example.com/readyz",
    });
  });

  it("returns a disabled worker readiness snapshot when the probe base url is unset", async () => {
    await expect(fetchWorkerReadiness()).resolves.toEqual({
      reachable: false,
      ready: null,
      workerName: null,
      workerBuildVersion: null,
      workerMode: null,
      drawingExtractionModel: null,
      drawingExtractionDebugAllowedModels: [],
      drawingExtractionModelFallbackEnabled: false,
      status: null,
      readinessIssues: [],
      message: "Set VITE_WORKER_BASE_URL to enable the worker readiness probe.",
      url: null,
    });
  });

  it("keeps payload-derived worker readiness fields when the probe returns a non-OK response", async () => {
    vi.stubEnv("VITE_WORKER_BASE_URL", "https://worker.example.com/root/");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({
          ready: false,
          workerName: "worker-1",
          workerBuildVersion: "build-456",
          workerMode: "live",
          drawingExtractionModel: "gpt-5.4-mini",
          drawingExtractionDebugAllowedModels: ["gpt-5.4-mini"],
          drawingExtractionModelFallbackEnabled: false,
          status: "degraded",
          readinessIssues: ["vendor adapter unavailable"],
        }),
      }),
    );

    await expect(fetchWorkerReadiness()).resolves.toEqual({
      reachable: true,
      ready: false,
      workerName: "worker-1",
      workerBuildVersion: "build-456",
      workerMode: "live",
      drawingExtractionModel: "gpt-5.4-mini",
      drawingExtractionDebugAllowedModels: ["gpt-5.4-mini"],
      drawingExtractionModelFallbackEnabled: false,
      status: "degraded",
      readinessIssues: ["vendor adapter unavailable"],
      message: "Worker readiness probe returned HTTP 503.",
      url: "https://worker.example.com/readyz",
    });
  });

  it("returns an unreachable worker readiness snapshot when the probe request fails", async () => {
    vi.stubEnv("VITE_WORKER_BASE_URL", "https://worker.example.com");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Failed to fetch")));

    await expect(fetchWorkerReadiness()).resolves.toEqual({
      reachable: false,
      ready: null,
      workerName: null,
      workerBuildVersion: null,
      workerMode: null,
      drawingExtractionModel: null,
      drawingExtractionDebugAllowedModels: [],
      drawingExtractionModelFallbackEnabled: false,
      status: null,
      readinessIssues: [],
      message: "Failed to fetch",
      url: "https://worker.example.com/readyz",
    });
  });

  it("requests a preview-only debug extraction run for a part", async () => {
    supabaseMock.rpc.mockResolvedValue({
      data: "debug-run-1",
      error: null,
    });

    await expect(requestDebugExtraction("part-1", "gpt-5.4-mini")).resolves.toBe("debug-run-1");

    expect(supabaseMock.rpc).toHaveBeenCalledWith("api_request_debug_extraction", {
      p_part_id: "part-1",
      p_model: "gpt-5.4-mini",
    });
  });

  it("treats extraction lab tables as optional when fetching a job aggregate", async () => {
    const jobRecord = {
      id: "job-1",
      organization_id: "org-1",
      title: "Example Job",
      active_pricing_policy_id: "policy-1",
      requested_service_kinds: ["manufacturing_quote"],
      primary_service_kind: "manufacturing_quote",
      service_notes: null,
      requested_quote_quantities: [3],
      requested_by_date: null,
    };
    const partRecord = {
      id: "part-1",
      job_id: "job-1",
      organization_id: "org-1",
      name: "Bracket",
      normalized_key: "bracket",
      cad_file_id: null,
      drawing_file_id: null,
      quantity: 3,
      created_at: "2026-03-03T00:00:00Z",
      updated_at: "2026-03-03T00:00:00Z",
    };
    const pricingPolicy = {
      id: "policy-1",
      organization_id: "org-1",
      name: "Default policy",
      is_active: true,
      created_at: "2026-03-03T00:00:00Z",
      updated_at: "2026-03-03T00:00:00Z",
      rules: {},
    };
    const missingPreviewTableError = {
      code: "42P01",
      message: 'relation "public.drawing_preview_assets" does not exist',
      details: null,
      hint: null,
    };
    const missingDebugRunTableError = {
      code: "42P01",
      message: 'relation "public.debug_extraction_runs" does not exist',
      details: null,
      hint: null,
    };

    supabaseMock.from.mockImplementation(((table: string) => {
      switch (table) {
        case "jobs":
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: jobRecord, error: null }),
              }),
            }),
          };
        case "job_files":
          return {
            select: () => ({
              eq: () => ({
                order: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          };
        case "parts":
          return {
            select: () => ({
              eq: () => ({
                order: () => Promise.resolve({ data: [partRecord], error: null }),
              }),
            }),
          };
        case "quote_runs":
        case "published_quote_packages":
        case "work_queue":
          return {
            select: () => ({
              eq: () => ({
                order: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          };
        case "drawing_extractions":
        case "approved_part_requirements":
          return {
            select: () => ({
              in: () => Promise.resolve({ data: [], error: null }),
            }),
          };
        case "drawing_preview_assets":
          return {
            select: () => ({
              in: () => Promise.resolve({ data: null, error: missingPreviewTableError }),
            }),
          };
        case "debug_extraction_runs":
          return {
            select: () => ({
              in: () => ({
                order: () => Promise.resolve({ data: null, error: missingDebugRunTableError }),
              }),
            }),
          };
        case "pricing_policies":
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: pricingPolicy, error: null }),
              }),
            }),
          };
        default:
          throw new Error(`Unexpected table: ${table}`);
      }
    }) as typeof supabaseMock.from.getMockImplementation extends () => infer T ? T : never);

    await expect(fetchJobAggregate("job-1")).resolves.toMatchObject({
      job: {
        id: "job-1",
      },
      parts: [
        expect.objectContaining({
          id: "part-1",
        }),
      ],
      drawingPreviewAssets: [],
      debugExtractionRuns: [],
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
    expect(supabaseMock.rpc).toHaveBeenCalledWith("api_create_job", {
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

  it("does not fall back to api_create_job for project-scoped client drafts", async () => {
    supabaseMock.rpc
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "42883",
          message: "function public.api_create_client_draft does not exist",
          details: null,
          hint: null,
        },
      })
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "42883",
          message: "function public.api_create_client_draft does not exist",
          details: null,
          hint: null,
        },
      })
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "42883",
          message: "function public.api_create_client_draft does not exist",
          details: null,
          hint: null,
        },
      });

    await expect(
      createClientDraft({
        projectId: "project-1",
        title: "Bracket",
        description: "Upload test",
        tags: [],
      }),
    ).rejects.toBeInstanceOf(ClientIntakeCompatibilityError);

    expect(supabaseMock.rpc).not.toHaveBeenCalledWith("api_create_job", expect.anything());
    expect(supabaseMock.membershipsSelect).not.toHaveBeenCalled();
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

  it("reports legacy intake compatibility when only legacy create paths are available", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: {
        supportsCurrentCreateJob: false,
        supportsLegacyCreateJobV2: true,
        supportsLegacyCreateJobV1: false,
        supportsLegacyCreateJobV0: false,
        supportsCurrentCreateClientDraft: false,
        supportsLegacyCreateClientDraftV1: true,
        supportsLegacyCreateClientDraftV0: false,
        hasRequestedServiceKindsColumn: false,
        hasPrimaryServiceKindColumn: false,
        hasServiceNotesColumn: false,
        missing: ["requested_service_kinds", "primary_service_kind", "service_notes"],
      },
      error: null,
    });

    await expect(checkClientIntakeCompatibility()).resolves.toBe("legacy");
    expect(getClientIntakeCompatibilityMessage()).toContain(
      "Missing: requested_service_kinds, primary_service_kind, service_notes.",
    );
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

  it("throws a compatibility error when the probe confirms neither current nor legacy intake support", async () => {
    supabaseMock.rpc.mockResolvedValueOnce({
      data: {
        supportsCurrentCreateJob: false,
        supportsLegacyCreateJobV2: false,
        supportsLegacyCreateJobV1: false,
        supportsLegacyCreateJobV0: false,
        supportsCurrentCreateClientDraft: false,
        supportsLegacyCreateClientDraftV1: false,
        supportsLegacyCreateClientDraftV0: false,
        hasRequestedServiceKindsColumn: false,
        hasPrimaryServiceKindColumn: false,
        hasServiceNotesColumn: false,
        missing: ["api_create_job", "api_create_client_draft"],
      },
      error: null,
    });

    await expect(checkClientIntakeCompatibility()).rejects.toBeInstanceOf(ClientIntakeCompatibilityError);
    expect(getClientIntakeCompatibilityMessage()).toContain(
      "Missing: api_create_job, api_create_client_draft.",
    );
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
    supabaseMock.authGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    await expect(fetchAppSessionData()).resolves.toEqual({
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "anonymous",
    });
  });

  it("reads live auth state on later app-session fetches instead of reusing the startup snapshot", async () => {
    supabaseMock.authGetSession
      .mockResolvedValueOnce({
        data: { session: null },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          session: {
            access_token: "token-2",
            user: {
              id: "user-2",
              email: "client@example.com",
            },
          },
        },
        error: null,
      });
    supabaseMock.authGetUser.mockResolvedValueOnce({
      data: {
        user: {
          id: "user-2",
          email: "client@example.com",
        },
      },
      error: null,
    });
    supabaseMock.membershipsOrder.mockResolvedValueOnce({
      data: [
        {
          id: "membership-1",
          organization_id: "org-1",
          role: "client",
          organizations: {
            id: "org-1",
            name: "Client Org",
            slug: "client-org",
          },
        },
      ],
      error: null,
    });

    await expect(fetchAppSessionData()).resolves.toEqual({
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "anonymous",
    });

    await expect(fetchAppSessionData()).resolves.toEqual({
      user: {
        id: "user-2",
        email: "client@example.com",
      },
      memberships: [
        {
          id: "membership-1",
          role: "client",
          organizationId: "org-1",
          organizationName: "Client Org",
          organizationSlug: "client-org",
        },
      ],
      isVerifiedAuth: false,
      isPlatformAdmin: false,
      authState: "authenticated",
    });
  });

  it("does not treat a stored-token startup getSession timeout as invalid_session", async () => {
    window.localStorage.setItem(
      getSupabaseAuthStorageKey(),
      JSON.stringify({ access_token: "token-1" }),
    );
    supabaseMock.authGetSession.mockReturnValueOnce(new Promise(() => undefined));

    const sessionPromise = fetchAppSessionData();
    await vi.advanceTimersByTimeAsync(STARTUP_AUTH_TIMEOUT_MS);

    await expect(sessionPromise).resolves.toEqual({
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "session_error",
    });
  });

  it("returns an anonymous app session when startup getSession times out without a stored access token", async () => {
    supabaseMock.authGetSession.mockReturnValueOnce(new Promise(() => undefined));

    const sessionPromise = fetchAppSessionData();
    await vi.advanceTimersByTimeAsync(STARTUP_AUTH_TIMEOUT_MS);

    await expect(sessionPromise).resolves.toEqual({
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "anonymous",
    });
  });

  it("preserves authenticated context when getUser fails while a local session is present", async () => {
    supabaseMock.membershipsOrder.mockResolvedValueOnce({
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
    supabaseMock.authGetUser.mockResolvedValue({
      data: { user: null },
      error: {
        name: "AuthSessionMissingError",
        message: "Auth session missing!",
      },
    });

    await expect(fetchAppSessionData()).resolves.toEqual({
      user: {
        id: "user-1",
      },
      memberships: [
        {
          id: "membership-1",
          role: "client",
          organizationId: "org-123",
          organizationName: "Acme",
          organizationSlug: "acme",
        },
      ],
      isVerifiedAuth: false,
      isPlatformAdmin: false,
      authState: "authenticated",
    });
  });

  it("preserves authenticated context when getUser stalls after getSession succeeds", async () => {
    supabaseMock.membershipsOrder.mockResolvedValueOnce({
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
    supabaseMock.authGetUser.mockReturnValueOnce(new Promise(() => undefined));

    const sessionPromise = fetchAppSessionData();
    await vi.advanceTimersByTimeAsync(STARTUP_AUTH_TIMEOUT_MS);

    await expect(sessionPromise).resolves.toEqual({
      user: {
        id: "user-1",
      },
      memberships: [
        {
          id: "membership-1",
          role: "client",
          organizationId: "org-123",
          organizationName: "Acme",
          organizationSlug: "acme",
        },
      ],
      isVerifiedAuth: false,
      isPlatformAdmin: false,
      authState: "authenticated",
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

  it("returns the authenticated user with membershipError when membership lookup fails", async () => {
    supabaseMock.membershipsOrder.mockResolvedValue({
      data: null,
      error: {
        message: "temporary membership lookup failure",
      },
    });

    await expect(fetchAppSessionData()).resolves.toEqual({
      user: {
        id: "user-1",
      },
      memberships: [],
      isVerifiedAuth: false,
      isPlatformAdmin: false,
      authState: "authenticated",
      membershipError: "temporary membership lookup failure",
    });
  });

  it("surfaces platform admin status in the authenticated app session", async () => {
    supabaseMock.membershipsOrder.mockResolvedValueOnce({
      data: [
        {
          id: "membership-1",
          organization_id: "org-123",
          role: "internal_admin",
          organizations: {
            id: "org-123",
            name: "Acme",
            slug: "acme",
          },
        },
      ],
      error: null,
    });
    supabaseMock.rpc.mockResolvedValueOnce({
      data: true,
      error: null,
    });

    await expect(fetchAppSessionData()).resolves.toEqual({
      user: {
        id: "user-1",
      },
      memberships: [
        {
          id: "membership-1",
          role: "internal_admin",
          organizationId: "org-123",
          organizationName: "Acme",
          organizationSlug: "acme",
        },
      ],
      isVerifiedAuth: false,
      isPlatformAdmin: true,
      authState: "authenticated",
    });

    expect(supabaseMock.rpc).toHaveBeenCalledWith("api_get_is_platform_admin", {});
  });

  it("persists platform admin lookup failures instead of silently coercing them to false", async () => {
    supabaseMock.membershipsOrder.mockResolvedValueOnce({
      data: [
        {
          id: "membership-1",
          organization_id: "org-123",
          role: "internal_admin",
          organizations: {
            id: "org-123",
            name: "Acme",
            slug: "acme",
          },
        },
      ],
      error: null,
    });
    supabaseMock.rpc.mockResolvedValueOnce({
      data: null,
      error: {
        message: "Could not find the function public.api_get_is_platform_admin() in the schema cache",
      },
    });

    await expect(fetchAppSessionData()).resolves.toEqual({
      user: {
        id: "user-1",
      },
      memberships: [
        {
          id: "membership-1",
          role: "internal_admin",
          organizationId: "org-123",
          organizationName: "Acme",
          organizationSlug: "acme",
        },
      ],
      isVerifiedAuth: false,
      isPlatformAdmin: false,
      authState: "authenticated",
      membershipError: "Could not find the function public.api_get_is_platform_admin() in the schema cache",
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

  it("requests a quote for a single job through the new RPC", async () => {
    supabaseMock.rpc.mockResolvedValue({
      data: {
        jobId: "job-1",
        accepted: true,
        created: true,
        deduplicated: false,
        quoteRequestId: "request-1",
        quoteRunId: "run-1",
        serviceRequestLineItemId: "line-item-1",
        status: "queued",
        reasonCode: null,
        reason: null,
        requestedVendors: ["xometry", "fictiv", "protolabs"],
      },
      error: null,
    });

    await expect(requestQuote("job-1")).resolves.toMatchObject({
      jobId: "job-1",
      status: "queued",
      quoteRequestId: "request-1",
      serviceRequestLineItemId: "line-item-1",
    });

    expect(supabaseMock.rpc).toHaveBeenCalledWith("api_request_quote", {
      p_job_id: "job-1",
      p_force_retry: false,
    });
  });

  it("accepts user-rate-limited quote request responses from the rpc", async () => {
    supabaseMock.rpc.mockResolvedValue({
      data: {
        jobId: "job-1",
        accepted: false,
        created: false,
        deduplicated: false,
        quoteRequestId: null,
        quoteRunId: null,
        serviceRequestLineItemId: null,
        status: "not_requested",
        reasonCode: "rate_limited_user",
        reason: "You have reached the quote request limit for now. Try again later or contact your estimator.",
        requestedVendors: ["xometry", "fictiv", "protolabs"],
      },
      error: null,
    });

    await expect(requestQuote("job-1")).resolves.toMatchObject({
      jobId: "job-1",
      accepted: false,
      reasonCode: "rate_limited_user",
    });
  });

  it("accepts no-enabled-vendors blockers from the rpc", async () => {
    supabaseMock.rpc.mockResolvedValue({
      data: {
        jobId: "job-1",
        accepted: false,
        created: false,
        deduplicated: false,
        quoteRequestId: null,
        quoteRunId: null,
        serviceRequestLineItemId: null,
        status: "not_requested",
        reasonCode: "no_enabled_vendors",
        reason: "No enabled vendors are available for this part in its current package state.",
        requestedVendors: [],
      },
      error: null,
    });

    await expect(requestQuote("job-1")).resolves.toMatchObject({
      jobId: "job-1",
      accepted: false,
      reasonCode: "no_enabled_vendors",
      requestedVendors: [],
    });
  });

  it("requests quotes in bulk and normalizes the array response", async () => {
    supabaseMock.rpc.mockResolvedValue({
      data: [
        {
          jobId: "job-1",
          accepted: true,
          created: true,
          deduplicated: false,
          quoteRequestId: "request-1",
          quoteRunId: "run-1",
          serviceRequestLineItemId: "line-item-1",
          status: "queued",
          reasonCode: null,
          reason: null,
          requestedVendors: ["xometry", "fictiv", "protolabs"],
        },
        {
          jobId: "job-2",
          accepted: false,
          created: false,
          deduplicated: false,
          quoteRequestId: null,
          quoteRunId: null,
          serviceRequestLineItemId: null,
          status: "not_requested",
          reasonCode: "missing_cad",
          reason: "Upload a CAD model before requesting a quote.",
          requestedVendors: ["xometry", "fictiv", "protolabs"],
        },
      ],
      error: null,
    });

    await expect(requestQuotes(["job-1", "job-2", "job-1"])).resolves.toEqual([
      {
        jobId: "job-1",
        accepted: true,
        created: true,
        deduplicated: false,
        quoteRequestId: "request-1",
        quoteRunId: "run-1",
        serviceRequestLineItemId: "line-item-1",
        status: "queued",
        reasonCode: null,
        reason: null,
        requestedVendors: ["xometry", "fictiv", "protolabs"],
      },
      {
        jobId: "job-2",
        accepted: false,
        created: false,
        deduplicated: false,
        quoteRequestId: null,
        quoteRunId: null,
        serviceRequestLineItemId: null,
        status: "not_requested",
        reasonCode: "missing_cad",
        reason: "Upload a CAD model before requesting a quote.",
        requestedVendors: ["xometry", "fictiv", "protolabs"],
      },
    ]);

    expect(supabaseMock.rpc).toHaveBeenCalledWith("api_request_quotes", {
      p_job_ids: ["job-1", "job-2"],
      p_force_retry: false,
    });
  });

  it("accepts org cost ceiling blockers in bulk quote request responses", async () => {
    supabaseMock.rpc.mockResolvedValue({
      data: [
        {
          jobId: "job-1",
          accepted: false,
          created: false,
          deduplicated: false,
          quoteRequestId: null,
          quoteRunId: null,
          serviceRequestLineItemId: null,
          status: "not_requested",
          reasonCode: "org_cost_ceiling_reached",
          reason: "Quote requests are temporarily paused for this workspace while current vendor quote requests are still in flight.",
          requestedVendors: ["xometry", "fictiv", "protolabs"],
        },
      ],
      error: null,
    });

    await expect(requestQuotes(["job-1"])).resolves.toEqual([
      {
        jobId: "job-1",
        accepted: false,
        created: false,
        deduplicated: false,
        quoteRequestId: null,
        quoteRunId: null,
        serviceRequestLineItemId: null,
        status: "not_requested",
        reasonCode: "org_cost_ceiling_reached",
        reason: "Quote requests are temporarily paused for this workspace while current vendor quote requests are still in flight.",
        requestedVendors: ["xometry", "fictiv", "protolabs"],
      },
    ]);
  });

  it("short-circuits empty bulk quote requests without calling the rpc", async () => {
    await expect(requestQuotes([])).resolves.toEqual([]);
    expect(supabaseMock.rpc).not.toHaveBeenCalledWith("api_request_quotes", expect.anything());
  });

  it("keeps raw requested_service_kinds reads confined to the compatibility accessor", () => {
    const quotesDir = join(process.cwd(), "src/features/quotes");
    const sourceFiles = listSourceFiles(quotesDir);
    const allowedFile = join(quotesDir, "api.ts");
    const violations: string[] = [];

    for (const path of sourceFiles) {
      const content = readFileSync(path, "utf8");
      const count = countRequestedServiceKindReads(content);

      if (count === 0) {
        continue;
      }

      if (path !== allowedFile) {
        violations.push(path);
        continue;
      }

      if (count !== 1) {
        violations.push(`${path} (expected 1 compatibility accessor, found ${count})`);
      }
    }

    expect(violations).toEqual([]);
  });
});
