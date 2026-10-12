// @vitest-environment node

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  detectExportControlMarkings,
  enforceAndRecordExportControlScan,
  enforceExportControlMarkings,
  evaluateExportControlDispatch,
  evaluateExportControlScanCoverage,
  EXPORT_CONTROL_DENIAL_CODES,
  ExportControlMarkingBlockedError,
  assertExportControlExtractionAllowed,
  ExportControlDrawingUnreadError,
  ExportControlExtractionDeniedError,
  ExportControlLookupError,
  ExportControlMarkingRecordError,
  ExportControlScanRecordError,
  isDrawingTextFullyRead,
  exportControlProviderJurisdiction,
  FOREIGN_JURISDICTION_PROVIDERS,
  isStepFileName,
  readStagedStepHeaderPrefix,
  readStepHeader,
  readStepHeaderText,
  drawingTextScanSource,
  enforceAndRecordStepHeaderScan,
  runExportMarkingRescan,
  scanDrawingTextForExportMarkings,
  scanStagedDrawingForExportMarkings,
  STEP_HEADER_SCAN_BYTES,
  scanStepHeaderForExportMarkings,
} from "./exportControl";
import { PROVIDER_DISPATCH_DENIAL_CODES, isRetryableProviderDispatchDenial } from "./providerDispatchEnvelope";
import { ProviderDispatchAuthorizationError, quoteWithProviderDispatchPreflight } from "./providerDispatchPreflight";
import { quoteWithDispatchPreflight, XometryDispatchAuthorizationError } from "./xometryDispatchPreflight";
import {
  assertExportControlDispatchAllowed,
  EXPORT_CONTROL_HOLD_NOTE,
  exportControlHoldReason,
  withExportControlDispatchRecheck,
} from "./dispatchRouting";
import { failureCodeForError, isRetryableVendorTaskError, nextRetryAt, VENDOR_TASK_RETRY_DELAYS_MS } from "./vendorTaskRetry";
import type { VendorName, VendorQuoteAdapterInput } from "./types";

const draft = readFileSync(new URL("../../docs/migration-drafts/ovd-723.sql", import.meta.url), "utf8");
const contract = readFileSync(new URL("../../docs/migration-drafts/ovd-723-contract.sql", import.meta.url), "utf8");
const expandRollback = readFileSync(new URL("../../docs/migration-drafts/ovd-723.rollback.sql", import.meta.url), "utf8");
const contractRollback = readFileSync(new URL("../../docs/migration-drafts/ovd-723-contract.rollback.sql", import.meta.url), "utf8");
const workerIndex = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

function sqlFunctionBody(name: string, source: string = draft): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start);
  return rest.slice(0, rest.indexOf("$$;"));
}

/** SQL statements only: comments removed. */
function sqlCode(source: string): string {
  return source.replace(/--[^\n]*/g, "");
}

function sqlWindow1(): string {
  const start = draft.indexOf("-- WINDOW 1: EXPAND");
  const end = draft.indexOf("-- ROLLBACK\n");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return draft.slice(start, end);
}

/** Title-block and note text as pdftotext/tesseract return it. */
const MARKING_FIXTURES = {
  itarStamp: "WARNING - THIS DOCUMENT CONTAINS TECHNICAL DATA WHOSE EXPORT IS RESTRICTED BY THE ITAR",
  eccn: "EXPORT CLASSIFICATION: ECCN 9E991",
  eccnShape: "CLASSIFIED 3A001 PER SUPPLEMENT 1",
  cui: "CUI // SP-EXPT",
  distributionStatement: "DISTRIBUTION STATEMENT D. Distribution authorized to the DoD and U.S. DoD contractors only.",
  usmlCategory: "USML Category XI(c)",
  cfr22: "Subject to 22 CFR 120-130",
  cfr15: "Controlled under 15 C.F.R. 734",
  earExport: "This item is subject to the EAR and may require an export license.",
  exportControlled: "EXPORT-CONTROLLED: do not disseminate",
} as const;

const CLEAN_DRAWING = [
  "BRACKET, MOUNTING  REV A  SHEET 1 OF 1",
  "MATERIAL: 6061-T6 ALUMINUM  FINISH: ANODIZE TYPE II CLEAR",
  "UNLESS OTHERWISE SPECIFIED DIMENSIONS ARE IN INCHES. TOLERANCES .XX +/-.01",
  "LINEAR GEAR RACK, BREAK ALL EDGES, DEBURR",
].join("\n");

const STEP_WITH_ITAR = [
  "ISO-10303-21;",
  "HEADER;",
  "FILE_DESCRIPTION(('ITAR CONTROLLED - USML CATEGORY IV'),'2;1');",
  "FILE_NAME('bracket.step','2026-10-01T00:00:00',('A. Engineer'),('Acme'),'SW','SolidWorks','');",
  "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));",
  "ENDSEC;",
  "DATA;",
  "#1=PRODUCT('bracket','bracket','',(#2));",
  "ENDSEC;",
  "END-ISO-10303-21;",
].join("\n");

const STEP_CLEAN_HEADER_MARKED_DATA = STEP_WITH_ITAR.replace(
  "FILE_DESCRIPTION(('ITAR CONTROLLED - USML CATEGORY IV'),'2;1');",
  "FILE_DESCRIPTION(('bracket'),'2;1');",
).replace("#1=PRODUCT('bracket'", "#1=PRODUCT('ITAR note in geometry data'");

describe("export-control marking detection", () => {
  it.each(Object.entries(MARKING_FIXTURES))("flags the %s fixture", (_name, text) => {
    expect(detectExportControlMarkings(text).length).toBeGreaterThan(0);
  });

  it("matches case-insensitively", () => {
    expect(detectExportControlMarkings("itar controlled")).toContain("itar");
    expect(detectExportControlMarkings("Distribution Statement c")).toContain("distribution_statement");
    expect(detectExportControlMarkings("cui")).toContain("cui");
  });

  it("names every matching pattern", () => {
    expect(detectExportControlMarkings(MARKING_FIXTURES.itarStamp)).toEqual(["itar", "technical_data"]);
    expect(detectExportControlMarkings(MARKING_FIXTURES.eccn)).toEqual(["eccn", "eccn_shape"]);
    expect(detectExportControlMarkings(MARKING_FIXTURES.eccnShape)).toEqual(["eccn_shape"]);
    expect(detectExportControlMarkings(MARKING_FIXTURES.cfr22)).toEqual(["cfr_22_itar"]);
    expect(detectExportControlMarkings(MARKING_FIXTURES.cfr15)).toEqual(["cfr_15_ear"]);
  });

  it("does not flag an ordinary drawing or EAR inside other words", () => {
    expect(detectExportControlMarkings(CLEAN_DRAWING)).toEqual([]);
    expect(detectExportControlMarkings("NEAR SIDE, YEAR 2026, GEAR")).toEqual([]);
    expect(detectExportControlMarkings(null)).toEqual([]);
    expect(detectExportControlMarkings("")).toEqual([]);
  });

  it("scans every drawing page", () => {
    const scan = scanDrawingTextForExportMarkings({
      pages: [{ text: CLEAN_DRAWING }, { text: MARKING_FIXTURES.cui }],
    });
    expect(scan).toEqual({ source: "drawing_text", patterns: ["cui"] });
    expect(scanDrawingTextForExportMarkings({ pages: [{ text: MARKING_FIXTURES.cui }] }, { ocr: true })?.source).toBe(
      "drawing_ocr",
    );
    expect(scanDrawingTextForExportMarkings({ pages: [{ text: CLEAN_DRAWING }] })).toBeNull();
    expect(scanDrawingTextForExportMarkings(null)).toBeNull();
  });

  it("reads only the STEP header section and scans it", () => {
    expect(readStepHeaderText(STEP_WITH_ITAR)).toContain("FILE_DESCRIPTION");
    expect(readStepHeaderText(STEP_WITH_ITAR)).not.toContain("#1=PRODUCT");
    expect(scanStepHeaderForExportMarkings(new TextEncoder().encode(STEP_WITH_ITAR))).toEqual({
      source: "step_header",
      patterns: ["itar", "usml", "usml_category"],
    });
    expect(scanStepHeaderForExportMarkings(STEP_CLEAN_HEADER_MARKED_DATA)).toBeNull();
  });

  it("scans the whole prefix when the STEP header is malformed", () => {
    expect(scanStepHeaderForExportMarkings("no header here; ITAR")).toEqual({ source: "step_header", patterns: ["itar"] });
  });

  it("reads only the bounded prefix of a staged STEP file and fails on a missing file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ovd723-step-"));
    try {
      const stepPath = path.join(dir, "large.step");
      writeFileSync(stepPath, STEP_WITH_ITAR + "x".repeat(STEP_HEADER_SCAN_BYTES * 2));
      const prefix = await readStagedStepHeaderPrefix(stepPath);
      expect(prefix.byteLength).toBe(STEP_HEADER_SCAN_BYTES);
      expect(scanStepHeaderForExportMarkings(prefix)?.patterns).toContain("itar");
      await expect(readStagedStepHeaderPrefix(path.join(dir, "missing.step"))).rejects.toThrow(/ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recognizes STEP file names", () => {
    expect(isStepFileName("bracket.STEP")).toBe(true);
    expect(isStepFileName("bracket.stp")).toBe(true);
    expect(isStepFileName("bracket.sldprt")).toBe(false);
    expect(isStepFileName(null)).toBe(false);
  });
});

