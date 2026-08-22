import "dotenv/config";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { buildLiveEvaluationAdapterRegistry } from "../adapters/index.js";
import { EXTENDED_VENDOR_WORKFLOWS, getExtendedVendorWorkflow } from "../adapters/extendedVendorWorkflows.js";
import { loadConfig } from "../config.js";
import {
  hasNonExportControlledConfirmation,
  stageLiveEvaluationFiles,
} from "../liveEvaluationFiles.js";
import {
  type LiveEvaluationAuthorization,
  type LiveAutomationVendorName,
  type VendorArtifact,
  type VendorAutomationError,
  type VendorName,
  type VendorQuoteAdapterInput,
  type WorkerConfig,
} from "../types.js";
import { buildLiveEvaluationQuoteFilePayload } from "./_vendorQuoteInputBuilders.js";

const DEFAULT_QUANTITIES = [1];
const LIVE_EVALUATION_VENDORS = [
  "xometry",
  "fictiv",
  ...EXTENDED_VENDOR_WORKFLOWS.map((workflow) => workflow.vendor),
] as const satisfies readonly LiveAutomationVendorName[];

type SmokeArgs = {
  vendors: LiveAutomationVendorName[];
  cadPath: string;
  drawingPath: string | null;
  quantities: number[];
  confirmedNonExportControlled: boolean;
};

type SmokeRow = {
  executionContext: "live_evaluation";
  vendor: string;
  quantity: number;
  startedAt: string;
  elapsedSec: number;
  status: string | null;
  totalPriceUsd: number | null;
  unitPriceUsd: number | null;
  leadTimeBusinessDays: number | null;
  quoteUrl: string | null;
  artifacts: VendorArtifact[];
  rawPayload: Record<string, unknown> | null;
  errorCode: string | null;
  errorPayload: Record<string, unknown> | null;
  error: string | null;
  cleanupError: string | null;
};

function usage() {
  return [
    "Usage: npm --prefix worker run eval:live-provider -- --vendor <vendor|all|vendor1,vendor2> --cad <path> [--drawing <path>] [--quantities 1,5] --confirm-non-export-controlled",
    "",
    `Live evaluation vendors: ${LIVE_EVALUATION_VENDORS.join(", ")}`,
    "",
    "Requires an authenticated provider session. This standalone evaluation command does not use production routing, provider admission, customer disclosure, or dispatch permits.",
  ].join("\n");
}

function readFlag(argv: string[], flagName: string): string | null {
  const index = argv.indexOf(flagName);
  if (index < 0) {
    return null;
  }

  return argv[index + 1] ?? null;
}

export function parseQuantities(rawValue: string | null): number[] {
  if (!rawValue) {
    return DEFAULT_QUANTITIES;
  }

  const parsed = rawValue
    .split(",")
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isInteger(entry) && entry > 0);

  return parsed.length > 0 ? parsed : DEFAULT_QUANTITIES;
}

function parseVendors(rawVendor: string | undefined): LiveAutomationVendorName[] | null {
  if (!rawVendor) {
    return null;
  }

  const requestedVendors = rawVendor
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  if (requestedVendors.length === 1 && requestedVendors[0] === "all") {
    return [...LIVE_EVALUATION_VENDORS];
  }

  const liveAutomationVendors = new Set<string>(LIVE_EVALUATION_VENDORS);
  const supportedVendors: LiveAutomationVendorName[] = [];
  for (const vendor of requestedVendors) {
    if (!liveAutomationVendors.has(vendor)) {
      return null;
    }

    supportedVendors.push(vendor as LiveAutomationVendorName);
  }

  return supportedVendors.length > 0 ? supportedVendors : null;
}

export function parseSmokeArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): SmokeArgs {
  const rawVendor = readFlag(argv, "--vendor")?.trim() ?? env.QUOTE_VENDOR_SMOKE_VENDOR?.trim();
  const vendors = parseVendors(rawVendor);
  const cadPath = readFlag(argv, "--cad") ?? env.QUOTE_VENDOR_LIVE_TEST_CAD_PATH ?? null;
  const drawingPath = readFlag(argv, "--drawing") ?? env.QUOTE_VENDOR_LIVE_TEST_DRAWING_PATH ?? null;
  const quantities = parseQuantities(readFlag(argv, "--quantities") ?? env.QUOTE_VENDOR_SMOKE_QUANTITIES ?? null);

  if (!vendors) {
    throw new Error(`Missing or unsupported --vendor.\n\n${usage()}`);
  }

  if (!cadPath) {
    throw new Error(`Missing --cad or QUOTE_VENDOR_LIVE_TEST_CAD_PATH.\n\n${usage()}`);
  }

  return {
    vendors,
    cadPath: path.resolve(cadPath),
    drawingPath: drawingPath ? path.resolve(drawingPath) : null,
    quantities,
    confirmedNonExportControlled: hasNonExportControlledConfirmation(argv, env),
  };
}

