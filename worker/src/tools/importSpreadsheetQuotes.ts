import "dotenv/config";
import path from "node:path";
import StreamZip from "node-stream-zip";
import { XMLParser } from "fast-xml-parser";
import { loadConfig } from "../config.js";
import { createServiceClient } from "../queue.js";

type Row = Record<string, string | null>;

type ImportArgs = {
  workbookPath: string;
  batch: string | null;
  batches: string[] | null;
  partNumber: string | null;
  jobId: string | null;
  organizationId: string | null;
  jobTags: string[];
  internalUserEmail: string;
  addInternalMembership: boolean;
  replaceExistingJobData: boolean;
  replaceImportedJobs: boolean;
  skipExistingParts: boolean;
};

type ImportedOffer = {
  offerId: string;
  supplier: string;
  laneLabel: string;
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

type SpreadsheetGroup = {
  batch: string;
  partNumber: string;
  revision: string | null;
  rows: Row[];
  importSourceKey: string;
};

type SupportedSupplier = "Xometry" | "Fictiv" | "Protolabs" | "SendCutSend" | "PartsBadger" | "FastDMS";
type SupportedVendor = "xometry" | "fictiv" | "protolabs" | "sendcutsend" | "partsbadger" | "fastdms";
type SupportedRow = Row & { Supplier: SupportedSupplier };

type JobContext = {
  job: {
    id: string;
    organization_id: string;
    source: string;
    title: string;
    tags: string[];
  };
  cadFile: { id: string; normalized_name: string } | null;
  drawingFile: { id: string; normalized_name: string } | null;
};

type PricingPolicyRow = {
  id: string;
  version: string;
  markup_percent: number | string;
  currency_minor_unit: number | string;
};

type ImportedOptionCandidate = {
  vendor: SupportedVendor;
  vendorQuoteId: string;
  offerRowId: string;
  totalPriceUsd: number;
  leadTimeBusinessDays: number | null;
};

const SUPPORTED_VENDOR_MAP: Record<SupportedSupplier, SupportedVendor> = {
  Xometry: "xometry",
  Fictiv: "fictiv",
  Protolabs: "protolabs",
  SendCutSend: "sendcutsend",
  PartsBadger: "partsbadger",
  FastDMS: "fastdms",
};

const AUTOMATED_VENDORS = new Set<SupportedVendor>([
  "xometry",
  "fictiv",
  "protolabs",
  "sendcutsend",
]);

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

function toSupportedVendor(value: string | null | undefined): SupportedVendor | null {
  return isSupportedSupplier(value) ? SUPPORTED_VENDOR_MAP[value] : null;
}

function parseArgs(): ImportArgs {
  const args = process.argv.slice(2);
  const result: ImportArgs = {
    workbookPath: "/Users/blainewilson/My Drive/Mako/Quotes/Quotes.xlsx",
    batch: null,
    batches: null,
    partNumber: null,
    jobId: null,
    organizationId: null,
    jobTags: [],
    internalUserEmail: "blaineswilson@gmail.com",
    addInternalMembership: true,
    replaceExistingJobData: false,
    replaceImportedJobs: true,
    skipExistingParts: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case "--workbook":
        result.workbookPath = next;
        index += 1;
        break;
      case "--batch":
        result.batch = next;
        index += 1;
        break;
      case "--batches":
        result.batches = next
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        index += 1;
        break;
      case "--part-number":
        result.partNumber = next;
        index += 1;
        break;
      case "--job-id":
        result.jobId = next;
        index += 1;
        break;
      case "--organization-id":
        result.organizationId = next;
        index += 1;
        break;
      case "--tags":
        result.jobTags = next
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        index += 1;
        break;
      case "--internal-user-email":
        result.internalUserEmail = next;
        index += 1;
        break;
      case "--no-add-internal-membership":
        result.addInternalMembership = false;
        break;
      case "--replace-existing-job-data":
        result.replaceExistingJobData = true;
        break;
      case "--keep-imported-jobs":
        result.replaceImportedJobs = false;
        break;
      case "--include-existing-parts":
        result.skipExistingParts = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (result.batch && result.batches) {
    throw new Error("Use either --batch or --batches, not both.");
  }

  if (Boolean(result.jobId) === Boolean(result.organizationId)) {
    throw new Error("Provide either --job-id or --organization-id.");
  }

  if (result.jobId && !result.batch && !result.batches) {
    throw new Error("Single-job imports require --batch or --batches plus an optional --part-number.");
  }

  return result;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function excelSerialToIso(serialText: string | null): string | null {
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

function parseTolerance(value: string | null): number | null {
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
  return rows[0]?.Description?.trim() ?? "Imported spreadsheet quote";
}

function normalizeRevision(rows: Row[]): string | null {
  return rows[0]?.Revision?.trim() ?? null;
}

function normalizeToken(value: string | null | undefined): string {
  return (value ?? "none")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "none";
}

function buildPartKey(partNumber: string, revision: string | null): string {
  return `${normalizeToken(partNumber)}::${normalizeToken(revision)}`;
}

function buildImportSourceKey(batch: string, partNumber: string, revision: string | null): string {
  return `spreadsheet_import:${normalizeToken(batch)}:${normalizeToken(partNumber)}:${normalizeToken(revision)}`;
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

function buildClientSummary(partNumber: string, revision: string | null): string {
  return `Curated CNC machining options for ${partNumber}${revision ? ` rev ${revision}` : ""}, based on approved requirements and confirmed supplier coverage.`;
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

function resolveWorksheetPath(target: string): string {
  if (target.startsWith("/")) {
    return target.replace(/^\/+/, "");
  }

  return path.posix.join("xl", target.replace(/^\/+/, ""));
}

async function readWorkbookRows(workbookPath: string, sheetName = "All Quotes"): Promise<Row[]> {
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
        const text =
          typeof item.t === "string"
            ? item.t
            : asArray(item.r)
                .map((run) => (typeof run.t === "string" ? run.t : ""))
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

function groupWorkbookRows(rows: Row[]): SpreadsheetGroup[] {
  const groups = new Map<string, SpreadsheetGroup>();

  rows.forEach((row) => {
    const batch = row["Quote Batch"]?.trim();
    const partNumber = row["Part Number"]?.trim();

    if (!batch || !partNumber) {
      return;
    }

    const revision = row.Revision?.trim() ?? null;
    const key = `${batch}::${partNumber}::${revision ?? ""}`;
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
      importSourceKey: buildImportSourceKey(batch, partNumber, revision),
    });
  });

  return [...groups.values()].sort((left, right) => {
    if (left.batch !== right.batch) {
      return left.batch.localeCompare(right.batch);
    }

    return left.partNumber.localeCompare(right.partNumber);
  });
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

function getUnsupportedSuppliers(rows: Row[]): string[] {
  return Array.from(
    new Set(
      rows
        .map((row) => row.Supplier?.trim())
        .filter((supplier): supplier is string => Boolean(supplier) && !isSupportedSupplier(supplier)),
    ),
  );
}

function selectGroups(groups: SpreadsheetGroup[], args: ImportArgs): SpreadsheetGroup[] {
  const requestedBatches = new Set(
    args.batches ?? (args.batch ? [args.batch] : groups.map((group) => group.batch)),
  );

  const selected = groups.filter((group) => {
    if (!requestedBatches.has(group.batch)) {
      return false;
    }

    if (args.partNumber && group.partNumber !== args.partNumber) {
      return false;
    }

    return getSupportedRows(group.rows).length > 0;
  });

  if (selected.length === 0) {
    throw new Error("No spreadsheet groups with supported quotes matched the requested filters.");
  }

  if (args.jobId && selected.length !== 1) {
    throw new Error("Single-job imports must resolve to exactly one part group. Use --part-number to disambiguate.");
  }

  return selected;
}

function markup(rawAmount: number, markupPercent = 20, minorUnit = 0.01): number {
  const divisor = Math.max(minorUnit, 0.0001);
  return Math.round(Math.ceil((rawAmount * (1 + markupPercent / 100)) / divisor) * divisor * 100) / 100;
}

async function resolveInternalUserId(supabase: ReturnType<typeof createServiceClient>, email: string): Promise<string> {
  const { data, error } = await supabase.auth.admin.listUsers();

  if (error || !data?.users) {
    throw error ?? new Error("Unable to list users.");
  }

  const user = data.users.find((candidate) => candidate.email === email);

  if (!user) {
    throw new Error(`Internal user ${email} was not found.`);
  }

  return user.id;
}

async function ensureInternalMembership(
  supabase: ReturnType<typeof createServiceClient>,
  organizationId: string,
  internalUserId: string,
  enabled: boolean,
) {
  if (!enabled) {
    return;
  }

  const { error } = await supabase.from("organization_memberships").upsert(
    {
      organization_id: organizationId,
      user_id: internalUserId,
      role: "internal_admin",
    },
    { onConflict: "organization_id,user_id" },
  );

  if (error) {
    throw error;
  }
}

async function getActivePricingPolicy(
  supabase: ReturnType<typeof createServiceClient>,
  organizationId: string,
): Promise<PricingPolicyRow> {
  const { data, error } = await supabase
    .from("pricing_policies")
    .select("*")
    .or(`organization_id.eq.${organizationId},organization_id.is.null`)
    .eq("is_active", true)
    .order("organization_id", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    throw error ?? new Error(`No active pricing policy found for org ${organizationId}.`);
  }

  return data as PricingPolicyRow;
}

async function getExistingJobContext(
  supabase: ReturnType<typeof createServiceClient>,
  jobId: string,
): Promise<JobContext> {
  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .select("id, organization_id, source, title, tags")
    .eq("id", jobId)
    .single();

  if (jobError || !job) {
    throw jobError ?? new Error(`Job ${jobId} not found.`);
  }

  const { data: files, error: filesError } = await supabase
    .from("job_files")
    .select("id, file_kind, normalized_name")
    .eq("job_id", jobId)
    .in("file_kind", ["cad", "drawing"])
    .order("created_at", { ascending: true });

  if (filesError) {
    throw filesError;
  }

  const cadFile = files?.find((file) => file.file_kind === "cad") ?? null;
  const drawingFile = files?.find((file) => file.file_kind === "drawing") ?? null;

  return {
    job: job as JobContext["job"],
    cadFile,
    drawingFile,
  };
}

async function deleteQuoteDataForJob(
  supabase: ReturnType<typeof createServiceClient>,
  jobId: string,
) {
  const { error: packageError } = await supabase
    .from("published_quote_packages")
    .delete()
    .eq("job_id", jobId);

  if (packageError) {
    throw packageError;
  }

  const { error } = await supabase.from("quote_runs").delete().eq("job_id", jobId);

  if (error) {
    throw error;
  }
}

async function deleteImportedJobsBySource(
  supabase: ReturnType<typeof createServiceClient>,
  organizationId: string,
  sourceKeys: string[],
) {
  if (sourceKeys.length === 0) {
    return;
  }

  const { data: jobs, error: selectError } = await supabase
    .from("jobs")
    .select("id")
    .eq("organization_id", organizationId)
    .in("source", sourceKeys);

  if (selectError) {
    throw selectError;
  }

  for (const job of jobs ?? []) {
    const { error } = await supabase.from("jobs").delete().eq("id", job.id);

    if (error) {
      throw error;
    }
  }
}

async function loadExistingPartKeys(
  supabase: ReturnType<typeof createServiceClient>,
  organizationId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("approved_part_requirements")
    .select("part_number, revision")
    .eq("organization_id", organizationId);

  if (error) {
    throw error;
  }

  return new Set(
    (data ?? []).map((row) => buildPartKey(row.part_number ?? "unknown", row.revision ?? null)),
  );
}

async function createSpreadsheetDemoJob(
  supabase: ReturnType<typeof createServiceClient>,
  group: SpreadsheetGroup,
  organizationId: string,
  internalUserId: string,
  jobTags: string[],
): Promise<JobContext> {
  const title = `${group.partNumber}${group.revision ? ` rev ${group.revision}` : ""}`;
  const description = normalizeDescription(group.rows);

  const { data, error } = await supabase
    .from("jobs")
    .insert({
      organization_id: organizationId,
      created_by: internalUserId,
      title,
      description,
      status: "uploaded",
      source: group.importSourceKey,
      tags: jobTags,
    })
    .select("id, organization_id, source, title, tags")
    .single();

  if (error || !data) {
    throw error ?? new Error(`Failed to create demo job for ${group.partNumber}.`);
  }

  return {
    job: data as JobContext["job"],
    cadFile: null,
    drawingFile: null,
  };
}

async function logImportAuditEvent(
  supabase: ReturnType<typeof createServiceClient>,
  input: {
    organizationId: string;
    internalUserId: string;
    jobId: string;
    packageId: string;
    group: SpreadsheetGroup;
    supportedVendors: SupportedVendor[];
    unsupportedSuppliers: string[];
  },
) {
  const { error } = await supabase.from("audit_events").insert({
    organization_id: input.organizationId,
    actor_user_id: input.internalUserId,
    job_id: input.jobId,
    package_id: input.packageId,
    event_type: "job.spreadsheet_imported",
    payload: {
      batch: input.group.batch,
      partNumber: input.group.partNumber,
      revision: input.group.revision,
      supportedVendors: input.supportedVendors,
      unsupportedSuppliers: input.unsupportedSuppliers,
    },
  });

  if (error) {
    throw error;
  }
}

function buildImportedOffer(vendor: SupportedVendor, row: SupportedRow): ImportedOffer {
  return {
    offerId: buildOfferId(vendor, row),
    supplier: row.Supplier,
    laneLabel: buildLaneLabel(row),
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

async function importGroupIntoJob(
  supabase: ReturnType<typeof createServiceClient>,
  input: {
    args: ImportArgs;
    group: SpreadsheetGroup;
    jobContext: JobContext;
    pricingPolicy: PricingPolicyRow;
    internalUserId: string;
  },
) {
  const { args, group, jobContext, pricingPolicy, internalUserId } = input;
  const { job, cadFile, drawingFile } = jobContext;

  if (args.replaceExistingJobData) {
    await deleteQuoteDataForJob(supabase, job.id);
  }

  const description = normalizeDescription(group.rows);
  const material = normalizeMaterial(group.rows);
  const finish = normalizeFinish(group.rows);
  const tightestTolerance = parseTolerance(group.rows[0]["Tightest Tolerance"]);
  const supportedRows = getSupportedRows(group.rows);
  const unsupportedSuppliers = getUnsupportedSuppliers(group.rows);
  const applicableVendors = Array.from(
    new Set(
      supportedRows
        .map((row) => SUPPORTED_VENDOR_MAP[row.Supplier])
        .filter((vendor) => AUTOMATED_VENDORS.has(vendor)),
    ),
  );

  if (supportedRows.length === 0) {
    throw new Error(`Group ${group.batch} ${group.partNumber} has no supported quotes to import.`);
  }

  if (args.jobTags.length > 0) {
    const mergedTags = Array.from(new Set([...(job.tags ?? []), ...args.jobTags]));
    const { error: tagError } = await supabase
      .from("jobs")
      .update({ tags: mergedTags })
      .eq("id", job.id);

    if (tagError) {
      throw tagError;
    }
  }

  const { data: part, error: partError } = await supabase
    .from("parts")
    .upsert(
      {
        job_id: job.id,
        organization_id: job.organization_id,
        name: `${group.partNumber}${group.revision ? ` rev ${group.revision}` : ""}`,
        normalized_key: cadFile?.normalized_name ?? normalizeToken(group.partNumber),
        cad_file_id: cadFile?.id ?? null,
        drawing_file_id: drawingFile?.id ?? null,
        quantity: Number(group.rows[0].Qty ?? 1),
      },
      { onConflict: "job_id,normalized_key" },
    )
    .select("*")
    .single();

  if (partError || !part) {
    throw partError ?? new Error(`Failed to upsert part for ${group.partNumber}.`);
  }

  const extractionPayload = {
    description,
    partNumber: group.partNumber,
    revision: group.revision,
    material: {
      raw: material,
      normalized: material,
      confidence: 0.99,
    },
    finish: {
      raw: finish,
      normalized: finish,
      confidence: finish ? 0.96 : 0.5,
    },
    tolerances: {
      tightest: group.rows[0]["Tightest Tolerance"] ?? null,
      valueInch: tightestTolerance,
      confidence: tightestTolerance ? 0.98 : 0.5,
    },
  };

  const { error: extractionError } = await supabase
    .from("drawing_extractions")
    .upsert(
      {
        part_id: part.id,
        organization_id: job.organization_id,
        extractor_version: "spreadsheet-import-v2",
        extraction: extractionPayload,
        confidence: 0.99,
        warnings: [`Imported from Quotes.xlsx batch ${group.batch}.`],
        evidence: [
          {
            field: "partNumber",
            page: 1,
            snippet: group.partNumber,
            confidence: 0.99,
          },
          {
            field: "material",
            page: 1,
            snippet: material,
            confidence: 0.98,
          },
          {
            field: "finish",
            page: 1,
            snippet: finish ?? "No finish",
            confidence: finish ? 0.95 : 0.5,
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
        part_id: part.id,
        organization_id: job.organization_id,
        approved_by: internalUserId,
        description,
        part_number: group.partNumber,
        revision: group.revision,
        material,
        finish,
        tightest_tolerance_inch: tightestTolerance,
        quantity: Number(group.rows[0].Qty ?? 1),
        applicable_vendors: applicableVendors,
        spec_snapshot: {
          importedBatch: group.batch,
          toleranceSource: group.rows[0]["Tolerance Source"] ?? null,
          threadCallouts: group.rows[0]["Thread Callouts"] ?? null,
          threadMatchNotes: group.rows[0]["Thread Match Notes"] ?? null,
        },
      },
      { onConflict: "part_id" },
    );

  if (requirementError) {
    throw requirementError;
  }

  const { data: quoteRun, error: quoteRunError } = await supabase
    .from("quote_runs")
    .insert({
      job_id: job.id,
      organization_id: job.organization_id,
      initiated_by: internalUserId,
      status: "published",
      requested_auto_publish: false,
    })
    .select("*")
    .single();

  if (quoteRunError || !quoteRun) {
    throw quoteRunError ?? new Error(`Failed to create quote run for ${group.partNumber}.`);
  }

  const offersByVendor = new Map<SupportedVendor, ImportedOffer[]>();

  for (const row of supportedRows) {
    const vendor = SUPPORTED_VENDOR_MAP[row.Supplier];
    const offer = buildImportedOffer(vendor, row);
    const current = offersByVendor.get(vendor) ?? [];
    current.push(offer);
    offersByVendor.set(vendor, current);
  }

  const vendorResultIds = new Map<SupportedVendor, string>();
  const allOfferCandidates: ImportedOptionCandidate[] = [];

  for (const [vendor, offers] of offersByVendor.entries()) {
    offers.sort((left, right) => left.totalPriceUsd - right.totalPriceUsd);
    const summaryOffer = offers[0];

    const { data: result, error: resultError } = await supabase
      .from("vendor_quote_results")
      .insert({
        quote_run_id: quoteRun.id,
        part_id: part.id,
        organization_id: job.organization_id,
        vendor,
        status: "official_quote_received",
        unit_price_usd: summaryOffer.unitPriceUsd,
        total_price_usd: summaryOffer.totalPriceUsd,
        lead_time_business_days: summaryOffer.leadTimeBusinessDays,
        quote_url: null,
        dfm_issues: offers
          .map((offer) => offer.notes)
          .filter((note): note is string => typeof note === "string" && /sharp internal corners|tool radius/i.test(note)),
        notes: [
          `Imported from Quotes.xlsx batch ${group.batch}.`,
          `Representative summary uses ${summaryOffer.laneLabel.toLowerCase()}.`,
          ...(unsupportedSuppliers.length > 0
            ? [`Unsupported suppliers skipped: ${unsupportedSuppliers.join(", ")}.`]
            : []),
        ],
        raw_payload: {
          importSource: {
            workbookPath: args.workbookPath,
            workbookName: path.basename(args.workbookPath),
            batch: group.batch,
          },
          partNumber: group.partNumber,
          revision: group.revision,
          summaryOfferKey: summaryOffer.offerId,
          offerCount: offers.length,
        },
      })
      .select("*")
      .single();

    if (resultError || !result) {
      throw resultError ?? new Error(`Failed to create vendor result for ${vendor}.`);
    }

    vendorResultIds.set(vendor, result.id);

    const { data: offerRows, error: offerError } = await supabase
      .from("vendor_quote_offers")
      .insert(
        offers.map((offer, sortIndex) => ({
          vendor_quote_result_id: result.id,
          organization_id: job.organization_id,
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
      .select("*");

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

  const lowestOffer =
    [...allOfferCandidates].sort((left, right) => left.totalPriceUsd - right.totalPriceUsd)[0] ?? null;

  const balancedOffer =
    [...allOfferCandidates]
      .filter((offer) =>
        fastestOffer?.leadTimeBusinessDays === null || fastestOffer?.leadTimeBusinessDays === undefined
          ? true
          : (offer.leadTimeBusinessDays ?? Number.MAX_SAFE_INTEGER) <= fastestOffer.leadTimeBusinessDays + 2,
      )
      .sort((left, right) => left.totalPriceUsd - right.totalPriceUsd)[0] ?? null;

  if (!lowestOffer || !fastestOffer || !balancedOffer) {
    throw new Error(`Unable to determine client options for ${group.partNumber}.`);
  }

  const { data: packageRow, error: packageError } = await supabase
    .from("published_quote_packages")
    .insert({
      job_id: job.id,
      quote_run_id: quoteRun.id,
      organization_id: job.organization_id,
      published_by: internalUserId,
      pricing_policy_id: pricingPolicy.id,
      auto_published: false,
      client_summary: buildClientSummary(group.partNumber, group.revision),
    })
    .select("*")
    .single();

  if (packageError || !packageRow) {
    throw packageError ?? new Error(`Failed to publish package for ${group.partNumber}.`);
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

    const { error: optionError } = await supabase.from("published_quote_options").insert({
      package_id: packageRow.id,
      organization_id: job.organization_id,
      option_kind: option.option_kind,
      label: option.label,
      published_price_usd: markup(
        option.offer.totalPriceUsd,
        Number(pricingPolicy.markup_percent),
        Number(pricingPolicy.currency_minor_unit),
      ),
      lead_time_business_days: option.offer.leadTimeBusinessDays,
      comparison_summary: buildOptionComparisonSummary(option.option_kind),
      source_vendor_quote_id: option.offer.vendorQuoteId,
      source_vendor_quote_offer_id: option.offer.offerRowId,
      markup_policy_version: pricingPolicy.version,
    });

    if (optionError) {
      throw optionError;
    }
  }

  const { error: jobUpdateError } = await supabase
    .from("jobs")
    .update({
      status: "published",
      active_pricing_policy_id: pricingPolicy.id,
    })
    .eq("id", job.id);

  if (jobUpdateError) {
    throw jobUpdateError;
  }

  const { error: quoteRunUpdateError } = await supabase
    .from("quote_runs")
    .update({
      status: "published",
    })
    .eq("id", quoteRun.id);

  if (quoteRunUpdateError) {
    throw quoteRunUpdateError;
  }

  await logImportAuditEvent(supabase, {
    organizationId: job.organization_id,
    internalUserId,
    jobId: job.id,
    packageId: packageRow.id,
    group,
    supportedVendors: [...offersByVendor.keys()],
    unsupportedSuppliers,
  });

  return {
    jobId: job.id,
    partId: part.id,
    quoteRunId: quoteRun.id,
    packageId: packageRow.id,
    supportedVendors: [...offersByVendor.keys()],
    unsupportedSuppliers,
  };
}

async function main() {
  const args = parseArgs();
  const config = loadConfig();
  const supabase = createServiceClient(config);
  const rows = await readWorkbookRows(args.workbookPath);
  const groups = selectGroups(groupWorkbookRows(rows), args);
  const internalUserId = await resolveInternalUserId(supabase, args.internalUserEmail);

  if (args.jobId) {
    const jobContext = await getExistingJobContext(supabase, args.jobId);
    const pricingPolicy = await getActivePricingPolicy(supabase, jobContext.job.organization_id);

    await ensureInternalMembership(
      supabase,
      jobContext.job.organization_id,
      internalUserId,
      args.addInternalMembership,
    );

    const imported = await importGroupIntoJob(supabase, {
      args,
      group: groups[0],
      jobContext,
      pricingPolicy,
      internalUserId,
    });

    console.log(
      JSON.stringify(
        {
          mode: "single_job",
          imported,
        },
        null,
        2,
      ),
    );

    return;
  }

  const organizationId = args.organizationId!;
  const pricingPolicy = await getActivePricingPolicy(supabase, organizationId);

  await ensureInternalMembership(
    supabase,
    organizationId,
    internalUserId,
    args.addInternalMembership,
  );

  if (args.replaceImportedJobs) {
    await deleteImportedJobsBySource(
      supabase,
      organizationId,
      groups.map((group) => group.importSourceKey),
    );
  }

  const existingPartKeys = args.skipExistingParts
    ? await loadExistingPartKeys(supabase, organizationId)
    : new Set<string>();

  const created = [];
  const skipped = [];

  for (const group of groups) {
    if (existingPartKeys.has(buildPartKey(group.partNumber, group.revision))) {
      skipped.push({
        batch: group.batch,
        partNumber: group.partNumber,
        revision: group.revision,
        reason: "existing_part_requirement",
      });
      continue;
    }

    const jobContext = await createSpreadsheetDemoJob(
      supabase,
      group,
      organizationId,
      internalUserId,
      args.jobTags,
    );
    const imported = await importGroupIntoJob(supabase, {
      args,
      group,
      jobContext,
      pricingPolicy,
      internalUserId,
    });

    created.push({
      batch: group.batch,
      partNumber: group.partNumber,
      revision: group.revision,
      ...imported,
    });
  }

  console.log(
    JSON.stringify(
      {
        mode: "organization",
        organizationId,
        created,
        skipped,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(JSON.stringify(error, null, 2));
  }
  process.exit(1);
});
