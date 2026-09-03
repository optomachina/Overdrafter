import "dotenv/config";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { FABWORKS_ENVELOPE } from "../adapters/fabworks.js";
import { buildLiveEvaluationAdapterRegistry } from "../adapters/index.js";
import {
  assertProviderAdapterContract,
  evaluateProviderAdapterFailureContract,
  PROVIDER_ADAPTER_CONTRACT_REVISION,
  type ProviderAdapterContractDefinition,
} from "../adapters/providerAdapterContract.js";
import { EXTENDED_VENDOR_WORKFLOWS, getExtendedVendorWorkflow } from "../adapters/extendedVendorWorkflows.js";
import {
  readProviderPortalApprovalFile,
  scrubProviderEvidenceText,
} from "../adapters/providerPortalKernel.js";
import { OSHCUT_PROVIDER_ENVELOPE } from "../adapters/oshcut.js";
import {
  parseSendCutSendEvaluationManifest,
  safeSendCutSendEvaluationError,
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
  type ProviderPortalApprovalDescriptor,
  type VendorArtifact,
  type VendorAutomationError,
  type VendorName,
  type VendorQuoteAdapterInput,
  type VendorQuoteAdapterOffer,
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
  approvalFilePath?: string | null;
  approvalFileSha256?: string | null;
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
  offers: VendorQuoteAdapterOffer[];
  artifacts: VendorArtifact[];
  rawPayload: Record<string, unknown> | null;
  errorCode: string | null;
  errorPayload: Record<string, unknown> | null;
  error: string | null;
  cleanupError: string | null;
  evidence: LiveEvaluationEvidenceV1;
};

type LiveEvaluationEvidenceV1 = {
  schemaVersion: "provider-live-evaluation-evidence.v1";
  providerKey: string;
  manifestRevision: string;
  envelopeRevision: string;
  adapterRevision: string;
  adapterContractRevision: typeof PROVIDER_ADAPTER_CONTRACT_REVISION;
  cadFileSha256: string | null;
  drawingFileSha256: string | null;
  accountMode: string;
  startedAt: string;
  completedAt: string;
  terminalState: string;
  normalizedOffers: Array<VendorQuoteAdapterOffer & {
    quantity: number;
    validUntil: string | null;
    validityDurationDays: number | null;
    validitySource: "vendor_date" | "vendor_duration" | null;
    validityTerms: string | null;
    artifactRefs: string[];
  }>;
  artifactRefs: string[];
  persistence: {
    localOnly: true;
    customerOfferPersistence: false;
    providerAdmission: false;
  };
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
    "Usage: npm --prefix worker run eval:live-provider -- --vendor <vendor|all|vendor1,vendor2> --cad <path> [--drawing <path>] [--quantities 1,5] [--sendcutsend-manifest <reviewed.json>] [--approval-file <reviewed.json> --approval-file-sha256 <sha256>] --confirm-non-export-controlled",
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
  const approvalFilePath = readFlag(argv, "--approval-file");
  const approvalFileSha256 = readFlag(argv, "--approval-file-sha256")?.trim().toLowerCase() ?? null;
  if ((approvalFilePath === null) !== (approvalFileSha256 === null)) {
    throw new Error("Provider portal approval requires both --approval-file and --approval-file-sha256.");
  }

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
    approvalFilePath: approvalFilePath ? path.resolve(approvalFilePath) : null,
    approvalFileSha256,
  };
}