describe("marking enforcement (records a block, then stops the task)", () => {
  const input = { jobId: "job-1", partId: "part-1", jobFileId: "file-1" };

  it("records a blocked_pending_review block and throws on a hit", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { blockId: "block-1", resolved: false }, error: null });
    const scan = scanDrawingTextForExportMarkings({ pages: [{ text: MARKING_FIXTURES.itarStamp }] });

    await expect(enforceExportControlMarkings({ rpc } as unknown as SupabaseClient, { ...input, scan })).rejects.toBeInstanceOf(
      ExportControlMarkingBlockedError,
    );
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("api_record_export_control_marking_hits", {
      p_job_id: "job-1",
      p_part_id: "part-1",
      p_job_file_id: "file-1",
      p_source: "drawing_text",
      p_patterns: ["itar", "technical_data"],
      p_content_sha256: null,
    });
  });

  it("fails closed when the block cannot be recorded", async () => {
    const scan = scanStepHeaderForExportMarkings(STEP_WITH_ITAR);
    for (const rpc of [
      vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202", message: "missing" } }),
      vi.fn().mockRejectedValue(new Error("network")),
      vi.fn().mockResolvedValue({ data: null, error: null }),
      // The old uuid-only answer, and an answer without a resolved flag, fail closed too.
      vi.fn().mockResolvedValue({ data: "block-1", error: null }),
      vi.fn().mockResolvedValue({ data: { blockId: "block-1" }, error: null }),
    ]) {
      await expect(
        enforceExportControlMarkings({ rpc } as unknown as SupabaseClient, { ...input, scan }),
      ).rejects.toBeInstanceOf(ExportControlMarkingRecordError);
    }
  });

  it("does nothing when nothing matched", async () => {
    const rpc = vi.fn();
    await expect(
      enforceExportControlMarkings({ rpc } as unknown as SupabaseClient, { ...input, scan: null }),
    ).resolves.toBe("clean");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("clean scans of record (reused files and skipped extraction)", () => {
  const contentSha256 = "c".repeat(64);
  const input = { jobId: "job-1", partId: "part-1", jobFileId: "file-1", contentSha256 };

  it("records a clean scan for a file with no markings", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "scan-1", error: null });
    await enforceAndRecordExportControlScan({ rpc } as unknown as SupabaseClient, {
      ...input,
      source: "step_header",
      scan: scanStepHeaderForExportMarkings(STEP_CLEAN_HEADER_MARKED_DATA),
      textRead: true,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("api_record_export_control_clean_scan", {
      p_job_id: "job-1",
      p_part_id: "part-1",
      p_job_file_id: "file-1",
      p_source: "step_header",
      p_content_sha256: contentSha256,
    });
  });

  it("fails closed without calling the database when the scanned bytes have no valid hash", async () => {
    for (const bad of ["", "C".repeat(64), "c".repeat(63)]) {
      const rpc = vi.fn().mockResolvedValue({ data: "scan-1", error: null });
      await expect(
        enforceAndRecordExportControlScan({ rpc } as unknown as SupabaseClient, {
          ...input,
          contentSha256: bad,
          source: "step_header",
          scan: null,
          textRead: true,
        }),
      ).rejects.toBeInstanceOf(ExportControlScanRecordError);
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it("fails closed when the database rejects the scanned bytes' hash", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "P0001", message: "export_content_hash_mismatch" } });
    await expect(
      enforceAndRecordExportControlScan({ rpc } as unknown as SupabaseClient, {
        ...input,
        source: "drawing_text",
        scan: null,
        textRead: true,
      }),
    ).rejects.toBeInstanceOf(ExportControlScanRecordError);
  });

  it("records a block and never a clean scan on a hit", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { blockId: "block-1", resolved: false }, error: null });
    await expect(
      enforceAndRecordExportControlScan({ rpc } as unknown as SupabaseClient, {
        ...input,
        source: "step_header",
        scan: scanStepHeaderForExportMarkings(STEP_WITH_ITAR),
        textRead: true,
      }),
    ).rejects.toBeInstanceOf(ExportControlMarkingBlockedError);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["api_record_export_control_marking_hits"]);
  });

  it("records nothing when the drawing text could not be read, so dispatch stays denied", async () => {
    const rpc = vi.fn();
    await enforceAndRecordExportControlScan({ rpc } as unknown as SupabaseClient, {
      ...input,
      source: "drawing_text",
      scan: scanDrawingTextForExportMarkings(null),
      textRead: false,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed when the clean scan cannot be recorded", async () => {
    for (const rpc of [
      vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202", message: "missing" } }),
      vi.fn().mockRejectedValue(new Error("network")),
      vi.fn().mockResolvedValue({ data: "", error: null }),
    ]) {
      await expect(
        enforceAndRecordExportControlScan({ rpc } as unknown as SupabaseClient, {
          ...input,
          source: "drawing_text",
          scan: null,
          textRead: true,
        }),
      ).rejects.toBeInstanceOf(ExportControlScanRecordError);
    }
  });

  it("scans the reusing part's own staged drawing instead of trusting copied artifacts", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { blockId: "block-1", resolved: false }, error: null });
    const extractText = vi.fn().mockResolvedValue({ pages: [{ text: MARKING_FIXTURES.cui }] });
    await expect(
      scanStagedDrawingForExportMarkings({ rpc } as unknown as SupabaseClient, {
        jobId: "target-job",
        partId: "target-part",
        drawingFile: { id: "target-drawing", localPath: "/stage/drawing.pdf", contentSha256: "d".repeat(64) },
        extractText,
      }),
    ).rejects.toBeInstanceOf(ExportControlMarkingBlockedError);
    expect(extractText).toHaveBeenCalledWith("/stage/drawing.pdf");
    expect(rpc).toHaveBeenCalledWith(
      "api_record_export_control_marking_hits",
      expect.objectContaining({ p_job_id: "target-job", p_part_id: "target-part", p_job_file_id: "target-drawing" }),
    );
  });

  it("records a clean scan for a clean reused drawing and propagates read errors", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "scan-1", error: null });
    await scanStagedDrawingForExportMarkings({ rpc } as unknown as SupabaseClient, {
      jobId: "target-job",
      partId: "target-part",
      drawingFile: { id: "target-drawing", localPath: "/stage/drawing.pdf", contentSha256: "d".repeat(64) },
      extractText: vi.fn().mockResolvedValue({ pages: [{ text: CLEAN_DRAWING }] }),
    });
    expect(rpc).toHaveBeenCalledWith("api_record_export_control_clean_scan", {
      p_job_id: "target-job",
      p_part_id: "target-part",
      p_job_file_id: "target-drawing",
      p_source: "drawing_text",
      p_content_sha256: "d".repeat(64),
    });

    const failing = vi.fn();
    await expect(
      scanStagedDrawingForExportMarkings({ rpc: failing } as unknown as SupabaseClient, {
        jobId: "target-job",
        partId: "target-part",
        drawingFile: { id: "target-drawing", localPath: "/stage/drawing.pdf", contentSha256: "d".repeat(64) },
        extractText: vi.fn().mockRejectedValue(new Error("pdftotext failed")),
      }),
    ).rejects.toThrow("pdftotext failed");
    expect(failing).not.toHaveBeenCalled();
  });

  it("treats a drawing as read only when every page yielded text", () => {
    expect(isDrawingTextFullyRead(null)).toBe(false);
    // pdftotext and OCR both found nothing: extractPdfText returns empty pages, not null.
    expect(isDrawingTextFullyRead({ pageCount: 2, pages: [{ text: "" }, { text: "  \n" }] })).toBe(false);
    expect(isDrawingTextFullyRead({ pageCount: 0, pages: [] })).toBe(false);
    // OCR reads only page 1: later pages come back empty.
    expect(isDrawingTextFullyRead({ pageCount: 3, pages: [{ text: CLEAN_DRAWING }, { text: "" }, { text: "" }] })).toBe(false);
    expect(isDrawingTextFullyRead({ pageCount: 2, pages: [{ text: CLEAN_DRAWING }] })).toBe(false);
    expect(isDrawingTextFullyRead({ pageCount: 2, pages: [{ text: CLEAN_DRAWING }, { text: "SHEET 2" }] })).toBe(true);
  });

  it.each([
    ["an extraction with only empty pages", { pageCount: 2, pages: [{ page: 1, text: "" }, { page: 2, text: "" }] }],
    ["page 1 text with empty later pages", { pageCount: 3, pages: [{ page: 1, text: CLEAN_DRAWING }, { page: 2, text: "" }, { page: 3, text: " " }] }],
  ])("records no clean scan for %s, so dispatch stays denied", async (_label, pdfText) => {
    const rpc = vi.fn().mockResolvedValue({ data: "scan-1", error: null });
    await scanStagedDrawingForExportMarkings({ rpc } as unknown as SupabaseClient, {
      jobId: "target-job",
      partId: "target-part",
      drawingFile: { id: "target-drawing", localPath: "/stage/drawing.pdf", contentSha256: "d".repeat(64) },
      extractText: vi.fn().mockResolvedValue(pdfText),
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(evaluateExportControlScanCoverage({ drawing: { inJob: true, hashVerified: true, scanned: false }, cad: null })).toBe(
      "export_scan_missing",
    );
  });

  it("still records a block when page 1 carries a marking and later pages are unread", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { blockId: "block-1", resolved: false }, error: null });
    await expect(
      scanStagedDrawingForExportMarkings({ rpc } as unknown as SupabaseClient, {
        jobId: "target-job",
        partId: "target-part",
        drawingFile: { id: "target-drawing", localPath: "/stage/drawing.pdf", contentSha256: "d".repeat(64) },
        extractText: vi.fn().mockResolvedValue({ pageCount: 2, pages: [{ text: MARKING_FIXTURES.itarStamp }, { text: "" }] }),
      }),
    ).rejects.toBeInstanceOf(ExportControlMarkingBlockedError);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["api_record_export_control_marking_hits"]);
  });

  it("stops extraction before any model call when the drawing is unread or the job is not cleared", () => {
    const run = workerIndex.slice(workerIndex.indexOf("async function runDrawingExtractionForTask("));
    const body = run.slice(0, run.indexOf("\nasync function handleExtractTask("));
    const modelAt = body.indexOf("await runHybridExtraction(");
    expect(modelAt).toBeGreaterThan(-1);
    expect(body).toContain("const drawingTextRead = isDrawingTextFullyRead(pdfText);");
    expect(body).toContain("textRead: drawingTextRead,");
    expect(body).not.toContain("textRead: pdfText !== null");
    expect(body.indexOf("throw new ExportControlDrawingUnreadError();")).toBeLessThan(modelAt);
    expect(body.indexOf("await assertExportControlExtractionAllowed(supabase, { jobId: task.job_id });")).toBeLessThan(modelAt);
    expect(body.indexOf("await assertExportControlExtractionAllowed(")).toBeGreaterThan(
      body.indexOf("await enforceAndRecordExportControlScan("),
    );
    // The debug lab preview sends the drawing to a model too, behind the same gate.
    const lab = readFileSync(new URL("./extraction/debugLab.ts", import.meta.url), "utf8");
    const preview = lab.slice(lab.indexOf("export async function previewStoredPartExtraction("));
    const firstModelCall = preview.indexOf("runPreviewModelAttempts(");
    for (const guard of [
      "await enforceExportControlMarkings(",
      "throw new ExportControlDrawingUnreadError();",
      "await assertExportControlExtractionAllowed(supabase, { jobId: context.part.job_id });",
    ]) {
      expect(preview.indexOf(guard)).toBeGreaterThan(-1);
      expect(preview.indexOf(guard)).toBeLessThan(firstModelCall);
    }
    // A failed lookup retries the extract task on the finite schedule; a decision does not.
    expect(workerIndex).toContain('(task.task_type === "extract_part" && error instanceof ExportControlLookupError)');
    expect(failureCodeForError(new ExportControlDrawingUnreadError())).toBe("export_scan_unread");
  });

  it("requires a verified hash and a job- and hash-bound clean scan before dispatch (reference model)", () => {
    const ok = { inJob: true, hashVerified: true, scanned: true };
    expect(evaluateExportControlScanCoverage(null)).toBe("export_scan_missing");
    expect(evaluateExportControlScanCoverage({ drawing: null, cad: null })).toBeNull();
    expect(evaluateExportControlScanCoverage({ drawing: { ...ok, scanned: false }, cad: null })).toBe("export_scan_missing");
    expect(evaluateExportControlScanCoverage({ drawing: { ...ok, inJob: false }, cad: null })).toBe("export_scan_missing");
    expect(evaluateExportControlScanCoverage({ drawing: { ...ok, hashVerified: false }, cad: null })).toBe("export_scan_missing");
    expect(
      evaluateExportControlScanCoverage({ drawing: ok, cad: { ...ok, originalName: "part.STEP", scanned: false } }),
    ).toBe("export_scan_missing");
    expect(evaluateExportControlScanCoverage({ drawing: ok, cad: { ...ok, originalName: "part.stp" } })).toBeNull();
    // No scanner exists for other CAD formats yet; documented in the notes.
    // They still need a verified hash in the part's job.
    expect(
      evaluateExportControlScanCoverage({ drawing: ok, cad: { ...ok, originalName: "part.sldprt", scanned: false } }),
    ).toBeNull();
    expect(
      evaluateExportControlScanCoverage({
        drawing: ok,
        cad: { inJob: true, hashVerified: false, scanned: false, originalName: "part.sldprt" },
      }),
    ).toBe("export_scan_missing");
  });

  it("wires the scan into the trusted-reuse branch before the task completes", () => {
    const reuse = workerIndex.slice(workerIndex.indexOf('"api_reuse_trusted_part_version_artifacts"'));
    const scanAt = reuse.indexOf("scanStagedDrawingForExportMarkings(");
    expect(scanAt).toBeGreaterThan(-1);
    expect(scanAt).toBeLessThan(reuse.indexOf("reusedCanonicalPartVersion: true"));
    expect(workerIndex).toContain("await enforceAndRecordStepHeaderScan(supabase, {");
    expect(workerIndex).toMatch(/source: drawingTextScanSource\(pdfText\),\s+scan: scanDrawingTextForExportMarkings\(pdfText\)/);
    // Every clean scan carries the hash of the bytes the worker staged.
    expect(workerIndex).toContain("contentSha256: stagedDrawingFile?.trustedContentSha256");
    expect(workerIndex).toContain("contentSha256: identityStagedDrawing.trustedContentSha256");
    expect(workerIndex).toContain("contentSha256: stagedCadFile.trustedContentSha256");
  });
});

