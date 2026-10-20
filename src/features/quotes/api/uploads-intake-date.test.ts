import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPORT_CONTROL_TERMS_VERSION } from "@/features/quotes/export-control";
import { parseRequestIntake } from "@/features/quotes/request-intake";
import { createJobsFromUploadFiles } from "./uploads-api";

// OVD-992: a need-by date typed in the upload prompt is a display filter only. The upload path must
// not save it into jobs.requested_by_date, because the approved requirement copies it and every
// controlled dispatch then denies the request.

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

const NOW = new Date("2026-10-19T12:00:00.000Z");

// [label, prompt, date the parser reads from it, quantities the call site must keep]
const NEED_BY_PROMPTS: Array<[string, string, string, number[]]> = [
  ["relative weekday", "Please quote 25 of these, need by next Friday", "2026-10-23", [25]],
  ["slash date", "Need 50 of these, needed by 11/20", "2026-11-20", [50]],
  ["month name", "Quote qty 10/50/100, deliver by Dec 5", "2026-12-05", [10, 50, 100]],
];

// What each RPC these tests reach returns in `data`; any other RPC returns null.
const RPC_DATA: Record<string, unknown> = {
  api_create_project: "project-1",
  api_declare_job_export_status: {
    declarationId: "declaration-1",
    answer: "not_controlled",
    termsVersion: EXPORT_CONTROL_TERMS_VERSION,
    uploadAllowed: true,
    reasonCode: null,
  },
  api_prepare_job_file_upload: { status: "upload_required", storageBucket: "job-files", storagePath: "p" },
  api_finalize_job_file_upload: "file-1",
  api_reconcile_job_parts: {},
  api_request_extraction: 1,
};

function draftRpcArgs(): Array<Record<string, unknown>> {
  return rpcMock.mock.calls
    .filter(([name]) => name === "api_create_client_draft")
    .map(([, args]) => args as Record<string, unknown>);
}

function respondToRpc(name: string) {
  // Each draft gets its own job id, numbered by how many drafts have been created so far.
  const data = name === "api_create_client_draft" ? `job-${draftRpcArgs().length}` : RPC_DATA[name] ?? null;
  return Promise.resolve({ data, error: null });
}

function stepFile(name: string): File {
  const bytes = new TextEncoder().encode(`solid ${name}`);
  const arrayBuffer = async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return { name, size: bytes.byteLength, type: "model/step", lastModified: 0, arrayBuffer } as unknown as File;
}

describe("createJobsFromUploadFiles need-by handling (OVD-992)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    rpcMock.mockReset();
    rpcMock.mockImplementation(respondToRpc);
    storageUpload.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(NEED_BY_PROMPTS)(
    "does not save a %s need-by date but keeps the parsed quantities and service intent",
    async (_label, prompt, parsedDate, quantities) => {
      // The parser still reads the date, so this proves the call site is what drops it.
      expect(parseRequestIntake(prompt, NOW).requestedByDate).toBe(parsedDate);

      await expect(
        createJobsFromUploadFiles({ files: [stepFile("alpha.step")], prompt, exportControlAnswer: "not_controlled" }),
      ).resolves.toEqual({ jobIds: ["job-1"], projectId: null });

      expect(draftRpcArgs()).toEqual([
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
      files: [stepFile("alpha.step"), stepFile("beta.step")],
      prompt: "Need 50 of these, needed by 11/20",
      exportControlAnswer: "not_controlled",
    });

    const drafts = draftRpcArgs();
    expect(drafts).toHaveLength(2);
    expect(drafts.map((draft) => draft.p_requested_by_date)).toEqual([null, null]);
    expect(drafts.map((draft) => draft.p_requested_quote_quantities)).toEqual([[50], [50]]);
  });

  it("sends no date for a prompt without one", async () => {
    await createJobsFromUploadFiles({
      files: [stepFile("alpha.step")],
      prompt: "Please quote 25 of these",
      exportControlAnswer: "not_controlled",
    });

    expect(draftRpcArgs()).toEqual([
      expect.objectContaining({ p_requested_quote_quantities: [25], p_requested_by_date: null }),
    ]);
  });
});
