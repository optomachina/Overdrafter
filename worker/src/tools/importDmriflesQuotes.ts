import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import StreamZip from "node-stream-zip";
import { XMLParser } from "fast-xml-parser";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadConfig } from "../config.js";
import { createServiceClient } from "../queue.js";

type Row = Record<string, string | null>;

type ImportArgs = {
  rootPath: string;
  workbookPath: string;
  accountEmail: string;
  internalUserEmail: string;
  batchMode: "project";
  cleanupMode: "replace";
  unsupportedMode: "skip";
  dryRun: boolean;
};

type SpreadsheetGroup = {
  batch: string;
  partNumber: string;
  revision: string | null;
  rows: Row[];
};

type RfqRecord = {
  batch: string;
  client: string | null;
  clientContact: string | null;
  rfqReceived: string | null;
  quoteDue: string | null;
  projectSystem: string | null;
  partCount: number | null;
  status: string | null;
  totalQuoted: number | null;
  dateQuoted: string | null;
  poReceived: string | null;
  notes: string | null;
};

type SupportedSupplier =
  | "Xometry"
  | "Fictiv"
  | "Protolabs"
  | "SendCutSend"
  | "PartsBadger"
  | "FastDMS";

type SupportedVendor =
  | "xometry"
  | "fictiv"
  | "protolabs"
  | "sendcutsend"
  | "partsbadger"
  | "fastdms";

type SupportedRow = Row & { Supplier: SupportedSupplier };

type ImportedOffer = {
  offerId: string;
  supplier: string;
  laneLabel: string;
  requestedQuantity: number;
  sourcing: string | null;
  tier: string | null;
  quoteRef: string | null;
  quoteDateIso: string | null;
  status: string | null;
  totalPriceUsd: number;
  unitPriceUsd: number;
  leadTimeBusinessDays: number | null;
  shipReceiveBy: string | null;
  dueDate: string | null;
  process: string | null;
  material: string | null;
  finish: string | null;
  tightestTolerance: string | null;
  toleranceSource: string | null;
  threadCallouts: string | null;
  threadMatchNotes: string | null;
  notes: string | null;
};

type ImportedOptionCandidate = {
  vendor: SupportedVendor;
  vendorQuoteId: string;
  offerRowId: string;
  totalPriceUsd: number;
  leadTimeBusinessDays: number | null;
  requestedQuantity: number;
};

type WorkspaceJob = {
  id: string;
  title: string;
  source: string;
  project_id: string | null;
  tags: string[] | null;
};

type WorkspaceJobFile = {
  id: string;
  job_id: string;
  blob_id: string | null;
  storage_bucket: string;
  storage_path: string;
  normalized_name: string;
  original_name: string;
};

type WorkspaceProject = {
  id: string;
  name: string;
  description: string | null;
};

type CleanupCandidates = {
  jobIds: string[];
  projectIds: string[];
};

type LocalImportFile = {
  absolutePath: string;
  relativePath: string;
  originalName: string;
  originalStem: string;
  extension: string;
  fileKind: "cad" | "drawing";
  normalizedStem: string;
};

type FileAssignment = {
  group: SpreadsheetGroup;
  files: LocalImportFile[];
};

type ProjectInsertResult = {
  id: string;
  name: string;
};

type JobInsertResult = {
  id: string;
  title: string;
  batch: string;
  partNumber: string;
  revision: string | null;
  status: string;
};

type ImportSummary = {
  projects: number;
  jobs: number;
  quotedJobs: number;
  readyJobs: number;
  files: number;
  packages: number;
  cleanedJobs: number;
  cleanedProjects: number;
};

const DEFAULT_ACCOUNT_EMAIL = "dmrifles@gmail.com";
const DEFAULT_INTERNAL_USER_EMAIL = "blaineswilson@gmail.com";
const IMPORT_TAG = "dmrifles-import";
const PROJECT_MARKER_PREFIX = "Imported batch ";
const WORKBOOK_SHEET_ALL_QUOTES = "All Quotes";
const WORKBOOK_SHEET_RFQ_LOG = "RFQ Log";

const SUPPORTED_VENDOR_MAP: Record<SupportedSupplier, SupportedVendor> = {
  Xometry: "xometry",
  Fictiv: "fictiv",
  Protolabs: "protolabs",
  SendCutSend: "sendcutsend",
  PartsBadger: "partsbadger",
  FastDMS: "fastdms",
};

const ALLOWED_CAD_EXTENSIONS = new Set([
  ".step",
  ".stp",
  ".igs",
  ".iges",
  ".sldprt",
  ".prt",
  ".sldasm",
  ".asm",
  ".x_t",
  ".xt",
]);

const ALLOWED_DRAWING_EXTENSIONS = new Set([".pdf"]);

const EXPLICIT_FILE_STEM_ALIASES: Record<string, string[]> = {
  [buildGroupKey("QB00003", "1093-10453", "A")]: ["1093-10435-a"],
  [buildGroupKey("QB00004", "1093-07054-01", "B")]: ["1093-07054"],
};

function buildGroupKey(batch: string, partNumber: string, revision: string | null): string {
  return `${batch.trim().toUpperCase()}::${partNumber.trim()}::${(revision ?? "").trim()}`;
}

