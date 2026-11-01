import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXPORT_CONTROL_TERMS_VERSION,
  GENERATED_SOURCE_TAG,
  GENERATOR_TAG_PREFIX,
  buildGeneratedTags,
  ingestGeneratedPart,
  isStorageObjectExistsError,
  parseArgs,
  sha256Hex,
  thumbnailMimeType,
  writeSessionFileAtomically,
} from "./ingest-generated-part.mjs";
import * as appTags from "../src/features/generated-parts/generated-part-tags.ts";

const tempFilesIn = (dir) => readdirSync(dir).filter((name) => name.endsWith(".tmp"));

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

describe("ingest constants stay in sync with the app", () => {
  it("matches the export-control terms version and tag contract", () => {
    const source = readFileSync(resolve(process.cwd(), "src/features/quotes/export-control.ts"), "utf8");
    expect(source).toContain(`EXPORT_CONTROL_TERMS_VERSION = "${EXPORT_CONTROL_TERMS_VERSION}"`);
    expect(GENERATED_SOURCE_TAG).toBe(appTags.GENERATED_SOURCE_TAG);
    expect(GENERATOR_TAG_PREFIX).toBe(appTags.GENERATOR_TAG_PREFIX);
  });
});

describe("ingest failure paths", () => {
  it("throws on a real storage error and tolerates already-exists", async () => {
    const failing = fakeClient();
    failing.storage.from = () => ({ upload: async () => ({ error: { message: "bucket not found", statusCode: "404" } }) });
    await expect(ingestGeneratedPart({ ...base, client: failing, files: [step] })).rejects.toThrow(/storage upload/);
    expect(failing.calls.map((c) => c.name)).not.toContain("api_finalize_job_file_upload");

    expect(isStorageObjectExistsError({ message: "The resource already exists", statusCode: "409" })).toBe(true);
    expect(isStorageObjectExistsError({ message: "Object does not exist" })).toBe(false);
  });

  it.each(["api_declare_job_export_status", "api_finalize_job_file_upload", "api_reconcile_job_parts", "api_request_extraction"])(
    "surfaces %s errors",
    async (rpc) => {
      const client = fakeClient({ [rpc]: { data: null, error: { message: "boom" } } });
      await expect(ingestGeneratedPart({ ...base, client, files: [step] })).rejects.toThrow(/boom/);
    },
  );

  it("refuses a spec over the description limit before any RPC", async () => {
    const client = fakeClient();
    await expect(ingestGeneratedPart({ ...base, specText: "x".repeat(4001), client, files: [step] })).rejects.toThrow(/limit is 4000/);
    expect(client.calls).toHaveLength(0);
  });

  it("names the step when prepare returns no storage location", async () => {
    const client = fakeClient({ api_prepare_job_file_upload: { data: null, error: null } });
    await expect(ingestGeneratedPart({ ...base, client, files: [step] })).rejects.toThrow(/prepare bracket.STEP returned no storage location/);
  });

  it("skips files already attached to the job", async () => {
    const client = fakeClient({ api_prepare_job_file_upload: { data: { status: "duplicate_in_job" }, error: null } });
    const result = await ingestGeneratedPart({ ...base, client, files: [step] });
    expect(result.files[0].status).toBe("duplicate_in_job");
    expect(client.uploads).toHaveLength(0);
  });

  it("rejects missing argument values and non-image thumbnails", () => {
    expect(() => parseArgs(["--step"])).toThrow(/Missing value/);
    expect(() => parseArgs(["--step", "--name", "x"])).toThrow(/Missing value/);
    expect(parseArgs(["--step", "a.step", "--name", "A"])).toEqual({ step: "a.step", name: "A" });
    expect(thumbnailMimeType("a.PNG")).toBe("image/png");
    expect(() => thumbnailMimeType("a.exe")).toThrow(/png/);
  });
});

describe("writeSessionFileAtomically", () => {
  it("replaces the session file with a 0600 token file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ingest-session-"));
    const sessionFile = join(dir, "session.json");
    await writeSessionFileAtomically(sessionFile, "rotated");
    expect(JSON.parse(readFileSync(sessionFile, "utf8"))).toEqual({ refresh_token: "rotated" });
    if (process.platform !== "win32") expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
    expect(tempFilesIn(dir)).toEqual([]);
  });

  it("never writes through a stale or planted temp file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ingest-session-"));
    const sessionFile = join(dir, "session.json");
    const target = join(dir, "elsewhere.txt");
    writeFileSync(target, "untouched");
    symlinkSync(target, `${sessionFile}.tmp`);
    await writeSessionFileAtomically(sessionFile, "rotated");
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(JSON.parse(readFileSync(sessionFile, "utf8"))).toEqual({ refresh_token: "rotated" });
  });

  it("removes the temp file when the rename fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ingest-session-"));
    const sessionFile = join(dir, "session.json");
    mkdirSync(join(sessionFile, "blocker"), { recursive: true });
    await expect(writeSessionFileAtomically(sessionFile, "rotated")).rejects.toThrow();
    expect(tempFilesIn(dir)).toEqual([]);
  });
});
