import { beforeEach, describe, expect, it, vi } from "vitest";
import { createJobsFromUploadFiles, uploadFilesToJob } from "./uploads-api";
import {
  EXPORT_CONTROL_TERMS_VERSION,
  ExportControlUploadBlockedError,
  registerExportControlDeclarationPrompter,
} from "@/features/quotes/export-control";

// OVD-723 client gate: a controlled, unsure, missing, or server-rejected
// declaration stops the upload before any storage object is written.

const storageMock = vi.hoisted(() => ({
  from: vi.fn(),
  upload: vi.fn(),
}));

const rpcMock = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: rpcMock,
    storage: { from: storageMock.from },
    functions: { invoke: vi.fn() },
  },
}));

function createUploadFile(contents: string, name: string): File {
  const bytes = new TextEncoder().encode(contents);

  return {
    name,
    size: bytes.byteLength,
    type: "model/step",
    lastModified: Date.now(),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File;
}

function rpcNames(): string[] {
  return rpcMock.mock.calls.map(([name]) => String(name));
}

function cleanDeclaration(declarationId = "declaration-1") {
  return {
    data: {
      declarationId,
      answer: "not_controlled",
      termsVersion: EXPORT_CONTROL_TERMS_VERSION,
      uploadAllowed: true,
      reasonCode: null,
    },
    error: null,
  };
}

describe("OVD-723 export-control upload gate", () => {
  let unregister: (() => void) | null = null;

  beforeEach(() => {
    unregister?.();
    unregister = null;
    storageMock.from.mockReturnValue({ upload: storageMock.upload });
    storageMock.upload.mockResolvedValue({ error: null });
  });

  describe("missing declaration", () => {
    it("rejects an upload when no declaration prompt is available and stores nothing", async () => {
      await expect(
        uploadFilesToJob("job-1", [createUploadFile("bracket", "bracket.step")]),
      ).rejects.toMatchObject({ name: "ExportControlUploadBlockedError", reasonCode: "export_declaration_missing" });

      expect(rpcMock).not.toHaveBeenCalled();
      expect(storageMock.upload).not.toHaveBeenCalled();
    });

    it("rejects an upload when the user dismisses the declaration prompt", async () => {
      unregister = registerExportControlDeclarationPrompter(async () => null);

      await expect(
        uploadFilesToJob("job-1", [createUploadFile("bracket", "bracket.step")]),
      ).rejects.toMatchObject({ reasonCode: "export_declaration_missing" });

      expect(rpcMock).not.toHaveBeenCalled();
      expect(storageMock.upload).not.toHaveBeenCalled();
    });

    it("rejects an upload when the prompt throws", async () => {
      unregister = registerExportControlDeclarationPrompter(async () => {
        throw new Error("dialog crashed");
      });

      await expect(
        uploadFilesToJob("job-1", [createUploadFile("bracket", "bracket.step")]),
      ).rejects.toBeInstanceOf(ExportControlUploadBlockedError);

      expect(storageMock.upload).not.toHaveBeenCalled();
    });

    it("rejects an explicit null answer and an unknown answer", async () => {
      await expect(
        uploadFilesToJob("job-1", [createUploadFile("a", "a.step")], { exportControlAnswer: null }),
      ).rejects.toMatchObject({ reasonCode: "export_declaration_missing" });
      await expect(
        uploadFilesToJob("job-1", [createUploadFile("a", "a.step")], {
          exportControlAnswer: "ear99" as unknown as "not_controlled",
        }),
      ).rejects.toMatchObject({ reasonCode: "export_declaration_missing" });

      expect(rpcMock).not.toHaveBeenCalled();
      expect(storageMock.upload).not.toHaveBeenCalled();
    });
  });

  describe.each(["controlled", "unsure"] as const)("%s answer", (answer) => {
    it("blocks uploadFilesToJob with zero storage objects", async () => {
      await expect(
        uploadFilesToJob("job-1", [createUploadFile("bracket", "bracket.step")], { exportControlAnswer: answer }),
      ).rejects.toMatchObject({ reasonCode: "export_declaration_not_clean" });

      expect(rpcMock).not.toHaveBeenCalled();
      expect(storageMock.from).not.toHaveBeenCalled();
      expect(storageMock.upload).not.toHaveBeenCalled();
    });

    it("blocks createJobsFromUploadFiles before any project, draft, or file is created", async () => {
      unregister = registerExportControlDeclarationPrompter(async () => answer);

      await expect(
        createJobsFromUploadFiles({
          files: [createUploadFile("a", "alpha.step"), createUploadFile("b", "beta.step")],
        }),
      ).rejects.toMatchObject({ reasonCode: "export_declaration_not_clean" });

      expect(rpcMock).not.toHaveBeenCalled();
      expect(storageMock.upload).not.toHaveBeenCalled();
    });
  });

  describe("server declaration", () => {
    it("records a not_controlled declaration and sends its id on prepare and finalize", async () => {
      unregister = registerExportControlDeclarationPrompter(async () => "not_controlled");
      rpcMock
        .mockResolvedValueOnce(cleanDeclaration("declaration-42"))
        .mockResolvedValueOnce({
          data: {
            status: "upload_required",
            storageBucket: "job-files",
            storagePath: "org-sha256/org-1/hash-a/bracket.step",
          },
          error: null,
        })
        .mockResolvedValueOnce({ data: "file-1", error: null });

      await expect(
        uploadFilesToJob("job-1", [createUploadFile("bracket", "bracket.step")]),
      ).resolves.toEqual({ uploadedCount: 1, reusedCount: 0, duplicateNames: [] });

      expect(rpcMock).toHaveBeenNthCalledWith(1, "api_declare_job_export_status", {
        p_job_id: "job-1",
        p_answer: "not_controlled",
        p_terms_version: EXPORT_CONTROL_TERMS_VERSION,
      });
      expect(rpcMock).toHaveBeenNthCalledWith(
        2,
        "api_prepare_job_file_upload",
        expect.objectContaining({ p_export_declaration_id: "declaration-42" }),
      );
      expect(rpcMock).toHaveBeenNthCalledWith(
        3,
        "api_finalize_job_file_upload",
        expect.objectContaining({ p_export_declaration_id: "declaration-42" }),
      );
      expect(storageMock.from).toHaveBeenCalledWith("job-files");
    });

    it.each([
      ["export_review_pending"],
      ["export_declaration_not_clean"],
      ["export_declaration_stale"],
    ] as const)("stops when the server reports %s", async (reasonCode) => {
      rpcMock.mockResolvedValueOnce({
        data: { declarationId: "declaration-1", uploadAllowed: false, reasonCode },
        error: null,
      });

      await expect(
        uploadFilesToJob("job-1", [createUploadFile("a", "a.step")], { exportControlAnswer: "not_controlled" }),
      ).rejects.toMatchObject({ reasonCode });

      expect(rpcNames()).toEqual(["api_declare_job_export_status"]);
      expect(storageMock.upload).not.toHaveBeenCalled();
    });

    it.each([
      ["null data", { data: null, error: null }],
      ["missing declarationId", { data: { uploadAllowed: true }, error: null }],
      ["non-boolean uploadAllowed", { data: { declarationId: "d", uploadAllowed: "true" }, error: null }],
      ["unknown reason code", { data: { declarationId: "d", uploadAllowed: false, reasonCode: "nope" }, error: null }],
    ])("fails closed on an unexpected declaration response (%s)", async (_label, response) => {
      rpcMock.mockResolvedValueOnce(response);

      await expect(
        uploadFilesToJob("job-1", [createUploadFile("a", "a.step")], { exportControlAnswer: "not_controlled" }),
      ).rejects.toMatchObject({ reasonCode: "export_declaration_missing" });

      expect(storageMock.upload).not.toHaveBeenCalled();
    });

    it("fails closed when the declaration RPC errors (including a missing RPC before the migration)", async () => {
      const missingRpc = {
        code: "PGRST202",
        details: null,
        hint: null,
        message: "Could not find the function public.api_declare_job_export_status",
      };
      rpcMock.mockResolvedValueOnce({ data: null, error: missingRpc });

      await expect(
        uploadFilesToJob("job-1", [createUploadFile("a", "a.step")], { exportControlAnswer: "not_controlled" }),
      ).rejects.toBe(missingRpc);

      expect(rpcNames()).toEqual(["api_declare_job_export_status"]);
      expect(storageMock.upload).not.toHaveBeenCalled();
    });

    it("maps a reason-code error from the declaration RPC to a blocked upload", async () => {
      rpcMock.mockResolvedValueOnce({
        data: null,
        error: { code: "P0001", details: null, hint: null, message: "export_review_pending" },
      });

      await expect(
        uploadFilesToJob("job-1", [createUploadFile("a", "a.step")], { exportControlAnswer: "not_controlled" }),
      ).rejects.toMatchObject({ reasonCode: "export_review_pending" });
    });

    it("stops with no storage object when prepare rejects the declaration", async () => {
      rpcMock
        .mockResolvedValueOnce(cleanDeclaration())
        .mockResolvedValueOnce({
          data: null,
          error: { code: "P0001", details: null, hint: null, message: "export_declaration_stale" },
        });

      await expect(
        uploadFilesToJob("job-1", [createUploadFile("a", "a.step")], { exportControlAnswer: "not_controlled" }),
      ).rejects.toMatchObject({ name: "ExportControlUploadBlockedError", reasonCode: "export_declaration_stale" });

      expect(storageMock.upload).not.toHaveBeenCalled();
    });

    it("surfaces a finalize export-control denial as a blocked upload", async () => {
      rpcMock
        .mockResolvedValueOnce(cleanDeclaration())
        .mockResolvedValueOnce({
          data: {
            status: "upload_required",
            storageBucket: "job-files",
            storagePath: "org-sha256/org-1/hash-a/a.step",
          },
          error: null,
        })
        .mockResolvedValueOnce({
          data: null,
          error: { code: "P0001", details: null, hint: null, message: "export_review_pending" },
        });

      await expect(
        uploadFilesToJob("job-1", [createUploadFile("a", "a.step")], { exportControlAnswer: "not_controlled" }),
      ).rejects.toMatchObject({ reasonCode: "export_review_pending" });
    });

    it("asks once for a multi-part batch and declares for every created job", async () => {
      const prompter = vi.fn(async () => "not_controlled" as const);
      unregister = registerExportControlDeclarationPrompter(prompter);
      storageMock.upload.mockResolvedValue({ error: null });
      rpcMock.mockImplementation((fn: string) => {
        switch (fn) {
          case "api_create_project":
            return Promise.resolve({ data: "project-1", error: null });
          case "api_create_client_draft": {
            const count = rpcMock.mock.calls.filter(([name]) => name === "api_create_client_draft").length;
            return Promise.resolve({ data: `job-${count}`, error: null });
          }
          case "api_declare_job_export_status":
            return Promise.resolve(cleanDeclaration());
          case "api_prepare_job_file_upload":
            return Promise.resolve({
              data: { status: "upload_required", storageBucket: "job-files", storagePath: "p" },
              error: null,
            });
          case "api_finalize_job_file_upload":
            return Promise.resolve({ data: "file-1", error: null });
          case "api_reconcile_job_parts":
            return Promise.resolve({ data: {}, error: null });
          case "api_request_extraction":
            return Promise.resolve({ data: 1, error: null });
          default:
            return Promise.resolve({ data: null, error: null });
        }
      });

      await expect(
        createJobsFromUploadFiles({
          files: [createUploadFile("a", "alpha.step"), createUploadFile("b", "beta.step")],
        }),
      ).resolves.toEqual({ jobIds: ["job-1", "job-2"], projectId: "project-1" });

      expect(prompter).toHaveBeenCalledTimes(1);
      expect(rpcMock.mock.calls.filter(([name]) => name === "api_declare_job_export_status")).toEqual([
        ["api_declare_job_export_status", expect.objectContaining({ p_job_id: "job-1" })],
        ["api_declare_job_export_status", expect.objectContaining({ p_job_id: "job-2" })],
      ]);
    });
  });
});