export function normalizeToken(value: string | null | undefined): string {
  return (value ?? "none")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "none";
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

export function excelSerialToIso(serialText: string | null): string | null {
  if (!serialText) {
    return null;
  }

  const serial = Number(serialText);

  if (!Number.isFinite(serial)) {
    return null;
  }

  const epoch = Date.UTC(1899, 11, 30);
  const date = new Date(epoch + serial * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function parseMoney(value: string | null): number {
  const parsed = Number.parseFloat(value ?? "");

  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid price value: ${value}`);
  }

  return Math.round(parsed * 100) / 100;
}

function parseOptionalMoney(value: string | null): number | null {
  if (!value) {
    return null;
  }

  return parseMoney(value);
}

export function parseTolerance(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const match = value.match(/([0-9]*\.?[0-9]+)/);

  if (!match) {
    return null;
  }

  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateFromMonthDay(text: string | null, fallbackYear: number): Date | null {
  if (!text) {
    return null;
  }

  const normalized = text.replace(/[–—]/g, "-");
  const match = normalized.match(/([A-Z][a-z]{2})\s+(\d{1,2})/);

  if (!match) {
    return null;
  }

  const parsed = new Date(`${match[1]} ${match[2]}, ${fallbackYear} 00:00:00 UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function businessDaysBetween(startIso: string | null, endText: string | null): number | null {
  if (!startIso || !endText) {
    return null;
  }

  const start = new Date(`${startIso}T00:00:00Z`);
  const end = dateFromMonthDay(endText, start.getUTCFullYear());

  if (Number.isNaN(start.getTime()) || !end || end < start) {
    return null;
  }

  const current = new Date(start);
  let businessDays = 0;

  while (current < end) {
    current.setUTCDate(current.getUTCDate() + 1);
    const weekday = current.getUTCDay();

    if (weekday !== 0 && weekday !== 6) {
      businessDays += 1;
    }
  }

  return businessDays;
}

function parseLeadTimeDays(row: Row): number | null {
  const direct = row["Lead Time"];

  if (direct) {
    const match = direct.match(/(\d+)/);

    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }

  return businessDaysBetween(excelSerialToIso(row["Quote Date"]), row["Ship/Receive By"]);
}

function resolveWorksheetPath(target: string): string {
  if (target.startsWith("/")) {
    return target.replace(/^\/+/, "");
  }

  return path.posix.join("xl", target.replace(/^\/+/, ""));
}

export async function readWorkbookRows(workbookPath: string, sheetName: string): Promise<Row[]> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
  });
  const zip = new StreamZip.async({ file: workbookPath });

  try {
    const workbookXml = await zip.entryData("xl/workbook.xml");
    const workbookRelsXml = await zip.entryData("xl/_rels/workbook.xml.rels");
    const workbook = parser.parse(workbookXml.toString("utf8"));
    const workbookRels = parser.parse(workbookRelsXml.toString("utf8"));

    const sheets = asArray(workbook.workbook.sheets.sheet);
    const relationships = asArray(workbookRels.Relationships.Relationship);
    const relationshipMap = new Map(
      relationships.map((relationship) => [relationship.Id, relationship.Target]),
    );

    const targetSheet = sheets.find((sheet) => sheet.name === sheetName);

    if (!targetSheet) {
      throw new Error(`Sheet "${sheetName}" was not found in ${workbookPath}.`);
    }

    const sheetTarget = relationshipMap.get(targetSheet["r:id"]);

    if (!sheetTarget) {
      throw new Error(`Relationship for sheet "${sheetName}" was not found.`);
    }

    const sharedStrings = new Map<number, string>();

    try {
      const sharedXml = await zip.entryData("xl/sharedStrings.xml");
      const shared = parser.parse(sharedXml.toString("utf8"));
      const items = asArray(shared.sst.si);

      items.forEach((item, index) => {
        const resolveText = (value: unknown): string => {
          if (typeof value === "string") {
            return value;
          }
          if (typeof value === "number") {
            return String(value);
          }
          if (value !== null && typeof value === "object" && "#text" in (value as object)) {
            return String((value as Record<string, unknown>)["#text"] ?? "");
          }
          return "";
        };

        const text =
          item.t !== undefined && item.t !== null
            ? resolveText(item.t)
            : asArray(item.r)
                .map((run) => resolveText(run.t))
                .join("");

        sharedStrings.set(index, text);
      });
    } catch {
      // Workbooks with inline strings do not include sharedStrings.xml.
    }

    const sheetPath = resolveWorksheetPath(sheetTarget);
    const sheetXml = await zip.entryData(sheetPath);
    const sheet = parser.parse(sheetXml.toString("utf8"));
    const rows = asArray(sheet.worksheet.sheetData.row);

    const parsedRows = rows.map((row) => {
      const cells = asArray(row.c);
      const values = cells.map((cell) => {
        if (cell.t === "s") {
          return sharedStrings.get(Number(cell.v)) ?? null;
        }

        if (typeof cell.v === "number") {
          return String(cell.v);
        }

        if (typeof cell.v === "string") {
          return cell.v;
        }

        if (typeof cell.is?.t === "string" || typeof cell.is?.t === "number") {
          return String(cell.is.t);
        }

        return null;
      });

      return values;
    });

    const [headers, ...dataRows] = parsedRows;

    return dataRows
      .filter((row) => row.some((value) => value !== null && value !== ""))
      .map((row) =>
        Object.fromEntries(headers.map((header, index) => [String(header), row[index] ?? null])),
      );
  } finally {
    await zip.close();
  }
}

export function groupWorkbookRows(rows: Row[]): SpreadsheetGroup[] {
  const groups = new Map<string, SpreadsheetGroup>();

  rows.forEach((row) => {
    const batch = row["Quote Batch"]?.trim();
    const partNumber = row["Part Number"]?.trim();

    if (!batch || !partNumber) {
      return;
    }

    const revision = row.Revision?.trim() ?? null;
    const key = buildGroupKey(batch, partNumber, revision);
    const existing = groups.get(key);

    if (existing) {
      existing.rows.push(row);
      return;
    }

    groups.set(key, {
      batch,
      partNumber,
      revision,
      rows: [row],
    });
  });

  return [...groups.values()].sort((left, right) => {
    if (left.batch !== right.batch) {
      return left.batch.localeCompare(right.batch);
    }

    return left.partNumber.localeCompare(right.partNumber);
  });
}

function parseRfqLogRows(rows: Row[]): Map<string, RfqRecord> {
  const rfqs = new Map<string, RfqRecord>();

  rows.forEach((row) => {
    const batch = row["Quote Batch"]?.trim();

    if (!batch) {
      return;
    }

    rfqs.set(batch, {
      batch,
      client: row.Client?.trim() ?? null,
      clientContact: row["Client Contact"]?.trim() ?? null,
      rfqReceived: excelSerialToIso(row["RFQ Received"]),
      quoteDue: excelSerialToIso(row["Quote Due"]),
      projectSystem: row["Project / System"]?.trim() ?? null,
      partCount: row["# Parts"] ? Number(row["# Parts"]) : null,
      status: row.Status?.trim() ?? null,
      totalQuoted: parseOptionalMoney(row["Total Quoted"]),
      dateQuoted: excelSerialToIso(row["Date Quoted"]),
      poReceived: excelSerialToIso(row["PO Received"]),
      notes: row.Notes?.trim() ?? null,
    });
  });

  return rfqs;
}

function isSupportedSupplier(value: string | null | undefined): value is SupportedSupplier {
  return (
    value === "Xometry" ||
    value === "Fictiv" ||
    value === "Protolabs" ||
    value === "SendCutSend" ||
    value === "PartsBadger" ||
    value === "FastDMS"
  );
}

function getSupportedRows(rows: Row[]): SupportedRow[] {
  return rows.filter(
    (row): row is SupportedRow =>
      isSupportedSupplier(row.Supplier) &&
      row["Total Price"] !== null &&
      row["Total Price"] !== "" &&
      row["Unit Price"] !== null &&
      row["Unit Price"] !== "",
  );
}

function buildPreferredStemLabel(group: SpreadsheetGroup): string {
  if (group.revision && /^\d+$/.test(group.revision)) {
    return `${group.partNumber}-${group.revision}`;
  }

  return group.partNumber;
}

function isNonPartGroup(group: SpreadsheetGroup): boolean {
  return group.partNumber.trim().toUpperCase() === "FINISH";
}

export function buildGroupStemAliases(group: SpreadsheetGroup): string[] {
  const aliases = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (!value) {
      return;
    }

    aliases.add(normalizeToken(value));
  };

  add(group.partNumber);
  add(buildPreferredStemLabel(group));

  if (group.revision) {
    add(`${group.partNumber}-${group.revision}`);
    add(`${group.partNumber} rev ${group.revision}`);

    if (/^\d+$/.test(group.revision)) {
      add(`${group.partNumber}-${group.revision.padStart(2, "0")}`);
      add(`${group.partNumber}-${String(Number.parseInt(group.revision, 10))}`);
    }
  }

  EXPLICIT_FILE_STEM_ALIASES[buildGroupKey(group.batch, group.partNumber, group.revision)]?.forEach(add);

  return [...aliases];
}

function buildPrimaryNormalizedStem(group: SpreadsheetGroup): string {
  return normalizeToken(buildPreferredStemLabel(group));
}

function inferFileKindFromExtension(fileName: string): "cad" | "drawing" | "other" {
  const extension = path.extname(fileName).toLowerCase();

  if (ALLOWED_DRAWING_EXTENSIONS.has(extension)) {
    return "drawing";
  }

  if (ALLOWED_CAD_EXTENSIONS.has(extension)) {
    return "cad";
  }

  return "other";
}

