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
 * The STEP `HEADER; ... ENDSEC;` section (file description, file name with
 * author/organization/authorization, schema) as text, and whether it was read
 * in full. `complete` is true only when both `HEADER;` and the `ENDSEC;` that
 * closes it are inside the scanned prefix. A header padded past the prefix,
 * or a file with no `HEADER;` in the prefix, is incomplete: its text is still
 * scanned for markings (a hit still blocks), but no clean scan may be
 * recorded for it, so dispatch stays denied (held).
 *
 * Both keywords are found with the same tokenizer, outside quoted strings and
 * comments, so a commented `HEADER; ENDSEC;` before the real header cannot
 * stand in for it. The returned text runs from the start of the file through
 * the header, so anything before `HEADER;` (comments included) is scanned too.
 *
 * A header with a malformed or unterminated string escape
 * (`stepHeaderEscapesWellFormed`) is incomplete too: its decoded text is not
 * what the exporter wrote, so a clean result would not be an answer.
 */
export function readStepHeader(content: Uint8Array | string): { text: string; complete: boolean } {
  const prefix =
    typeof content === "string"
      ? content.slice(0, STEP_HEADER_SCAN_BYTES)
      : Buffer.from(content.subarray(0, STEP_HEADER_SCAN_BYTES)).toString("latin1");
  const start = findStepKeyword(prefix, 0, STEP_HEADER);
  if (start < 0) return { text: prefix, complete: false };
  const end = findStepKeyword(prefix, start, STEP_ENDSEC);
  if (end < 0) return { text: prefix, complete: false };
  const text = prefix.slice(0, end);
  return { text, complete: stepHeaderEscapesWellFormed(text) };
}

const STEP_HEADER = /^HEADER\s*;/i;
const STEP_ENDSEC = /^ENDSEC\s*;/i;

/**
 * Index of the first `keyword` at or after `start` that is outside any quoted
 * string (single quotes; a doubled `''` is an escaped quote) or `/* ... *\/`
 * comment, or -1 when there is none in `text`. A quoted or commented keyword
 * never counts, so it cannot open or close the header early and hide text
 * from the scan. An unbalanced quote or comment reaches the end of the text
 * and returns -1 (incomplete, held).
 */
