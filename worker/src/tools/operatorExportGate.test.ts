// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { admitOperatorDrawing, isInRepoFixture, OperatorExportGateError, readJobIdArg } from "./operatorExportGate.js";

const readPdf = (text: string) => ({
  pageCount: 1,
  pageCountKnown: true,
  drawingFullyRead: true,
  pages: [{ text, ocrText: text || "title block", ocrStatus: "ok" }],
});

function rpcReturning(data: unknown, error: unknown = null) {
  const rpc = vi.fn(async () => ({ data, error }));
  return { client: { rpc } as never, rpc };
}

const notFixture = async () => false;

describe("admitOperatorDrawing", () => {
  it("admits a fixture without a job, a read, or a database call", async () => {
    const supabase = vi.fn();
    const gate = await admitOperatorDrawing({
      filePath: "/repo/worker/eval-corpus/a.pdf",
      jobId: null,
      pdfText: null,
      supabase,
      isFixture: async () => true,
    });
    expect(gate.basis).toBe("fixture");
    await expect(gate.beforeModelAttempt()).resolves.toBeUndefined();
    expect(supabase).not.toHaveBeenCalled();
  });

  it("refuses a non fixture without a job id", async () => {
    await expect(
      admitOperatorDrawing({ filePath: "/tmp/x.pdf", jobId: null, pdfText: readPdf("PART"), supabase: vi.fn(), isFixture: notFixture }),
    ).rejects.toThrow(/Pass --job-id/);
  });

  it("refuses a marking hit before any database call", async () => {
    const supabase = vi.fn();
    await expect(
      admitOperatorDrawing({ filePath: "/tmp/x.pdf", jobId: "job-1", pdfText: readPdf("ITAR controlled"), supabase, isFixture: notFixture }),
    ).rejects.toThrow(/markings found \(itar/);
    expect(supabase).not.toHaveBeenCalled();
  });

  it("refuses a drawing that was not fully read", async () => {
    const unread = { ...readPdf("PART"), drawingFullyRead: false };
    await expect(
      admitOperatorDrawing({ filePath: "/tmp/x.pdf", jobId: "job-1", pdfText: unread, supabase: vi.fn(), isFixture: notFixture }),
    ).rejects.toBeInstanceOf(OperatorExportGateError);
    await expect(
      admitOperatorDrawing({ filePath: "/tmp/x.pdf", jobId: "job-1", pdfText: null, supabase: vi.fn(), isFixture: notFixture }),
    ).rejects.toThrow(/not every drawing page/);
  });

  it("refuses when the job declaration is missing", async () => {
    const { client, rpc } = rpcReturning({ allowed: false, reasonCode: "export_declaration_missing" });
    await expect(
      admitOperatorDrawing({ filePath: "/tmp/x.pdf", jobId: "job-1", pdfText: readPdf("PART"), supabase: () => client, isFixture: notFixture }),
    ).rejects.toThrow(OperatorExportGateError);
    expect(rpc).toHaveBeenCalledWith("api_check_export_control_extraction", { p_job_id: "job-1" });
  });

  it("fails closed when the lookup errors", async () => {
    const { client } = rpcReturning(null, { message: "down" });
    await expect(
      admitOperatorDrawing({ filePath: "/tmp/x.pdf", jobId: "job-1", pdfText: readPdf("PART"), supabase: () => client, isFixture: notFixture }),
    ).rejects.toBeInstanceOf(OperatorExportGateError);
  });

  it("admits a clean declared job and re-checks before each model attempt", async () => {
    const { client, rpc } = rpcReturning({ allowed: true });
    const gate = await admitOperatorDrawing({
      filePath: "/tmp/x.pdf",
      jobId: "job-1",
      pdfText: readPdf("PART 123"),
      supabase: () => client,
      isFixture: notFixture,
    });
    expect(gate.basis).toBe("job_declaration");
    expect(rpc).toHaveBeenCalledTimes(1);
    await gate.beforeModelAttempt();
    expect(rpc).toHaveBeenCalledTimes(2);
    rpc.mockResolvedValueOnce({ data: { allowed: false, reasonCode: "export_review_pending" }, error: null });
    await expect(gate.beforeModelAttempt()).rejects.toThrow();
  });
});

describe("isInRepoFixture", () => {
  it("accepts files under a root and rejects outside files, missing files and symlink escapes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ovd757-"));
    try {
      const root = path.join(dir, "root");
      await fs.mkdir(root);
      const inside = path.join(root, "a.pdf");
      const outside = path.join(dir, "b.pdf");
      const link = path.join(root, "link.pdf");
      await fs.writeFile(inside, "x");
      await fs.writeFile(outside, "x");
      await fs.symlink(outside, link);
      expect(await isInRepoFixture(inside, [root])).toBe(true);
      expect(await isInRepoFixture(outside, [root])).toBe(false);
      expect(await isInRepoFixture(link, [root])).toBe(false);
      expect(await isInRepoFixture(path.join(root, "missing.pdf"), [root])).toBe(false);
      expect(await isInRepoFixture(root, [root])).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("readJobIdArg", () => {
  it("reads the value after --job-id", () => {
    expect(readJobIdArg(["a.pdf", "--job-id", "j1"])).toBe("j1");
    expect(readJobIdArg(["a.pdf"])).toBeNull();
    expect(readJobIdArg(["--job-id"])).toBeNull();
  });
});