async function listBatchFiles(rootPath: string, batch: string): Promise<LocalImportFile[]> {
  const batchPath = path.join(rootPath, batch);
  const entries = await fs.readdir(batchPath, { withFileTypes: true });
  const files: LocalImportFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".") || entry.name === "Icon\r") {
      continue;
    }

    const fileKind = inferFileKindFromExtension(entry.name);

    if (fileKind === "other") {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    const stem = entry.name.slice(0, -extension.length);
    files.push({
      absolutePath: path.join(batchPath, entry.name),
      relativePath: path.join(batch, entry.name),
      originalName: entry.name,
      originalStem: stem,
      extension,
      fileKind,
      normalizedStem: normalizeToken(stem),
    });
  }

  return files.sort((left, right) => left.originalName.localeCompare(right.originalName));
}

export function assignFilesToGroups(
  groups: SpreadsheetGroup[],
  files: LocalImportFile[],
): FileAssignment[] {
  const assignments = new Map<string, LocalImportFile[]>(
    groups.map((group) => [buildGroupKey(group.batch, group.partNumber, group.revision), []]),
  );
  const ownerByFile = new Map<string, string>();

  for (const group of groups) {
    const aliases = new Set(buildGroupStemAliases(group));
    const groupKey = buildGroupKey(group.batch, group.partNumber, group.revision);

    for (const file of files) {
      if (!aliases.has(file.normalizedStem)) {
        continue;
      }

      const existingOwner = ownerByFile.get(file.relativePath);

      if (existingOwner && existingOwner !== groupKey) {
        throw new Error(
          `File ${file.relativePath} matched multiple groups: ${existingOwner} and ${groupKey}.`,
        );
      }

      ownerByFile.set(file.relativePath, groupKey);
      assignments.set(groupKey, [...(assignments.get(groupKey) ?? []), file]);
    }
  }

  return groups.map((group) => {
    const key = buildGroupKey(group.batch, group.partNumber, group.revision);
    const matchedFiles = assignments.get(key) ?? [];

    if (matchedFiles.length === 0) {
      throw new Error(`No files matched ${group.batch} ${group.partNumber}${group.revision ? ` rev ${group.revision}` : ""}.`);
    }

    return {
      group,
      files: matchedFiles,
    };
  });
}

function buildOfferId(vendor: SupportedVendor, row: Row): string {
  const pieces = [vendor, row.Sourcing ?? "default", row.Tier ?? "default"]
    .map((piece) => piece.toLowerCase().replace(/[^a-z0-9]+/g, "-"))
    .filter(Boolean);

  return pieces.join(":");
}

function buildLaneLabel(row: { Sourcing?: string | null; Tier?: string | null; Supplier?: string | null }): string {
  return [row.Sourcing, row.Tier].filter(Boolean).join(" / ") || row.Supplier || "Default lane";
}

function buildImportedOffer(group: SpreadsheetGroup, vendor: SupportedVendor, row: SupportedRow): ImportedOffer {
  const requestedQuantity = Math.max(Number.parseInt(row.Qty ?? "1", 10) || 1, 1);

  return {
    offerId: buildOfferId(vendor, row),
    supplier: row.Supplier,
    laneLabel: buildLaneLabel(row),
    requestedQuantity,
    sourcing: row.Sourcing ?? null,
    tier: row.Tier ?? null,
    quoteRef: row["Quote Ref"] ?? null,
    quoteDateIso: excelSerialToIso(row["Quote Date"]),
    status: row.Status ?? null,
    totalPriceUsd: parseMoney(row["Total Price"]),
    unitPriceUsd: parseMoney(row["Unit Price"]),
    leadTimeBusinessDays: parseLeadTimeDays(row),
    shipReceiveBy: row["Ship/Receive By"] ?? null,
    dueDate: row["Due Date"] ?? null,
    process: row.Process ?? null,
    material: row.Material ?? null,
    finish: row.Finish ?? null,
    tightestTolerance: row["Tightest Tolerance"] ?? null,
    toleranceSource: row["Tolerance Source"] ?? null,
    threadCallouts: row["Thread Callouts"] ?? null,
    threadMatchNotes: row["Thread Match Notes"] ?? null,
    notes: row.Notes ?? null,
  };
}

function normalizeMaterial(rows: Row[]): string {
  const materials = rows
    .map((row) => row.Material?.trim())
    .filter((value): value is string => Boolean(value));

  const preferred = materials.find((value) => /6061/i.test(value));
  return preferred ?? materials[0] ?? "6061 Aluminum";
}

function normalizeFinish(rows: Row[]): string | null {
  const finishes = rows
    .map((row) => row.Finish?.trim())
    .filter((value): value is string => Boolean(value) && value !== "-");

  return finishes[0] ?? null;
}

function normalizeDescription(rows: Row[]): string {
  return rows[0]?.Description?.trim() ?? "Imported quote";
}

function buildJobTitle(group: SpreadsheetGroup): string {
  return group.revision ? `${group.partNumber} rev ${group.revision}` : group.partNumber;
}

function buildJobTags(batch: string): string[] {
  return [IMPORT_TAG, `quote-batch:${batch.toLowerCase()}`];
}

function buildProjectDescription(rfq: RfqRecord): string {
  const lines = [
    `${PROJECT_MARKER_PREFIX}${rfq.batch} from Quotes Spreadsheet - Improved.xlsx.`,
    rfq.client ? `Client: ${rfq.client}` : null,
    rfq.clientContact ? `Client contact: ${rfq.clientContact}` : null,
    rfq.rfqReceived ? `RFQ received: ${rfq.rfqReceived}` : null,
    rfq.quoteDue ? `Quote due: ${rfq.quoteDue}` : null,
    rfq.dateQuoted ? `Date quoted: ${rfq.dateQuoted}` : null,
    rfq.poReceived ? `PO received: ${rfq.poReceived}` : null,
    rfq.status ? `Status: ${rfq.status}` : null,
    rfq.partCount !== null ? `Part count: ${rfq.partCount}` : null,
    rfq.totalQuoted !== null ? `Total quoted: ${rfq.totalQuoted.toFixed(2)}` : null,
    rfq.notes ? `Notes: ${rfq.notes}` : null,
  ].filter((value): value is string => Boolean(value));

  return lines.join("\n");
}

function buildClientSummary(group: SpreadsheetGroup): string {
  return `Curated CNC machining options for ${group.partNumber}${group.revision ? ` rev ${group.revision}` : ""}, based on approved requirements and confirmed supplier coverage.`;
}

function buildOptionComparisonSummary(kind: "lowest_cost" | "fastest_delivery" | "balanced"): string {
  switch (kind) {
    case "lowest_cost":
      return "Lowest total price across confirmed machining options.";
    case "fastest_delivery":
      return "Shortest confirmed lead time across the available options.";
    case "balanced":
    default:
      return "Best price among options that remain within two business days of the fastest delivery lane.";
  }
}

function markup(rawAmount: number, markupPercent = 20, minorUnit = 0.01): number {
  const divisor = Math.max(minorUnit, 0.0001);
  return Math.round(Math.ceil((rawAmount * (1 + markupPercent / 100)) / divisor) * divisor * 100) / 100;
}

function buildStoragePath(organizationId: string, contentSha256: string, originalName: string): string {
  const safeName =
    originalName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-|-$/g, "") || "file";

  return `org-sha256/${organizationId}/${contentSha256.toLowerCase()}/${safeName}`;
}

function fileLooksLikeLegacyDmriflesDraft(job: WorkspaceJob, files: WorkspaceJobFile[]): boolean {
  if (job.source !== "client_home" || job.title !== "1093-05589-02" || files.length !== 2) {
    return false;
  }

  const names = files.map((file) => file.original_name).sort();
  return names[0] === "1093-05589-02.STEP" && names[1] === "1093-05589-02.pdf";
}