describe("export-control dispatch rule (reference model of the SQL gate)", () => {
  const clean = { latestAnswer: "not_controlled" as const, markingBlocked: false };

  it.each<VendorName>(["xometry", "fictiv", "quickparts"])("admits %s only with a clean, unblocked declaration", (provider) => {
    expect(evaluateExportControlDispatch({ provider, ...clean })).toBeNull();
    expect(evaluateExportControlDispatch({ provider, latestAnswer: null, markingBlocked: false })).toBe(
      "export_declaration_missing",
    );
    expect(evaluateExportControlDispatch({ provider, latestAnswer: "missing", markingBlocked: false })).toBe(
      "export_declaration_missing",
    );
    expect(evaluateExportControlDispatch({ provider, latestAnswer: "controlled", markingBlocked: false })).toBe(
      "export_declaration_not_clean",
    );
    expect(evaluateExportControlDispatch({ provider, latestAnswer: "unsure", markingBlocked: false })).toBe(
      "export_declaration_not_clean",
    );
    expect(evaluateExportControlDispatch({ provider, latestAnswer: "not_controlled", markingBlocked: true })).toBe(
      "export_review_pending",
    );
  });

  it.each<VendorName>(["weerg", "geomiq"])("denies foreign provider %s with its own code unless clean", (provider) => {
    expect(exportControlProviderJurisdiction(provider)).toBe("foreign");
    expect(evaluateExportControlDispatch({ provider, ...clean })).toBeNull();
    for (const latestAnswer of [null, "missing", "controlled", "unsure"] as const) {
      expect(evaluateExportControlDispatch({ provider, latestAnswer, markingBlocked: false })).toBe(
        "export_foreign_provider_requires_clean_declaration",
      );
    }
    expect(evaluateExportControlDispatch({ provider, latestAnswer: "not_controlled", markingBlocked: true })).toBe(
      "export_foreign_provider_requires_clean_declaration",
    );
  });

  it("treats an unknown provider like a foreign one", () => {
    expect(exportControlProviderJurisdiction("brand-new-provider")).toBe("unknown");
    expect(evaluateExportControlDispatch({ provider: "brand-new-provider", latestAnswer: null, markingBlocked: false })).toBe(
      "export_foreign_provider_requires_clean_declaration",
    );
  });

  it("denies when the lookup failed or the evidence is malformed", () => {
    expect(evaluateExportControlDispatch({ lookupFailed: true })).toBe("export_control_lookup_failed");
    expect(evaluateExportControlDispatch({} as never)).toBe("export_control_lookup_failed");
    expect(
      evaluateExportControlDispatch({ provider: "fictiv", latestAnswer: "not_controlled" } as never),
    ).toBe("export_review_pending");
  });
});

