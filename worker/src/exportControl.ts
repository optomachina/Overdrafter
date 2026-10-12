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
 * - clean scans, recorded through `api_record_export_control_clean_scan`
 *   with the SHA-256 of the bytes that were scanned. The database records the
 *   scan only when that hash equals the file's claimed hash, and dispatch
 *   requires a clean scan of record bound to the part's own file, its current
 *   job, and its current hash, so a path that skips extraction (trusted
 *   artifact reuse, org blob reuse) or a repointed file row is denied until
 *   the worker scans those bytes;
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
export const FOREIGN_JURISDICTION_PROVIDERS: ReadonlySet<VendorName> = new Set<VendorName>([
  "weerg",
  "geomiq",
  // RapidDirect manufactures in China; Protolabs Network (Hubs) routes work
  // through its own non-US partner network.
  "rapiddirect",
  "protolabsnetwork",
]);

const US_JURISDICTION_PROVIDERS: ReadonlySet<string> = new Set<VendorName>([
  "xometry",
  "fictiv",
  "protolabs",
  "sendcutsend",
  "oshcut",
  "fabworks",
  "ponoko",
  "quickparts",
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

/**
 * One file the part sends. `inJob`: the file row is in the part's job.
 * `hashVerified`: the worker's staged bytes hashed to the file's claimed
 * content hash. `scanned`: a clean scan of record matches this file id, its
 * current job, and its current content hash.
 */
export type ExportControlFileCoverage = { inJob: boolean; hashVerified: boolean; scanned: boolean };

export type ExportControlScanCoverage = {
  /** Null when the part has no drawing. */
  drawing: ExportControlFileCoverage | null;
  /** Null when the part has no CAD file. */
  cad: (ExportControlFileCoverage & { originalName: string }) | null;
} | null;

/**
 * Reference model of `private.export_control_scan_denial`. Every file must be
 * in the part's job with a verified hash. The drawing and a STEP CAD file
 * also need a clean scan bound to that job and hash. A missing part is a
 * denial. Other CAD formats have no scanner yet.
 */
export function evaluateExportControlScanCoverage(part: ExportControlScanCoverage): "export_scan_missing" | null {
  if (!part) return "export_scan_missing";
  const fileOk = (file: ExportControlFileCoverage, needsScan: boolean) =>
    file.inJob === true && file.hashVerified === true && (!needsScan || file.scanned === true);
  if (part.drawing && !fileOk(part.drawing, true)) return "export_scan_missing";
  if (part.cad && !fileOk(part.cad, isStepFileName(part.cad.originalName))) return "export_scan_missing";
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

/**
 * True only when every page of the drawing yielded text. `extractPdfText`
 * returns pages with empty text when neither pdftotext nor OCR found any (a
 * raster drawing on a host without tesseract, or OCR that reads only page 1),
 * so a non-null result is not proof the drawing was read. A drawing with any
 * unread page is unread as a whole: no clean scan is recorded for it, so
 * dispatch stays denied, and its content never goes to an extraction model.
 */
export function isDrawingTextFullyRead(
  pdfText: { pageCount?: number; pages: ReadonlyArray<{ text: string }> } | null | undefined,
): boolean {
  if (!pdfText || !Array.isArray(pdfText.pages) || pdfText.pages.length === 0) return false;
  if (typeof pdfText.pageCount === "number" && pdfText.pages.length < pdfText.pageCount) return false;
  return pdfText.pages.every((page) => typeof page.text === "string" && page.text.trim().length > 0);
}

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

/**
 * The drawing's text could not be read on every page, so the marking scan is
 * incomplete. Nothing clean is recorded and the drawing is not sent to any
 * model. Terminal: rerunning the same scanner on the same bytes reads the
 * same nothing.
 */
export class ExportControlDrawingUnreadError extends Error {
  constructor() {
    super("Export-control scan could not read every drawing page; the drawing is held and not sent to any model.");
    this.name = "ExportControlDrawingUnreadError";
  }
}

/**
 * The worker's own export-control lookup (dispatch or extraction check)
 * failed: an RPC error, a thrown call, or a malformed response. It is not a
 * decision, so the task retries on the finite vendor schedule; once retries
 * run out the lane is held like any other export-control denial.
 */
export class ExportControlLookupError extends Error {
  readonly reasonCode = "export_control_lookup_failed" as const;
  constructor(public readonly check: "dispatch" | "extraction") {
    super(`Export-control ${check} check could not be completed; failing closed.`);
    this.name = "ExportControlLookupError";
  }
}

/** The job's export-control state does not allow CAD or drawing content to reach a model. */
export class ExportControlExtractionDeniedError extends Error {
  constructor(public readonly reasonCode: ExportControlDenialCode) {
    super(`Export-control check denied model extraction (${reasonCode}).`);
    this.name = "ExportControlExtractionDeniedError";
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

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Records a clean scan of one job file. `contentSha256` is the hash of the
 * staged bytes that were scanned; the database rejects it
 * (`export_content_hash_mismatch`) unless it equals the file's claimed hash.
 * Any RPC error, malformed hash, or malformed response throws, so the task
 * fails and dispatch stays denied (`export_scan_missing`).
 */
export async function recordExportControlCleanScan(
  supabase: Pick<SupabaseClient, "rpc">,
  input: {
    jobId: string;
    partId: string | null;
    jobFileId: string;
    source: ExportControlMarkingSource;
    contentSha256: string;
  },
): Promise<string> {
  if (!SHA256_HEX.test(input.contentSha256)) {
    throw new ExportControlScanRecordError();
  }
  let response: { data: unknown; error: unknown };
  try {
    response = await supabase.rpc("api_record_export_control_clean_scan", {
      p_job_id: input.jobId,
      p_part_id: input.partId,
      p_job_file_id: input.jobFileId,
      p_source: input.source,
      p_content_sha256: input.contentSha256,
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
    /** SHA-256 of the staged bytes that were scanned. */
    contentSha256: string;
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
    drawingFile: { id: string; localPath: string; contentSha256: string } | null;
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
    textRead: isDrawingTextFullyRead(pdfText),
    contentSha256: input.drawingFile.contentSha256,
  });
}

/**
 * OVD-723: asked before any CAD or drawing content goes to an extraction
 * model (`api_check_export_control_extraction`, service role). The job's
 * latest declaration must be not_controlled with no open or confirmed marking
 * block. Anything but exactly `{ allowed: true }` throws, so an undeclared job
 * (stale tab, direct API call, service-role import) never reaches the model.
 */
export async function assertExportControlExtractionAllowed(
  supabase: Pick<SupabaseClient, "rpc">,
  input: { jobId: string },
): Promise<void> {
  let denial: ExportControlDenialCode = "export_control_lookup_failed";
  try {
    const { data, error } = await supabase.rpc("api_check_export_control_extraction", { p_job_id: input.jobId });
    if (!error && data && typeof data === "object" && !Array.isArray(data)) {
      const value = data as Record<string, unknown>;
      const keys = Object.keys(value).sort((a, b) => a.localeCompare(b)).join(",");
      if (value.allowed === true && keys === "allowed") return;
      if (
        value.allowed === false
        && keys === "allowed,reasonCode"
        && (EXPORT_CONTROL_DENIAL_CODES as readonly unknown[]).includes(value.reasonCode)
      ) {
        denial = value.reasonCode as ExportControlDenialCode;
      }
    }
  } catch {
    // Fail closed: denial stays export_control_lookup_failed.
  }
  if (denial === "export_control_lookup_failed") throw new ExportControlLookupError("extraction");
  throw new ExportControlExtractionDeniedError(denial);
}