export function findCleanupCandidates(input: {
  jobs: WorkspaceJob[];
  jobFiles: WorkspaceJobFile[];
  projects: WorkspaceProject[];
}): CleanupCandidates {
  const importProjectIds = new Set(
    input.projects
      .filter((project) => project.description?.includes(PROJECT_MARKER_PREFIX))
      .map((project) => project.id),
  );
  const filesByJobId = new Map<string, WorkspaceJobFile[]>();

  input.jobFiles.forEach((file) => {
    filesByJobId.set(file.job_id, [...(filesByJobId.get(file.job_id) ?? []), file]);
  });

  const jobIds = new Set<string>();

  input.jobs.forEach((job) => {
    const tags = new Set(job.tags ?? []);

    if (
      tags.has(IMPORT_TAG) ||
      job.source.startsWith("spreadsheet_import:") ||
      (job.project_id !== null && importProjectIds.has(job.project_id)) ||
      fileLooksLikeLegacyDmriflesDraft(job, filesByJobId.get(job.id) ?? [])
    ) {
      jobIds.add(job.id);
    }
  });

  return {
    jobIds: [...jobIds],
    projectIds: [...importProjectIds],
  };
}

async function ensureEnvironmentLoaded() {
  const { config: loadDotenv } = await import("dotenv");
  const toolDir = path.dirname(fileURLToPath(import.meta.url));
  const workerRoot = path.resolve(toolDir, "../..");
  const repoRoot = path.resolve(workerRoot, "..");

  loadDotenv({ path: path.join(repoRoot, ".env") });
  loadDotenv({ path: path.join(workerRoot, ".env") });

  process.env.SUPABASE_URL ||= process.env.VITE_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
}

function parseArgs(): ImportArgs {
  const args = process.argv.slice(2);
  const result: ImportArgs = {
    rootPath: "",
    workbookPath: "",
    accountEmail: DEFAULT_ACCOUNT_EMAIL,
    internalUserEmail: DEFAULT_INTERNAL_USER_EMAIL,
    batchMode: "project",
    cleanupMode: "replace",
    unsupportedMode: "skip",
    dryRun: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case "--root":
        result.rootPath = next;
        index += 1;
        break;
      case "--workbook":
        result.workbookPath = next;
        index += 1;
        break;
      case "--account":
        result.accountEmail = next;
        index += 1;
        break;
      case "--internal-user-email":
        result.internalUserEmail = next;
        index += 1;
        break;
      case "--batch-mode":
        if (next !== "project") {
          throw new Error(`Unsupported --batch-mode value: ${next}`);
        }
        result.batchMode = next;
        index += 1;
        break;
      case "--cleanup":
        if (next !== "replace") {
          throw new Error(`Unsupported --cleanup value: ${next}`);
        }
        result.cleanupMode = next;
        index += 1;
        break;
      case "--unsupported":
        if (next !== "skip") {
          throw new Error(`Unsupported --unsupported value: ${next}`);
        }
        result.unsupportedMode = next;
        index += 1;
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!result.workbookPath) {
    throw new Error("Provide --workbook <path-to-xlsx>.");
  }

  if (!result.rootPath) {
    result.rootPath = path.dirname(result.workbookPath);
  }

  return result;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const content = await fs.readFile(filePath);
  hash.update(content);
  return hash.digest("hex");
}

async function resolveUserIdByEmail(
  supabase: SupabaseClient,
  email: string,
): Promise<string> {
  const { data, error } = await supabase.auth.admin.listUsers();

  if (error || !data?.users) {
    throw error ?? new Error("Unable to list auth users.");
  }

  const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email.toLowerCase());

  if (!user) {
    throw new Error(`Auth user ${email} was not found.`);
  }

  return user.id;
}

async function resolveOrganizationIdForClient(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("organization_memberships")
    .select("organization_id, role")
    .eq("user_id", userId)
    .eq("role", "client");

  if (error) {
    throw error;
  }

  if (!data || data.length !== 1) {
    throw new Error(`Expected exactly one client membership for user ${userId}.`);
  }

  return data[0].organization_id;
}

async function ensureInternalMembership(
  supabase: SupabaseClient,
  organizationId: string,
  userId: string,
) {
  const { error } = await supabase
    .from("organization_memberships")
    .upsert(
      {
        organization_id: organizationId,
        user_id: userId,
        role: "internal_admin",
      },
      { onConflict: "organization_id,user_id" },
    );

  if (error) {
    throw error;
  }
}

async function getActivePricingPolicy(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ id: string; version: string; markup_percent: number | string; currency_minor_unit: number | string }> {
  const { data, error } = await supabase
    .from("pricing_policies")
    .select("id, version, markup_percent, currency_minor_unit")
    .or(`organization_id.eq.${organizationId},organization_id.is.null`)
    .eq("is_active", true)
    .order("organization_id", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    throw error ?? new Error(`No active pricing policy found for org ${organizationId}.`);
  }

  return data;
}

async function insertAuditEvent(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    actorUserId: string | null;
    eventType: string;
    payload?: Record<string, unknown>;
    jobId?: string | null;
    packageId?: string | null;
  },
) {
  const { error } = await supabase.from("audit_events").insert({
    organization_id: input.organizationId,
    actor_user_id: input.actorUserId,
    job_id: input.jobId ?? null,
    package_id: input.packageId ?? null,
    event_type: input.eventType,
    payload: input.payload ?? {},
  });

  if (error) {
    throw error;
  }
}

