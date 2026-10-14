// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { admitOperatorDrawing, isInRepoFixture, OperatorExportGateError, readJobIdArg } from "./operatorExportGate.js";

const readPdf = (text: string) => ({
  pageCount: 1,
  pageCountKnown: true,
  drawingFullyRead: true,
  pages: [{ text, ocrText: text || "title block", ocrStatus: "ok" }],
});

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

let tmpDir: string;
let drawing: string;
beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ovd757-gate-"));
  drawing = path.join(tmpDir, "x.pdf");
  await fs.writeFile(drawing, "drawing bytes");
});
afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function rpcReturning(
  data: unknown,
  error: unknown = null,
  jobFiles: { data: unknown; error?: unknown } = { data: [{ content_sha256: sha256("drawing bytes") }] },
) {
  const rpc = vi.fn(async () => ({ data, error }));
  const eqs: Array<[string, unknown]> = [];
  const query = {
    eq: (column: string, value: unknown) => {
      eqs.push([column, value]);
      return eqs.length >= 2 ? Promise.resolve({ data: jobFiles.data, error: jobFiles.error ?? null }) : query;
    },
  };
  const from = vi.fn(() => ({ select: () => query }));
  return { client: { rpc, from } as never, rpc, from, eqs };
}

const notFixture = async () => false;

