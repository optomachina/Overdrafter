import "dotenv/config";
import { createHash } from "node:crypto";
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
import { prepareRuntimeSecrets } from "../runtimeSecrets.js";
import {
  summarizeWorkerError,
  UNKNOWN_WORKER_ERROR_MESSAGE,
} from "../errorSummary.js";
import {
  type LiveEvaluationAuthorization,
  type LiveAutomationVendorName,
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
  sendCutSendManifestPath?: string | null;
};

export type SendCutSendEvaluationManifest = {
  schemaVersion: "sendcutsend-evaluation-manifest.v1";
  reviewed: true;
  reviewedAt: string;
  reviewedBy: string;
  envelopeRevision: "sendcutsend-cnc-envelope.v1";
  accountMode: "company_controlled";
  cadSha256: string;
  drawingSha256: string | null;
  process: "CNC machining";
  material: "6061-T6 aluminum";
  finish: "as machined";
  tightestToleranceInch: 0.005;
  quantities: number[];
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
  offers: VendorQuoteAdapterOffer[];
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
    "",
    `Live evaluation vendors: ${LIVE_EVALUATION_VENDORS.join(", ")}`,
    "",
    "SendCutSend requires a reviewed digest-bound manifest and currently performs preflight only; it does not navigate, upload, or acquire a live quote.",
    "Other vendors require an authenticated provider session. This standalone evaluation command does not use production routing, provider admission, customer disclosure, or dispatch permits.",
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
    .map((entry) => entry.trim())
    .filter((entry) => /^\d+$/.test(entry))
    .map((entry) => Number(entry))
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
  const sendCutSendManifestPath = readFlag(argv, "--sendcutsend-manifest")
    ?? env.QUOTE_VENDOR_SENDCUTSEND_MANIFEST_PATH
    ?? null;

  if (!vendors) {
    throw new Error(`Missing or unsupported --vendor.\n\n${usage()}`);
  }

  if (!cadPath) {
    throw new Error(`Missing --cad or QUOTE_VENDOR_LIVE_TEST_CAD_PATH.\n\n${usage()}`);
  }
  if (vendors.includes("sendcutsend") && !sendCutSendManifestPath) {
    throw new Error(`SendCutSend requires --sendcutsend-manifest with reviewed, digest-bound facts.\n\n${usage()}`);
  }

  return {
    vendors,
    cadPath: path.resolve(cadPath),
    drawingPath: drawingPath ? path.resolve(drawingPath) : null,
    quantities,
    confirmedNonExportControlled: hasNonExportControlledConfirmation(argv, env),
    sendCutSendManifestPath: sendCutSendManifestPath
      ? path.resolve(sendCutSendManifestPath)
      : null,
  };
}

const SENDCUTSEND_MANIFEST_KEYS = [
  "accountMode",
  "cadSha256",
  "drawingSha256",
  "envelopeRevision",
  "finish",
  "material",
  "process",
  "quantities",
  "reviewed",
  "reviewedAt",
  "reviewedBy",
  "schemaVersion",
  "tightestToleranceInch",
] as const;

function sha256(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function sameQuantities(left: readonly number[], right: readonly number[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertSendCutSendManifest(
  value: unknown,
  args: SmokeArgs,
): asserts value is SendCutSendEvaluationManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SendCutSend evaluation manifest must be a JSON object.");
  }
  const manifest = value as Record<string, unknown>;
  const keys = Object.keys(manifest).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...SENDCUTSEND_MANIFEST_KEYS].sort())) {
    throw new Error("SendCutSend evaluation manifest fields are missing or unrecognized.");
  }
  const exactFacts = manifest.schemaVersion === "sendcutsend-evaluation-manifest.v1"
    && manifest.reviewed === true
    && manifest.envelopeRevision === "sendcutsend-cnc-envelope.v1"
    && manifest.accountMode === "company_controlled"
    && manifest.process === "CNC machining"
    && manifest.material === "6061-T6 aluminum"
    && manifest.finish === "as machined"
    && manifest.tightestToleranceInch === 0.005;
  const reviewedFacts = typeof manifest.reviewedAt === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(manifest.reviewedAt)
    && Number.isFinite(Date.parse(`${manifest.reviewedAt}T00:00:00Z`))
    && typeof manifest.reviewedBy === "string"
    && manifest.reviewedBy.trim().length > 0;
  const digests = typeof manifest.cadSha256 === "string"
    && /^[a-f0-9]{64}$/.test(manifest.cadSha256)
    && (manifest.drawingSha256 === null
      || (typeof manifest.drawingSha256 === "string" && /^[a-f0-9]{64}$/.test(manifest.drawingSha256)));
  const quantities = Array.isArray(manifest.quantities)
    && manifest.quantities.every((quantity) => Number.isInteger(quantity) && quantity > 0)
    && sameQuantities(manifest.quantities as number[], args.quantities);
  if (!exactFacts || !reviewedFacts || !digests || !quantities) {
    throw new Error("SendCutSend evaluation manifest facts are incomplete or outside the exact reviewed envelope.");
  }
}

