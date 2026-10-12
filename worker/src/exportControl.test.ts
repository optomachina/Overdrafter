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
  ExportControlMarkingRecordError,
  ExportControlScanRecordError,
  exportControlProviderJurisdiction,
  FOREIGN_JURISDICTION_PROVIDERS,
  isStepFileName,
  readStagedStepHeaderPrefix,
  readStepHeaderText,
  ExportControlRescanIncompleteError,
  rescanPartForExportMarkings,
  scanDrawingTextForExportMarkings,
  scanStagedDrawingForExportMarkings,
  STEP_HEADER_SCAN_BYTES,
  scanStepHeaderForExportMarkings,
} from "./exportControl";
import { PROVIDER_DISPATCH_DENIAL_CODES, isRetryableProviderDispatchDenial } from "./providerDispatchEnvelope";
import { ProviderDispatchAuthorizationError, quoteWithProviderDispatchPreflight } from "./providerDispatchPreflight";
import { quoteWithDispatchPreflight, XometryDispatchAuthorizationError } from "./xometryDispatchPreflight";
import type { VendorName, VendorQuoteAdapterInput } from "./types";

const draft = readFileSync(new URL("../../docs/migration-drafts/ovd-723.sql", import.meta.url), "utf8");
const workerIndex = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

function sqlFunctionBody(name: string): string {
  const start = draft.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = draft.slice(start);
  return rest.slice(0, rest.indexOf("$$;"));
}

function sqlPhase(phase: "1" | "2"): string {
  const start = draft.indexOf(`-- PHASE ${phase} - `);
  const end = phase === "1" ? draft.indexOf("-- PHASE 2 - ") : draft.indexOf("-- ROLLBACK\n");
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
    const rpc = vi.fn().mockResolvedValue({ data: "block-1", error: null });
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
    });
  });

  it("fails closed when the block cannot be recorded", async () => {
    const scan = scanStepHeaderForExportMarkings(STEP_WITH_ITAR);
    for (const rpc of [
      vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202", message: "missing" } }),
      vi.fn().mockRejectedValue(new Error("network")),
      vi.fn().mockResolvedValue({ data: null, error: null }),
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
    ).resolves.toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("clean scans of record (reused files and skipped extraction)", () => {
  const input = { jobId: "job-1", partId: "part-1", jobFileId: "file-1" };

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
    });
  });

  it("records a block and never a clean scan on a hit", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "block-1", error: null });
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
    const rpc = vi.fn().mockResolvedValue({ data: "block-1", error: null });
    const extractText = vi.fn().mockResolvedValue({ pages: [{ text: MARKING_FIXTURES.cui }] });
    await expect(
      scanStagedDrawingForExportMarkings({ rpc } as unknown as SupabaseClient, {
        jobId: "target-job",
        partId: "target-part",
        drawingFile: { id: "target-drawing", localPath: "/stage/drawing.pdf" },
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
      drawingFile: { id: "target-drawing", localPath: "/stage/drawing.pdf" },
      extractText: vi.fn().mockResolvedValue({ pages: [{ text: CLEAN_DRAWING }] }),
    });
    expect(rpc).toHaveBeenCalledWith("api_record_export_control_clean_scan", {
      p_job_id: "target-job",
      p_part_id: "target-part",
      p_job_file_id: "target-drawing",
      p_source: "drawing_text",
    });

    const failing = vi.fn();
    await expect(
      scanStagedDrawingForExportMarkings({ rpc: failing } as unknown as SupabaseClient, {
        jobId: "target-job",
        partId: "target-part",
        drawingFile: { id: "target-drawing", localPath: "/stage/drawing.pdf" },
        extractText: vi.fn().mockRejectedValue(new Error("pdftotext failed")),
      }),
    ).rejects.toThrow("pdftotext failed");
    expect(failing).not.toHaveBeenCalled();
  });

  it("requires a clean scan for the drawing and STEP CAD file before dispatch (reference model)", () => {
    expect(evaluateExportControlScanCoverage(null)).toBe("export_scan_missing");
    expect(evaluateExportControlScanCoverage({ drawing: null, cad: null })).toBeNull();
    expect(evaluateExportControlScanCoverage({ drawing: { scanned: false }, cad: null })).toBe("export_scan_missing");
    expect(
      evaluateExportControlScanCoverage({ drawing: { scanned: true }, cad: { originalName: "part.STEP", scanned: false } }),
    ).toBe("export_scan_missing");
    expect(
      evaluateExportControlScanCoverage({ drawing: { scanned: true }, cad: { originalName: "part.stp", scanned: true } }),
    ).toBeNull();
    // No scanner exists for other CAD formats yet; documented in the notes.
    expect(
      evaluateExportControlScanCoverage({ drawing: { scanned: true }, cad: { originalName: "part.sldprt", scanned: false } }),
    ).toBeNull();
  });

  it("wires the scan into the trusted-reuse branch before the task completes", () => {
    const reuse = workerIndex.slice(workerIndex.indexOf('"api_reuse_trusted_part_version_artifacts"'));
    const scanAt = reuse.indexOf("scanStagedDrawingForExportMarkings(");
    expect(scanAt).toBeGreaterThan(-1);
    expect(scanAt).toBeLessThan(reuse.indexOf("reusedCanonicalPartVersion: true"));
    expect(workerIndex).toMatch(/source: "step_header",\s+scan: scanStepHeaderForExportMarkings/);
    expect(workerIndex).toMatch(/source: "drawing_text",\s+scan: scanDrawingTextForExportMarkings\(pdfText\)/);
  });
});

