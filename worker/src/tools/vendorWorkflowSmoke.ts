import "dotenv/config";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { FABWORKS_ENVELOPE } from "../adapters/fabworks.js";
import { buildLiveEvaluationAdapterRegistry } from "../adapters/index.js";
import { EXTENDED_VENDOR_WORKFLOWS, getExtendedVendorWorkflow } from "../adapters/extendedVendorWorkflows.js";
import { OSHCUT_PROVIDER_ENVELOPE } from "../adapters/oshcut.js";
import {
  parseSendCutSendEvaluationManifest,
  type SendCutSendEvaluationManifest,
} from "../adapters/sendcutsend.js";
import { loadConfig } from "../config.js";
import {
  hasNonExportControlledConfirmation,
  sha256File,
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
  "sendcutsend",
  ...EXTENDED_VENDOR_WORKFLOWS.map((workflow) => workflow.vendor),
] as const satisfies readonly LiveAutomationVendorName[];

type SmokeArgs = {
  vendors: LiveAutomationVendorName[];
  cadPath: string;
  drawingPath: string | null;
  quantities: number[];
  confirmedNonExportControlled: boolean;
  fabworksPackage?: FabworksPackageMetadata | null;
  oshcutPackage?: OshcutPackageMetadata | null;
  sendCutSendManifestPath?: string | null;
};

type FabworksCompatibilityRow = (typeof FABWORKS_ENVELOPE.compatibilityMatrix)[number];

type FabworksPackageMetadata = {
  process: FabworksCompatibilityRow["process"];
  material: FabworksCompatibilityRow["materials"][number];
  geometryFamily: FabworksCompatibilityRow["geometryFamily"];
};

const OSHCUT_PACKAGE_METADATA = {
  process: OSHCUT_PROVIDER_ENVELOPE.process,
  material: OSHCUT_PROVIDER_ENVELOPE.material,
  geometryFamily: OSHCUT_PROVIDER_ENVELOPE.geometryFamilies[0],
} as const;

type OshcutPackageMetadata = typeof OSHCUT_PACKAGE_METADATA;

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
    "Usage: npm --prefix worker run eval:live-provider -- --vendor <vendor|all|vendor1,vendor2> --cad <path> [--drawing <path>] [--quantities 1,5] [--sendcutsend-manifest <reviewed.json>] --confirm-non-export-controlled",
    "Fabworks additionally requires explicit exact matrix metadata, for example: --fabworks-process sheet_metal_bending --fabworks-material \"6061-T6 aluminum\" --fabworks-geometry bent_sheet_3d",
    "OSH Cut additionally requires: --oshcut-process laser_cutting --oshcut-material aluminum_6061_t6 --oshcut-geometry flat_sheet",
    "SendCutSend additionally requires a complete reviewed digest-bound manifest and performs local envelope evaluation only.",
    "",
    `Live evaluation vendors: ${LIVE_EVALUATION_VENDORS.join(", ")}`,
    "",
    "Provider-interacting evaluation vendors require an authenticated session. SendCutSend performs local admission only. This command does not use production routing, provider admission, customer disclosure, or dispatch permits.",
  ].join("\n");
}

function readFlag(argv: string[], flagName: string): string | null {
  const index = argv.indexOf(flagName);
  if (index < 0) {
    return null;
  }

  return argv[index + 1] ?? null;
}

/**
 * Parses positive safe-integer tokens while preserving the generic-vendor
 * fallback; OSH Cut batches reject any malformed token before staging.
 */
export function parseQuantities(rawValue: string | null): number[] {
  if (!rawValue) {
    return DEFAULT_QUANTITIES;
  }

  const parsed = rawValue
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .filter((entry) => Number.isSafeInteger(entry) && entry > 0);

  return parsed.length > 0 ? parsed : DEFAULT_QUANTITIES;
}