describe("worker preflights surface the export-control denials", () => {
  it("adds every export code to the closed, terminal provider vocabulary", () => {
    for (const code of EXPORT_CONTROL_DENIAL_CODES) {
      expect(PROVIDER_DISPATCH_DENIAL_CODES).toContain(code);
      expect(isRetryableProviderDispatchDenial(code)).toBe(false);
    }
  });

  it.each<[VendorName, (typeof EXPORT_CONTROL_DENIAL_CODES)[number]]>([
    ["fictiv", "export_declaration_missing"],
    ["fictiv", "export_declaration_not_clean"],
    ["fictiv", "export_review_pending"],
    ["fictiv", "export_control_lookup_failed"],
    ["weerg", "export_foreign_provider_requires_clean_declaration"],
    ["geomiq", "export_foreign_provider_requires_clean_declaration"],
  ])("generic preflight for %s: %s makes zero adapter calls", async (provider, denial) => {
    const rpc = vi.fn().mockResolvedValue({
      data: { schema: "provider-dispatch-authorization.v1", authorized: false, denial, retryable: false },
      error: null,
    });
    const quote = vi.fn();
    const run = quoteWithProviderDispatchPreflight({
      supabase: { rpc } as unknown as SupabaseClient,
      workerName: "worker-1",
      claimedAt: "2026-10-11T12:00:00.000Z",
      claim: {
        workQueueTaskId: "00000000-0000-4000-8000-000000007231",
        vendorQuoteResultId: "00000000-0000-4000-8000-000000007232",
        provider,
        permitId: "00000000-0000-4000-8000-000000007233",
        envelopeFingerprint: "a".repeat(64),
      },
      scopeSnapshot: { schema: "quote-lane-scope.v1", vendor: provider },
      adapter: { quote },
      quoteInput: {} as VendorQuoteAdapterInput,
    });
    await expect(run).rejects.toEqual(new ProviderDispatchAuthorizationError(denial));
    await expect(run).rejects.toMatchObject({ retryable: false });
    expect(quote).not.toHaveBeenCalled();
  });

  it.each(EXPORT_CONTROL_DENIAL_CODES)("Xometry preflight: %s is kept and makes zero adapter calls", async (reasonCode) => {
    const rpc = vi.fn().mockResolvedValue({ data: { authorized: false, reasonCode }, error: null });
    const quote = vi.fn();
    await expect(
      quoteWithDispatchPreflight({
        supabase: { rpc } as unknown as SupabaseClient,
        config: { workerMode: "live", workerName: "worker-1" },
        workQueueTaskId: "task-1",
        vendorQuoteResultId: "result-1",
        claimedAt: "2026-10-11T12:00:00.000Z",
        vendor: "xometry",
        scopeSnapshot: { schema: "quote-lane-scope.v1", vendor: "xometry" },
        adapter: { quote },
        quoteInput: {} as VendorQuoteAdapterInput,
      }),
    ).rejects.toEqual(new XometryDispatchAuthorizationError(reasonCode));
    expect(quote).not.toHaveBeenCalled();
  });

  it("denies when the preflight lookup itself errors (fail closed)", async () => {
    const quote = vi.fn();
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "XX000", message: "lookup failed" } });
    await expect(
      quoteWithDispatchPreflight({
        supabase: { rpc } as unknown as SupabaseClient,
        config: { workerMode: "live", workerName: "worker-1" },
        workQueueTaskId: "task-1",
        vendorQuoteResultId: "result-1",
        claimedAt: "2026-10-11T12:00:00.000Z",
        vendor: "xometry",
        scopeSnapshot: { schema: "quote-lane-scope.v1", vendor: "xometry" },
        adapter: { quote },
        quoteInput: {} as VendorQuoteAdapterInput,
      }),
    ).rejects.toBeInstanceOf(XometryDispatchAuthorizationError);
    expect(quote).not.toHaveBeenCalled();
  });
});

describe("export-control dispatch check (window 1 worker gate)", () => {
  const call = (rpc: ReturnType<typeof vi.fn>, vendor: "fictiv" | "xometry" = "fictiv") =>
    assertExportControlDispatchAllowed({ rpc } as unknown as SupabaseClient, { taskId: "task-1", vendor });

  it("passes only on exactly { allowed: true }", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { allowed: true }, error: null });
    await expect(call(rpc)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("api_check_export_control_dispatch", {
      p_work_queue_task_id: "task-1",
      p_provider: "fictiv",
    });
  });

  it.each(EXPORT_CONTROL_DENIAL_CODES.filter((code) => code !== "export_control_lookup_failed"))(
    "throws the boundary's own error for %s, which holds the lane",
    async (reasonCode) => {
      const rpc = vi.fn().mockResolvedValue({ data: { allowed: false, reasonCode }, error: null });
      await expect(call(rpc)).rejects.toEqual(new ProviderDispatchAuthorizationError(reasonCode));
      await expect(call(rpc, "xometry")).rejects.toEqual(new XometryDispatchAuthorizationError(reasonCode));
      const error = await call(rpc).catch((caught: unknown) => caught);
      expect(exportControlHoldReason(error)).toBe(reasonCode);
      expect(isRetryableVendorTaskError(error, undefined)).toBe(false);
    },
  );

  it("throws a retryable lookup error when the check reports a failed lookup", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { allowed: false, reasonCode: "export_control_lookup_failed" }, error: null });
    const error = await call(rpc).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExportControlLookupError);
    expect(isRetryableVendorTaskError(error, undefined)).toBe(true);
    expect(failureCodeForError(error)).toBe("export_control_lookup_failed");
    expect(exportControlHoldReason(error)).toBeNull();
  });

  it("fails closed on errors and malformed responses", async () => {
    for (const rpc of [
      vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202", message: "missing" } }),
      vi.fn().mockRejectedValue(new Error("network")),
      vi.fn().mockResolvedValue({ data: null, error: null }),
      vi.fn().mockResolvedValue({ data: { allowed: "true" }, error: null }),
      vi.fn().mockResolvedValue({ data: { allowed: true, extra: 1 }, error: null }),
      vi.fn().mockResolvedValue({ data: { allowed: false, reasonCode: "made_up" }, error: null }),
      vi.fn().mockResolvedValue({ data: [{ allowed: true }], error: null }),
    ]) {
      await expect(call(rpc)).rejects.toEqual(new ExportControlLookupError("dispatch"));
      await expect(call(rpc, "xometry")).rejects.toEqual(new ExportControlLookupError("dispatch"));
    }
  });

  it("holds the lane, never as manual follow-up, on a denial or a marking hit while staging", () => {
    expect(exportControlHoldReason(new ExportControlMarkingBlockedError("step_header", ["itar"]))).toBe(
      "export_review_pending",
    );
    expect(isRetryableVendorTaskError(new ExportControlMarkingBlockedError("step_header", ["itar"]), undefined)).toBe(false);
    expect(failureCodeForError(new ExportControlMarkingBlockedError("step_header", ["itar"]))).toBe("export_review_pending");
    // A contract-era wrapper reporting a failed lookup is a decision of record: hold.
    expect(exportControlHoldReason(new ProviderDispatchAuthorizationError("export_control_lookup_failed"))).toBe(
      "export_control_lookup_failed",
    );
    expect(exportControlHoldReason(new ProviderDispatchAuthorizationError("permit_expired"))).toBeNull();
    expect(exportControlHoldReason(new XometryDispatchAuthorizationError("dispatch_preflight_unavailable"))).toBeNull();
    expect(exportControlHoldReason(new Error("network"))).toBeNull();

    const catchBlock = workerIndex.slice(workerIndex.indexOf("const dispatchAuthorizationError = dispatchAuthorizationFailure(error);"));
    const holdAt = catchBlock.indexOf("if (exportControlHold) {");
    expect(holdAt).toBeGreaterThan(-1);
    // The hold returns before the manual follow-up decision is ever made.
    expect(holdAt).toBeLessThan(catchBlock.indexOf("const requiresManualVendorFollowUp ="));
    const hold = catchBlock.slice(holdAt, catchBlock.indexOf("return;", holdAt));
    expect(hold).toContain('status: "failed"');
    expect(hold).toContain("notes: [EXPORT_CONTROL_HOLD_NOTE]");
    expect(hold).toContain("requiresManualVendorFollowUp: false");
    expect(hold).toContain("manualFollowUpReason: null");
    expect(hold).toContain("await markTaskCompleted(");
    expect(hold).not.toContain("manual_vendor_followup");
    expect(catchBlock).toContain(
      "?? (error instanceof ExportControlLookupError && nextRetryAt(task.attempts) === null ? error.reasonCode : null);",
    );
    expect(EXPORT_CONTROL_HOLD_NOTE).toContain("must not be quoted manually");
    expect(EXPORT_CONTROL_HOLD_NOTE).not.toMatch(/manual follow-up is required/i);
  });

  it("retries a failed lookup only on the finite schedule", () => {
    expect(nextRetryAt(1)).not.toBeNull();
    expect(nextRetryAt(VENDOR_TASK_RETRY_DELAYS_MS.length + 1)).toBeNull();
  });

  it("runs before the routed preflight in the quote task", () => {
    const checkAt = workerIndex.indexOf("await assertExportControlDispatchAllowed(supabase, { taskId: task.id, vendor });");
    expect(checkAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(workerIndex.indexOf("const result = await quoteWithRoutedDispatchPreflight({"));
    expect(checkAt).toBeGreaterThan(workerIndex.indexOf('source: "step_header",'));
  });
});

