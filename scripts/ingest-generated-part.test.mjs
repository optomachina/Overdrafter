import { describe, expect, it } from "vitest";
import { buildGeneratedTags, ingestGeneratedPart, sha256Hex } from "./ingest-generated-part.mjs";

function fakeClient(overrides = {}) {
  const calls = [];
  const uploads = [];
  const responses = {
    api_create_client_draft: { data: "job-1", error: null },
    api_declare_job_export_status: { data: { uploadAllowed: true, declarationId: "decl-1" }, error: null },
    api_prepare_job_file_upload: { data: { status: "upload_required", storageBucket: "job-files", storagePath: "org/job-1/x" }, error: null },
    api_finalize_job_file_upload: { data: "file-1", error: null },
    api_reconcile_job_parts: { data: {}, error: null },
    api_request_extraction: { data: 1, error: null },
    ...overrides,
  };
  return {
    calls,
    uploads,
    rpc: async (name, args) => {
      calls.push({ name, args });
      return responses[name];
    },
    storage: { from: (bucket) => ({ upload: async (path, bytes, opts) => { uploads.push({ bucket, path, opts }); return { error: null }; } }) },
  };
}

const step = { name: "bracket.STEP", bytes: new TextEncoder().encode("ISO-10303-21;"), kind: "cad", mimeType: "model/step" };
const png = { name: "bracket.png", bytes: new Uint8Array([137, 80, 78, 71]), kind: "other", mimeType: "image/png" };
const base = { name: "Bracket", specText: "{\"w\":10}", generator: "CAD Monkey", projectId: null, exportControl: "not_controlled" };

describe("ingestGeneratedPart", () => {
  it("runs the browser upload RPC sequence as the user and tags the part as generated", async () => {
    const client = fakeClient();
    const result = await ingestGeneratedPart({ ...base, client, files: [step, png] });

    expect(result.jobId).toBe("job-1");
    expect(client.calls.map((c) => c.name)).toEqual([
      "api_create_client_draft",
      "api_declare_job_export_status",
      "api_prepare_job_file_upload",
      "api_finalize_job_file_upload",
      "api_prepare_job_file_upload",
      "api_finalize_job_file_upload",
      "api_reconcile_job_parts",
      "api_request_extraction",
    ]);
    const draft = client.calls[0].args;
    expect(draft.p_tags).toEqual(["source:generated", "generator:cad-monkey"]);
    expect(draft.p_description).toBe("{\"w\":10}");
    const prepare = client.calls[2].args;
    expect(prepare.p_content_sha256).toBe(sha256Hex(step.bytes));
    expect(prepare.p_export_declaration_id).toBe("decl-1");
    expect(client.uploads[0].opts.upsert).toBe(false);
  });

  it("refuses without an explicit export-control declaration", async () => {
    const client = fakeClient();
    await expect(ingestGeneratedPart({ ...base, exportControl: undefined, client, files: [step] })).rejects.toThrow(/export-control/);
    expect(client.calls).toHaveLength(0);
  });

  it("requires exactly one STEP file", async () => {
    const client = fakeClient();
    await expect(ingestGeneratedPart({ ...base, client, files: [png] })).rejects.toThrow(/STEP/);
    await expect(
      ingestGeneratedPart({ ...base, client, files: [{ ...step, name: "bracket.SLDPRT" }] }),
    ).rejects.toThrow(/STEP/);
  });

  it("stops when the export declaration is not allowed", async () => {
    const client = fakeClient({ api_declare_job_export_status: { data: { uploadAllowed: false, reasonCode: "x" }, error: null } });
    await expect(ingestGeneratedPart({ ...base, client, files: [step] })).rejects.toThrow(/blocked/);
    expect(client.uploads).toHaveLength(0);
  });

  it("surfaces RPC errors without uploading", async () => {
    const client = fakeClient({ api_create_client_draft: { data: null, error: { message: "permission denied" } } });
    await expect(ingestGeneratedPart({ ...base, client, files: [step] })).rejects.toThrow(/permission denied/);
  });

  it("skips upload for files the workspace already has", async () => {
    const client = fakeClient({ api_prepare_job_file_upload: { data: { status: "reused" }, error: null } });
    const result = await ingestGeneratedPart({ ...base, client, files: [step] });
    expect(result.files).toEqual([{ name: "bracket.STEP", status: "reused" }]);
    expect(client.uploads).toHaveLength(0);
  });
});

describe("buildGeneratedTags", () => {
  it("normalizes the generator name", () => {
    expect(buildGeneratedTags("")).toEqual(["source:generated"]);
    expect(buildGeneratedTags("CAD Monkey")).toEqual(["source:generated", "generator:cad-monkey"]);
  });
});