describe("admitOperatorDrawing", () => {
  it("admits a fixture without a job, a read, or a database call", async () => {
    const supabase = vi.fn();
    const gate = await admitOperatorDrawing({
      filePath: drawing,
      jobId: null,
      readPdfText: async () => null,
      supabase,
      isFixture: async () => true,
    });
    expect(gate.basis).toBe("fixture");
    await gate.cleanup();
    await expect(gate.beforeModelAttempt()).resolves.toBeUndefined();
    expect(supabase).not.toHaveBeenCalled();
  });

  it("refuses a non fixture without a job id", async () => {
    await expect(
      admitOperatorDrawing({ filePath: drawing, jobId: null, readPdfText: async () => readPdf("PART"), supabase: vi.fn(), isFixture: notFixture }),
    ).rejects.toThrow(/Pass --job-id/);
  });

  it("refuses a marking hit before any database call", async () => {
    const supabase = vi.fn();
    await expect(
      admitOperatorDrawing({ filePath: drawing, jobId: "job-1", readPdfText: async () => readPdf("ITAR controlled"), supabase, isFixture: notFixture }),
    ).rejects.toThrow(/markings found \(itar/);
    expect(supabase).not.toHaveBeenCalled();
  });

  it("refuses a drawing that was not fully read", async () => {
    const unread = { ...readPdf("PART"), drawingFullyRead: false };
    await expect(
      admitOperatorDrawing({ filePath: drawing, jobId: "job-1", readPdfText: async () => unread, supabase: vi.fn(), isFixture: notFixture }),
    ).rejects.toBeInstanceOf(OperatorExportGateError);
    await expect(
      admitOperatorDrawing({ filePath: drawing, jobId: "job-1", readPdfText: async () => null, supabase: vi.fn(), isFixture: notFixture }),
    ).rejects.toThrow(/not every drawing page/);
  });

  it("refuses a file that is not a drawing of the declared job before the declaration check", async () => {
    const { client, rpc, eqs } = rpcReturning({ allowed: true }, null, { data: [{ content_sha256: sha256("other bytes") }] });
    await expect(
      admitOperatorDrawing({ filePath: drawing, jobId: "job-1", readPdfText: async () => readPdf("PART"), supabase: () => client, isFixture: notFixture }),
    ).rejects.toThrow(/does not match any drawing recorded for job job-1/);
    expect(eqs).toEqual([["job_id", "job-1"], ["file_kind", "drawing"]]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses an unrelated job with no drawing records", async () => {
    const { client, rpc } = rpcReturning({ allowed: true }, null, { data: [] });
    await expect(
      admitOperatorDrawing({ filePath: drawing, jobId: "clean-job", readPdfText: async () => readPdf("PART"), supabase: () => client, isFixture: notFixture }),
    ).rejects.toBeInstanceOf(OperatorExportGateError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed when the drawing lookup errors or the file is unreadable", async () => {
    const failing = rpcReturning({ allowed: true }, null, { data: null, error: { message: "down" } });
    await expect(
      admitOperatorDrawing({ filePath: drawing, jobId: "job-1", readPdfText: async () => readPdf("PART"), supabase: () => failing.client, isFixture: notFixture }),
    ).rejects.toThrow(/lookup failed/);
    const ok = rpcReturning({ allowed: true });
    await expect(
      admitOperatorDrawing({ filePath: path.join(tmpDir, "missing.pdf"), jobId: "job-1", readPdfText: async () => readPdf("PART"), supabase: () => ok.client, isFixture: notFixture }),
    ).rejects.toThrow(/could not be read/);
    expect(failing.rpc).not.toHaveBeenCalled();
    expect(ok.rpc).not.toHaveBeenCalled();
  });

  it("refuses when the job declaration is missing", async () => {
    const { client, rpc } = rpcReturning({ allowed: false, reasonCode: "export_declaration_missing" });
    await expect(
      admitOperatorDrawing({ filePath: drawing, jobId: "job-1", readPdfText: async () => readPdf("PART"), supabase: () => client, isFixture: notFixture }),
    ).rejects.toThrow(OperatorExportGateError);
    expect(rpc).toHaveBeenCalledWith("api_check_export_control_extraction", { p_job_id: "job-1" });
  });

  it("fails closed when the lookup errors", async () => {
    const { client } = rpcReturning(null, { message: "down" });
    await expect(
      admitOperatorDrawing({ filePath: drawing, jobId: "job-1", readPdfText: async () => readPdf("PART"), supabase: () => client, isFixture: notFixture }),
    ).rejects.toBeInstanceOf(OperatorExportGateError);
  });

  it("admits a clean declared job and re-checks before each model attempt", async () => {
    const { client, rpc } = rpcReturning({ allowed: true });
    const gate = await admitOperatorDrawing({
      filePath: drawing,
      jobId: "job-1",
      readPdfText: async () => readPdf("PART 123"),
      supabase: () => client,
      isFixture: notFixture,
    });
    expect(gate.basis).toBe("job_declaration");
    expect(gate.drawingPath).not.toBe(drawing);
    expect(rpc).toHaveBeenCalledTimes(1);
    await gate.beforeModelAttempt();
    expect(rpc).toHaveBeenCalledTimes(2);
    rpc.mockResolvedValueOnce({ data: { allowed: false, reasonCode: "export_review_pending" }, error: null });
    await expect(gate.beforeModelAttempt()).rejects.toThrow();
  });
});

describe("admitOperatorDrawing snapshot", () => {
  it("keeps the admitted bytes when the original is replaced afterwards", async () => {
    const original = path.join(tmpDir, "swap.pdf");
    await fs.writeFile(original, "drawing bytes");
    const { client } = rpcReturning({ allowed: true });
    const gate = await admitOperatorDrawing({
      filePath: original,
      jobId: "job-1",
      readPdfText: async (snapshot) => readPdf(await fs.readFile(snapshot, "utf8")),
      supabase: () => client,
      isFixture: notFixture,
    });
    try {
      await fs.writeFile(original, "ITAR replacement bytes");
      await gate.beforeModelAttempt();
      expect(gate.drawingPath).not.toBe(original);
      expect(await fs.readFile(gate.drawingPath, "utf8")).toBe("drawing bytes");
    } finally {
      await gate.cleanup();
    }
    await expect(fs.access(gate.drawingPath)).rejects.toThrow();
  });

  it("scans and hashes the snapshot, so a swap during the text read is ignored", async () => {
    const original = path.join(tmpDir, "swap2.pdf");
    await fs.writeFile(original, "drawing bytes");
    const { client, rpc } = rpcReturning({ allowed: true });
    await expect(
      admitOperatorDrawing({
        filePath: original,
        jobId: "job-1",
        readPdfText: async (snapshot) => {
          await fs.writeFile(original, "other bytes");
          return readPdf(await fs.readFile(snapshot, "utf8"));
        },
        supabase: () => client,
        isFixture: notFixture,
      }),
    ).resolves.toMatchObject({ basis: "job_declaration" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe("isInRepoFixture", () => {
  it("admits only approved, unmodified files under a root", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ovd757-"));
    try {
      const root = path.join(dir, "root");
      await fs.mkdir(root);
      const approved = path.join(root, "a.pdf");
      const untracked = path.join(root, "new.pdf");
      const modified = path.join(root, "m.pdf");
      const outside = path.join(dir, "b.pdf");
      const link = path.join(root, "link.pdf");
      await fs.writeFile(approved, "x");
      await fs.writeFile(untracked, "x");
      await fs.writeFile(modified, "changed");
      await fs.writeFile(outside, "x");
      await fs.symlink(outside, link);
      const manifest = { "root/a.pdf": sha256("x"), "root/m.pdf": sha256("original"), "b.pdf": sha256("x"), "root/link.pdf": sha256("x") };
      const check = (file: string, m: Record<string, string> = manifest) => isInRepoFixture(file, [root], m, dir);
      expect(await check(approved)).toBe(true);
      expect(await check(untracked)).toBe(false);
      expect(await check(modified)).toBe(false);
      expect(await check(outside)).toBe(false);
      expect(await check(link)).toBe(false);
      expect(await check(path.join(root, "missing.pdf"))).toBe(false);
      expect(await check(root)).toBe(false);
      expect(await check(approved, {})).toBe(false);
      expect(await check(approved, { "root/a.pdf": "not-a-hash" })).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("admits nothing from the checked in roots while the manifest is empty", async () => {
    expect(await isInRepoFixture(path.join(process.cwd(), "package.json"))).toBe(false);
  });
});

describe("readJobIdArg", () => {
  it("reads the value after --job-id", () => {
    expect(readJobIdArg(["a.pdf", "--job-id", "j1"])).toBe("j1");
    expect(readJobIdArg(["a.pdf"])).toBeNull();
    expect(readJobIdArg(["--job-id"])).toBeNull();
  });
});