describe("export-control extraction check (no CAD or drawing to a model without a clean job)", () => {
  const call = (rpc: ReturnType<typeof vi.fn>) =>
    assertExportControlExtractionAllowed({ rpc } as unknown as SupabaseClient, { jobId: "job-1" });

  it("passes only on exactly { allowed: true }", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { allowed: true }, error: null });
    await expect(call(rpc)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("api_check_export_control_extraction", { p_job_id: "job-1" });
  });

  it.each(["export_declaration_missing", "export_declaration_not_clean", "export_review_pending"] as const)(
    "denies %s",
    async (reasonCode) => {
      const rpc = vi.fn().mockResolvedValue({ data: { allowed: false, reasonCode }, error: null });
      await expect(call(rpc)).rejects.toEqual(new ExportControlExtractionDeniedError(reasonCode));
      const error = await call(rpc).catch((caught: unknown) => caught);
      expect(failureCodeForError(error)).toBe(reasonCode);
    },
  );

  it("fails closed with a lookup error on errors and malformed responses", async () => {
    for (const rpc of [
      vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202", message: "missing" } }),
      vi.fn().mockRejectedValue(new Error("network")),
      vi.fn().mockResolvedValue({ data: null, error: null }),
      vi.fn().mockResolvedValue({ data: { allowed: "true" }, error: null }),
      vi.fn().mockResolvedValue({ data: { allowed: true, extra: 1 }, error: null }),
      vi.fn().mockResolvedValue({ data: { allowed: false, reasonCode: "made_up" }, error: null }),
      vi.fn().mockResolvedValue({ data: { allowed: false, reasonCode: "export_control_lookup_failed" }, error: null }),
    ]) {
      await expect(call(rpc)).rejects.toEqual(new ExportControlLookupError("extraction"));
    }
  });
});