async function loadWorkspaceState(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{
  jobs: WorkspaceJob[];
  jobFiles: WorkspaceJobFile[];
  projects: WorkspaceProject[];
}> {
  const [jobsResult, jobFilesResult, projectsResult] = await Promise.all([
    supabase
      .from("jobs")
      .select("id, title, source, project_id, tags")
      .eq("organization_id", organizationId),
    supabase
      .from("job_files")
      .select("id, job_id, blob_id, storage_bucket, storage_path, normalized_name, original_name")
      .eq("organization_id", organizationId),
    supabase
      .from("projects")
      .select("id, name, description")
      .eq("organization_id", organizationId),
  ]);

  if (jobsResult.error) {
    throw jobsResult.error;
  }

  if (jobFilesResult.error) {
    throw jobFilesResult.error;
  }

  if (projectsResult.error) {
    throw projectsResult.error;
  }

  return {
    jobs: (jobsResult.data ?? []) as WorkspaceJob[],
    jobFiles: (jobFilesResult.data ?? []) as WorkspaceJobFile[],
    projects: (projectsResult.data ?? []) as WorkspaceProject[],
  };
}

async function cleanupExistingRecords(
  supabase: SupabaseClient,
  organizationId: string,
  candidates: CleanupCandidates,
): Promise<{ deletedJobs: number; deletedProjects: number }> {
  if (candidates.jobIds.length === 0 && candidates.projectIds.length === 0) {
    return { deletedJobs: 0, deletedProjects: 0 };
  }

  const { data: jobFiles, error: filesError } = await supabase
    .from("job_files")
    .select("id, job_id, blob_id, storage_bucket, storage_path")
    .eq("organization_id", organizationId)
    .in("job_id", candidates.jobIds.length > 0 ? candidates.jobIds : ["00000000-0000-0000-0000-000000000000"]);

  if (filesError) {
    throw filesError;
  }

  const blobsById = new Map<string, { storage_bucket: string; storage_path: string }>();
  (jobFiles ?? []).forEach((file) => {
    if (file.blob_id) {
      blobsById.set(file.blob_id, {
        storage_bucket: file.storage_bucket,
        storage_path: file.storage_path,
      });
    }
  });

  if (candidates.jobIds.length > 0) {
    const { error: deleteJobsError } = await supabase.from("jobs").delete().in("id", candidates.jobIds);

    if (deleteJobsError) {
      throw deleteJobsError;
    }
  }

  for (const [blobId, blob] of blobsById.entries()) {
    const { count, error: countError } = await supabase
      .from("job_files")
      .select("id", { count: "exact", head: true })
      .eq("blob_id", blobId);

    if (countError) {
      throw countError;
    }

    if ((count ?? 0) > 0) {
      continue;
    }

    const { error: storageError } = await supabase.storage
      .from(blob.storage_bucket)
      .remove([blob.storage_path]);

    if (storageError) {
      throw storageError;
    }

    const { error: blobDeleteError } = await supabase
      .from("organization_file_blobs")
      .delete()
      .eq("id", blobId);

    if (blobDeleteError) {
      throw blobDeleteError;
    }
  }

  if (candidates.projectIds.length > 0) {
    const { data: projectJobs, error: projectJobsError } = await supabase
      .from("project_jobs")
      .select("project_id")
      .in("project_id", candidates.projectIds);

    if (projectJobsError) {
      throw projectJobsError;
    }

    const occupied = new Set((projectJobs ?? []).map((row) => row.project_id));
    const deletableProjectIds = candidates.projectIds.filter((projectId) => !occupied.has(projectId));

    if (deletableProjectIds.length > 0) {
      const { error: deleteProjectsError } = await supabase
        .from("projects")
        .delete()
        .in("id", deletableProjectIds);

      if (deleteProjectsError) {
        throw deleteProjectsError;
      }
    }
  }

  return {
    deletedJobs: candidates.jobIds.length,
    deletedProjects: candidates.projectIds.length,
  };
}

async function createProject(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    ownerUserId: string;
    rfq: RfqRecord;
  },
): Promise<ProjectInsertResult> {
  const { data, error } = await supabase
    .from("projects")
    .insert({
      organization_id: input.organizationId,
      owner_user_id: input.ownerUserId,
      name: input.rfq.projectSystem ?? input.rfq.batch,
      description: buildProjectDescription(input.rfq),
    })
    .select("id, name")
    .single();

  if (error || !data) {
    throw error ?? new Error(`Failed to create project for ${input.rfq.batch}.`);
  }

  const { error: membershipError } = await supabase
    .from("project_memberships")
    .upsert(
      {
        project_id: data.id,
        user_id: input.ownerUserId,
        role: "owner",
      },
      { onConflict: "project_id,user_id" },
    );

  if (membershipError) {
    throw membershipError;
  }

  await insertAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorUserId: input.ownerUserId,
    eventType: "project.created",
    payload: {
      projectId: data.id,
      name: data.name,
      batch: input.rfq.batch,
    },
  });

  return data;
}

async function createJob(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    createdBy: string;
    projectId: string;
    pricingPolicyId: string;
    rfq: RfqRecord;
    group: SpreadsheetGroup;
  },
): Promise<JobInsertResult> {
  const requestedQuantity = Math.max(Number.parseInt(input.group.rows[0].Qty ?? "1", 10) || 1, 1);
  const title = buildJobTitle(input.group);
  const description = normalizeDescription(input.group.rows);

  const { data, error } = await supabase
    .from("jobs")
    .insert({
      organization_id: input.organizationId,
      created_by: input.createdBy,
      title,
      description,
      status: "uploaded",
      source: "shared_project",
      active_pricing_policy_id: input.pricingPolicyId,
      tags: buildJobTags(input.group.batch),
      project_id: input.projectId,
      requested_service_kinds: ["manufacturing_quote"],
      primary_service_kind: "manufacturing_quote",
      requested_quote_quantities: [requestedQuantity],
      requested_by_date: input.rfq.quoteDue,
    })
    .select("id, title")
    .single();

  if (error || !data) {
    throw error ?? new Error(`Failed to create job for ${title}.`);
  }

  const { error: projectJobError } = await supabase
    .from("project_jobs")
    .insert({
      project_id: input.projectId,
      job_id: data.id,
      created_by: input.createdBy,
    });

  if (projectJobError) {
    throw projectJobError;
  }

  await insertAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorUserId: input.createdBy,
    jobId: data.id,
    eventType: "job.created",
    payload: {
      title,
      source: "shared_project",
      batch: input.group.batch,
      requestedServiceKinds: ["manufacturing_quote"],
      primaryServiceKind: "manufacturing_quote",
      requestedQuoteQuantities: [requestedQuantity],
      requestedByDate: input.rfq.quoteDue,
    },
  });

  return {
    id: data.id,
    title: data.title,
    batch: input.group.batch,
    partNumber: input.group.partNumber,
    revision: input.group.revision,
    status: "uploaded",
  };
}

async function attachFileToJob(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    uploadedBy: string;
    jobId: string;
    normalizedStem: string;
    file: LocalImportFile;
  },
): Promise<{ id: string; file_kind: "cad" | "drawing"; normalized_name: string }> {
  const contentSha256 = await hashFile(input.file.absolutePath);
  const sizeBytes = (await fs.stat(input.file.absolutePath)).size;
  const { data: existingBlob, error: existingBlobError } = await supabase
    .from("organization_file_blobs")
    .select("id, storage_bucket, storage_path, size_bytes, mime_type")
    .eq("organization_id", input.organizationId)
    .eq("content_sha256", contentSha256)
    .maybeSingle();

  if (existingBlobError) {
    throw existingBlobError;
  }

  let blobId = existingBlob?.id ?? null;
  const storageBucket = existingBlob?.storage_bucket ?? "job-files";
  const storagePath = existingBlob?.storage_path ?? buildStoragePath(input.organizationId, contentSha256, input.file.originalName);

  if (!existingBlob) {
    const content = await fs.readFile(input.file.absolutePath);
    const { error: storageError } = await supabase.storage
      .from(storageBucket)
      .upload(storagePath, content, {
        upsert: false,
      });

    if (storageError) {
      throw storageError;
    }

    const { data: insertedBlob, error: insertBlobError } = await supabase
      .from("organization_file_blobs")
      .insert({
        organization_id: input.organizationId,
        content_sha256: contentSha256,
        storage_bucket: storageBucket,
        storage_path: storagePath,
        size_bytes: sizeBytes,
        mime_type: null,
      })
      .select("id")
      .single();

    if (insertBlobError || !insertedBlob) {
      throw insertBlobError ?? new Error(`Failed to create blob for ${input.file.relativePath}.`);
    }

    blobId = insertedBlob.id;
  }

  const { data: jobFile, error: jobFileError } = await supabase
    .from("job_files")
    .insert({
      job_id: input.jobId,
      organization_id: input.organizationId,
      uploaded_by: input.uploadedBy,
      blob_id: blobId,
      content_sha256: contentSha256,
      storage_bucket: storageBucket,
      storage_path: storagePath,
      original_name: input.file.originalName,
      normalized_name: input.normalizedStem,
      file_kind: input.file.fileKind,
      matched_part_key: null,
      mime_type: null,
      size_bytes: sizeBytes,
    })
    .select("id, file_kind, normalized_name")
    .single();

  if (jobFileError || !jobFile) {
    throw jobFileError ?? new Error(`Failed to attach ${input.file.relativePath} to job ${input.jobId}.`);
  }

  await insertAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorUserId: input.uploadedBy,
    jobId: input.jobId,
    eventType: "job.file_attached",
    payload: {
      fileId: jobFile.id,
      originalName: input.file.originalName,
      kind: input.file.fileKind,
      dedupe: existingBlob ? "reused" : "uploaded",
    },
  });

  return jobFile;
}