/** Loads and binds reviewed SendCutSend facts to the exact source bytes before staging. */
export async function loadSendCutSendEvaluationManifest(
  args: SmokeArgs,
): Promise<SendCutSendEvaluationManifest | null> {
  if (!args.vendors.includes("sendcutsend")) {
    return null;
  }
  if (!args.confirmedNonExportControlled) {
    throw new Error("SendCutSend evaluation requires --confirm-non-export-controlled before reading selected files.");
  }
  if (!args.sendCutSendManifestPath) {
    throw new Error("SendCutSend evaluation manifest is required before staging.");
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(await fs.readFile(args.sendCutSendManifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `SendCutSend evaluation manifest could not be read: ${safeEvaluationError(error, evaluationSensitivePaths(args))}`,
    );
  }
  assertSendCutSendManifest(manifest, args);

  const cadDigest = sha256(await fs.readFile(args.cadPath));
  if (cadDigest !== manifest.cadSha256) {
    throw new Error("SendCutSend evaluation manifest CAD digest does not match the selected bytes.");
  }
  if (args.drawingPath === null && manifest.drawingSha256 !== null) {
    throw new Error("SendCutSend evaluation manifest declares a drawing that was not selected.");
  }
  if (args.drawingPath !== null) {
    const drawingDigest = sha256(await fs.readFile(args.drawingPath));
    if (drawingDigest !== manifest.drawingSha256) {
      throw new Error("SendCutSend evaluation manifest drawing digest does not match the selected bytes.");
    }
  }
  return manifest;
}

function assertStagedSendCutSendBinding(
  stagedFiles: StagedEvaluationFiles,
  manifest: SendCutSendEvaluationManifest | null,
) {
  if (!manifest) {
    return;
  }
  const authorization = stagedFiles.authorization;
  if (authorization.cadFileSha256 !== manifest.cadSha256
    || authorization.drawingFileSha256 !== manifest.drawingSha256) {
    throw new Error("SendCutSend staged authorization does not match the reviewed manifest digests.");
  }
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
  sendCutSendManifest: SendCutSendEvaluationManifest | null,
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

  let material = "6061 aluminum";
  let finish = "as machined";
  let tightestToleranceInch = 0.005;
  let specSnapshot: Record<string, unknown> | undefined;
  if (vendor === "sendcutsend") {
    if (!sendCutSendManifest || !sendCutSendManifest.quantities.includes(quantity)) {
      throw new Error("SendCutSend reviewed manifest facts are unavailable for this quantity.");
    }
    material = sendCutSendManifest.material;
    finish = sendCutSendManifest.finish;
    tightestToleranceInch = sendCutSendManifest.tightestToleranceInch;
    specSnapshot = {
      process: sendCutSendManifest.process,
      evaluationManifest: {
        schemaVersion: sendCutSendManifest.schemaVersion,
        reviewedAt: sendCutSendManifest.reviewedAt,
        reviewedBy: sendCutSendManifest.reviewedBy,
        envelopeRevision: sendCutSendManifest.envelopeRevision,
        cadSha256: sendCutSendManifest.cadSha256,
        drawingSha256: sendCutSendManifest.drawingSha256,
      },
    };
  }

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
      tightest_tolerance_inch: tightestToleranceInch,
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

const EVALUATION_PATH_PATTERN = /(?:[A-Za-z]:\\[^\s:;,)\]}]*|\/(?:[^/\s:;,)\]}]+\/)*[^/\s:;,)\]}]+)/g;
const MAX_EVALUATION_PAYLOAD_ENTRIES = 25;
const MAX_EVALUATION_PAYLOAD_DEPTH = 4;

type EvaluationSensitivePath = string | null | undefined;

function evaluationSensitivePaths(
  args: SmokeArgs,
  stagedFiles: StagedEvaluationFiles | null = null,
  extraPaths: readonly EvaluationSensitivePath[] = [],
) {
  return [
    args.cadPath,
    args.drawingPath,
    args.sendCutSendManifestPath,
    stagedFiles?.cadPath,
    stagedFiles?.drawingPath,
    ...extraPaths,
  ];
}

function redactKnownEvaluationPaths(
  message: string,
  sensitivePaths: readonly EvaluationSensitivePath[],
) {
  const exactPaths = sensitivePaths
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 1)
    .sort((left, right) => right.length - left.length);
  let redacted = message;
  for (const exactPath of exactPaths) {
    redacted = redacted.replaceAll(exactPath, "<redacted-path>");
  }
  return redacted;
}