describe("OVD-723 migration draft", () => {
  it("is a draft, not an applied migration", () => {
    expect(draft.startsWith("-- =")).toBe(true);
    expect(draft).toContain("NEEDS BLAINE MIGRATION WINDOW - not applied");
    expect(draft).toMatch(/-- WINDOW 1: EXPAND [\s\S]*-- ROLLBACK/);
    expect(contract).toContain("NEEDS BLAINE MIGRATION WINDOW - not applied");
    expect(draft).not.toMatch(/PHASE [12]/);
    const migrationsDir = new URL("../../supabase/migrations/", import.meta.url);
    for (const name of readdirSync(migrationsDir)) {
      expect(readFileSync(new URL(name, migrationsDir), "utf8")).not.toContain("job_export_declarations");
    }
  });

  it("returns every worker export code and nothing else from the gate", () => {
    for (const code of EXPORT_CONTROL_DENIAL_CODES) expect(draft).toContain(`'${code}'`);
    const gate = [
      sqlFunctionBody("private.export_control_dispatch_denial"),
      sqlFunctionBody("private.export_control_scan_denial"),
      sqlFunctionBody("private.export_control_file_denial"),
      sqlFunctionBody("private.export_control_dispatch_denial_for_task"),
    ].join("\n");
    const returned = [...gate.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]);
    expect(new Set(returned)).toEqual(new Set(EXPORT_CONTROL_DENIAL_CODES));
  });

  it("keeps window 1 additive: no existing function or policy is changed or revoked", () => {
    const window1 = sqlCode(sqlWindow1());
    expect(window1).not.toMatch(/alter function public\./);
    expect(window1).not.toMatch(/create or replace function public\.api_authorize_/);
    expect(window1).not.toContain('drop policy if exists "job_files_storage_insert" on');
    expect(window1).not.toMatch(/revoke all on function public\.api_(prepare|finalize)_job_file_upload\(\s+uuid, text, public\.job_file_kind, text, bigint, text\s+\)/);
    // Exactly one new overload each; the 6- and 8-argument legacy RPCs are untouched.
    expect(window1.match(/create or replace function public\.api_prepare_job_file_upload\(/g)).toHaveLength(1);
    expect(window1.match(/create or replace function public\.api_finalize_job_file_upload\(/g)).toHaveLength(1);
    expect(sqlFunctionBody("public.api_prepare_job_file_upload")).toContain("p_export_declaration_id uuid");
    expect(sqlFunctionBody("private.job_file_prepare_delegate")).toContain("return public.api_prepare_job_file_upload(");
    // The grant policy is added alongside the existing one.
    expect(window1).toContain('create policy "job_files_storage_insert_export_cleared"');
    expect(window1).toContain("and public.current_user_has_export_cleared_upload(bucket_id, name)");
    // The worker asks the gate through a new service-role RPC.
    expect(sqlFunctionBody("public.api_check_export_control_dispatch")).toContain(
      "private.export_control_dispatch_denial_for_task(p_work_queue_task_id, p_provider)",
    );
    expect(window1).toMatch(/grant execute on function public\.api_check_export_control_dispatch\(uuid, text\)\s+to service_role;/);
  });

  it("puts every change to an existing object in the contract draft", () => {
    const code = sqlCode(contract);
    expect(code).toContain("raise exception 'OVD-723 contract refused: apply the OVD-723 expand migration first'");
    for (const fn of ["api_authorize_xometry_beta_worker_dispatch", "api_authorize_provider_worker_dispatch"]) {
      expect(code).toContain(`create or replace function public.${fn}(`);
    }
    expect(code).toContain('drop policy "job_files_storage_insert" on storage.objects;');
    expect(sqlFunctionBody("private.job_file_prepare_delegate", contract)).toContain("return private.job_file_prepare_core(");
    // The legacy signatures refuse and never delegate.
    const legacy =
      /create or replace function public\.api_prepare_job_file_upload\(\s+p_job_id uuid,\s+p_original_name text,\s+p_file_kind public\.job_file_kind,\s+p_mime_type text default null,[\s\S]*?\$\$;/.exec(code)?.[0] ?? "";
    expect(legacy).toContain("message = 'export_declaration_missing'");
    expect(legacy).not.toContain("job_file_prepare_core");
  });

  it("guards both rollbacks and restores exactly what each step changed", () => {
    expect(expandRollback).toContain("OVD-723 expand rollback refused: the contract migration is applied");
    expect(expandRollback).toContain('drop policy "job_files_storage_insert_export_cleared" on storage.objects;');
    expect(expandRollback).toContain("drop function public.api_record_export_control_clean_scan(uuid, uuid, uuid, text, text);");
    expect(expandRollback).toContain("drop function public.current_user_has_export_cleared_upload(text, text);");
    expect(expandRollback).not.toMatch(/drop table private\.(job_export_declarations|export_control_events|job_export_marking_blocks|job_file_export_scans)/);
    expect(contractRollback).toContain("the OVD-723 wrappers are not the outermost preflights");
    expect(contractRollback).toContain('create policy "job_files_storage_insert"');
    expect(contractRollback).toContain("drop function public.api_authorize_provider_worker_dispatch(");
    expect(contractRollback).toContain("drop function public.api_authorize_xometry_beta_worker_dispatch(");
  });

  it("binds each upload grant to one exact object and serializes Storage authorization", () => {
    const grants = draft.slice(draft.indexOf("create table if not exists private.export_cleared_upload_grants"));
    const table = grants.slice(0, grants.indexOf(");\n"));
    for (const column of ["storage_bucket", "storage_path", "size_bytes", "content_sha256", "finalized_at"]) {
      expect(table).toContain(column);
    }
    const helper = sqlFunctionBody("public.current_user_has_export_cleared_upload");
    expect(helper).toContain("volatile");
    expect(helper).toContain("grant_row.storage_path = p_object_name");
    expect(helper).toContain("grant_row.finalized_at is null");
    expect(helper.indexOf("private.lock_job_export_state(v_grant.job_id, false)")).toBeLessThan(
      helper.indexOf("private.job_export_upload_denial(v_grant.job_id, v_grant.declaration_id)"),
    );
    const finalize = draft.slice(draft.lastIndexOf("create or replace function public.api_finalize_job_file_upload("));
    const finalizeBody = finalize.slice(0, finalize.indexOf("$$;", finalize.indexOf("as $$") + 5));
    expect(finalizeBody).toContain("coalesce(object_row.owner_id, object_row.owner::text) = auth.uid()::text");
    expect(finalizeBody).toContain("grant_row.size_bytes = p_size_bytes");
    expect(finalizeBody).toContain("message = 'file_upload_grant_missing'");
    expect(finalizeBody).toContain("set finalized_at = pg_catalog.clock_timestamp()");
  });

  it("binds clean scans to the file, its current job, and its current content hash", () => {
    const forTask = sqlFunctionBody("private.export_control_dispatch_denial_for_task");
    expect(forTask).toContain("task_row.part_id");
    expect(forTask).toContain("return private.export_control_scan_denial(v_job_id, v_part_id);");
    const scanRule = sqlFunctionBody("private.export_control_scan_denial");
    expect(scanRule).toContain("v_part.job_id is distinct from p_job_id");
    const fileRule = sqlFunctionBody("private.export_control_file_denial");
    // Keyed on the part's own job_file id, its current job, and its current
    // hash: a scan of the same bytes in another job never counts, and a row
    // that is repointed or moved loses its scan.
    expect(fileRule).toContain("scan.job_file_id = v_file.id");
    expect(fileRule).toContain("scan.job_id = v_file.job_id");
    expect(fileRule).toContain("scan.content_sha256 = v_hash");
    expect(fileRule).toContain("v_file.job_id is distinct from p_job_id");
    expect(fileRule).toContain("v_file.trusted_content_sha256 is distinct from v_hash");
    const sqlStep = /~ '([^']+)'/.exec(scanRule)?.[1];
    expect(sqlStep).toBe("\\.(step|stp)$");
    for (const name of ["a.step", "a.STP", " b.Step "]) expect(isStepFileName(name)).toBe(true);
    const record = sqlFunctionBody("public.api_record_export_control_clean_scan");
    expect(record).toContain("v_file.job_id is distinct from p_job_id");
    expect(record).toContain("message = 'export_content_hash_mismatch'");
    expect(draft).toMatch(
      /revoke all on function public\.api_record_export_control_clean_scan\([^)]*\)\s+from public, anon, authenticated;\s+grant execute on function public\.api_record_export_control_clean_scan\([^)]*\)\s+to service_role;/,
    );
  });

  it("matches the SQL foreign-provider list exactly to FOREIGN_JURISDICTION_PROVIDERS", () => {
    const fn = sqlFunctionBody("private.export_control_provider_jurisdiction");
    const foreignBranches = [...fn.matchAll(/when p_provider in \(([^)]*)\) then 'foreign'/g)];
    expect(foreignBranches).toHaveLength(1);
    const sqlForeign = [...foreignBranches[0][1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(sqlForeign.length).toBeGreaterThan(0);
    expect(new Set(sqlForeign).size).toBe(sqlForeign.length);
    expect([...sqlForeign].sort()).toEqual([...FOREIGN_JURISDICTION_PROVIDERS].sort());
    for (const provider of sqlForeign) expect(exportControlProviderJurisdiction(provider)).toBe("foreign");
    // Anything not listed is not 'us', so it gets the foreign rule.
    expect(fn).toMatch(/else 'unknown'/);
    expect(sqlFunctionBody("private.export_control_dispatch_denial")).toContain(
      "private.export_control_provider_jurisdiction(p_provider) is distinct from 'us'",
    );
  });

  it("checks foreign providers first, as a separate rule, and fails closed on lookup errors", () => {
    const gate = draft.slice(draft.indexOf("function private.export_control_dispatch_denial("));
    const body = gate.slice(0, gate.indexOf("$$;"));
    expect(body.indexOf("export_foreign_provider_requires_clean_declaration")).toBeLessThan(
      body.indexOf("'export_declaration_missing'", body.indexOf("export_foreign_provider_requires_clean_declaration")),
    );
    expect(body).toContain("is distinct from 'us'");
    expect(body).toMatch(/exception when others then\s+return 'export_control_lookup_failed'/);
  });

  it("keeps the SQL jurisdiction list in step with the worker", () => {
    const fn = draft.slice(draft.indexOf("function private.export_control_provider_jurisdiction"));
    const foreign = /when p_provider in \(([^)]*)\) then 'foreign'/.exec(fn)?.[1] ?? "";
    expect(new Set([...foreign.matchAll(/'([a-z]+)'/g)].map((m) => m[1]))).toEqual(new Set(FOREIGN_JURISDICTION_PROVIDERS));
    const us = /when p_provider in \(([\s\S]*?)\) then 'us'/.exec(fn.slice(fn.indexOf("then 'foreign'")))?.[1] ?? "";
    expect(us).toContain("'xometry'");
    for (const provider of [...us.matchAll(/'([a-z]+)'/g)].map((m) => m[1])) {
      expect(exportControlProviderJurisdiction(provider)).toBe("us");
    }
  });

  it("wraps both preflights in the contract and keeps them service-role only", () => {
    for (const fn of ["api_authorize_xometry_beta_worker_dispatch", "api_authorize_provider_worker_dispatch"]) {
      expect(contract).toContain(`create or replace function public.${fn}(`);
      expect(contract).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`));
    }
    expect(contract).toContain("private.export_control_dispatch_denial_for_task(p_work_queue_task_id, 'xometry')");
    // The core decides first, so its denials keep their codes; an export
    // denial after a core authorization rolls the core's writes back (OV723).
    for (const [fn, core] of [
      ["public.api_authorize_xometry_beta_worker_dispatch", "private.xometry_beta_worker_dispatch_core("],
      ["public.api_authorize_provider_worker_dispatch", "private.provider_worker_dispatch_core("],
    ]) {
      const body = sqlFunctionBody(fn, contract);
      expect(body).toContain("set search_path = pg_catalog");
      expect(body.indexOf(core)).toBeLessThan(body.indexOf("private.export_control_dispatch_denial_for_task("));
      expect(body).toContain("raise exception using errcode = 'OV723'");
      expect(body).toContain("exception when sqlstate 'OV723' then");
    }
  });

  it("bounds every storage.objects policy change with a lock timeout", () => {
    const window1 = sqlWindow1();
    const timeoutAt = window1.indexOf("set local lock_timeout = '3s';");
    expect(timeoutAt).toBeGreaterThan(-1);
    expect(timeoutAt).toBeLessThan(window1.indexOf('create policy "job_files_storage_insert_export_cleared"'));
    expect(contract.indexOf("set local lock_timeout = '3s';")).toBeGreaterThan(-1);
    expect(contract.indexOf("set local lock_timeout = '3s';")).toBeLessThan(
      contract.indexOf('drop policy "job_files_storage_insert" on storage.objects;'),
    );
  });

  it("records marking hits through a service-role-only RPC and audits admin review", () => {
    expect(draft).toMatch(
      /revoke all on function public\.api_record_export_control_marking_hits\([^)]*\)\s+from public, anon, authenticated;/,
    );
    expect(draft).toMatch(/if not public\.is_platform_admin\(\) then\s+raise exception using errcode = '42501', message = 'export_review_admin_required'/);
    expect(draft).toContain("'marking_block_cleared'");
  });

  it("adds a service-role extraction check that needs a clean, unblocked latest declaration", () => {
    const denial = sqlFunctionBody("private.export_control_extraction_denial");
    expect(denial).toContain("private.lock_job_export_state(p_job_id, false)");
    expect(denial).toContain("order by declaration.declared_at desc, declaration.id desc");
    expect(denial).toContain("return 'export_declaration_missing'");
    expect(denial).toContain("return 'export_declaration_not_clean'");
    expect(denial).toContain("return 'export_review_pending'");
    expect(denial).toMatch(/exception when others then\s+return 'export_control_lookup_failed'/);
    expect(sqlFunctionBody("public.api_check_export_control_extraction")).toContain(
      "private.export_control_extraction_denial(p_job_id)",
    );
    expect(sqlWindow1()).toMatch(
      /revoke all on function public\.api_check_export_control_extraction\(uuid\)\s+from public, anon, authenticated, service_role;\s+grant execute on function public\.api_check_export_control_extraction\(uuid\)\s+to service_role;/,
    );
    expect(expandRollback).toContain("drop function public.api_check_export_control_extraction(uuid);");
    expect(expandRollback).toContain("drop function private.export_control_extraction_denial(uuid);");
  });

  it("opens at most one open block per job, file, and source", () => {
    const record = sqlFunctionBody("public.api_record_export_control_marking_hits");
    const lookupAt = record.indexOf("block.job_file_id is not distinct from p_job_file_id");
    expect(lookupAt).toBeGreaterThan(record.indexOf("private.lock_job_export_state(v_job.id, true)"));
    expect(lookupAt).toBeLessThan(record.indexOf("insert into private.job_export_marking_blocks"));
    expect(record).toContain("block.state in ('blocked_pending_review', 'confirmed_controlled')");
  });

  it("does not duplicate backfill audit events when expand is reapplied after a rollback", () => {
    const backfill = sqlWindow1().slice(sqlWindow1().indexOf("-- 1.17 One-time backfill"));
    const audit = backfill.slice(backfill.indexOf("insert into private.export_control_events"));
    expect(audit.slice(0, audit.indexOf(";"))).toMatch(
      /not exists \(\s+select 1\s+from private\.export_control_events event_row\s+where event_row\.event = 'declaration_backfilled_missing'[\s\S]*event_row\.detail ->> 'declarationId' = declaration\.id::text/,
    );
  });

  it("stores no client IP: an unkeyed hash of an address is reversible", () => {
    expect(sqlCode(draft)).not.toContain("ip_hash");
    expect(sqlCode(draft)).not.toContain("x-forwarded-for");
  });

  it("classifies RapidDirect and Protolabs Network as foreign", () => {
    for (const provider of ["rapiddirect", "protolabsnetwork", "weerg", "geomiq"] as const) {
      expect(FOREIGN_JURISDICTION_PROVIDERS.has(provider)).toBe(true);
      expect(exportControlProviderJurisdiction(provider)).toBe("foreign");
      expect(evaluateExportControlDispatch({ provider, latestAnswer: "unsure", markingBlocked: false })).toBe(
        "export_foreign_provider_requires_clean_declaration",
      );
    }
  });
});

describe("OVD-723 review round 3: STEP header completeness", () => {
  const contentSha256 = "e".repeat(64);
  const base = { jobId: "job-1", partId: "part-1", jobFileId: "cad-1", localPath: "/stage/part.step", contentSha256 };

  it("reports a header as complete only when HEADER; and ENDSEC; are both inside the prefix", () => {
    expect(readStepHeader(STEP_CLEAN_HEADER_MARKED_DATA).complete).toBe(true);
    // A header padded past the scanned prefix: HEADER; found, ENDSEC; not.
    const padded = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('" + "x".repeat(STEP_HEADER_SCAN_BYTES) + "'),'2;1');\nENDSEC;\n";
    expect(readStepHeader(padded).complete).toBe(false);
    // A large file with no HEADER; in the prefix.
    expect(readStepHeader("ISO-10303-21;\n" + "y".repeat(STEP_HEADER_SCAN_BYTES * 2)).complete).toBe(false);
  });

  it("records no clean scan for a padded header, so dispatch stays denied", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "scan-1", error: null });
    const padded = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('" + "x".repeat(STEP_HEADER_SCAN_BYTES) + "'),'2;1');\nENDSEC;\n";
    await expect(
      enforceAndRecordStepHeaderScan({ rpc } as unknown as SupabaseClient, {
        ...base,
        readPrefix: async () => new TextEncoder().encode(padded).subarray(0, STEP_HEADER_SCAN_BYTES),
      }),
    ).resolves.toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("records no clean scan for a large file with no HEADER section", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ovd723-noheader-"));
    try {
      const stepPath = path.join(dir, "large.step");
      writeFileSync(stepPath, "ISO-10303-21;\n" + "y".repeat(STEP_HEADER_SCAN_BYTES * 2));
      const rpc = vi.fn().mockResolvedValue({ data: "scan-1", error: null });
      await expect(
        enforceAndRecordStepHeaderScan({ rpc } as unknown as SupabaseClient, { ...base, localPath: stepPath }),
      ).resolves.toBe(false);
      expect(rpc).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a clean scan for a complete clean header and still blocks a marked partial header", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "scan-1", error: null });
    await expect(
      enforceAndRecordStepHeaderScan({ rpc } as unknown as SupabaseClient, {
        ...base,
        readPrefix: async () => new TextEncoder().encode(STEP_CLEAN_HEADER_MARKED_DATA),
      }),
    ).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("api_record_export_control_clean_scan", expect.objectContaining({ p_source: "step_header" }));

    const hit = vi.fn().mockResolvedValue({ data: { blockId: "block-1", resolved: false }, error: null });
    const partial = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ITAR'),'2;1');" + "z".repeat(STEP_HEADER_SCAN_BYTES);
    await expect(
      enforceAndRecordStepHeaderScan({ rpc: hit } as unknown as SupabaseClient, {
        ...base,
        readPrefix: async () => new TextEncoder().encode(partial).subarray(0, STEP_HEADER_SCAN_BYTES),
      }),
    ).rejects.toBeInstanceOf(ExportControlMarkingBlockedError);
  });

  it("wires the quote task to record STEP scans only for a complete header", () => {
    expect(workerIndex).not.toMatch(/source: "step_header",[\s\S]{0,200}textRead: true/);
    expect(workerIndex).toContain("await enforceAndRecordStepHeaderScan(supabase, {");
  });
});

describe("OVD-723 review round 3: OCR text is recorded as drawing_ocr", () => {
  const contentSha256 = "f".repeat(64);

  it("uses drawing_ocr for the clean scan and the block of OCR text", async () => {
    expect(drawingTextScanSource({ ocr: true })).toBe("drawing_ocr");
    expect(drawingTextScanSource({})).toBe("drawing_text");
    expect(drawingTextScanSource(null)).toBe("drawing_text");
    expect(scanDrawingTextForExportMarkings({ pages: [{ text: MARKING_FIXTURES.cui }], ocr: true })?.source).toBe("drawing_ocr");

    const rpc = vi.fn().mockResolvedValue({ data: "scan-1", error: null });
    await scanStagedDrawingForExportMarkings({ rpc } as unknown as SupabaseClient, {
      jobId: "job-1",
      partId: "part-1",
      drawingFile: { id: "drawing-1", localPath: "/stage/d.pdf", contentSha256 },
      extractText: vi.fn().mockResolvedValue({ pageCount: 1, pages: [{ text: CLEAN_DRAWING }], ocr: true }),
    });
    expect(rpc).toHaveBeenCalledWith("api_record_export_control_clean_scan", expect.objectContaining({ p_source: "drawing_ocr" }));
  });

  it("wires extraction to the OCR aware source", () => {
    const run = workerIndex.slice(workerIndex.indexOf("async function runDrawingExtractionForTask("));
    const body = run.slice(0, run.indexOf("\nasync function handleExtractTask("));
    expect(body).toContain("source: drawingTextScanSource(pdfText),");
    expect(body).not.toContain('source: "drawing_text",');
  });
});

describe("OVD-723 review round 3: admin cleared false positives", () => {
  const input = { jobId: "job-1", partId: "part-1", jobFileId: "file-1", contentSha256: "a".repeat(64) };

  it("continues without a block when the database resolves the hit to an admin cleared block", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { blockId: "block-1", resolved: true }, error: null });
    const scan = scanDrawingTextForExportMarkings({ pages: [{ text: MARKING_FIXTURES.itarStamp }] });
    await expect(enforceExportControlMarkings({ rpc } as unknown as SupabaseClient, { ...input, scan })).resolves.toBe(
      "admin_cleared",
    );
    expect(rpc).toHaveBeenCalledWith(
      "api_record_export_control_marking_hits",
      expect.objectContaining({ p_job_file_id: "file-1", p_content_sha256: "a".repeat(64) }),
    );

    // The scan of record comes from the clearance; the worker records no "clean" scan for text that matched.
    const recorder = vi.fn().mockResolvedValue({ data: { blockId: "block-1", resolved: true }, error: null });
    await enforceAndRecordExportControlScan({ rpc: recorder } as unknown as SupabaseClient, {
      ...input,
      source: "drawing_text",
      scan,
      textRead: true,
    });
    expect(recorder.mock.calls.map(([name]) => name)).toEqual(["api_record_export_control_marking_hits"]);
  });

  it("still blocks when the database opens or keeps a block (a new hash or a new pattern)", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { blockId: "block-2", resolved: false }, error: null });
    const scan = scanDrawingTextForExportMarkings({ pages: [{ text: MARKING_FIXTURES.cui }] });
    await expect(enforceExportControlMarkings({ rpc } as unknown as SupabaseClient, { ...input, scan })).rejects.toBeInstanceOf(
      ExportControlMarkingBlockedError,
    );
  });
});

describe("OVD-723 review round 3: scan only rescan of files extracted before the deploy", () => {
  const sha = "9".repeat(64);
  const stage = vi.fn(async () => ({ localPath: "/stage/f", trustedContentSha256: sha }));

  it("records a clean drawing scan without any model call", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "scan-1", error: null });
    await expect(
      runExportMarkingRescan({ rpc } as unknown as SupabaseClient, {
        jobId: "job-1",
        partId: "part-1",
        file: { id: "drawing-1", original_name: "bracket.pdf", file_kind: "drawing" },
        stage,
        extractText: vi.fn().mockResolvedValue({ pageCount: 1, pages: [{ text: CLEAN_DRAWING }] }),
      }),
    ).resolves.toBe("clean");
    expect(rpc).toHaveBeenCalledWith("api_record_export_control_clean_scan", {
      p_job_id: "job-1",
      p_part_id: "part-1",
      p_job_file_id: "drawing-1",
      p_source: "drawing_text",
      p_content_sha256: sha,
    });
  });

  it("opens a block on a hit, leaves an unread drawing without a scan, and scans STEP headers", async () => {
    const hit = vi.fn().mockResolvedValue({ data: { blockId: "block-1", resolved: false }, error: null });
    await expect(
      runExportMarkingRescan({ rpc: hit } as unknown as SupabaseClient, {
        jobId: "job-1",
        partId: "part-1",
        file: { id: "drawing-1", original_name: "bracket.pdf", file_kind: "drawing" },
        stage,
        extractText: vi.fn().mockResolvedValue({ pageCount: 1, pages: [{ text: MARKING_FIXTURES.itarStamp }] }),
      }),
    ).resolves.toBe("blocked");
    expect(hit.mock.calls.map(([name]) => name)).toEqual(["api_record_export_control_marking_hits"]);

    const unread = vi.fn();
    await expect(
      runExportMarkingRescan({ rpc: unread } as unknown as SupabaseClient, {
        jobId: "job-1",
        partId: "part-1",
        file: { id: "drawing-1", original_name: "scan.pdf", file_kind: "drawing" },
        stage,
        extractText: vi.fn().mockResolvedValue({ pageCount: 2, pages: [{ text: CLEAN_DRAWING }, { text: "" }] }),
      }),
    ).resolves.toBe("drawing_unread");
    expect(unread).not.toHaveBeenCalled();

    const step = vi.fn().mockResolvedValue({ data: "scan-2", error: null });
    await expect(
      runExportMarkingRescan({ rpc: step } as unknown as SupabaseClient, {
        jobId: "job-1",
        partId: "part-1",
        file: { id: "cad-1", original_name: "bracket.STEP", file_kind: "cad" },
        stage,
        extractText: vi.fn(),
        readStepPrefix: async () => new TextEncoder().encode(STEP_CLEAN_HEADER_MARKED_DATA),
      }),
    ).resolves.toBe("clean");
    expect(step).toHaveBeenCalledWith("api_record_export_control_clean_scan", expect.objectContaining({ p_source: "step_header" }));

    const other = vi.fn();
    await expect(
      runExportMarkingRescan({ rpc: other } as unknown as SupabaseClient, {
        jobId: "job-1",
        partId: "part-1",
        file: { id: "cad-2", original_name: "bracket.sldprt", file_kind: "cad" },
        stage,
        extractText: vi.fn(),
      }),
    ).resolves.toBe("not_scannable");
    expect(other).not.toHaveBeenCalled();
  });

  it("is a worker task that never reaches model code", () => {
    // The task handler is wired, and neither it nor the scanner module imports any model path.
    expect(workerIndex).toContain('case "export_marking_rescan":');
    const handler = workerIndex.slice(workerIndex.indexOf("export async function handleExportMarkingRescanTask("));
    const body = handler.slice(0, handler.indexOf("\nasync function fetchQuoteRequestStatusForTask("));
    expect(body).toContain("runExportMarkingRescan(");
    for (const modelPath of ["runHybridExtraction", "extractDrawingFieldsWithModel", "callModel", "createProvider", "runPreviewModelAttempts"]) {
      expect(body).not.toContain(modelPath);
    }
    const scanner = readFileSync(new URL("./exportControl.ts", import.meta.url), "utf8");
    expect(scanner.match(/^import .*$/gm)).toEqual([
      'import { open } from "node:fs/promises";',
      'import type { SupabaseClient } from "@supabase/supabase-js";',
      'import type { VendorName } from "./types.js";',
    ]);
  });
});

describe("OVD-723 review round 3: point in time checks", () => {
  it("asks the dispatch gate again after authorization and right before adapter.quote", async () => {
    const order: string[] = [];
    const rpc = vi.fn(async () => {
      order.push("check");
      return { data: { allowed: true }, error: null };
    });
    const adapter = { quote: vi.fn(async () => { order.push("quote"); return {} as never; }) };
    const wrapped = withExportControlDispatchRecheck(adapter, { rpc } as unknown as SupabaseClient, { taskId: "t", vendor: "fictiv" });
    await wrapped.quote({} as VendorQuoteAdapterInput);
    expect(order).toEqual(["check", "quote"]);

    const deny = vi.fn(async () => ({ data: { allowed: false, reasonCode: "export_review_pending" }, error: null }));
    const blocked = { quote: vi.fn() };
    await expect(
      withExportControlDispatchRecheck(blocked, { rpc: deny } as unknown as SupabaseClient, { taskId: "t", vendor: "fictiv" })
        .quote({} as VendorQuoteAdapterInput),
    ).rejects.toBeInstanceOf(ProviderDispatchAuthorizationError);
    expect(blocked.quote).not.toHaveBeenCalled();
  });

  it("wires the per attempt extraction guard and the pre send dispatch recheck", () => {
    expect(workerIndex).toContain("beforeModelAttempt: exportControlModelAttemptGuard(supabase, { jobId: task.job_id }),");
    expect(workerIndex).toContain("adapter: withExportControlDispatchRecheck(adapter, supabase, {");
    const lab = readFileSync(new URL("./extraction/debugLab.ts", import.meta.url), "utf8");
    expect(lab).toContain("beforeModelAttempt: exportControlModelAttemptGuard(supabase, { jobId: context.part.job_id }),");
  });

  // Review round 4: the full spend estimate is booked only for a lane whose
  // recheck passed, and Xometry and Fictiv ask the gate again before upload.
  it("counts vendor automation as started only after the recheck passes", async () => {
    const onAllowed = vi.fn();
    const deny = vi.fn(async () => ({ data: { allowed: false, reasonCode: "export_review_pending" }, error: null }));
    await expect(
      withExportControlDispatchRecheck({ quote: vi.fn() }, { rpc: deny } as unknown as SupabaseClient, { taskId: "t", vendor: "fictiv", onAllowed })
        .quote({} as VendorQuoteAdapterInput),
    ).rejects.toBeInstanceOf(ProviderDispatchAuthorizationError);
    expect(onAllowed).not.toHaveBeenCalled();

    const allow = vi.fn(async () => ({ data: { allowed: true }, error: null }));
    const seen: Array<VendorQuoteAdapterInput["beforeProviderDisclosure"]> = [];
    const quoteInput = {} as VendorQuoteAdapterInput;
    await withExportControlDispatchRecheck(
      { quote: vi.fn(async (received: VendorQuoteAdapterInput) => { seen.push(received.beforeProviderDisclosure); expect(received).toBe(quoteInput); return {} as never; }) },
      { rpc: allow } as unknown as SupabaseClient,
      { taskId: "t", vendor: "fictiv", onAllowed },
    ).quote(quoteInput);
    expect(onAllowed).toHaveBeenCalledTimes(1);
    expect(typeof seen[0]).toBe("function");
    expect(quoteInput.beforeProviderDisclosure).toBeUndefined();
    expect(workerIndex).not.toContain("onAuthorized: () => {\n        vendorAutomationStarted = true;");
  });

  it("asks the gate again right before the Xometry and Fictiv uploads", () => {
    const xometry = readFileSync(new URL("./adapters/xometry.ts", import.meta.url), "utf8");
    const target = xometry.slice(xometry.indexOf("async function setFilesOnApprovedUploadTarget("));
    expect(target.indexOf("await beforeProviderDisclosure?.();")).toBeGreaterThan(-1);
    expect(target.indexOf("await beforeProviderDisclosure?.();")).toBeLessThan(target.indexOf("markProviderMutationStarted();"));
    expect(xometry).toContain("input.beforeProviderDisclosure,\n      );\n      uploadSelector = uploadResult.selector;");
    expect(xometry).toContain("await input.beforeProviderDisclosure?.();\n        const drawingFallbackResult = await attachDrawingFallback(");
    expect(xometry).toContain("if (dispatchDecisionError) throw dispatchDecisionError;");
    const fictiv = readFileSync(new URL("./adapters/fictiv.ts", import.meta.url), "utf8");
    const upload = fictiv.slice(fictiv.indexOf("async function setFilesOnUpload("));
    expect(upload.indexOf("await beforeProviderDisclosure?.();")).toBeLessThan(upload.indexOf("markProviderMutationStarted();"));
    expect(fictiv).toContain("await setFilesOnUpload(page, uploadFiles, input.beforeProviderDisclosure);");
    expect(fictiv).toContain("if (isDispatchDecisionError(error)) {\n        throw error;");
  });

  it("runs the export gate before the manual and spend cap routes of a quote task", () => {
    const quote = workerIndex.slice(workerIndex.indexOf("export async function handleVendorQuoteTask("));
    const gate = quote.indexOf("await assertExportControlDispatchAllowed(supabase, { taskId: task.id, vendor });");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(quote.indexOf("if (!adapter) {"));
    expect(gate).toBeLessThan(quote.indexOf('vendorSpendGuard.reserve("vendor_automation"'));
  });
});