function findStepKeyword(text: string, start: number, keyword: RegExp): number {
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === "'") {
      index += 1;
      for (;;) {
        if (index >= text.length) return -1;
        if (text[index] === "'") {
          if (text[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      if (close < 0) return -1;
      index = close + 2;
      continue;
    }
    if (
      /[a-z]/i.test(char)
      && (index === 0 || !/\w/.test(text[index - 1]))
      && keyword.test(text.slice(index, index + 64))
    ) {
      return index;
    }
    index += 1;
  }
  return -1;
}

/**
 * Returns the header text `readStepHeader` scans. When the section is not
 * found in the scanned prefix, the whole prefix is returned so a malformed
 * header is still scanned rather than skipped.
 */
export function readStepHeaderText(content: Uint8Array | string): string {
  return readStepHeader(content).text;
}

/**
 * Decodes ISO 10303-21 string escapes, which real exporters use for any
 * non ASCII text: `\X2\hhhh...\X0\` (UTF-16 hex), `\X4\hhhhhhhh...\X0\`
 * (UTF-32 hex), `\X\hh` (one 8 bit code), `\S\c` (the high half of the
 * current ISO 8859 part), and `\\` (one backslash). `\P?\` switches the code
 * page and is stripped. A malformed escape is left as is; the raw text is
 * always scanned too, and `readStepHeader` marks such a header incomplete.
 */
export function decodeStepStringEscapes(text: string): string {
  return text.replace(
    STEP_STRING_ESCAPE,
    (match, x2: string | undefined, x4: string | undefined, x: string | undefined, high: string | undefined) => {
      if (x2 !== undefined) return String.fromCharCode(...hexGroups(x2, 4));
      if (x4 !== undefined) {
        const codePoints = hexGroups(x4, 8);
        return codePoints.every(isUnicodeScalarValue) ? String.fromCodePoint(...codePoints) : match;
      }
      if (x !== undefined) return String.fromCharCode(Number.parseInt(x, 16));
      if (high !== undefined) return String.fromCharCode(high.charCodeAt(0) + 0x80);
      if (match === "\\\\") return "\\";
      return "";
    },
  );
}

const STEP_STRING_ESCAPE =
  /\\X2\\((?:[0-9A-F]{4})+)\\X0\\|\\X4\\((?:[0-9A-F]{8})+)\\X0\\|\\X\\([0-9A-F]{2})|\\S\\([\x20-\x7e])|\\P[A-I]\\|\\\\/gi;

/** A well formed escape, matched at one backslash (sticky). */
const STEP_STRING_ESCAPE_AT =
  /\\X2\\((?:[0-9A-F]{4})+)\\X0\\|\\X4\\((?:[0-9A-F]{8})+)\\X0\\|\\X\\[0-9A-F]{2}|\\S\\[\x20-\x7e]|\\P[A-I]\\|\\\\/iy;

/**
 * The start of an escape directive: `\X2\`, `\X4\`, `\X0\`, `\X\`, `\S\`, or
 * `\P?\`. A backslash that starts none of these (a Windows path some
 * exporters write unescaped, `C:\Users\Parts`) is plain text, not an escape.
 */
const STEP_ESCAPE_DIRECTIVE_AT = /\\(?:X[024]?\\|S\\|P[^\\]\\)/iy;

/**
 * False when the text holds a malformed or unterminated escape: a directive
 * whose hex is the wrong length, holds a non hex digit, or names a code point
 * that is not a Unicode scalar value, an `\X2\` or `\X4\` with no `\X0\`
 * before the string ends, an escape split across two strings, or a stray
 * `\X0\`. Read left to right, so `\\` is one backslash and never starts a
 * directive.
 */
export function stepHeaderEscapesWellFormed(text: string): boolean {
  for (let index = text.indexOf("\\"); index >= 0; index = text.indexOf("\\", index)) {
    STEP_STRING_ESCAPE_AT.lastIndex = index;
    const match = STEP_STRING_ESCAPE_AT.exec(text);
    if (match) {
      if (match[2] !== undefined && !hexGroups(match[2], 8).every(isUnicodeScalarValue)) return false;
      index = STEP_STRING_ESCAPE_AT.lastIndex;
      continue;
    }
    STEP_ESCAPE_DIRECTIVE_AT.lastIndex = index;
    if (STEP_ESCAPE_DIRECTIVE_AT.test(text)) return false;
    index += 1;
  }
  return true;
}

function isUnicodeScalarValue(codePoint: number): boolean {
  return codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
}

function hexGroups(hex: string, width: number): number[] {
  const groups: number[] = [];
  for (let index = 0; index < hex.length; index += width) {
    groups.push(Number.parseInt(hex.slice(index, index + width), 16));
  }
  return groups;
}

/**
 * Marking ids found in STEP header text, raw or with its string escapes
 * decoded. The raw text is always scanned too, so a malformed escape never
 * hides text that was readable before decoding. The decoded text is
 * normalized (NFKC, format characters such as a zero width space removed)
 * before matching, so fullwidth `ＩＴＡＲ` or `IT\u200BAR` still matches. The
 * header is read as latin1; it is also read as UTF-8, which nonconforming
 * exporters write into strings directly.
 */
export function detectStepHeaderMarkings(text: string): string[] {
  const candidates = new Set([text, normalizeStepHeaderText(decodeStepStringEscapes(text))]);
  const utf8 = Buffer.from(text, "latin1").toString("utf8");
  if (utf8 !== text) candidates.add(normalizeStepHeaderText(decodeStepStringEscapes(utf8)));
  const found = new Set([...candidates].flatMap((candidate) => detectExportControlMarkings(candidate)));
  return EXPORT_CONTROL_MARKING_PATTERNS.map(({ id }) => id).filter((id) => found.has(id));
}

function normalizeStepHeaderText(text: string): string {
  return text.normalize("NFKC").replace(/\p{Cf}/gu, "");
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
 * The shape of `extractPdfText`'s result that the export scan reads.
 * `drawingFullyRead` is OVD-747's single fail closed answer: true only when the
 * page count is known, every text layer read cleanly, and every page's OCR
 * status is ok. `ocrText` is OCR output alone, never mixed with the text layer.
 */
export type DrawingTextForExportScan = {
  pageCount?: number;
  pageCountKnown?: boolean;
  drawingFullyRead?: boolean | null;
  ocr?: boolean;
  pages: ReadonlyArray<{ text: string; ocrText?: string; ocrStatus?: string }>;
};

/**
 * True only when `extractPdfText` says the drawing was fully read
 * (`drawingFullyRead === true`; missing or null is unread) and every page was
 * read by OCR: its OCR status is ok and its OCR text is not empty. OCR is the
 * only reader that sees a raster stamp, so a text layer alone never makes a
 * page read. An empty tesseract result on a nonblank page looks the same as a
 * blank page, so a drawing with a truly blank page is held too. A drawing with
 * any unread page is unread as a whole: no clean scan is recorded for it, so
 * dispatch stays denied, and its content never goes to an extraction model.
 */
export function isDrawingTextFullyRead(pdfText: DrawingTextForExportScan | null | undefined): boolean {
  if (pdfText?.drawingFullyRead !== true) return false;
  if (!Array.isArray(pdfText.pages) || pdfText.pages.length === 0) return false;
  if (typeof pdfText.pageCount === "number" && pdfText.pages.length < pdfText.pageCount) return false;
  return pdfText.pages.every((page) => page.ocrStatus === "ok" && hasText(page.ocrText));
}

/** OCR statuses that say the OCR environment failed, not the page. */
const RETRYABLE_OCR_STATUSES: ReadonlySet<string> = new Set(["failed", "not_read", "unavailable"]);

/**
 * The outcome for a drawing `isDrawingTextFullyRead` rejects.
 * `drawing_ocr_failed` when any page's OCR failed, timed out, ran out of
 * budget, or was unavailable: the environment, not the bytes, so a recheck
 * of the same bytes may read it and the database does not treat it as final.
 * Otherwise `drawing_unread` (OCR ran and read nothing, the page count is
 * unknown, or a text layer failed), which is final for those bytes.
 */
export function drawingUnreadOutcome(
  pdfText: DrawingTextForExportScan | null | undefined,
): "drawing_unread" | "drawing_ocr_failed" {
  const pages = Array.isArray(pdfText?.pages) ? pdfText.pages : [];
  return pages.some((page) => typeof page.ocrStatus === "string" && RETRYABLE_OCR_STATUSES.has(page.ocrStatus))
    ? "drawing_ocr_failed"
    : "drawing_unread";
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The scan source for drawing text: `drawing_ocr` when `extractPdfText` read
 * the text through its OCR fallback (it sets `ocr: true`), else `drawing_text`.
 */
export function drawingTextScanSource(
  pdfText: { ocr?: boolean } | null | undefined,
): "drawing_text" | "drawing_ocr" {
  return pdfText?.ocr === true ? "drawing_ocr" : "drawing_text";
}

/**
 * Scans every drawing page; OCR-derived text is reported as `drawing_ocr`.
 * When a page carries separate OCR output (`ocrText`, PR #710), it is scanned
 * too, so a raster marking next to a selectable text layer is still found.
 */
export function scanDrawingTextForExportMarkings(
  pdfText: DrawingTextForExportScan | null | undefined,
  options: { ocr?: boolean } = {},
): ExportControlMarkingScan | null {
  if (!pdfText) return null;
  const layerPatterns = detectExportControlMarkings(pdfText.pages.map((page) => page.text).join("\n"));
  const ocrPatterns = detectExportControlMarkings(
    pdfText.pages.map((page) => (typeof page.ocrText === "string" ? page.ocrText : "")).join("\n"),
  );
  const patterns = EXPORT_CONTROL_MARKING_PATTERNS
    .map(({ id }) => id)
    .filter((id) => layerPatterns.includes(id) || ocrPatterns.includes(id));
  const ocr = options.ocr ?? (pdfText.ocr === true || (layerPatterns.length === 0 && ocrPatterns.length > 0));
  return patterns.length > 0 ? { source: ocr ? "drawing_ocr" : "drawing_text", patterns } : null;
}

export function scanStepHeaderForExportMarkings(content: Uint8Array | string): ExportControlMarkingScan | null {
  const patterns = detectStepHeaderMarkings(readStepHeaderText(content));
  return patterns.length > 0 ? { source: "step_header", patterns } : null;
}

/**
 * Scans and records the STEP header of one staged CAD file. A clean scan is
 * recorded only when the whole header was inside the scanned prefix
 * (`readStepHeader(...).complete`); otherwise nothing clean is recorded and
 * dispatch stays denied. A hit records a block and throws. Returns whether the
 * header was read in full.
 */
export async function enforceAndRecordStepHeaderScan(
  supabase: Pick<SupabaseClient, "rpc">,
  input: {
    jobId: string;
    partId: string | null;
    jobFileId: string;
    localPath: string;
    contentSha256: string;
    readPrefix?: (localPath: string) => Promise<Uint8Array>;
  },
): Promise<boolean> {
  const header = readStepHeader(await (input.readPrefix ?? readStagedStepHeaderPrefix)(input.localPath));
  const patterns = detectStepHeaderMarkings(header.text);
  await enforceAndRecordExportControlScan(supabase, {
    jobId: input.jobId,
    partId: input.partId,
    jobFileId: input.jobFileId,
    source: "step_header",
    scan: patterns.length > 0 ? { source: "step_header", patterns } : null,
    textRead: header.complete,
    contentSha256: input.contentSha256,
  });
  return header.complete;
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
 * model. The task is not retried. The outcome says whether a recheck can
 * help: `drawing_unread` (OCR ran and read nothing) is final for those bytes;
 * `drawing_ocr_failed` (OCR failed, timed out, ran out of budget, or was
 * unavailable) is not, so the owner can requeue a scan with Recheck files.
 */
export class ExportControlDrawingUnreadError extends Error {
  /**
   * Scan outcomes the failed task records in its payload
   * (`exportScanOutcomes`), so the part shows `drawing_unread` at once
   * (`private.export_rescan_final_outcome`) instead of first `missing`.
   */
  exportScanOutcomes: ExportScanOutcomes = {};

  constructor(
    drawing?: { jobFileId: string; contentSha256: string },
    outcome: "drawing_unread" | "drawing_ocr_failed" = "drawing_unread",
  ) {
    super("Export-control scan could not read every drawing page; the drawing is held and not sent to any model.");
    this.name = "ExportControlDrawingUnreadError";
    if (drawing) addExportScanOutcome(this.exportScanOutcomes, drawing.jobFileId, drawing.contentSha256, outcome);
  }
}

/** What one scan of one file's bytes found, as recorded in a task payload. */
export type ExportScanOutcome =
  | "clean"
  | "admin_cleared"
  | "drawing_unread"
  | "drawing_ocr_failed"
  | "step_header_incomplete";

/**
 * Per file outcomes an extract_part task records in its payload
 * (`exportScanOutcomes`, keyed by job file id, with the hash of the scanned
 * bytes). The database reads `drawing_unread` and `step_header_incomplete`
 * from it as final for those bytes; `drawing_ocr_failed` is not final, so the
 * file shows as missing and Recheck files queues it again. A clean outcome
 * also has its scan of record, which is what dispatch checks.
 */
export type ExportScanOutcomes = Record<string, { contentSha256: string; outcome: ExportScanOutcome }>;

export function addExportScanOutcome(
  outcomes: ExportScanOutcomes,
  jobFileId: string,
  contentSha256: string | null | undefined,
  outcome: ExportScanOutcome,
): void {
  if (jobFileId.length === 0 || typeof contentSha256 !== "string" || !SHA256_HEX.test(contentSha256)) return;
  outcomes[jobFileId] = { contentSha256, outcome };
}

/** The payload patch a failed task records for an unread drawing; empty otherwise. */
export function exportScanOutcomesPayload(error: unknown): { exportScanOutcomes?: ExportScanOutcomes } {
  if (error instanceof ExportControlDrawingUnreadError && Object.keys(error.exportScanOutcomes).length > 0) {
    return { exportScanOutcomes: { ...error.exportScanOutcomes } };
  }
  return {};
}

/**
 * OVD-723 review round 5: extraction scans the part's STEP header too (the
 * same 256 KB prefix scanner as the quote task, no model), so a new STEP
 * part has a scan of record, or a held outcome, before any quote is asked
 * for. A file not named .step/.stp is not scanned. A hit opens a block and
 * throws (`ExportControlMarkingBlockedError`). Adds the outcome to
 * `outcomes`.
 */
export async function scanPartStepHeaderForExtraction(
  supabase: Pick<SupabaseClient, "rpc">,
  input: {
    jobId: string;
    partId: string | null;
    cadFile: { id: string; original_name: string } | null;
    stagedCad: { localPath: string; trustedContentSha256?: string | null } | null;
    readPrefix?: (localPath: string) => Promise<Uint8Array>;
  },
  outcomes: ExportScanOutcomes,
): Promise<void> {
  if (!input.cadFile || !isStepFileName(input.cadFile.original_name)) return;
  if (!input.stagedCad) throw new ExportControlStepScanRetryableError();
  const contentSha256 = input.stagedCad.trustedContentSha256 ?? "";
  let complete: boolean;
  try {
    complete = await enforceAndRecordStepHeaderScan(supabase, {
      jobId: input.jobId,
      partId: input.partId,
      jobFileId: input.cadFile.id,
      localPath: input.stagedCad.localPath,
      contentSha256,
      readPrefix: input.readPrefix,
    });
  } catch (error) {
    // A scan or block that could not be recorded is not an answer about the
    // file: retry extraction on the bounded schedule (no model has run yet).
    if (error instanceof ExportControlScanRecordError || error instanceof ExportControlMarkingRecordError) {
      throw new ExportControlStepScanRetryableError();
    }
    throw error;
  }
  addExportScanOutcome(outcomes, input.cadFile.id, contentSha256, complete ? "clean" : "step_header_incomplete");
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
 * OVD-723 review round 6: extraction's STEP header scan could not be staged
 * or recorded (a Storage or RPC error). It runs before any model call, so
 * extract_part retries it on the bounded schedule instead of failing the
 * part's extraction for good after one blip. Until it succeeds the file has
 * no scan of record and dispatch stays denied.
 */
export class ExportControlStepScanRetryableError extends ExportControlScanRecordError {
  constructor() {
    super();
    this.message = "Export-control STEP header scan could not be recorded; extraction will retry.";
    this.name = "ExportControlStepScanRetryableError";
  }
}

/**
 * Records a marking hit. The database answers with the block it opened or
 * already holds open (`resolved: false`), or, when an admin already cleared a
 * block for this same file, content hash, and source whose patterns include
 * every pattern found now, with that cleared block (`resolved: true`; the
 * database records an admin cleared scan for those bytes). A new hash or a
 * new pattern always opens a block. Any RPC error or malformed response
 * throws, so the caller's task fails closed.
 */
export async function recordExportControlMarkings(
  supabase: Pick<SupabaseClient, "rpc">,
  input: {
    jobId: string;
    partId: string | null;
    jobFileId: string | null;
    scan: ExportControlMarkingScan;
    /** SHA-256 of the scanned bytes; null when no staged bytes exist. */
    contentSha256?: string | null;
  },
): Promise<{ blockId: string; resolved: boolean }> {
  let response: { data: unknown; error: unknown };
  try {
    response = await supabase.rpc("api_record_export_control_marking_hits", {
      p_job_id: input.jobId,
      p_part_id: input.partId,
      p_job_file_id: input.jobFileId,
      p_source: input.scan.source,
      p_patterns: input.scan.patterns,
      p_content_sha256: input.contentSha256 && SHA256_HEX.test(input.contentSha256) ? input.contentSha256 : null,
    });
  } catch {
    throw new ExportControlMarkingRecordError();
  }
  const data = response.data;
  if (response.error || !data || typeof data !== "object" || Array.isArray(data)) {
    throw new ExportControlMarkingRecordError();
  }
  const value = data as Record<string, unknown>;
  if (typeof value.blockId !== "string" || value.blockId.length === 0 || typeof value.resolved !== "boolean") {
    throw new ExportControlMarkingRecordError();
  }
  return { blockId: value.blockId, resolved: value.resolved };
}

/**
 * Scan, record, and stop. Returns normally when nothing matched (`"clean"`)
 * or when the database matched the hit to an admin cleared block for the same
 * bytes and patterns (`"admin_cleared"`). Any other hit ends in a thrown
 * error (blocked, or record failed).
 */
export async function enforceExportControlMarkings(
  supabase: Pick<SupabaseClient, "rpc">,
  input: {
    jobId: string;
    partId: string | null;
    jobFileId: string | null;
    scan: ExportControlMarkingScan | null;
    contentSha256?: string | null;
  },
): Promise<"clean" | "admin_cleared"> {
  if (!input.scan) return "clean";
  const recorded = await recordExportControlMarkings(supabase, { ...input, scan: input.scan });
  if (recorded.resolved) return "admin_cleared";
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
  const outcome = await enforceExportControlMarkings(supabase, input);
  // An admin cleared hit already has its scan of record (written by the
  // database with the clearance); the text did match, so it is not "clean".
  if (outcome === "admin_cleared" || !input.textRead) return;
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
    extractText: (localPath: string) => Promise<DrawingTextForExportScan | null>;
  },
  outcomes: ExportScanOutcomes = {},
): Promise<void> {
  if (!input.drawingFile) return;
  const pdfText = await input.extractText(input.drawingFile.localPath);
  const textRead = isDrawingTextFullyRead(pdfText);
  await enforceAndRecordExportControlScan(supabase, {
    jobId: input.jobId,
    partId: input.partId,
    jobFileId: input.drawingFile.id,
    source: drawingTextScanSource(pdfText),
    scan: scanDrawingTextForExportMarkings(pdfText),
    textRead,
    contentSha256: input.drawingFile.contentSha256,
  });
  // An unread drawing gets no clean scan; the outcome makes it show as
  // drawing_unread (replace the drawing) rather than missing, or as missing
  // (recheck) when OCR itself failed (drawing_ocr_failed).
  addExportScanOutcome(
    outcomes,
    input.drawingFile.id,
    input.drawingFile.contentSha256,
    textRead ? "clean" : drawingUnreadOutcome(pdfText),
  );
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

/**
 * True for the errors that mean "stop: this content may not reach a model":
 * an export-control denial or a failed export-control lookup. Model callers
 * rethrow these instead of degrading to parser-only output.
 */
export function isExportControlModelStop(error: unknown): boolean {
  return error instanceof ExportControlExtractionDeniedError || error instanceof ExportControlLookupError;
}

/**
 * OVD-723 point in time check: a hook run before EACH model attempt (title
 * block crop, full page). The job's state can change between the check
 * before extraction and a later attempt (a re-declaration, a marking block
 * opened by another task), so every attempt asks again and a denial stops the
 * attempt before any content is sent.
 */
export function exportControlModelAttemptGuard(
  supabase: Pick<SupabaseClient, "rpc">,
  input: { jobId: string },
): () => Promise<void> {
  return () => assertExportControlExtractionAllowed(supabase, input);
}

/** What a scan only rescan of one job file found. */
export type ExportMarkingRescanOutcome =
  | "clean"
  | "admin_cleared"
  | "blocked"
  | "drawing_unread"
  | "drawing_ocr_failed"
  | "step_header_incomplete"
  | "not_scannable";

/**
 * OVD-723 scan only rescan (task `export_marking_rescan`), queued by
 * `api_declare_job_export_status` after a clean declaration and by the
 * service role `api_queue_export_marking_rescan`. It covers files that never
 * got a clean scan of record, above all parts extracted before the deploy:
 * `api_request_extraction` skips a part that already has an extraction, and
 * the quote task scans only the STEP header, so without this the drawing of
 * such a part stays `export_scan_missing` forever.
 *
 * It stages the file (which verifies and registers its hash), scans the
 * drawing text (text layer and OCR of every page; a page counts as read only
 * when OCR read it) or the STEP header, and records a clean scan or opens a
 * block. An unread drawing is `drawing_unread`, or `drawing_ocr_failed` when
 * OCR itself failed, which the owner can recheck. It never calls any model: this
 * module imports no extraction model code, and the only readers are the
 * injected text and header readers.
 */
export async function runExportMarkingRescan(
  supabase: Pick<SupabaseClient, "rpc">,
  input: {
    jobId: string;
    partId: string | null;
    file: { id: string; original_name: string; file_kind: string };
    stage: () => Promise<{ localPath: string; trustedContentSha256?: string | null } | null>;
    extractText: (localPath: string) => Promise<DrawingTextForExportScan | null>;
    readStepPrefix?: (localPath: string) => Promise<Uint8Array>;
  },
): Promise<ExportMarkingRescanOutcome> {
  const isStep = isStepFileName(input.file.original_name);
  const isDrawing = !isStep && input.file.file_kind === "drawing";
  if (!isStep && !isDrawing) return "not_scannable";

  const staged = await input.stage();
  if (!staged) throw new ExportControlScanRecordError();
  const contentSha256 = staged.trustedContentSha256 ?? "";

  try {
    if (isStep) {
      const complete = await enforceAndRecordStepHeaderScan(supabase, {
        jobId: input.jobId,
        partId: input.partId,
        jobFileId: input.file.id,
        localPath: staged.localPath,
        contentSha256,
        readPrefix: input.readStepPrefix,
      });
      return complete ? "clean" : "step_header_incomplete";
    }

    const pdfText = await input.extractText(staged.localPath);
    const scan = scanDrawingTextForExportMarkings(pdfText);
    const fullyRead = isDrawingTextFullyRead(pdfText);
    const outcome = await enforceExportControlMarkings(supabase, {
      jobId: input.jobId,
      partId: input.partId,
      jobFileId: input.file.id,
      scan,
      contentSha256,
    });
    if (outcome === "admin_cleared") return "admin_cleared";
    if (!fullyRead) return drawingUnreadOutcome(pdfText);
    await recordExportControlCleanScan(supabase, {
      jobId: input.jobId,
      partId: input.partId,
      jobFileId: input.file.id,
      source: drawingTextScanSource(pdfText),
      contentSha256,
    });
    return "clean";
  } catch (error) {
    if (error instanceof ExportControlMarkingBlockedError) return "blocked";
    throw error;
  }
}