/** Verifies reviewed approval bytes before staging or provider/session work. */
export async function loadProviderPortalApproval(
  args: SmokeArgs,
): Promise<ProviderPortalApprovalDescriptor | null> {
  const portalVendors = args.vendors.filter((vendor) => getExtendedVendorWorkflow(vendor));
  if (!args.approvalFilePath || !args.approvalFileSha256) {
    if (portalVendors.length > 0) {
      throw new Error(
        "Provider portal evaluation requires --approval-file and --approval-file-sha256 before staging or provider interaction.",
      );
    }
    return null;
  }
  const approval = await readProviderPortalApprovalFile(
    args.approvalFilePath,
    args.approvalFileSha256,
  );
  if (
    !approval
    || portalVendors.length !== 1
    || portalVendors[0] !== approval.providerKey
    || approval.cadPath !== args.cadPath
    || approval.drawingPath !== args.drawingPath
    || JSON.stringify(approval.requestedQuantities) !== JSON.stringify(args.quantities)
  ) {
    throw new Error("Provider portal approval file or digest is invalid for the selected provider.");
  }
  return approval;
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
  providerPortalApproval: ProviderPortalApprovalDescriptor | null;
  requestedQuantities: number[];
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
    providerPortalApproval,
    requestedQuantities,
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
    providerPortalApproval: providerPortalApproval?.providerKey === vendor
      ? providerPortalApproval
      : undefined,
    providerPortalExecutionScope: providerPortalApproval?.providerKey === vendor
      ? {
          cadPath,
          drawingPath,
          requestedQuantities: [...requestedQuantities],
        }
      : undefined,
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

function evaluationSensitivePaths(
  args: SmokeArgs,
  stagedFiles?: StagedEvaluationFiles | null,
  runtimePaths: readonly string[] = [],
) {
  return normalizeEvaluationSensitivePaths([
    args.cadPath,
    args.drawingPath,
    args.sendCutSendManifestPath,
    stagedFiles?.cadPath,
    stagedFiles?.drawingPath,
    ...runtimePaths,
  ]);
}

function normalizeEvaluationSensitivePaths(
  sensitivePaths: readonly (string | null | undefined)[],
) {
  const normalizedPaths = new Set<string>();
  for (const sensitivePath of sensitivePaths) {
    if (typeof sensitivePath !== "string" || sensitivePath.length <= 1) {
      continue;
    }
    normalizedPaths.add(sensitivePath);
    normalizedPaths.add(path.resolve(sensitivePath));
  }
  return [...normalizedPaths];
}

function safeEvaluationText(
  value: unknown,
  sensitivePaths: readonly (string | null | undefined)[],
) {
  return scrubProviderEvidenceText(
    safeSendCutSendEvaluationError(value, sensitivePaths)
      .replace(/(?:<redacted-path>){2,}/g, "<redacted-path>"),
    1_000,
  );
}

function safeEvaluationValue(
  value: unknown,
  sensitivePaths: readonly (string | null | undefined)[],
  depth = 0,
): unknown {
  if (typeof value === "string") {
    return safeEvaluationText(value, sensitivePaths);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth >= 4) {
    return "<bounded-value>";
  }
  if (Array.isArray(value)) {
    try {
      return value.slice(0, 50).map((entry) => safeEvaluationValue(
        entry,
        sensitivePaths,
        depth + 1,
      ));
    } catch {
      return "<unavailable-value>";
    }
  }
  if (value && typeof value === "object") {
    try {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([key, entry]) => [key.slice(0, 120), safeEvaluationValue(
          entry,
          sensitivePaths,
          depth + 1,
        )]));
    } catch {
      return "<unavailable-value>";
    }
  }
  return "<unavailable-value>";
}

const SAFE_EVALUATION_PAYLOAD_KEYS = new Set([
  "vendor",
  "terminalState",
  "reason",
  "reasonCode",
  "detectedFlow",
  "providerInteractionAttempted",
  "providerMutationPossible",
  "orderAttempted",
  "quoteOnly",
  "orderProhibited",
  "priceTrusted",
  "priceGateReason",
  "locatorDriftDetected",
  "requirementsVerified",
  "customerLiveOfferEligible",
  "requiresManualVendorFollowUp",
  "manualFollowUpReason",
  "automationVersion",
  "executionContext",
  "kernelRevision",
  "manifestRevision",
  "envelopeRevision",
  "adapterRevision",
  "fabworksState",
  "oshcutState",
  "sendCutSendState",
  "eligibilityReason",
]);

function safeEvaluationPayload(
  value: Record<string, unknown> | null,
  sensitivePaths: readonly (string | null | undefined)[],
) {
  if (!value) {
    return null;
  }
  const allowlistedValue = Object.fromEntries(
    Object.entries(value).filter(([key]) => SAFE_EVALUATION_PAYLOAD_KEYS.has(key)),
  );
  const safeValue = safeEvaluationValue(allowlistedValue, sensitivePaths);
  if (safeValue && typeof safeValue === "object" && !Array.isArray(safeValue)) {
    return safeValue as Record<string, unknown>;
  }
  return { value: safeValue };
}

