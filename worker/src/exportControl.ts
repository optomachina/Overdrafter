import { open } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VendorName } from "./types.js";

/**
 * OVD-723 export-control gate, worker side.
 *
 * The database is authoritative (`docs/migration-drafts/ovd-723.sql`): it
 * stores declarations and marking blocks and denies dispatch in the provider
 * preflights. This module holds the worker's part of that contract:
 *
 * - marking detection over extracted drawing text (text and OCR layers) and
 *   STEP header strings, recorded through the service-role RPC
 *   `api_record_export_control_marking_hits`. A failed record is an error, so
 *   the task fails instead of continuing without a block;
 * - clean scans, recorded through `api_record_export_control_clean_scan`.
 *   Dispatch requires a clean scan of record for the part's own files, so a
 *   path that skips extraction (trusted artifact reuse, org blob reuse) is
 *   denied until the worker scans that part's files;
 * - the reason codes the preflights return, and a pure reference model of the
 *   dispatch rule that the SQL implements, used by tests to pin the rule.
 */

export const EXPORT_CONTROL_DENIAL_CODES = [
  "export_declaration_missing",
  "export_declaration_not_clean",
  "export_review_pending",
  "export_foreign_provider_requires_clean_declaration",
  "export_control_lookup_failed",
  "export_scan_missing",
] as const;

export type ExportControlDenialCode = (typeof EXPORT_CONTROL_DENIAL_CODES)[number];

export type ExportDeclarationAnswer = "not_controlled" | "controlled" | "unsure" | "missing";

/** Providers outside US jurisdiction. Unknown providers get the same rule. */
export const FOREIGN_JURISDICTION_PROVIDERS: ReadonlySet<VendorName> = new Set<VendorName>(["weerg", "geomiq"]);

const US_JURISDICTION_PROVIDERS: ReadonlySet<string> = new Set<VendorName>([
  "xometry",
  "fictiv",
  "protolabs",
  "sendcutsend",
  "oshcut",
  "fabworks",
  "ponoko",
  "quickparts",
  "rapiddirect",
  "protolabsnetwork",
  "partsbadger",
  "fastdms",
  "devzmanufacturing",
  "infraredlaboratories",
  "emachineshop",
  "rmfg",
]);

export function exportControlProviderJurisdiction(provider: string): "us" | "foreign" | "unknown" {
  if ((FOREIGN_JURISDICTION_PROVIDERS as ReadonlySet<string>).has(provider)) return "foreign";
  if (US_JURISDICTION_PROVIDERS.has(provider)) return "us";
  return "unknown";
}

export type ExportControlDispatchEvidence =
  | { lookupFailed: true }
  | {
      lookupFailed?: false;
      provider: string;
      /** Latest declaration answer for the job, or null when none exists. */
      latestAnswer: ExportDeclarationAnswer | null;
      /** True when any marking block is pending review or confirmed controlled. */
      markingBlocked: boolean;
    };

/**
 * Reference model of `private.export_control_dispatch_denial`. Returns null
 * only for a clean latest declaration with no open marking block. The foreign
 * provider rule is a separate explicit check, evaluated first, so a later
 * change to the general rule cannot loosen it.
 */
export function evaluateExportControlDispatch(evidence: ExportControlDispatchEvidence): ExportControlDenialCode | null {
  if (evidence.lookupFailed === true || !("provider" in evidence) || typeof evidence.provider !== "string") {
    return "export_control_lookup_failed";
  }

  if (exportControlProviderJurisdiction(evidence.provider) !== "us") {
    if (evidence.latestAnswer !== "not_controlled" || evidence.markingBlocked !== false) {
      return "export_foreign_provider_requires_clean_declaration";
    }
  }

  if (evidence.latestAnswer === null || evidence.latestAnswer === "missing") return "export_declaration_missing";
  if (evidence.latestAnswer !== "not_controlled") return "export_declaration_not_clean";
  if (evidence.markingBlocked !== false) return "export_review_pending";
  return null;
}

export type ExportControlScanCoverage = {
  /** Null when the part has no drawing. */
  drawing: { scanned: boolean } | null;
  /** Null when the part has no CAD file. */
  cad: { originalName: string; scanned: boolean } | null;
} | null;

/**
 * Reference model of `private.export_control_scan_denial`. The part's drawing
 * and its STEP CAD file each need a clean scan of record in this job. A
 * missing part is a denial. Other CAD formats have no scanner yet.
 */