function makeConfig(vendor: LiveAutomationVendorName): WorkerConfig {
  return loadConfig({
    ...process.env,
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    WORKER_MODE: "live",
    WORKER_LIVE_ADAPTERS: vendor,
    WORKER_NAME: `${vendor}-workflow-smoke`,
    WORKER_TEMP_DIR: process.env.WORKER_TEMP_DIR ?? path.join(os.tmpdir(), `overdrafter-${vendor}-workflow-smoke`),
    PLAYWRIGHT_BROWSER_TIMEOUT_MS: process.env.PLAYWRIGHT_BROWSER_TIMEOUT_MS ?? "90000",
  });
}

function makeInput(
  vendor: VendorName,
  quantity: number,
  cadPath: string,
  drawingPath: string | null,
  stagedCadPath: string,
  stagedDrawingPath: string | null,
  authorization: LiveEvaluationAuthorization,
): VendorQuoteAdapterInput {
  const stamp = Date.now();
  const idPrefix = `${vendor}-smoke-q${quantity}`;

  const filePayload = buildLiveEvaluationQuoteFilePayload({
    cadPath,
    drawingPath,
    idPrefix,
    jobId: "job-workflow-smoke",
    stagedCadPath,
    stagedDrawingPath,
    authorization,
  });

  return {
    executionContext: "live_evaluation",
    liveEvaluationAuthorization: authorization,
    organizationId: "org-workflow-smoke",
    quoteRunId: `${vendor}-workflow-smoke-${stamp}-q${quantity}`,
    requestedQuantity: quantity,
    part: {
      id: `part-${idPrefix}-${stamp}`,
      job_id: "job-workflow-smoke",
      organization_id: "org-workflow-smoke",
      name: `${vendor} Workflow Smoke Part`,
      normalized_key: idPrefix,
      cad_file_id: `cad-${idPrefix}`,
      drawing_file_id: drawingPath ? `drawing-${idPrefix}` : null,
      quantity,
    },
    ...filePayload,
    requirement: {
      id: `req-${idPrefix}`,
      part_id: `part-${idPrefix}-${stamp}`,
      description: `${vendor} workflow smoke test, qty ${quantity}`,
      part_number: "WORKFLOW-SMOKE-001",
      revision: "A",
      material: "6061 aluminum",
      finish: "as machined",
      tightest_tolerance_inch: 0.005,
      quantity,
      quote_quantities: [quantity],
      requested_by_date: null,
      applicable_vendors: [vendor],
    },
  };
}

function isVendorAutomationError(error: unknown): error is VendorAutomationError {
  return error instanceof Error && error.name === "VendorAutomationError" && "code" in error;
}

export function buildErrorRow(
  vendor: VendorName,
  quantity: number,
  startedAt: string,
  startMs: number,
  error: unknown,
): SmokeRow {
  const vendorError = isVendorAutomationError(error) ? error : null;

  return {
    executionContext: "live_evaluation",
    vendor,
    quantity,
    startedAt,
    elapsedSec: (Date.now() - startMs) / 1000,
    status: null,
    totalPriceUsd: null,
    unitPriceUsd: null,
    leadTimeBusinessDays: null,
    quoteUrl: null,
    artifacts: vendorError?.artifacts ?? [],
    rawPayload: null,
    errorCode: vendorError ? String(vendorError.code) : null,
    errorPayload: vendorError ? vendorError.payload : null,
    error: error instanceof Error ? error.message : String(error),
    cleanupError: null,
  };
}

function formatPrice(value: number | null): string {
  return value === null ? "-" : `$${value.toFixed(2)}`;
}

function formatBusinessDays(value: number | null): string {
  return value === null ? "-" : `${value} days`;
}