describe("existing-part rescan (export_rescan_part)", () => {
  const encoder = new TextEncoder();
  const base = {
    jobId: "old-job",
    partId: "old-part",
    drawingFileId: "old-drawing",
    cadFileId: "old-cad",
    drawingFile: { id: "old-drawing", localPath: "/stage/drawing.pdf" },
    cadFile: { id: "old-cad", originalName: "bracket.STEP", localPath: "/stage/bracket.step" },
  };

  it("records fresh clean drawing and STEP header scans for the part's own files", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "scan-1", error: null });
    const result = await rescanPartForExportMarkings({ rpc } as unknown as SupabaseClient, {
      ...base,
      extractText: vi.fn().mockResolvedValue({ pages: [{ text: CLEAN_DRAWING }] }),
      readStepHeader: vi.fn().mockResolvedValue(encoder.encode(STEP_CLEAN_HEADER_MARKED_DATA)),
    });
    expect(result).toEqual({ drawing: "clean", cad: "clean" });
    expect(rpc.mock.calls).toEqual([
      [
        "api_record_export_control_clean_scan",
        { p_job_id: "old-job", p_part_id: "old-part", p_job_file_id: "old-cad", p_source: "step_header" },
      ],
      [
        "api_record_export_control_clean_scan",
        { p_job_id: "old-job", p_part_id: "old-part", p_job_file_id: "old-drawing", p_source: "drawing_text" },
      ],
    ]);
  });

  it("opens a block on a marked drawing and records no clean drawing scan", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "id-1", error: null });
    await expect(
      rescanPartForExportMarkings({ rpc } as unknown as SupabaseClient, {
        ...base,
        extractText: vi.fn().mockResolvedValue({ pages: [{ text: MARKING_FIXTURES.itarStamp }] }),
        readStepHeader: vi.fn().mockResolvedValue(encoder.encode(STEP_CLEAN_HEADER_MARKED_DATA)),
      }),
    ).rejects.toBeInstanceOf(ExportControlMarkingBlockedError);
    expect(rpc).toHaveBeenLastCalledWith(
      "api_record_export_control_marking_hits",
      expect.objectContaining({ p_job_id: "old-job", p_job_file_id: "old-drawing", p_source: "drawing_text" }),
    );
    expect(rpc).not.toHaveBeenCalledWith(
      "api_record_export_control_clean_scan",
      expect.objectContaining({ p_job_file_id: "old-drawing" }),
    );
  });

  it("opens a block on a marked STEP header before reading the drawing", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "block-1", error: null });
    const extractText = vi.fn();
    await expect(
      rescanPartForExportMarkings({ rpc } as unknown as SupabaseClient, {
        ...base,
        extractText,
        readStepHeader: vi.fn().mockResolvedValue(encoder.encode(STEP_WITH_ITAR)),
      }),
    ).rejects.toBeInstanceOf(ExportControlMarkingBlockedError);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["api_record_export_control_marking_hits"]);
    expect(extractText).not.toHaveBeenCalled();
  });

  it("fails closed when the drawing text can't be read", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "scan-1", error: null });
    await expect(
      rescanPartForExportMarkings({ rpc } as unknown as SupabaseClient, {
        ...base,
        cadFile: null,
        cadFileId: null,
        extractText: vi.fn().mockResolvedValue(null),
      }),
    ).rejects.toBeInstanceOf(ExportControlRescanIncompleteError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed when a referenced file is missing and records nothing", async () => {
    const rpc = vi.fn();
    for (const missing of [{ drawingFile: null }, { cadFile: null }, { drawingFile: { id: "other", localPath: "/x" } }]) {
      await expect(
        rescanPartForExportMarkings({ rpc } as unknown as SupabaseClient, {
          ...base,
          ...missing,
          extractText: vi.fn().mockResolvedValue({ pages: [{ text: CLEAN_DRAWING }] }),
          readStepHeader: vi.fn().mockResolvedValue(encoder.encode(STEP_CLEAN_HEADER_MARKED_DATA)),
        }),
      ).rejects.toBeInstanceOf(ExportControlRescanIncompleteError);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed when a clean scan can't be recorded", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(
      rescanPartForExportMarkings({ rpc } as unknown as SupabaseClient, {
        ...base,
        extractText: vi.fn().mockResolvedValue({ pages: [{ text: CLEAN_DRAWING }] }),
        readStepHeader: vi.fn().mockResolvedValue(encoder.encode(STEP_CLEAN_HEADER_MARKED_DATA)),
      }),
    ).rejects.toBeInstanceOf(ExportControlScanRecordError);
  });

  it("leaves CAD formats without a scanner unrecorded (unchanged policy)", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "scan-1", error: null });
    const readStepHeader = vi.fn();
    const result = await rescanPartForExportMarkings({ rpc } as unknown as SupabaseClient, {
      ...base,
      cadFile: { id: "old-cad", originalName: "bracket.sldprt", localPath: "/stage/bracket.sldprt" },
      extractText: vi.fn().mockResolvedValue({ pages: [{ text: CLEAN_DRAWING }] }),
      readStepHeader,
    });
    expect(result).toEqual({ drawing: "clean", cad: "no_scanner" });
    expect(readStepHeader).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("is dispatched by the worker task switch", () => {
    expect(workerIndex).toMatch(/case "export_rescan_part":\s+await handleExportRescanTask\(/);
    const handler = workerIndex.slice(workerIndex.indexOf("async function handleExportRescanTask("));
    expect(handler.slice(0, handler.indexOf("\n}\n"))).toContain("rescanPartForExportMarkings(");
    expect(handler.slice(0, handler.indexOf("\n}\n"))).not.toContain("runDrawingExtractionForTask");
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

describe("OVD-723 migration draft", () => {
  it("is a draft, not an applied migration", () => {
    expect(draft.startsWith("-- =")).toBe(true);
    expect(draft).toContain("NEEDS BLAINE MIGRATION WINDOW - not applied");
    expect(draft).toMatch(/PHASE 1 - EXPAND[\s\S]*PHASE 2 - CONTRACT[\s\S]*ROLLBACK/);
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
      sqlFunctionBody("private.export_control_dispatch_denial_for_task"),
    ].join("\n");
    const returned = [...gate.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]);
    expect(new Set(returned)).toEqual(new Set(EXPORT_CONTROL_DENIAL_CODES));
  });

  it("puts both dispatch preflight wrappers in PHASE 1 and keeps PHASE 2 upload-only", () => {
    const phase1 = sqlPhase("1");
    const phase2 = sqlPhase("2");
    for (const fn of ["api_authorize_xometry_beta_worker_dispatch", "api_authorize_provider_worker_dispatch"]) {
      expect(phase1).toContain(`create or replace function public.${fn}(`);
      expect(phase2).not.toContain(fn);
    }
    expect(phase1).toContain("create or replace function private.export_control_dispatch_denial(");
    expect(phase1).toContain("create or replace function private.export_control_scan_denial(");
    const phase2Code = phase2.replace(/--[^\n]*/g, "");
    expect(phase2Code).not.toMatch(/dispatch/i);
    expect(phase2).toContain("create policy \"job_files_storage_insert\"");
    expect(phase2).toContain("create or replace function public.api_prepare_job_file_upload(");
    // The rollback undoes the wrappers with PHASE 1, not PHASE 2.
    const rollback = draft.slice(draft.indexOf("-- ROLLBACK\n"));
    const r1 = rollback.slice(rollback.indexOf("-- R1 (undo PHASE 1"));
    const r2 = rollback.slice(rollback.indexOf("-- R2 (undo PHASE 2"), rollback.indexOf("-- R1 (undo PHASE 1"));
    expect(r2).not.toContain("drop function public.api_authorize");
    expect(r1).toContain("drop function public.api_authorize_provider_worker_dispatch(");
    expect(r1).toContain("drop function public.api_authorize_xometry_beta_worker_dispatch(");
    expect(r1).toContain("drop function public.api_record_export_control_clean_scan(");
  });

  it("requires a per-job clean scan of the dispatched part's files", () => {
    const forTask = sqlFunctionBody("private.export_control_dispatch_denial_for_task");
    expect(forTask).toContain("task_row.part_id");
    expect(forTask).toContain("return private.export_control_scan_denial(v_part_id);");
    const scanRule = sqlFunctionBody("private.export_control_scan_denial");
    // Keyed on the part's own job_file ids: a scan of the same bytes in another
    // job (blob reuse, trusted artifact reuse) never counts.
    expect(scanRule).toContain("scan.job_file_id = v_part.drawing_file_id");
    expect(scanRule).toContain("scan.job_file_id = v_cad.id");
    expect(scanRule).not.toContain("content_sha256");
    const sqlStep = /~ '([^']+)'/.exec(scanRule)?.[1];
    expect(sqlStep).toBe("\\.(step|stp)$");
    for (const name of ["a.step", "a.STP", " b.Step "]) expect(isStepFileName(name)).toBe(true);
    const record = sqlFunctionBody("public.api_record_export_control_clean_scan");
    expect(record).toContain("v_file.job_id is distinct from p_job_id");
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

  it("wraps both preflights and keeps them service-role only", () => {
    for (const fn of ["api_authorize_xometry_beta_worker_dispatch", "api_authorize_provider_worker_dispatch"]) {
      expect(draft).toContain(`create or replace function public.${fn}(`);
      expect(draft).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`));
    }
    expect(draft).toContain("private.export_control_dispatch_denial_for_task(p_work_queue_task_id, 'xometry')");
  });

  it("adds an existing-job rescan RPC in PHASE 1 and documents why api_request_extraction can't rescan", () => {
    const phase1 = sqlPhase("1");
    expect(phase1).toContain("alter type public.queue_task_type add value if not exists 'export_rescan_part';");
    expect(phase1).toContain("create or replace function public.api_request_export_control_rescan(p_job_id uuid)");
    expect(phase1).toContain("api_request_extraction (20260812042000) only queues extract_part");
    const rescan = sqlFunctionBody("public.api_request_export_control_rescan");
    expect(rescan).toContain("perform public.require_verified_auth();");
    expect(rescan).toMatch(/user_can_edit_job\(v_job\.id\)[\s\S]*elsif public\.is_platform_admin\(\)/);
    expect(rescan).toContain("'rescan_requested'");
    expect(rescan).not.toContain("drawing_extractions");
    expect(draft).toMatch(
      /revoke all on function public\.api_request_export_control_rescan\(uuid\) from public, anon;\s+grant execute on function public\.api_request_export_control_rescan\(uuid\) to authenticated;/,
    );
    const status = sqlFunctionBody("public.api_get_job_export_control_status");
    expect(status).toContain("'partsMissingScan'");
    expect(status).toContain("private.export_control_scan_denial(part.id)");
  });

  it("writes the PHASE 1 rollback grants as statements, not placeholders", () => {
    const rollback = draft.slice(draft.indexOf("-- ROLLBACK\n"));
    const r1 = rollback.slice(rollback.indexOf("-- R1 (undo PHASE 1"));
    expect(r1).not.toMatch(/restate/i);
    for (const fn of ["api_authorize_provider_worker_dispatch", "api_authorize_xometry_beta_worker_dispatch"]) {
      expect(r1).toMatch(
        new RegExp(`revoke all on function public\\.${fn}\\([\\s\\S]*?\\) from public, anon, authenticated, service_role;`),
      );
      expect(r1).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([\\s\\S]*?\\) to service_role;`));
    }
    for (const fn of ["api_prepare_job_file_upload", "api_finalize_job_file_upload"]) {
      expect(r1).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([\\s\\S]*?\\) from public, anon;`));
      expect(r1).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([\\s\\S]*?\\) to authenticated;`));
    }
    expect(r1).toContain("drop function public.api_request_export_control_rescan(uuid);");
  });

  it("records marking hits through a service-role-only RPC and audits admin review", () => {
    expect(draft).toMatch(
      /revoke all on function public\.api_record_export_control_marking_hits\([^)]*\)\s+from public, anon, authenticated;/,
    );
    expect(draft).toMatch(/if not public\.is_platform_admin\(\) then\s+raise exception using errcode = '42501', message = 'export_review_admin_required'/);
    expect(draft).toContain("'marking_block_cleared'");
  });
});