export function evaluateExportControlScanCoverage(part: ExportControlScanCoverage): "export_scan_missing" | null {
  if (!part) return "export_scan_missing";
  if (part.drawing && part.drawing.scanned !== true) return "export_scan_missing";
  if (part.cad && isStepFileName(part.cad.originalName) && part.cad.scanned !== true) return "export_scan_missing";
  return null;
}

export type ExportControlMarkingPattern = {
  id: string;
  pattern: RegExp;
};

/**
 * Conservative, case-insensitive marking patterns. False positives go to the
 * admin review queue; nothing here clears a block automatically.
 */
export const EXPORT_CONTROL_MARKING_PATTERNS: readonly ExportControlMarkingPattern[] = Object.freeze([
  { id: "itar", pattern: /\bITAR\b/i },
  // Bare "EAR" only next to export language, so "EAR" in "LINEAR"/"GEAR"
  // never matches and a lone word "ear" in notes does not either.
  {
    id: "ear",
    pattern: /\bEAR\b[^\n]{0,40}\b(export|controlled|regulations?|99|license)\b|\b(export|controlled|subject to)\b[^\n]{0,40}\bEAR\b/i,
  },
  { id: "export_controlled", pattern: /\bexport[\s-]+controlled\b/i },
  { id: "eccn", pattern: /\bECCN\b/i },
  { id: "eccn_shape", pattern: /\b[0-9][A-E][0-9]{3}\b/i },
  { id: "usml", pattern: /\bUSML\b/i },
  { id: "usml_category", pattern: /\bCategory\s+[IVX]+\b/i },
  { id: "cfr_22_itar", pattern: /\b22\s*C\.?F\.?R\.?\s*(?:§|part|parts)?\s*12[0-9]\b/i },
  { id: "cfr_15_ear", pattern: /\b15\s*C\.?F\.?R\.?\s*(?:§|part|parts)?\s*7[3-7][0-9]?\b/i },
  { id: "cui", pattern: /\bCUI\b/i },
  { id: "technical_data", pattern: /\btechnical\s+data\b/i },
  { id: "distribution_statement", pattern: /\bdistribution\s+statement\s+[B-F]\b/i },
]);

export type ExportControlMarkingSource = "drawing_text" | "drawing_ocr" | "step_header";

/** Returns the ids of every pattern that matches, in pattern order. */
export function detectExportControlMarkings(text: string | null | undefined): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  return EXPORT_CONTROL_MARKING_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ id }) => id);
}

/** Largest STEP prefix read for the header; headers are a few KB at most. */
export const STEP_HEADER_SCAN_BYTES = 256 * 1024;

/**
 * Returns the STEP `HEADER; ... ENDSEC;` section (file description, file
 * name with author/organization/authorization, schema) as text. When the
 * section is not found in the scanned prefix, the whole prefix is returned so
 * a malformed header is still scanned rather than skipped.
 */
export function readStepHeaderText(content: Uint8Array | string): string {
  const prefix =
    typeof content === "string"
      ? content.slice(0, STEP_HEADER_SCAN_BYTES)
      : Buffer.from(content.subarray(0, STEP_HEADER_SCAN_BYTES)).toString("latin1");
  const start = prefix.search(/\bHEADER\s*;/i);
  if (start < 0) return prefix;
  const end = prefix.slice(start).search(/\bENDSEC\s*;/i);
  return end < 0 ? prefix.slice(start) : prefix.slice(start, start + end);
}

/**
 * Reads at most STEP_HEADER_SCAN_BYTES from a staged STEP file. A read error
 * propagates, so a file that cannot be scanned fails the task.
 */