async function reconcileSinglePartJob(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    jobId: string;
    group: SpreadsheetGroup;
    requestedQuantity: number;
    normalizedStem: string;
    files: { id: string; file_kind: "cad" | "drawing"; normalized_name: string }[];
    actorUserId: string;
  },
): Promise<{ id: string; normalized_key: string }> {
  const cadFile = input.files.find((file) => file.file_kind === "cad") ?? null;
  const drawingFile = input.files.find((file) => file.file_kind === "drawing") ?? null;

  const { data: part, error: partError } = await supabase
    .from("parts")
    .upsert(
      {
        job_id: input.jobId,
        organization_id: input.organizationId,
        name: buildJobTitle(input.group),
        normalized_key: input.normalizedStem,
        cad_file_id: cadFile?.id ?? null,
        drawing_file_id: drawingFile?.id ?? null,
        quantity: input.requestedQuantity,
      },
      { onConflict: "job_id,normalized_key" },
    )
    .select("id, normalized_key")
    .single();

  if (partError || !part) {
    throw partError ?? new Error(`Failed to reconcile part for job ${input.jobId}.`);
  }

  const { error: updateFilesError } = await supabase
    .from("job_files")
    .update({
      matched_part_key: input.normalizedStem,
      normalized_name: input.normalizedStem,
    })
    .eq("job_id", input.jobId);

  if (updateFilesError) {
    throw updateFilesError;
  }

  await insertAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    jobId: input.jobId,
    eventType: "job.parts_reconciled",
    payload: {
      totalParts: 1,
      matchedPairs: cadFile && drawingFile ? 1 : 0,
      missingDrawings: cadFile && !drawingFile ? 1 : 0,
      missingCad: !cadFile && drawingFile ? 1 : 0,
    },
  });

  return part;
}

async function upsertExtractionAndRequirements(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    approverUserId: string;
    partId: string;
    group: SpreadsheetGroup;
    requestedQuantity: number;
    requestedByDate: string | null;
  },
) {
  const description = normalizeDescription(input.group.rows);
  const material = normalizeMaterial(input.group.rows);
  const finish = normalizeFinish(input.group.rows);
  const tightestTolerance = parseTolerance(input.group.rows[0]["Tightest Tolerance"]);
  const supportedRows = getSupportedRows(input.group.rows);
  const applicableVendors = Array.from(
    new Set(supportedRows.map((row) => SUPPORTED_VENDOR_MAP[row.Supplier])),
  );

  const extractionPayload = {
    description,
    partNumber: input.group.partNumber,
    revision: input.group.revision,
    extractedDescriptionRaw: {
      value: description,
      confidence: 0.99,
      reviewNeeded: false,
      reasons: ["imported_spreadsheet"],
      sourceRegion: null,
    },
    extractedPartNumberRaw: {
      value: input.group.partNumber,
      confidence: 0.99,
      reviewNeeded: false,
      reasons: ["imported_spreadsheet"],
      sourceRegion: null,
    },
    extractedRevisionRaw: {
      value: input.group.revision,
      confidence: input.group.revision ? 0.99 : 0.5,
      reviewNeeded: false,
      reasons: ["imported_spreadsheet"],
      sourceRegion: null,
    },
    extractedFinishRaw: {
      value: finish,
      confidence: finish ? 0.96 : 0.5,
      reviewNeeded: false,
      reasons: ["imported_spreadsheet"],
      sourceRegion: null,
    },
    quoteDescription: description,
    quoteFinish: finish,
    pageCount: 1,
    reviewFields: [],
    material: {
      raw: material,
      normalized: material,
      confidence: 0.99,
      reviewNeeded: false,
      reasons: ["imported_spreadsheet"],
    },
    finish: {
      raw: finish,
      normalized: finish,
      confidence: finish ? 0.96 : 0.5,
      reviewNeeded: false,
      reasons: ["imported_spreadsheet"],
    },
    tolerances: {
      tightest: input.group.rows[0]["Tightest Tolerance"] ?? null,
      valueInch: tightestTolerance,
      confidence: tightestTolerance ? 0.98 : 0.5,
    },
  };

  const { error: extractionError } = await supabase
    .from("drawing_extractions")
    .upsert(
      {
        part_id: input.partId,
        organization_id: input.organizationId,
        extractor_version: "dmrifles-import-v1",
        extraction: extractionPayload,
        confidence: 0.99,
        warnings: [`Imported from Quotes Spreadsheet - Improved.xlsx batch ${input.group.batch}.`],
        evidence: [
          {
            field: "partNumber",
            page: 1,
            snippet: input.group.partNumber,
            confidence: 0.99,
            reasons: ["imported_spreadsheet"],
          },
          {
            field: "material",
            page: 1,
            snippet: material,
            confidence: 0.98,
            reasons: ["imported_spreadsheet"],
          },
          {
            field: "finish",
            page: 1,
            snippet: finish ?? "No finish",
            confidence: finish ? 0.95 : 0.5,
            reasons: ["imported_spreadsheet"],
          },
        ],
        status: "approved",
      },
      { onConflict: "part_id" },
    );

  if (extractionError) {
    throw extractionError;
  }

  const { error: requirementError } = await supabase
    .from("approved_part_requirements")
    .upsert(
      {
        part_id: input.partId,
        organization_id: input.organizationId,
        approved_by: input.approverUserId,
        description,
        part_number: input.group.partNumber,
        revision: input.group.revision,
        material,
        finish,
        tightest_tolerance_inch: tightestTolerance,
        quantity: input.requestedQuantity,
        quote_quantities: [input.requestedQuantity],
        requested_by_date: input.requestedByDate,
        applicable_vendors: applicableVendors,
        spec_snapshot: {
          importedBatch: input.group.batch,
          quoteDescription: description,
          quoteFinish: finish,
          partNumber: input.group.partNumber,
          revision: input.group.revision,
          process: input.group.rows[0].Process ?? null,
          notes: input.group.rows[0].Notes ?? null,
          fieldSources: {
            description: "imported",
            partNumber: "imported",
            revision: "imported",
            finish: "imported",
          },
          fieldOverrides: {
            description: false,
            partNumber: false,
            revision: false,
            finish: false,
          },
          toleranceSource: input.group.rows[0]["Tolerance Source"] ?? null,
          threadCallouts: input.group.rows[0]["Thread Callouts"] ?? null,
          threadMatchNotes: input.group.rows[0]["Thread Match Notes"] ?? null,
        },
      },
      { onConflict: "part_id" },
    );

  if (requirementError) {
    throw requirementError;
  }
}

