import "dotenv/config";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { FABWORKS_ENVELOPE } from "../adapters/fabworks.js";
import { buildLiveEvaluationAdapterRegistry } from "../adapters/index.js";
import { EXTENDED_VENDOR_WORKFLOWS, getExtendedVendorWorkflow } from "../adapters/extendedVendorWorkflows.js";
import { loadConfig } from "../config.js";
import {
  hasNonExportControlledConfirmation,
  stageLiveEvaluationFiles,
} from "../liveEvaluationFiles.js";
import { prepareRuntimeSecrets } from "../runtimeSecrets.js";
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
  fabworksPackage?: FabworksPackageMetadata | null;
};

type FabworksCompatibilityRow = (typeof FABWORKS_ENVELOPE.compatibilityMatrix)[number];

type FabworksPackageMetadata = {
  process: FabworksCompatibilityRow["process"];
  material: FabworksCompatibilityRow["materials"][number];
  geometryFamily: FabworksCompatibilityRow["geometryFamily"];
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

type StagedEvaluationFiles = Awaited<ReturnType<typeof stageLiveEvaluationFiles>>;

type EvaluationBatchDependencies = {
  buildRegistry?: typeof buildLiveEvaluationAdapterRegistry;
  makeVendorConfig?: typeof makeConfig;
  prepareConfig?: typeof prepareRuntimeSecrets;
  stageFiles?: typeof stageLiveEvaluationFiles;
};

function usage() {
  return [
    "Usage: npm --prefix worker run eval:live-provider -- --vendor <vendor|all|vendor1,vendor2> --cad <path> [--drawing <path>] [--quantities 1,5] --confirm-non-export-controlled",
    "Fabworks additionally requires explicit exact matrix metadata, for example: --fabworks-process sheet_metal_bending --fabworks-material \"6061-T6 aluminum\" --fabworks-geometry bent_sheet_3d",
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

function isExactFabworksPackageMetadata(
  metadata: FabworksPackageMetadata | null | undefined,
  cadPath: string,
): metadata is FabworksPackageMetadata {
  if (!metadata) {
    return false;
  }

  const fileExtension = path.extname(cadPath).slice(1).toLowerCase();

  return FABWORKS_ENVELOPE.compatibilityMatrix.some((row) =>
    row.process === metadata.process
    && row.geometryFamily === metadata.geometryFamily
    && row.materials.some((material) => material === metadata.material)
    && row.fileExtensions.some((extension) => extension === fileExtension));
}

function parseFabworksPackageMetadata(
  argv: string[],
  vendors: LiveAutomationVendorName[],
  cadPath: string,
): FabworksPackageMetadata | null {
  const process = readFlag(argv, "--fabworks-process")?.trim() ?? null;
  const material = readFlag(argv, "--fabworks-material")?.trim() ?? null;
  const geometryFamily = readFlag(argv, "--fabworks-geometry")?.trim() ?? null;
  const fileExtension = path.extname(cadPath).slice(1).toLowerCase();
  const hasFabworksMetadata = process !== null || material !== null || geometryFamily !== null;
  const includesFabworks = vendors.includes("fabworks");

  if (!includesFabworks) {
    if (hasFabworksMetadata) {
      throw new Error("Fabworks package metadata may only be supplied when --vendor includes fabworks.");
    }
    return null;
  }

  for (const row of FABWORKS_ENVELOPE.compatibilityMatrix) {
    const matchedMaterial = row.materials.find((candidate) => candidate === material);
    if (
      row.process === process
      && row.geometryFamily === geometryFamily
      && matchedMaterial
      && row.fileExtensions.some((extension) => extension === fileExtension)
    ) {
      return {
        process: row.process,
        material: matchedMaterial,
        geometryFamily: row.geometryFamily,
      };
    }
  }

  throw new Error(
    "Fabworks evaluation requires explicit exact package metadata from the supported compatibility matrix: " +
    "--fabworks-process <process> " +
    "--fabworks-material \"<exact grade and family>\" " +
    "--fabworks-geometry <geometry>.",
  );
}

function assertFabworksPackageMetadata(
  args: SmokeArgs,
  invokedVendor?: LiveAutomationVendorName,
): void {
  const invokesFabworks = invokedVendor === undefined
    ? args.vendors.includes("fabworks")
    : invokedVendor === "fabworks";
  if (!invokesFabworks) {
    return;
  }

  if (!isExactFabworksPackageMetadata(args.fabworksPackage, args.cadPath)) {
    throw new Error(
      "Fabworks adapter invocation denied: exact operator-supplied package metadata is missing or invalid.",
    );
  }
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
    fabworksPackage: parseFabworksPackageMetadata(argv, vendors, cadPath),
  };
}

function makeConfig(
  vendor: LiveAutomationVendorName,
  evaluationRuntimeDir: string,
): WorkerConfig {
  return loadConfig({
    ...process.env,
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    WORKER_MODE: "live",
    WORKER_LIVE_ADAPTERS: vendor,
    WORKER_NAME: `${vendor}-workflow-smoke`,
    WORKER_TEMP_DIR: evaluationRuntimeDir,
    PLAYWRIGHT_BROWSER_TIMEOUT_MS: process.env.PLAYWRIGHT_BROWSER_TIMEOUT_MS ?? "90000",
  });
}

function scopeRuntimeCredentialPreparation(
  config: WorkerConfig,
  vendor: LiveAutomationVendorName,
): WorkerConfig {
  if (vendor === "xometry") {
    return {
      ...config,
      fictivStorageStatePath: null,
      fictivStorageStateJson: null,
    };
  }

  const withoutXometryCredentials = {
    ...config,
    xometryStorageStatePath: null,
    xometryStorageStateJson: null,
    xometryUserDataDir: null,
    xometryProfileSnapshotBucket: null,
    xometryProfileSnapshotObject: null,
    xometryProfileSnapshotGeneration: null,
  };
  if (vendor === "fictiv") {
    return withoutXometryCredentials;
  }

  return {
    ...withoutXometryCredentials,
    fictivStorageStatePath: null,
    fictivStorageStateJson: null,
  };
}

function makeInput(
  vendor: VendorName,
  quantity: number,
  cadPath: string,
  drawingPath: string | null,
  stagedCadPath: string,
  stagedDrawingPath: string | null,
  authorization: LiveEvaluationAuthorization,
  fabworksPackage: FabworksPackageMetadata | null,
): VendorQuoteAdapterInput {
  const stamp = Date.now();
  const idPrefix = `${vendor}-smoke-q${quantity}`;
  let material = "6061 aluminum";
  let specSnapshot: Record<string, unknown> | undefined;
  if (vendor === "fabworks") {
    if (!isExactFabworksPackageMetadata(fabworksPackage, cadPath)) {
      throw new Error("Fabworks adapter invocation denied: package metadata is missing or invalid.");
    }
    material = fabworksPackage.material;
    specSnapshot = {
      process: fabworksPackage.process,
      geometryFamily: fabworksPackage.geometryFamily,
    };
  }

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
      material,
      finish: "as machined",
      tightest_tolerance_inch: 0.005,
      quantity,
      quote_quantities: [quantity],
      requested_by_date: null,
      applicable_vendors: [vendor],
      spec_snapshot: specSnapshot,
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

/**
 * Runs one row from a batch against the batch's already captured file bytes.
 */
export async function runQuote(
  config: WorkerConfig,
  args: SmokeArgs,
  vendor: LiveAutomationVendorName,
  quantity: number,
  stagedFiles: StagedEvaluationFiles,
  buildRegistry: typeof buildLiveEvaluationAdapterRegistry = buildLiveEvaluationAdapterRegistry,
): Promise<SmokeRow> {
  assertFabworksPackageMetadata(args, vendor);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const registry = buildRegistry(config);
  const adapter = registry[vendor];

  if (!adapter) {
    return buildErrorRow(vendor, quantity, startedAt, startMs, new Error(`${vendor} adapter is not enabled.`));
  }

  process.stdout.write(`\n>>> Quoting ${vendor} qty ${quantity}... `);

  let row: SmokeRow;
  try {
    const result = await adapter.quote(
      makeInput(
        vendor,
        quantity,
        args.cadPath,
        args.drawingPath,
        stagedFiles.cadPath,
        stagedFiles.drawingPath,
        stagedFiles.authorization,
        args.fabworksPackage ?? null,
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

  return row;
}

/**
 * Captures and authorizes the selected files once, then reuses those immutable
 * bytes for every vendor and quantity in the batch before cleaning up once.
 */
export async function runEvaluationBatch(
  args: SmokeArgs,
  dependencies: EvaluationBatchDependencies = {},
): Promise<SmokeRow[]> {
  assertFabworksPackageMetadata(args);
  const buildRegistry = dependencies.buildRegistry ?? buildLiveEvaluationAdapterRegistry;
  const makeVendorConfig = dependencies.makeVendorConfig ?? makeConfig;
  const prepareConfig = dependencies.prepareConfig ?? prepareRuntimeSecrets;
  const stageFiles = dependencies.stageFiles ?? stageLiveEvaluationFiles;
  const runtimeBaseDir = process.env.WORKER_TEMP_DIR ?? os.tmpdir();
  await fs.mkdir(runtimeBaseDir, { recursive: true, mode: 0o700 });
  const batchRuntimeDir = await fs.mkdtemp(
    path.join(runtimeBaseDir, "overdrafter-live-provider-"),
  );
  const credentialRuntimeDir = path.join(batchRuntimeDir, "private");
  const evidenceRuntimeDir = path.join(batchRuntimeDir, "evidence");
  let stagedFiles: StagedEvaluationFiles | null = null;
  const rows: SmokeRow[] = [];
  let primaryError: unknown;
  const cleanupFailures: unknown[] = [];

  try {
    await Promise.all([
      fs.mkdir(credentialRuntimeDir, { recursive: true, mode: 0o700 }),
      fs.mkdir(evidenceRuntimeDir, { recursive: true, mode: 0o700 }),
    ]);
    stagedFiles = await stageFiles({
      cadPath: args.cadPath,
      drawingPath: args.drawingPath,
      confirmedNonExportControlled: args.confirmedNonExportControlled,
    });
    for (const vendor of args.vendors) {
      const workflow = getExtendedVendorWorkflow(vendor);
      const preparedConfig = await prepareConfig(
        scopeRuntimeCredentialPreparation(
          makeVendorConfig(vendor, credentialRuntimeDir),
          vendor,
        ),
      );
      const config = {
        ...preparedConfig,
        workerTempDir: evidenceRuntimeDir,
      };

      console.log(`\n## ${workflow?.displayName ?? vendor}`);
      console.log(`  Session dir: ${config.vendorStorageStateDir ?? "(not configured)"}`);

      for (const quantity of args.quantities) {
        const row = await runQuote(
          config,
          args,
          vendor,
          quantity,
          stagedFiles,
          buildRegistry,
        );
        rows.push(row);
      }
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (stagedFiles) {
      try {
        await stagedFiles.cleanup();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await fs.rm(credentialRuntimeDir, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (!rows.some((row) => row.artifacts.length > 0)) {
      try {
        await fs.rm(batchRuntimeDir, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
  }

  if (primaryError !== undefined) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupFailures],
        "Live provider evaluation and private cleanup both failed.",
      );
    }
    throw primaryError;
  }

  if (cleanupFailures.length > 0 && rows.length === 0) {
    if (cleanupFailures.length === 1) {
      throw cleanupFailures[0];
    }
    throw new AggregateError(
      cleanupFailures,
      "Live provider evaluation private cleanup failed.",
    );
  }

  if (cleanupFailures.length > 0) {
    const cleanupError = cleanupFailures
      .map((failure) => failure instanceof Error ? failure.message : String(failure))
      .join("; ");
    for (const row of rows) {
      row.cleanupError = cleanupError;
    }
  }

  return rows;
}

async function main() {
  const args = parseSmokeArgs(process.argv.slice(2));

  console.log(`Live provider evaluation - vendors: [${args.vendors.join(", ")}], quantities: [${args.quantities.join(", ")}]`);
  console.log(`  CAD: ${args.cadPath}`);
  console.log(`  Drawing: ${args.drawingPath ?? "(none)"}`);
  const rows = await runEvaluationBatch(args);

  console.log("\nEvaluation results:");
  for (const row of rows) {
    console.log(formatRow(row));
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
