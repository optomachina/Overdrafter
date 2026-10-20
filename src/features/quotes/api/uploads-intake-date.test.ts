import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPORT_CONTROL_TERMS_VERSION } from "@/features/quotes/export-control";
import { parseRequestIntake } from "@/features/quotes/request-intake";
import { createJobsFromUploadFiles } from "./uploads-api";

// OVD-992: a need-by date typed in the upload prompt is a display filter only. The upload path must
// not save it into jobs.requested_by_date, because the approved requirement copies it and every
// controlled dispatch then denies the request.

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

const NOW = new Date("2026-10-19T12:00:00.000Z");

// Each prompt carries a date the parser really reads, plus a quantity the call site must keep.
const NEED_BY_PROMPTS = [
  {
    label: "relative weekday",
    prompt: "Please quote 25 of these, need by next Friday",
    parsedDate: "2026-10-23",
    quantities: [25],
  },
  {
    label: "slash date",
    prompt: "Need 50 of these, needed by 11/20",
    parsedDate: "2026-11-20",
    quantities: [50],
  },
  {
    label: "month name",
    prompt: "Quote qty 10/50/100, deliver by Dec 5",
    parsedDate: "2026-12-05",
    quantities: [10, 50, 100],
  },
] as const;

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

function respondToRpc(name: string) {
  switch (name) {
    case "api_create_project":
      return Promise.resolve({ data: "project-1", error: null });
    case "api_create_client_draft": {
      const count = rpcMock.mock.calls.filter(([callName]) => callName === "api_create_client_draft").length;
      return Promise.resolve({ data: `job-${count}`, error: null });
    }
    case "api_declare_job_export_status":
      return Promise.resolve({
        data: {
          declarationId: "declaration-1",
          answer: "not_controlled",
          termsVersion: EXPORT_CONTROL_TERMS_VERSION,
          uploadAllowed: true,
          reasonCode: null,
        },
        error: null,
      });
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
}

function createDraftArgs(): Array<Record<string, unknown>> {
  return rpcMock.mock.calls
    .filter(([name]) => name === "api_create_client_draft")
    .map(([, args]) => args as Record<string, unknown>);
}

describe("createJobsFromUploadFiles need-by handling (OVD-992)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    rpcMock.mockReset();
    rpcMock.mockImplementation(respondToRpc);
    storageMock.from.mockReturnValue({ upload: storageMock.upload });
    storageMock.upload.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(NEED_BY_PROMPTS)(
    "does not save a $label need-by date but keeps the parsed quantities and service intent",
    async ({ prompt, parsedDate, quantities }) => {
      // The parser still reads the date, so this proves the call site is what drops it.
      expect(parseRequestIntake(prompt, NOW).requestedByDate).toBe(parsedDate);

      await expect(
        createJobsFromUploadFiles({
          files: [createUploadFile("solid", "alpha.step")],
          prompt,
          exportControlAnswer: "not_controlled",
        }),
      ).resolves.toEqual({ jobIds: ["job-1"], projectId: null });

      expect(createDraftArgs()).toEqual([
        {
          p_title: "alpha",
          p_description: prompt,
          p_project_id: null,
          p_tags: [],
          p_requested_service_kinds: ["manufacturing_quote"],
          p_primary_service_kind: "manufacturing_quote",
          p_service_notes: null,
          p_requested_quote_quantities: quantities,
          p_requested_by_date: null,
        },
      ]);
    },
  );

  it("saves no date on any draft of a multi-file upload", async () => {
    await createJobsFromUploadFiles({
      files: [createUploadFile("a", "alpha.step"), createUploadFile("b", "beta.step")],
      prompt: "Need 50 of these, needed by 11/20",
      exportControlAnswer: "not_controlled",
    });

    const drafts = createDraftArgs();
    expect(drafts).toHaveLength(2);
    expect(drafts.map((draft) => draft.p_requested_by_date)).toEqual([null, null]);
    expect(drafts.map((draft) => draft.p_requested_quote_quantities)).toEqual([[50], [50]]);
  });

  it("sends no date for a prompt without one", async () => {
    await createJobsFromUploadFiles({
      files: [createUploadFile("solid", "alpha.step")],
      prompt: "Please quote 25 of these",
      exportControlAnswer: "not_controlled",
    });

    expect(createDraftArgs()).toEqual([
      expect.objectContaining({ p_requested_quote_quantities: [25], p_requested_by_date: null }),
    ]);
  });
});