function safeEvaluationUrl(
  value: string | null,
): string | null {
  if (value === null) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function safeEvaluationString(
  value: string | null,
  sensitivePaths: readonly (string | null | undefined)[],
) {
  return value === null ? null : safeEvaluationText(value, sensitivePaths);
}

function safeEvaluationOffers(
  offers: readonly VendorQuoteAdapterOffer[],
  sensitivePaths: readonly (string | null | undefined)[],
): VendorQuoteAdapterOffer[] {
  return offers.map((offer) => ({
    providerOptionId: safeEvaluationText(offer.providerOptionId, sensitivePaths),
    providerLabel: safeEvaluationText(offer.providerLabel, sensitivePaths),
    quoteRef: offer.quoteRef === null ? null : "<redacted-quote-ref>",
    quoteUrl: safeEvaluationUrl(offer.quoteUrl),
    unitPriceUsd: offer.unitPriceUsd,
    totalPriceUsd: offer.totalPriceUsd,
    leadTimeBusinessDays: offer.leadTimeBusinessDays,
    shipReceiveBy: safeEvaluationString(offer.shipReceiveBy, sensitivePaths),
    tier: safeEvaluationString(offer.tier, sensitivePaths),
    sourcing: safeEvaluationString(offer.sourcing, sensitivePaths),
    geographicOrigin: offer.geographicOrigin,
    sortRank: offer.sortRank,
    provenance: {
      containerSelector: safeEvaluationText(
        offer.provenance.containerSelector,
        sensitivePaths,
      ),
      providerOptionIdSource: offer.provenance.providerOptionIdSource,
      priceSource: offer.provenance.priceSource,
      leadTimeSource: offer.provenance.leadTimeSource,
      geographicOriginSource: offer.provenance.geographicOriginSource,
    },
    rawPayload: {
      normalizationRevision: "provider-live-evaluation-offer.v1",
      sourcePayloadRetained: false,
    },
  }));
}

function safeEvaluationArtifacts(
  artifacts: readonly VendorArtifact[],
  sensitivePaths: readonly (string | null | undefined)[],
): VendorArtifact[] {
  return artifacts.map((artifact) => ({
    ...artifact,
    label: safeEvaluationText(artifact.label, sensitivePaths),
    localPath: "<redacted-artifact-path>",
  }));
}

function artifactEvidenceRefs(artifacts: readonly VendorArtifact[]): string[] {
  return artifacts.map((artifact, index) =>
    `${artifact.kind}:${index + 1}:${artifact.label.slice(0, 120)}`);
}

function payloadString(
  payload: Record<string, unknown> | null,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function buildLiveEvaluationEvidence(input: {
  vendor: VendorName;
  quantity: number;
  startedAt: string;
  authorization?: LiveEvaluationAuthorization | null;
  accountMode?: string | null;
  status?: string | null;
  offers?: readonly VendorQuoteAdapterOffer[];
  artifacts?: readonly VendorArtifact[];
  rawPayload?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorPayload?: Record<string, unknown> | null;
  validUntil?: string | null;
  validityDurationDays?: number | null;
  validitySource?: "vendor_date" | "vendor_duration" | null;
  validityTerms?: string | null;
}): LiveEvaluationEvidenceV1 {
  const artifacts = input.artifacts ?? [];
  const refs = artifactEvidenceRefs(artifacts);
  const terminalState = payloadString(input.errorPayload ?? null, "terminalState")
    ?? input.errorCode
    ?? payloadString(input.rawPayload ?? null, "terminalState", "detectedFlow")
    ?? input.status
    ?? "unavailable";
  return {
    schemaVersion: "provider-live-evaluation-evidence.v1",
    providerKey: input.vendor,
    manifestRevision: payloadString(input.rawPayload ?? input.errorPayload ?? null, "manifestRevision")
      ?? "provider-manifest.v1",
    envelopeRevision: payloadString(input.rawPayload ?? input.errorPayload ?? null, "envelopeRevision")
      ?? "provider-capability-envelope.v1",
    adapterRevision: payloadString(
      input.rawPayload ?? input.errorPayload ?? null,
      "adapterRevision",
      "automationVersion",
    ) ?? "unknown",
    adapterContractRevision: PROVIDER_ADAPTER_CONTRACT_REVISION,
    cadFileSha256: input.authorization?.cadFileSha256 ?? null,
    drawingFileSha256: input.authorization?.drawingFileSha256 ?? null,
    accountMode: input.accountMode ?? "unknown",
    startedAt: input.startedAt,
    completedAt: new Date().toISOString(),
    terminalState,
    normalizedOffers: (input.offers ?? []).map((offer) => ({
      ...offer,
      quantity: input.quantity,
      validUntil: input.validUntil ?? null,
      validityDurationDays: input.validityDurationDays ?? null,
      validitySource: input.validitySource ?? null,
      validityTerms: input.validityTerms ?? null,
      artifactRefs: [...refs],
    })),
    artifactRefs: refs,
    persistence: {
      localOnly: true,
      customerOfferPersistence: false,
      providerAdmission: false,
    },
  };
}

function exactHost(rawUrl: string): string {
  return new URL(rawUrl).hostname.toLowerCase();
}

function adapterContractDefinition(
  vendor: LiveAutomationVendorName,
): ProviderAdapterContractDefinition {
  const workflow = getExtendedVendorWorkflow(vendor);
  let allowedHosts: string[];
  if (workflow) {
    allowedHosts = [...new Set([
      exactHost(workflow.publicUrl),
      exactHost(workflow.loginUrl),
      exactHost(workflow.uploadUrl),
    ])];
  } else if (vendor === "xometry") {
    allowedHosts = ["www.xometry.com"];
  } else if (vendor === "fictiv") {
    allowedHosts = ["app.fictiv.com"];
  } else if (vendor === "sendcutsend") {
    allowedHosts = ["app.sendcutsend.com"];
  } else {
    throw new Error(`Provider adapter contract is unavailable for ${vendor}.`);
  }
  return {
    provider: vendor,
    allowedHosts,
    selectors: { cadUpload: "input[type='file']" },
    requirements: {
      quoteOnly: true,
      orderProhibited: true,
      isolatedSession: true,
    },
  };
}

function contractFailure(error: unknown, vendor: LiveAutomationVendorName): unknown {
  if (!isVendorAutomationError(error)) {
    return error;
  }
  const result = evaluateProviderAdapterFailureContract(error);
  if (result.ok) {
    return error;
  }
  return new Error(
    `${vendor} provider adapter failure contract failed: ${result.violations.join(", ")}`,
  );
}

/** Bounds and redacts a CLI-visible evaluation failure without changing its source error. */
export function safeTopLevelEvaluationError(
  error: unknown,
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  return safeEvaluationText(error, normalizeEvaluationSensitivePaths([
    readFlag(argv, "--cad"),
    readFlag(argv, "--drawing"),
    readFlag(argv, "--sendcutsend-manifest"),
    env.QUOTE_VENDOR_LIVE_TEST_CAD_PATH,
    env.QUOTE_VENDOR_LIVE_TEST_DRAWING_PATH,
    env.QUOTE_VENDOR_SENDCUTSEND_MANIFEST_PATH,
    env.WORKER_TEMP_DIR,
  ]));
}

export function buildErrorRow(
  vendor: VendorName,
  quantity: number,
  startedAt: string,
  startMs: number,
  error: unknown,
  sensitivePaths: readonly (string | null | undefined)[] = [],
  evidenceContext: {
    authorization?: LiveEvaluationAuthorization | null;
    accountMode?: string | null;
  } = {},
): SmokeRow {
  const vendorError = isVendorAutomationError(error) ? error : null;
  const normalizedSensitivePaths = normalizeEvaluationSensitivePaths(sensitivePaths);

  const artifacts = safeEvaluationArtifacts(
    vendorError?.artifacts ?? [],
    normalizedSensitivePaths,
  );
  const errorPayload = vendorError
    ? safeEvaluationPayload(vendorError.payload, normalizedSensitivePaths)
    : null;
  const errorCode = vendorError ? String(vendorError.code) : null;
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
    offers: [],
    artifacts,
    rawPayload: null,
    errorCode,
    errorPayload,
    error: safeEvaluationText(error, normalizedSensitivePaths),
    cleanupError: null,
    evidence: buildLiveEvaluationEvidence({
      vendor,
      quantity,
      startedAt,
      authorization: evidenceContext.authorization,
      accountMode: evidenceContext.accountMode,
      artifacts,
      errorCode,
      errorPayload,
    }),
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
  providerPortalApproval: ProviderPortalApprovalDescriptor | null = null,
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
  const sensitivePaths = evaluationSensitivePaths(
    args,
    stagedFiles,
    [config.workerTempDir],
  );
  const accountMode = vendor === "sendcutsend"
    ? "local_reviewed_manifest"
    : "isolated_authenticated_session";

  if (!adapter) {
    return buildErrorRow(
      vendor,
      quantity,
      startedAt,
      startMs,
      new Error(`${vendor} adapter is not enabled.`),
      sensitivePaths,
      {
        authorization: stagedFiles.authorization,
        accountMode,
      },
    );
  }

  process.stdout.write(`\n>>> Quoting ${vendor} qty ${quantity}... `);

  let row: SmokeRow;
  try {
    const adapterInput = makeInput({
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
        providerPortalApproval,
        requestedQuantities: args.quantities,
      });
    const result = await adapter.quote(adapterInput);
    const contract = assertProviderAdapterContract({
      definition: adapterContractDefinition(vendor),
      adapterInput,
      output: result,
    });
    console.log("done");
    const offers = safeEvaluationOffers(contract.normalizedOffers, sensitivePaths);
    const artifacts = safeEvaluationArtifacts(result.artifacts, sensitivePaths);
    const rawPayload = safeEvaluationPayload(result.rawPayload, sensitivePaths);
    row = {
      executionContext: "live_evaluation",
      vendor,
      quantity,
      startedAt,
      elapsedSec: (Date.now() - startMs) / 1000,
      status: result.status,
      totalPriceUsd: offers[0]?.totalPriceUsd ?? null,
      unitPriceUsd: offers[0]?.unitPriceUsd ?? null,
      leadTimeBusinessDays: offers[0]?.leadTimeBusinessDays ?? null,
      quoteUrl: safeEvaluationUrl(result.quoteUrl),
      offers,
      artifacts,
      rawPayload,
      errorCode: null,
      errorPayload: null,
      error: null,
      cleanupError: null,
      evidence: buildLiveEvaluationEvidence({
        vendor,
        quantity,
        startedAt,
        authorization: stagedFiles.authorization,
        accountMode,
        status: result.status,
        offers,
        artifacts,
        rawPayload,
        validUntil: result.validUntil,
        validityDurationDays: result.validityDurationDays,
        validitySource: result.validitySource,
        validityTerms: result.validityTerms,
      }),
    };
  } catch (error) {
    console.log("FAILED");
    row = buildErrorRow(
      vendor,
      quantity,
      startedAt,
      startMs,
      contractFailure(error, vendor),
      sensitivePaths,
      {
        authorization: stagedFiles.authorization,
        accountMode,
      },
    );
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
  const providerPortalApproval = await loadProviderPortalApproval(args);
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
      console.log(`  Session state: ${config.vendorStorageStateDir ? "configured" : "not configured"}`);

      for (const quantity of args.quantities) {
        const row = await runQuote(
          config,
          args,
          vendor,
          quantity,
          stagedFiles,
          buildRegistry,
          sendCutSendManifest,
          providerPortalApproval,
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
    const sensitivePaths = evaluationSensitivePaths(
      args,
      stagedFiles,
      [batchRuntimeDir, credentialRuntimeDir, evidenceRuntimeDir],
    );
    const cleanupError = safeSendCutSendEvaluationError(
      cleanupFailures
        .map((failure) => safeSendCutSendEvaluationError(failure, sensitivePaths))
        .join("; "),
      sensitivePaths,
    );
    for (const row of rows) {
      row.cleanupError = cleanupError;
    }
  }

  return rows;
}

/** Writes path-free startup status suitable for captured CLI output. */
export function writeEvaluationStartupSummary(
  args: SmokeArgs,
  writeLine: (line: string) => void = console.log,
) {
  writeLine(`Live provider evaluation - vendors: [${args.vendors.join(", ")}], quantities: [${args.quantities.join(", ")}]`);
  writeLine("  CAD: selected");
  writeLine(`  Drawing: ${args.drawingPath ? "selected" : "not selected"}`);
}

async function main() {
  const args = parseSmokeArgs(process.argv.slice(2));

  writeEvaluationStartupSummary(args);
  const rows = await runEvaluationBatch(args);

  console.log("\nEvaluation results:");
  for (const row of rows) {
    console.log(formatRow(row));
  }

  const outPrefix = args.vendors.length === 1 ? args.vendors[0] : "live-providers";
  const outPath = path.join(os.tmpdir(), `${outPrefix}-workflow-smoke-${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify(rows, null, 2), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
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
    console.error(safeTopLevelEvaluationError(error, process.argv.slice(2)));
    process.exitCode = 1;
  }
}