async function publishSupportedQuotes(
  supabase: SupabaseClient,
  input: {
    workbookPath: string;
    organizationId: string;
    jobId: string;
    partId: string;
    group: SpreadsheetGroup;
    initiatedBy: string;
    publishedBy: string;
    pricingPolicy: { id: string; version: string; markup_percent: number | string; currency_minor_unit: number | string };
  },
): Promise<string | null> {
  const supportedRows = getSupportedRows(input.group.rows);

  if (supportedRows.length === 0) {
    return null;
  }

  const requestedQuantity = Math.max(Number.parseInt(input.group.rows[0].Qty ?? "1", 10) || 1, 1);
  const { data: quoteRun, error: quoteRunError } = await supabase
    .from("quote_runs")
    .insert({
      job_id: input.jobId,
      organization_id: input.organizationId,
      initiated_by: input.initiatedBy,
      status: "published",
      requested_auto_publish: false,
    })
    .select("id")
    .single();

  if (quoteRunError || !quoteRun) {
    throw quoteRunError ?? new Error(`Failed to create quote run for ${input.group.partNumber}.`);
  }

  const offersByVendor = new Map<SupportedVendor, ImportedOffer[]>();

  for (const row of supportedRows) {
    const vendor = SUPPORTED_VENDOR_MAP[row.Supplier];
    const offer = buildImportedOffer(input.group, vendor, row);
    offersByVendor.set(vendor, [...(offersByVendor.get(vendor) ?? []), offer]);
  }

  const allOfferCandidates: ImportedOptionCandidate[] = [];

  for (const [vendor, offers] of offersByVendor.entries()) {
    offers.sort((left, right) => left.totalPriceUsd - right.totalPriceUsd);
    const summaryOffer = offers[0];

    const { data: result, error: resultError } = await supabase
      .from("vendor_quote_results")
      .insert({
        quote_run_id: quoteRun.id,
        part_id: input.partId,
        organization_id: input.organizationId,
        vendor,
        requested_quantity: requestedQuantity,
        status: "official_quote_received",
        unit_price_usd: summaryOffer.unitPriceUsd,
        total_price_usd: summaryOffer.totalPriceUsd,
        lead_time_business_days: summaryOffer.leadTimeBusinessDays,
        quote_url: null,
        dfm_issues: offers
          .map((offer) => offer.notes)
          .filter((note): note is string => typeof note === "string" && /sharp internal corners|tool radius/i.test(note)),
        notes: [`Imported from Quotes Spreadsheet - Improved.xlsx batch ${input.group.batch}.`],
        raw_payload: {
          source: "dmrifles-import",
          workbookPath: input.workbookPath,
          batch: input.group.batch,
          partNumber: input.group.partNumber,
          revision: input.group.revision,
          requestedQuantity,
          offerCount: offers.length,
          summaryOfferKey: summaryOffer.offerId,
          offers,
        },
      })
      .select("id")
      .single();

    if (resultError || !result) {
      throw resultError ?? new Error(`Failed to create vendor result for ${vendor}.`);
    }

    const { data: offerRows, error: offerError } = await supabase
      .from("vendor_quote_offers")
      .insert(
        offers.map((offer, sortIndex) => ({
          vendor_quote_result_id: result.id,
          organization_id: input.organizationId,
          offer_key: offer.offerId,
          supplier: offer.supplier,
          lane_label: offer.laneLabel,
          sourcing: offer.sourcing,
          tier: offer.tier,
          quote_ref: offer.quoteRef,
          quote_date: offer.quoteDateIso,
          unit_price_usd: offer.unitPriceUsd,
          total_price_usd: offer.totalPriceUsd,
          lead_time_business_days: offer.leadTimeBusinessDays,
          ship_receive_by: offer.shipReceiveBy,
          due_date: offer.dueDate,
          process: offer.process,
          material: offer.material,
          finish: offer.finish,
          tightest_tolerance: offer.tightestTolerance,
          tolerance_source: offer.toleranceSource,
          thread_callouts: offer.threadCallouts,
          thread_match_notes: offer.threadMatchNotes,
          notes: offer.notes,
          sort_rank: sortIndex,
          raw_payload: offer,
        })),
      )
      .select("id, total_price_usd, lead_time_business_days");

    if (offerError || !offerRows) {
      throw offerError ?? new Error(`Failed to create offer rows for ${vendor}.`);
    }

    offerRows.forEach((offerRow) => {
      allOfferCandidates.push({
        vendor,
        vendorQuoteId: result.id,
        offerRowId: offerRow.id,
        totalPriceUsd: Number(offerRow.total_price_usd ?? 0),
        leadTimeBusinessDays: offerRow.lead_time_business_days,
        requestedQuantity,
      });
    });
  }

  const fastestOffer =
    [...allOfferCandidates]
      .filter((offer) => offer.leadTimeBusinessDays !== null)
      .sort((left, right) => {
        if (left.leadTimeBusinessDays !== right.leadTimeBusinessDays) {
          return (left.leadTimeBusinessDays ?? Number.MAX_SAFE_INTEGER) - (right.leadTimeBusinessDays ?? Number.MAX_SAFE_INTEGER);
        }

        return left.totalPriceUsd - right.totalPriceUsd;
      })[0] ?? null;
  const lowestOffer = [...allOfferCandidates].sort((left, right) => left.totalPriceUsd - right.totalPriceUsd)[0] ?? null;
  const balancedOffer =
    [...allOfferCandidates]
      .filter((offer) =>
        fastestOffer?.leadTimeBusinessDays === null || fastestOffer?.leadTimeBusinessDays === undefined
          ? true
          : (offer.leadTimeBusinessDays ?? Number.MAX_SAFE_INTEGER) <= fastestOffer.leadTimeBusinessDays + 2,
      )
      .sort((left, right) => left.totalPriceUsd - right.totalPriceUsd)[0] ?? null;

  if (!lowestOffer || !fastestOffer || !balancedOffer) {
    throw new Error(`Unable to determine client options for ${input.group.partNumber}.`);
  }

  const { data: packageRow, error: packageError } = await supabase
    .from("published_quote_packages")
    .insert({
      job_id: input.jobId,
      quote_run_id: quoteRun.id,
      organization_id: input.organizationId,
      published_by: input.publishedBy,
      pricing_policy_id: input.pricingPolicy.id,
      auto_published: false,
      client_summary: buildClientSummary(input.group),
    })
    .select("id")
    .single();

  if (packageError || !packageRow) {
    throw packageError ?? new Error(`Failed to publish package for ${input.group.partNumber}.`);
  }

  const optionCandidates = [
    {
      option_kind: "lowest_cost" as const,
      label: "Lowest Cost",
      offer: lowestOffer,
    },
    {
      option_kind: "fastest_delivery" as const,
      label: "Fastest Delivery",
      offer: fastestOffer,
    },
    {
      option_kind: "balanced" as const,
      label: "Balanced",
      offer: balancedOffer,
    },
  ];
  const seenOfferIds = new Set<string>();

  for (const option of optionCandidates) {
    if (seenOfferIds.has(option.offer.offerRowId)) {
      continue;
    }

    seenOfferIds.add(option.offer.offerRowId);

    const { error: optionError } = await supabase
      .from("published_quote_options")
      .insert({
        package_id: packageRow.id,
        organization_id: input.organizationId,
        option_kind: option.option_kind,
        label: option.label,
        requested_quantity: option.offer.requestedQuantity,
        published_price_usd: markup(
          option.offer.totalPriceUsd,
          Number(input.pricingPolicy.markup_percent),
          Number(input.pricingPolicy.currency_minor_unit),
        ),
        lead_time_business_days: option.offer.leadTimeBusinessDays,
        comparison_summary: buildOptionComparisonSummary(option.option_kind),
        source_vendor_quote_id: option.offer.vendorQuoteId,
        source_vendor_quote_offer_id: option.offer.offerRowId,
        markup_policy_version: input.pricingPolicy.version,
      });

    if (optionError) {
      throw optionError;
    }
  }

  await insertAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorUserId: input.publishedBy,
    jobId: input.jobId,
    packageId: packageRow.id,
    eventType: "job.quote_package_published",
    payload: {
      quoteRunId: quoteRun.id,
      autoPublished: false,
    },
  });

  return packageRow.id;
}