function formatRow(row: SmokeRow) {
  if (row.error) {
    const code = row.errorCode ? ` ${row.errorCode}` : "";
    return `  ${row.vendor} qty ${row.quantity}: ERROR${code} (${row.elapsedSec.toFixed(1)}s) - ${row.error}`;
  }

  if (row.cleanupError) {
    return `  ${row.vendor} qty ${row.quantity}: CLEANUP ERROR (${row.elapsedSec.toFixed(1)}s) - ${row.cleanupError}`;
  }

  return [
    `  ${row.vendor} qty ${row.quantity}: ${row.status}`,
    `total ${formatPrice(row.totalPriceUsd)}`,
    `unit ${formatPrice(row.unitPriceUsd)}`,
    `lead ${formatBusinessDays(row.leadTimeBusinessDays)}`,
    `${row.elapsedSec.toFixed(1)}s`,
  ].join(" | ");
}

export async function runQuote(
  config: WorkerConfig,
  args: SmokeArgs,
  vendor: LiveAutomationVendorName,
  quantity: number,
  buildRegistry: typeof buildLiveEvaluationAdapterRegistry = buildLiveEvaluationAdapterRegistry,
  stageFiles: typeof stageLiveEvaluationFiles = stageLiveEvaluationFiles,
): Promise<SmokeRow> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const registry = buildRegistry(config);
  const adapter = registry[vendor];

  if (!adapter) {
    return buildErrorRow(vendor, quantity, startedAt, startMs, new Error(`${vendor} adapter is not enabled.`));
  }

  process.stdout.write(`\n>>> Quoting ${vendor} qty ${quantity}... `);

  let stagedFiles: Awaited<ReturnType<typeof stageLiveEvaluationFiles>> | null = null;
  let row: SmokeRow;
  try {
    stagedFiles = await stageFiles({
      cadPath: args.cadPath,
      drawingPath: args.drawingPath,
      confirmedNonExportControlled: args.confirmedNonExportControlled,
    });
    const result = await adapter.quote(
      makeInput(
        vendor,
        quantity,
        args.cadPath,
        args.drawingPath,
        stagedFiles.cadPath,
        stagedFiles.drawingPath,
        stagedFiles.authorization,
      ),
    );
    console.log("done");
    row = {
      executionContext: "live_evaluation",
      vendor,
      quantity,
      startedAt,
      elapsedSec: (Date.now() - startMs) / 1000,
      status: result.status,
      totalPriceUsd: result.totalPriceUsd,
      unitPriceUsd: result.unitPriceUsd,
      leadTimeBusinessDays: result.leadTimeBusinessDays,
      quoteUrl: result.quoteUrl,
      artifacts: result.artifacts,
      rawPayload: result.rawPayload,
      errorCode: null,
      errorPayload: null,
      error: null,
      cleanupError: null,
    };
  } catch (error) {
    console.log("FAILED");
    row = buildErrorRow(vendor, quantity, startedAt, startMs, error);
  }

  if (stagedFiles) {
    try {
      await stagedFiles.cleanup();
    } catch (error) {
      row.cleanupError = error instanceof Error ? error.message : String(error);
    }
  }

  return row;
}

async function main() {
  const args = parseSmokeArgs(process.argv.slice(2));
  const rows: SmokeRow[] = [];

  console.log(`Live provider evaluation - vendors: [${args.vendors.join(", ")}], quantities: [${args.quantities.join(", ")}]`);
  console.log(`  CAD: ${args.cadPath}`);
  console.log(`  Drawing: ${args.drawingPath ?? "(none)"}`);

  for (const vendor of args.vendors) {
    const workflow = getExtendedVendorWorkflow(vendor);
    const config = makeConfig(vendor);

    console.log(`\n## ${workflow?.displayName ?? vendor}`);
    console.log(`  Session dir: ${config.vendorStorageStateDir ?? "(not configured)"}`);

    for (const quantity of args.quantities) {
      const row = await runQuote(config, args, vendor, quantity);
      rows.push(row);
      console.log(formatRow(row));
    }
  }

  const outPrefix = args.vendors.length === 1 ? args.vendors[0] : "live-providers";
  const outPath = path.join(os.tmpdir(), `${outPrefix}-workflow-smoke-${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify(rows, null, 2), "utf8");
  console.log(`\nFull results written to: ${outPath}`);

  if (rows.some((row) => row.error || row.cleanupError)) {
    process.exitCode = 1;
  }
}

const invokedAsScript = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (invokedAsScript) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