export async function readStagedStepHeaderPrefix(localPath: string): Promise<Uint8Array> {
  const handle = await open(localPath, "r");
  try {
    const buffer = Buffer.alloc(STEP_HEADER_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, STEP_HEADER_SCAN_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function isStepFileName(name: string | null | undefined): boolean {
  return typeof name === "string" && /\.(step|stp)$/i.test(name.trim());
}

export type ExportControlMarkingScan = {
  source: ExportControlMarkingSource;
  patterns: string[];
};

/** Scans every drawing page; OCR-derived text is reported as `drawing_ocr`. */
export function scanDrawingTextForExportMarkings(
  pdfText: { pages: ReadonlyArray<{ text: string }> } | null | undefined,
  options: { ocr?: boolean } = {},
): ExportControlMarkingScan | null {
  if (!pdfText) return null;
  const patterns = detectExportControlMarkings(pdfText.pages.map((page) => page.text).join("\n"));
  return patterns.length > 0 ? { source: options.ocr ? "drawing_ocr" : "drawing_text", patterns } : null;
}

export function scanStepHeaderForExportMarkings(content: Uint8Array | string): ExportControlMarkingScan | null {
  const patterns = detectExportControlMarkings(readStepHeaderText(content));
  return patterns.length > 0 ? { source: "step_header", patterns } : null;
}

export class ExportControlMarkingBlockedError extends Error {
  constructor(
    public readonly source: ExportControlMarkingSource,
    public readonly patterns: readonly string[],
  ) {
    super("Export-control markings were found; the part is blocked pending admin review.");
    this.name = "ExportControlMarkingBlockedError";
  }
}

export class ExportControlMarkingRecordError extends Error {
  constructor() {
    super("Export-control marking block could not be recorded; failing closed.");
    this.name = "ExportControlMarkingRecordError";
  }
}

export class ExportControlScanRecordError extends Error {
  constructor() {
    super("Export-control clean scan could not be recorded; failing closed.");
    this.name = "ExportControlScanRecordError";
  }
}

/**
 * Records a marking hit as a `blocked_pending_review` block. Any RPC error or
 * malformed response throws, so the caller's task fails closed.
 */
export async function recordExportControlMarkings(
  supabase: Pick<SupabaseClient, "rpc">,
  input: {
    jobId: string;
    partId: string | null;
    jobFileId: string | null;
    scan: ExportControlMarkingScan;
  },
): Promise<string> {
  let response: { data: unknown; error: unknown };
  try {
    response = await supabase.rpc("api_record_export_control_marking_hits", {
      p_job_id: input.jobId,
      p_part_id: input.partId,
      p_job_file_id: input.jobFileId,
      p_source: input.scan.source,
      p_patterns: input.scan.patterns,
    });
  } catch {
    throw new ExportControlMarkingRecordError();
  }
  if (response.error || typeof response.data !== "string" || response.data.length === 0) {
    throw new ExportControlMarkingRecordError();
  }
  return response.data;
}

/**
 * Scan, record, and stop. Returns normally only when nothing matched; a hit
 * always ends in a thrown error (blocked, or record failed).
 */
export async function enforceExportControlMarkings(
  supabase: Pick<SupabaseClient, "rpc">,
  input: {
    jobId: string;
    partId: string | null;
    jobFileId: string | null;
    scan: ExportControlMarkingScan | null;
  },
): Promise<void> {
  if (!input.scan) return;
  await recordExportControlMarkings(supabase, { ...input, scan: input.scan });
  throw new ExportControlMarkingBlockedError(input.scan.source, input.scan.patterns);
}

/**
 * Records a clean scan of one job file. Any RPC error or malformed response
 * throws, so the task fails and dispatch stays denied (`export_scan_missing`).
 */
export async function recordExportControlCleanScan(
  supabase: Pick<SupabaseClient, "rpc">,
  input: {
    jobId: string;
    partId: string | null;
    jobFileId: string;
    source: ExportControlMarkingSource;
  },
): Promise<string> {
  let response: { data: unknown; error: unknown };
  try {
    response = await supabase.rpc("api_record_export_control_clean_scan", {
      p_job_id: input.jobId,
      p_part_id: input.partId,
      p_job_file_id: input.jobFileId,
      p_source: input.source,
    });
  } catch {
    throw new ExportControlScanRecordError();
  }
  if (response.error || typeof response.data !== "string" || response.data.length === 0) {
    throw new ExportControlScanRecordError();
  }
  return response.data;
}

/**
 * Scans one file and records the result: a hit records a block and throws
 * (`enforceExportControlMarkings`); a clean result records a clean scan. When
 * the text could not be read (`text === null`), nothing is recorded, so the
 * file has no clean scan and dispatch denies it.
 */
export async function enforceAndRecordExportControlScan(
  supabase: Pick<SupabaseClient, "rpc">,
  input: {
    jobId: string;
    partId: string | null;
    jobFileId: string;
    source: ExportControlMarkingSource;
    scan: ExportControlMarkingScan | null;
    textRead: boolean;
  },
): Promise<void> {
  await enforceExportControlMarkings(supabase, input);
  if (!input.textRead) return;
  await recordExportControlCleanScan(supabase, input);
}

/**
 * Scans a part's staged drawing when extraction is skipped (trusted artifact
 * reuse). Copied artifacts from another part are never treated as a scan of
 * this part's file.
 */
export async function scanStagedDrawingForExportMarkings(
  supabase: Pick<SupabaseClient, "rpc">,
  input: {
    jobId: string;
    partId: string | null;
    drawingFile: { id: string; localPath: string } | null;
    extractText: (localPath: string) => Promise<{ pages: ReadonlyArray<{ text: string }> } | null>;
  },
): Promise<void> {
  if (!input.drawingFile) return;
  const pdfText = await input.extractText(input.drawingFile.localPath);
  await enforceAndRecordExportControlScan(supabase, {
    jobId: input.jobId,
    partId: input.partId,
    jobFileId: input.drawingFile.id,
    source: "drawing_text",
    scan: scanDrawingTextForExportMarkings(pdfText),
    textRead: pdfText !== null,
  });
}

export class ExportControlRescanIncompleteError extends Error {
  constructor(public readonly reason: "drawing_unreadable" | "file_missing") {
    super(
      reason === "drawing_unreadable"
        ? "Export-control rescan could not read the drawing text; no clean scan was recorded."
        : "Export-control rescan could not find a file the part references; no clean scan was recorded.",
    );
    this.name = "ExportControlRescanIncompleteError";
  }
}

export type ExportControlRescanResult = {
  drawing: "none" | "clean";
  cad: "none" | "clean" | "no_scanner";
};

/**
 * Rescans one existing part (`export_rescan_part`): its own drawing text and,
 * for STEP CAD, its header. A hit records a block and throws; a clean result
 * records a clean scan of record. It never re-runs extraction. Fails closed:
 * a referenced file that is missing, or a drawing whose text can't be read,
 * records nothing for that file and throws, so the task fails and dispatch
 * stays denied (`export_scan_missing`). The STEP header is still scanned
 * first, so a marked header opens a block even when the drawing is unreadable.
 * CAD formats without a scanner are reported as `no_scanner` and are not
 * recorded.
 */
export async function rescanPartForExportMarkings(
  supabase: Pick<SupabaseClient, "rpc">,
  input: {
    jobId: string;
    partId: string;
    drawingFileId: string | null;
    cadFileId: string | null;
    drawingFile: { id: string; localPath: string } | null;
    cadFile: { id: string; originalName: string; localPath: string } | null;
    extractText: (localPath: string) => Promise<{ pages: ReadonlyArray<{ text: string }> } | null>;
    readStepHeader?: (localPath: string) => Promise<Uint8Array>;
  },
): Promise<ExportControlRescanResult> {
  if (
    (input.drawingFileId !== null && input.drawingFile?.id !== input.drawingFileId) ||
    (input.cadFileId !== null && input.cadFile?.id !== input.cadFileId)
  ) {
    throw new ExportControlRescanIncompleteError("file_missing");
  }

  const result: ExportControlRescanResult = { drawing: "none", cad: "none" };

  if (input.cadFile) {
    if (isStepFileName(input.cadFile.originalName)) {
      const header = await (input.readStepHeader ?? readStagedStepHeaderPrefix)(input.cadFile.localPath);
      await enforceAndRecordExportControlScan(supabase, {
        jobId: input.jobId,
        partId: input.partId,
        jobFileId: input.cadFile.id,
        source: "step_header",
        scan: scanStepHeaderForExportMarkings(header),
        textRead: true,
      });
      result.cad = "clean";
    } else {
      result.cad = "no_scanner";
    }
  }

  if (input.drawingFile) {
    const pdfText = await input.extractText(input.drawingFile.localPath);
    await enforceAndRecordExportControlScan(supabase, {
      jobId: input.jobId,
      partId: input.partId,
      jobFileId: input.drawingFile.id,
      source: "drawing_text",
      scan: scanDrawingTextForExportMarkings(pdfText),
      textRead: pdfText !== null,
    });
    if (pdfText === null) {
      throw new ExportControlRescanIncompleteError("drawing_unreadable");
    }
    result.drawing = "clean";
  }

  return result;
}