async function setJobStatus(
  supabase: SupabaseClient,
  jobId: string,
  status: "ready_to_quote" | "published",
) {
  const { error } = await supabase
    .from("jobs")
    .update({
      status,
    })
    .eq("id", jobId);

  if (error) {
    throw error;
  }
}

async function importGroup(
  supabase: SupabaseClient,
  input: {
    workbookPath: string;
    organizationId: string;
    project: ProjectInsertResult;
    rfq: RfqRecord;
    group: SpreadsheetGroup;
    files: LocalImportFile[];
    clientUserId: string;
    internalUserId: string;
    pricingPolicy: { id: string; version: string; markup_percent: number | string; currency_minor_unit: number | string };
  },
): Promise<JobInsertResult & { packageId: string | null; fileCount: number }> {
  const job = await createJob(supabase, {
    organizationId: input.organizationId,
    createdBy: input.clientUserId,
    projectId: input.project.id,
    pricingPolicyId: input.pricingPolicy.id,
    rfq: input.rfq,
    group: input.group,
  });
  const requestedQuantity = Math.max(Number.parseInt(input.group.rows[0].Qty ?? "1", 10) || 1, 1);
  const normalizedStem = buildPrimaryNormalizedStem(input.group);
  const attachedFiles = [];

  for (const file of input.files) {
    const attachedFile = await attachFileToJob(supabase, {
      organizationId: input.organizationId,
      uploadedBy: input.clientUserId,
      jobId: job.id,
      normalizedStem,
      file,
    });

    attachedFiles.push(attachedFile);
  }

  const part = await reconcileSinglePartJob(supabase, {
    organizationId: input.organizationId,
    jobId: job.id,
    group: input.group,
    requestedQuantity,
    normalizedStem,
    files: attachedFiles,
    actorUserId: input.clientUserId,
  });

  await upsertExtractionAndRequirements(supabase, {
    organizationId: input.organizationId,
    approverUserId: input.internalUserId,
    partId: part.id,
    group: input.group,
    requestedQuantity,
    requestedByDate: input.rfq.quoteDue,
  });

  const packageId = await publishSupportedQuotes(supabase, {
    workbookPath: input.workbookPath,
    organizationId: input.organizationId,
    jobId: job.id,
    partId: part.id,
    group: input.group,
    initiatedBy: input.internalUserId,
    publishedBy: input.internalUserId,
    pricingPolicy: input.pricingPolicy,
  });

  await setJobStatus(supabase, job.id, packageId ? "published" : "ready_to_quote");

  return {
    ...job,
    status: packageId ? "published" : "ready_to_quote",
    packageId,
    fileCount: attachedFiles.length,
  };
}

function summarizeAssignments(assignmentsByBatch: Map<string, FileAssignment[]>): Record<string, number> {
  return Object.fromEntries(
    [...assignmentsByBatch.entries()].map(([batch, assignments]) => [batch, assignments.length]),
  );
}

async function main() {
  await ensureEnvironmentLoaded();
  const args = parseArgs();

  if (!(await fileExists(args.workbookPath))) {
    throw new Error(`Workbook not found: ${args.workbookPath}`);
  }

  if (!(await fileExists(args.rootPath))) {
    throw new Error(`Root path not found: ${args.rootPath}`);
  }

  const config = loadConfig();
  const supabase = createServiceClient(config);
  const clientUserId = await resolveUserIdByEmail(supabase, args.accountEmail);
  const internalUserId = await resolveUserIdByEmail(supabase, args.internalUserEmail);
  const organizationId = await resolveOrganizationIdForClient(supabase, clientUserId);

  await ensureInternalMembership(supabase, organizationId, internalUserId);

  const pricingPolicy = await getActivePricingPolicy(supabase, organizationId);
  const allQuoteRows = await readWorkbookRows(args.workbookPath, WORKBOOK_SHEET_ALL_QUOTES);
  const rfqRows = await readWorkbookRows(args.workbookPath, WORKBOOK_SHEET_RFQ_LOG);
  const groupedRows = groupWorkbookRows(allQuoteRows);
  const importableGroups = groupedRows.filter((group) => !isNonPartGroup(group));
  const skippedGroups = groupedRows
    .filter((group) => isNonPartGroup(group))
    .map((group) => ({
      batch: group.batch,
      partNumber: group.partNumber,
      revision: group.revision,
      reason: "non_part_finishing_line",
    }));
  const rfqsByBatch = parseRfqLogRows(rfqRows);

  const groupsByBatch = new Map<string, SpreadsheetGroup[]>();

  importableGroups.forEach((group) => {
    groupsByBatch.set(group.batch, [...(groupsByBatch.get(group.batch) ?? []), group]);
  });

  const assignmentsByBatch = new Map<string, FileAssignment[]>();

  for (const [batch, groups] of groupsByBatch.entries()) {
    const batchFiles = await listBatchFiles(args.rootPath, batch);
    assignmentsByBatch.set(batch, assignFilesToGroups(groups, batchFiles));
  }

  const workspaceBefore = await loadWorkspaceState(supabase, organizationId);
  const cleanupCandidates = findCleanupCandidates(workspaceBefore);

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          mode: "dry_run",
          organizationId,
          pricingPolicy,
          cleanupCandidates,
          rfqBatches: [...rfqsByBatch.keys()],
          groupedCounts: summarizeAssignments(assignmentsByBatch),
          totalQuoteRows: allQuoteRows.length,
          totalGroups: groupedRows.length,
          importableGroups: importableGroups.length,
          skippedGroups,
        },
        null,
        2,
      ),
    );
    return;
  }

  const cleanupResult = await cleanupExistingRecords(supabase, organizationId, cleanupCandidates);
  const projects = new Map<string, ProjectInsertResult>();
  const summary: ImportSummary = {
    projects: 0,
    jobs: 0,
    quotedJobs: 0,
    readyJobs: 0,
    files: 0,
    packages: 0,
    cleanedJobs: cleanupResult.deletedJobs,
    cleanedProjects: cleanupResult.deletedProjects,
  };
  const importedJobs: Array<JobInsertResult & { packageId: string | null; fileCount: number }> = [];

  for (const batch of [...groupsByBatch.keys()].sort()) {
    const rfq = rfqsByBatch.get(batch);

    if (!rfq) {
      throw new Error(`RFQ Log entry missing for batch ${batch}.`);
    }

    const project = await createProject(supabase, {
      organizationId,
      ownerUserId: clientUserId,
      rfq,
    });

    projects.set(batch, project);
    summary.projects += 1;

    for (const assignment of assignmentsByBatch.get(batch) ?? []) {
      const importedJob = await importGroup(supabase, {
        workbookPath: args.workbookPath,
        organizationId,
        project,
        rfq,
        group: assignment.group,
        files: assignment.files,
        clientUserId,
        internalUserId,
        pricingPolicy,
      });

      importedJobs.push(importedJob);
      summary.jobs += 1;
      summary.files += importedJob.fileCount;
      summary.packages += importedJob.packageId ? 1 : 0;
      summary.quotedJobs += importedJob.packageId ? 1 : 0;
      summary.readyJobs += importedJob.packageId ? 0 : 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: "apply",
        organizationId,
        summary,
        jobs: importedJobs.map((job) => ({
          id: job.id,
          title: job.title,
          batch: job.batch,
          partNumber: job.partNumber,
          revision: job.revision,
          status: job.status,
          packageId: job.packageId,
          fileCount: job.fileCount,
        })),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