function readEvaluationErrorMessage(error: unknown) {
  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object" && !Array.isArray(error)) {
    try {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string") {
        return message;
      }
    } catch {
      return UNKNOWN_WORKER_ERROR_MESSAGE;
    }
  }

  return UNKNOWN_WORKER_ERROR_MESSAGE;
}

/** Produces the bounded, path-redacted message used by console and JSON evidence. */
export function safeEvaluationError(
  error: unknown,
  sensitivePaths: readonly EvaluationSensitivePath[] = [],
) {
  const message = readEvaluationErrorMessage(error);
  const exactPathRedacted = redactKnownEvaluationPaths(message, sensitivePaths);
  const filesystemPathRedacted = exactPathRedacted.replace(
    EVALUATION_PATH_PATTERN,
    "<redacted-path>",
  );
  return summarizeWorkerError(filesystemPathRedacted);
}

function safeEvaluationValue(
  value: unknown,
  depth: number,
  sensitivePaths: readonly EvaluationSensitivePath[],
): unknown {
  if (typeof value === "string") {
    return safeEvaluationError(value, sensitivePaths);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth >= MAX_EVALUATION_PAYLOAD_DEPTH) {
    return "[bounded]";
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_EVALUATION_PAYLOAD_ENTRIES)
      .map((entry) => safeEvaluationValue(entry, depth + 1, sensitivePaths));
  }
  if (value && typeof value === "object") {
    try {
      return Object.fromEntries(
        Object.entries(value)
          .slice(0, MAX_EVALUATION_PAYLOAD_ENTRIES)
          .map(([key, entry]) => [
            key.slice(0, 100),
            safeEvaluationValue(entry, depth + 1, sensitivePaths),
          ]),
      );
    } catch {
      return "[unavailable]";
    }
  }
  return "[unavailable]";
}

function safeEvaluationPayload(
  payload: Record<string, unknown>,
  sensitivePaths: readonly EvaluationSensitivePath[],
) {
  const sanitized = safeEvaluationValue(payload, 0, sensitivePaths);
  if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
    return sanitized as Record<string, unknown>;
  }
  return { detail: sanitized };
}

export function buildErrorRow(
  vendor: VendorName,
  quantity: number,
  startedAt: string,
  startMs: number,
  error: unknown,
  sensitivePaths: readonly EvaluationSensitivePath[] = [],
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
    offers: [],
    artifacts: vendorError?.artifacts ?? [],
    rawPayload: null,
    errorCode: vendorError ? String(vendorError.code) : null,
    errorPayload: vendorError ? safeEvaluationPayload(vendorError.payload, sensitivePaths) : null,
    error: safeEvaluationError(error, sensitivePaths),
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
  sendCutSendManifest: SendCutSendEvaluationManifest | null = null,
): Promise<SmokeRow> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const registry = buildRegistry(config);
  const adapter = registry[vendor];
  const sensitivePaths = evaluationSensitivePaths(args, stagedFiles, [config.workerTempDir]);

  if (!adapter) {
    return buildErrorRow(
      vendor,
      quantity,
      startedAt,
      startMs,
      new Error(`${vendor} adapter is not enabled.`),
      sensitivePaths,
    );
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
        sendCutSendManifest,
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
      offers: result.offers ?? [],
      artifacts: result.artifacts,
      rawPayload: result.rawPayload,
      errorCode: null,
      errorPayload: null,
      error: null,
      cleanupError: null,
    };
  } catch (error) {
    console.log("FAILED");
    row = buildErrorRow(vendor, quantity, startedAt, startMs, error, sensitivePaths);
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
    assertStagedSendCutSendBinding(stagedFiles, sendCutSendManifest);
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
    const sensitivePaths = evaluationSensitivePaths(args, stagedFiles, [
      runtimeBaseDir,
      batchRuntimeDir,
      credentialRuntimeDir,
      evidenceRuntimeDir,
    ]);
    const cleanupError = cleanupFailures
      .map((failure) => safeEvaluationError(failure, sensitivePaths))
      .join("; ");
    for (const row of rows) {
      row.cleanupError = cleanupError;
    }
  }

  return rows;
}

async function main() {
  const args = parseSmokeArgs(process.argv.slice(2));
  const sensitivePaths = evaluationSensitivePaths(args, null, [process.env.WORKER_TEMP_DIR]);

  try {
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
  } catch (error) {
    throw new Error(safeEvaluationError(error, sensitivePaths));
  }
}

const invokedAsScript = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (invokedAsScript) {
  try {
    await main();
  } catch (error) {
    console.error(safeEvaluationError(error));
    process.exitCode = 1;
  }
}