function hasInvalidQuantityToken(rawValue: string | null): boolean {
  if (rawValue === null) {
    return false;
  }

  const tokens = rawValue.split(",").map((entry) => entry.trim());
  return tokens.length === 0 || tokens.some((entry) => {
    if (!/^\d+$/.test(entry)) {
      return true;
    }

    const quantity = Number(entry);
    return !Number.isSafeInteger(quantity) || quantity <= 0;
  });
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

  return FABWORKS_ENVELOPE.compatibilityMatrix.some((row) => {
    const materials: readonly string[] = row.materials;
    const fileExtensions: readonly string[] = row.fileExtensions;
    return row.process === metadata.process
      && row.geometryFamily === metadata.geometryFamily
      && materials.includes(metadata.material)
      && fileExtensions.includes(fileExtension);
  });
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
    const fileExtensions: readonly string[] = row.fileExtensions;
    if (
      row.process === process
      && row.geometryFamily === geometryFamily
      && matchedMaterial
      && fileExtensions.includes(fileExtension)
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

function parseOshcutPackageMetadata(
  argv: string[],
  vendors: LiveAutomationVendorName[],
): OshcutPackageMetadata | null {
  const process = readFlag(argv, "--oshcut-process")?.trim() ?? null;
  const material = readFlag(argv, "--oshcut-material")?.trim() ?? null;
  const geometryFamily = readFlag(argv, "--oshcut-geometry")?.trim() ?? null;
  const hasOshcutMetadata = process !== null || material !== null || geometryFamily !== null;
  const includesOshcut = vendors.includes("oshcut");

  if (!includesOshcut) {
    if (hasOshcutMetadata) {
      throw new Error("OSH Cut package metadata may only be supplied when --vendor includes oshcut.");
    }
    return null;
  }

  if (
    process !== OSHCUT_PACKAGE_METADATA.process ||
    material !== OSHCUT_PACKAGE_METADATA.material ||
    geometryFamily !== OSHCUT_PACKAGE_METADATA.geometryFamily
  ) {
    throw new Error(
      "OSH Cut evaluation requires explicit exact package metadata: " +
      "--oshcut-process laser_cutting " +
      "--oshcut-material aluminum_6061_t6 " +
      "--oshcut-geometry flat_sheet.",
    );
  }

  return OSHCUT_PACKAGE_METADATA;
}

function assertExactOshcutPackageMetadata(
  oshcutPackage: SmokeArgs["oshcutPackage"],
): asserts oshcutPackage is OshcutPackageMetadata {
  if (
    oshcutPackage?.process !== OSHCUT_PACKAGE_METADATA.process ||
    oshcutPackage.material !== OSHCUT_PACKAGE_METADATA.material ||
    oshcutPackage.geometryFamily !== OSHCUT_PACKAGE_METADATA.geometryFamily
  ) {
    throw new Error(
      "OSH Cut adapter invocation denied: exact operator-supplied package metadata is missing or invalid.",
    );
  }
}

function assertOshcutQuantity(quantity: number): void {
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < OSHCUT_PROVIDER_ENVELOPE.quantity.minimum ||
    quantity > OSHCUT_PROVIDER_ENVELOPE.quantity.certifiedMaximum
  ) {
    throw new Error(
      `OSH Cut adapter invocation denied: quantity must be a whole number from ${OSHCUT_PROVIDER_ENVELOPE.quantity.minimum} through ${OSHCUT_PROVIDER_ENVELOPE.quantity.certifiedMaximum}.`,
    );
  }
}

function assertOshcutBatch(args: SmokeArgs): void {
  if (!args.vendors.includes("oshcut")) {
    return;
  }

  assertExactOshcutPackageMetadata(args.oshcutPackage);
  if (args.quantities.length === 0) {
    throw new Error("OSH Cut adapter invocation denied: at least one quantity is required.");
  }
  for (const quantity of args.quantities) {
    assertOshcutQuantity(quantity);
  }
}

function sameQuantities(left: readonly number[], right: readonly number[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === left.length
    && rightSet.size === right.length
    && leftSet.size === rightSet.size
    && [...leftSet].every((quantity) => rightSet.has(quantity));
}

function assertSendCutSendManifestInvocation(
  manifest: SendCutSendEvaluationManifest,
  args: SmokeArgs,
): void {
  if (
    manifest.cadFileName !== path.basename(args.cadPath)
    || manifest.drawingFileName !== (args.drawingPath ? path.basename(args.drawingPath) : null)
    || !sameQuantities(manifest.quantities, args.quantities)
  ) {
    throw new Error(
      "SendCutSend evaluation manifest does not match the selected filenames and quantities.",
    );
  }
}

/** Loads and binds the canonical reviewed manifest to selected bytes before staging. */
export async function loadSendCutSendEvaluationManifest(
  args: SmokeArgs,
): Promise<SendCutSendEvaluationManifest | null> {
  if (!args.vendors.includes("sendcutsend")) {
    return null;
  }
  if (!args.confirmedNonExportControlled) {
    throw new Error(
      "SendCutSend evaluation requires --confirm-non-export-controlled before reading selected files.",
    );
  }
  if (!args.sendCutSendManifestPath) {
    throw new Error("SendCutSend evaluation requires a reviewed manifest before staging.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(args.sendCutSendManifestPath, "utf8"));
  } catch {
    throw new Error("SendCutSend evaluation manifest could not be read or parsed.");
  }
  const manifest = parseSendCutSendEvaluationManifest(parsed);
  if (!manifest) {
    throw new Error(
      "SendCutSend evaluation manifest facts are missing, inexact, or outside the reviewed envelope.",
    );
  }
  assertSendCutSendManifestInvocation(manifest, args);

  if (await sha256File(args.cadPath) !== manifest.cadSha256) {
    throw new Error("SendCutSend evaluation manifest CAD digest does not match selected bytes.");
  }
  if (args.drawingPath === null) {
    if (manifest.drawingSha256 !== null) {
      throw new Error("SendCutSend evaluation manifest declares a drawing that was not selected.");
    }
  } else if (await sha256File(args.drawingPath) !== manifest.drawingSha256) {
    throw new Error("SendCutSend evaluation manifest drawing digest does not match selected bytes.");
  }

  return manifest;
}

function assertStagedSendCutSendBinding(
  args: SmokeArgs,
  manifest: SendCutSendEvaluationManifest | null,
  stagedFiles: StagedEvaluationFiles,
): void {
  if (!args.vendors.includes("sendcutsend")) {
    return;
  }
  if (!manifest) {
    throw new Error("SendCutSend adapter invocation denied: reviewed manifest is unavailable.");
  }
  if (
    stagedFiles.authorization.cadFileSha256 !== manifest.cadSha256
    || stagedFiles.authorization.drawingFileSha256 !== manifest.drawingSha256
  ) {
    throw new Error("SendCutSend staged bytes do not match the reviewed manifest.");
  }
}

async function verifyStagedSendCutSendBytes(
  args: SmokeArgs,
  manifest: SendCutSendEvaluationManifest,
  stagedFiles: StagedEvaluationFiles,
): Promise<void> {
  if (!args.confirmedNonExportControlled) {
    throw new Error(
      "SendCutSend adapter invocation denied: export-control confirmation is unavailable.",
    );
  }
  assertStagedSendCutSendBinding(args, manifest, stagedFiles);
  if (await sha256File(stagedFiles.cadPath) !== manifest.cadSha256) {
    throw new Error("SendCutSend staged CAD bytes do not match the reviewed manifest.");
  }
  if (manifest.drawingSha256 === null) {
    if (stagedFiles.drawingPath !== null) {
      throw new Error("SendCutSend staged drawing selection does not match the reviewed manifest.");
    }
    return;
  }
  if (
    stagedFiles.drawingPath === null
    || await sha256File(stagedFiles.drawingPath) !== manifest.drawingSha256
  ) {
    throw new Error("SendCutSend staged drawing bytes do not match the reviewed manifest.");
  }
}

function assertSendCutSendCliAdmission(input: {
  vendors: readonly LiveAutomationVendorName[];
  rawQuantities: string | null;
  quantities: readonly number[];
  manifestPath: string | null;
}): void {
  if (!input.vendors.includes("sendcutsend")) {
    if (input.manifestPath) {
      throw new Error(
        "SendCutSend manifest metadata may only be supplied when --vendor includes sendcutsend.",
      );
    }
    return;
  }
  if (hasInvalidQuantityToken(input.rawQuantities)) {
    throw new Error("SendCutSend quantities must be complete positive safe-integer tokens.");
  }
  if (new Set(input.quantities).size !== input.quantities.length) {
    throw new Error("SendCutSend quantities must be unique before evaluation.");
  }
  if (!input.manifestPath) {
    throw new Error(`SendCutSend requires --sendcutsend-manifest.\n\n${usage()}`);
  }
}

/**
 * Parses smoke CLI input and requires each provider's exact admission metadata
 * before returning runnable arguments.
 */
export function parseSmokeArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): SmokeArgs {
  const rawVendor = readFlag(argv, "--vendor")?.trim() ?? env.QUOTE_VENDOR_SMOKE_VENDOR?.trim();
  const vendors = parseVendors(rawVendor);
  const cadPath = readFlag(argv, "--cad") ?? env.QUOTE_VENDOR_LIVE_TEST_CAD_PATH ?? null;
  const drawingPath = readFlag(argv, "--drawing") ?? env.QUOTE_VENDOR_LIVE_TEST_DRAWING_PATH ?? null;
  const rawQuantities = readFlag(argv, "--quantities") ?? env.QUOTE_VENDOR_SMOKE_QUANTITIES ?? null;
  const quantities = parseQuantities(rawQuantities);
  const sendCutSendManifestPath = readFlag(argv, "--sendcutsend-manifest")
    ?? env.QUOTE_VENDOR_SENDCUTSEND_MANIFEST_PATH
    ?? null;

  if (!vendors) {
    throw new Error(`Missing or unsupported --vendor.\n\n${usage()}`);
  }

  if (!cadPath) {
    throw new Error(`Missing --cad or QUOTE_VENDOR_LIVE_TEST_CAD_PATH.\n\n${usage()}`);
  }

  if (vendors.includes("oshcut") && hasInvalidQuantityToken(rawQuantities)) {
    throw new Error("OSH Cut quantities must be complete positive integer tokens.");
  }
  assertSendCutSendCliAdmission({
    vendors,
    rawQuantities,
    quantities,
    manifestPath: sendCutSendManifestPath,
  });

  const oshcutPackage = parseOshcutPackageMetadata(argv, vendors);
  if (vendors.includes("oshcut")) {
    assertExactOshcutPackageMetadata(oshcutPackage);
    for (const quantity of quantities) {
      assertOshcutQuantity(quantity);
    }
  }

  return {
    vendors,
    cadPath: path.resolve(cadPath),
    drawingPath: drawingPath ? path.resolve(drawingPath) : null,
    quantities,
    confirmedNonExportControlled: hasNonExportControlledConfirmation(argv, env),
    fabworksPackage: parseFabworksPackageMetadata(argv, vendors, cadPath),
    oshcutPackage,
    sendCutSendManifestPath: sendCutSendManifestPath
      ? path.resolve(sendCutSendManifestPath)
      : null,
  };
}

function makeConfig(
  vendor: LiveAutomationVendorName,
  evaluationRuntimeDir: string,
): WorkerConfig {
  const genericKeys = [
    "WORKER_POLL_INTERVAL_MS",
    "WORKER_QUANTITY_PRICING_LADDER",
    "WORKER_VENDOR_RATE_LIMIT_MS",
    "WORKER_PRICING_MODEL_ENABLED",
    "WORKER_PRICING_MODEL_MIN_CONFIDENCE",
    "WORKER_HTTP_HOST",
    "QUOTE_ARTIFACT_BUCKET",
    "PORT",
    "WORKER_BUILD_VERSION",
  ] as const;
  const configEnv: NodeJS.ProcessEnv = vendor === "sendcutsend"
    ? Object.fromEntries(genericKeys.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }))
    : process.env;
  return loadConfig({
    ...configEnv,
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

/**
 * Builds a live-evaluation input from exact provider metadata and a canonical
 * SendCutSend manifest when that local evaluation lane is selected.
 */
function makeInput(input: {
  vendor: VendorName;
  quantity: number;
  cadPath: string;
  drawingPath: string | null;
  stagedCadPath: string;
  stagedDrawingPath: string | null;
  authorization: LiveEvaluationAuthorization;
  fabworksPackage: FabworksPackageMetadata | null;
  oshcutPackage: OshcutPackageMetadata | null;
  sendCutSendManifest: SendCutSendEvaluationManifest | null;
}): VendorQuoteAdapterInput {
  const {
    vendor,
    quantity,
    cadPath,
    drawingPath,
    stagedCadPath,
    stagedDrawingPath,
    authorization,
    fabworksPackage,
    oshcutPackage,
    sendCutSendManifest,
  } = input;
  const stamp = Date.now();
  const idPrefix = `${vendor}-smoke-q${quantity}`;
  let material = "6061 aluminum";
  let finish = "as machined";
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
  } else if (vendor === "oshcut") {
    assertExactOshcutPackageMetadata(oshcutPackage);
    material = oshcutPackage.material === "aluminum_6061_t6"
      ? "Aluminum 6061-T6"
      : "6061 aluminum";
    finish = "Mill finish";
    specSnapshot = {
      process: oshcutPackage.process,
      geometryFamily: oshcutPackage.geometryFamily,
    };
  } else if (vendor === "sendcutsend") {
    if (!sendCutSendManifest) {
      throw new Error("SendCutSend adapter invocation denied: reviewed manifest is unavailable.");
    }
    material = sendCutSendManifest.material;
    finish = sendCutSendManifest.finish;
    specSnapshot = {
      process: sendCutSendManifest.process,
      evaluationManifest: sendCutSendManifest,
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
      finish,
      tightest_tolerance_inch: sendCutSendManifest?.tightestToleranceInch ?? 0.005,
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
 * Runs one quantity from captured bytes after provider-specific admission is
 * revalidated before registry construction or any adapter/provider call.
 */
export async function runQuote(
  config: WorkerConfig,
  args: SmokeArgs,
  vendor: LiveAutomationVendorName,
  quantity: number,
  stagedFiles: StagedEvaluationFiles,
  buildRegistry: typeof buildLiveEvaluationAdapterRegistry = buildLiveEvaluationAdapterRegistry,
  sendCutSendManifest: SendCutSendEvaluationManifest | null = null,
): Promise<SmokeRow> {
  assertFabworksPackageMetadata(args, vendor);
  if (vendor === "oshcut") {
    assertExactOshcutPackageMetadata(args.oshcutPackage);
    assertOshcutQuantity(quantity);
  }
  if (vendor === "sendcutsend") {
    const exactManifest = parseSendCutSendEvaluationManifest(sendCutSendManifest);
    if (!args.vendors.includes("sendcutsend") || !exactManifest) {
      throw new Error("SendCutSend adapter invocation denied: reviewed manifest is unavailable.");
    }
    assertSendCutSendManifestInvocation(exactManifest, args);
    await verifyStagedSendCutSendBytes(args, exactManifest, stagedFiles);
    if (!exactManifest.quantities.includes(quantity)) {
      throw new Error("SendCutSend adapter invocation denied: quantity is not manifest-bound.");
    }
  }
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
      makeInput({
        vendor,
        quantity,
        cadPath: args.cadPath,
        drawingPath: args.drawingPath,
        stagedCadPath: stagedFiles.cadPath,
        stagedDrawingPath: stagedFiles.drawingPath,
        authorization: stagedFiles.authorization,
        fabworksPackage: args.fabworksPackage ?? null,
        oshcutPackage: args.oshcutPackage ?? null,
        sendCutSendManifest,
      }),
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
 * Validates provider metadata and quantity bounds before configuration, then
 * reuses one authorized byte capture and performs one cleanup after the batch.
 */
export async function runEvaluationBatch(
  args: SmokeArgs,
  dependencies: EvaluationBatchDependencies = {},
): Promise<SmokeRow[]> {
  assertFabworksPackageMetadata(args);
  assertOshcutBatch(args);
  const sendCutSendManifest = await loadSendCutSendEvaluationManifest(args);
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
    if (sendCutSendManifest) {
      await verifyStagedSendCutSendBytes(args, sendCutSendManifest, stagedFiles);
    }
    for (const vendor of args.vendors) {
      const workflow = getExtendedVendorWorkflow(vendor);
      const scopedConfig = scopeRuntimeCredentialPreparation(
        makeVendorConfig(vendor, credentialRuntimeDir),
        vendor,
      );
      const preparedConfig = vendor === "sendcutsend"
        ? scopedConfig
        : await prepareConfig(scopedConfig);
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
          sendCutSendManifest,
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
