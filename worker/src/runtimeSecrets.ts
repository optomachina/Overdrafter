import fs from "node:fs/promises";
import path from "node:path";
import type { WorkerConfig } from "./types.js";
import { withXometryProfileInterprocessLock } from "./adapters/persistentProfileLock.js";
import {
  resolveIsolatedProviderStorageState,
  type ProviderPortalDefinition,
} from "./adapters/providerPortalKernel.js";
import { buildOshcutProductionPortalDefinition } from "./adapters/oshcutProductionPortal.js";
import { buildQuickpartsProductionPortalDefinition } from "./adapters/quickpartsPortal.js";
import { buildWeergProductionPortalDefinition } from "./adapters/weergPortal.js";
import { hasDirectExtractionCredential } from "./extraction/modelRegistry.js";
import {
  restoreXometryProfileSnapshot,
  withXometryProfileSnapshotLock,
} from "./xometryProfileSnapshot.js";
import { PRODUCTION_LIVE_ADAPTERS } from "./generated/providerRegistry.js";

/**
 * Adapters with a reviewed production dispatch path. The list is generated from
 * provider-integrations/provider-registry.v1.json. Listing a generic provider
 * here never admits it; the database policy, reviewed envelope, and rollout
 * still decide every dispatch.
 */
export { PRODUCTION_LIVE_ADAPTERS };

function parseStorageStateJson(input: string, source: string) {
  let parsedStorageState: unknown;

  try {
    parsedStorageState = JSON.parse(input);
  } catch (error) {
    throw new Error(
      `${source} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return parsedStorageState;
}

function hasStorageStateShape(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    cookies?: unknown;
    origins?: unknown;
  };

  return Array.isArray(candidate.cookies) && Array.isArray(candidate.origins);
}

export async function prepareRuntimeSecrets(config: WorkerConfig): Promise<WorkerConfig> {
  let preparedConfig = config;

  if (preparedConfig.xometryProfileSnapshotBucket) {
    if (!preparedConfig.xometryUserDataDir) {
      throw new Error(
        "Snapshot mode requires a local Xometry profile directory.",
      );
    }
    preparedConfig = await withXometryProfileInterprocessLock(
      preparedConfig.xometryUserDataDir,
      {
        waitMs: preparedConfig.xometryProfileLockWaitMs,
        vendor: "xometry-runtime-restore",
      },
      () =>
        withXometryProfileSnapshotLock(() =>
          restoreXometryProfileSnapshot(preparedConfig),
        ),
    );
  }

  if (!preparedConfig.xometryStorageStatePath && preparedConfig.xometryStorageStateJson) {
    const parsedStorageState = parseStorageStateJson(
      preparedConfig.xometryStorageStateJson,
      "XOMETRY_STORAGE_STATE_JSON",
    );

    const secretsDir = path.join(preparedConfig.workerTempDir, "runtime-secrets");
    await fs.mkdir(secretsDir, { recursive: true });

    const xometryStorageStatePath = path.join(secretsDir, "xometry-storage-state.json");
    await fs.writeFile(
      xometryStorageStatePath,
      JSON.stringify(parsedStorageState),
      { encoding: "utf8", mode: 0o600 },
    );

    preparedConfig = {
      ...preparedConfig,
      xometryStorageStatePath,
    };
  }

  if (!preparedConfig.fictivStorageStatePath && preparedConfig.fictivStorageStateJson) {
    const parsedStorageState = parseStorageStateJson(
      preparedConfig.fictivStorageStateJson,
      "FICTIV_STORAGE_STATE_JSON",
    );

    const secretsDir = path.join(preparedConfig.workerTempDir, "runtime-secrets");
    await fs.mkdir(secretsDir, { recursive: true });

    const fictivStorageStatePath = path.join(secretsDir, "fictiv-storage-state.json");
    await fs.writeFile(
      fictivStorageStatePath,
      JSON.stringify(parsedStorageState),
      { encoding: "utf8", mode: 0o600 },
    );

    preparedConfig = {
      ...preparedConfig,
      fictivStorageStatePath,
    };
  }

  return preparedConfig;
}

export async function validateXometryReadiness(config: WorkerConfig): Promise<string[]> {
  if (config.workerMode !== "live") {
    return [];
  }

  if (!config.workerLiveAdapters.includes("xometry")) {
    return [];
  }

  const issues: string[] = [];

  if (config.xometryUserDataDir) {
    try {
      const stat = await fs.stat(config.xometryUserDataDir);
      if (!stat.isDirectory()) {
        issues.push(
          `XOMETRY_USER_DATA_DIR at ${config.xometryUserDataDir} is not a directory.`,
        );
      }
    } catch {
      issues.push(
        `XOMETRY_USER_DATA_DIR was not found at ${config.xometryUserDataDir}. Run \`npm --prefix worker run auth:xometry\` to bootstrap the persistent profile.`,
      );
    }
    return issues;
  }

  if (!config.xometryStorageStatePath) {
    issues.push(
      "Live mode requires XOMETRY_USER_DATA_DIR (recommended) or XOMETRY_STORAGE_STATE_PATH / XOMETRY_STORAGE_STATE_JSON.",
    );
    return issues;
  }

  let storageStateRaw: string;

  try {
    storageStateRaw = await fs.readFile(config.xometryStorageStatePath, "utf8");
  } catch {
    issues.push(`Xometry storage state file was not found at ${config.xometryStorageStatePath}.`);
    return issues;
  }

  let parsedStorageState: unknown;

  try {
    parsedStorageState = parseStorageStateJson(
      storageStateRaw,
      `Xometry storage state file at ${config.xometryStorageStatePath}`,
    );
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
    return issues;
  }

  if (!hasStorageStateShape(parsedStorageState)) {
    issues.push(
      `Xometry storage state file at ${config.xometryStorageStatePath} must include cookies and origins arrays.`,
    );
  }

  return issues;
}

export async function validateFictivReadiness(config: WorkerConfig): Promise<string[]> {
  if (config.workerMode !== "live") {
    return [];
  }

  if (!config.workerLiveAdapters.includes("fictiv")) {
    return [];
  }

  const issues: string[] = [];

  if (!config.fictivStorageStatePath) {
    issues.push(
      "Live mode requires FICTIV_STORAGE_STATE_PATH or FICTIV_STORAGE_STATE_JSON.",
    );
    return issues;
  }

  let storageStateRaw: string;

  try {
    storageStateRaw = await fs.readFile(config.fictivStorageStatePath, "utf8");
  } catch {
    issues.push(`Fictiv storage state file was not found at ${config.fictivStorageStatePath}.`);
    return issues;
  }

  let parsedStorageState: unknown;

  try {
    parsedStorageState = parseStorageStateJson(
      storageStateRaw,
      `Fictiv storage state file at ${config.fictivStorageStatePath}`,
    );
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
    return issues;
  }

  if (!hasStorageStateShape(parsedStorageState)) {
    issues.push(
      `Fictiv storage state file at ${config.fictivStorageStatePath} must include cookies and origins arrays.`,
    );
  }

  return issues;
}

export async function validateDrawingExtractionReadiness(config: WorkerConfig): Promise<string[]> {
  const issues: string[] = [];

  if (config.drawingExtractionDebugAllowedModels.length === 0) {
    issues.push(
      "DRAWING_EXTRACTION_DEBUG_ALLOWED_MODELS must include at least one model for debug extraction runs.",
    );
  }

  if (!config.drawingExtractionEnableModelFallback) {
    return issues;
  }

  if (
    hasDirectExtractionCredential(config.drawingExtractionModel, {
      openai: config.openAiApiKey,
      anthropic: config.anthropicApiKey,
    })
  ) {
    return issues;
  }

  issues.push(
    "Drawing extraction model fallback is enabled but the configured model lacks matching direct-provider credentials. Fallback requests will stay disabled.",
  );

  return issues;
}

/**
 * A worker listing a production portal adapter must hold a session for it
 * that the portal kernel can actually open (QUOTE_VENDOR_STORAGE_STATE_PATHS,
 * _JSON or _DIR), resolved exactly as the kernel resolves it before launch.
 */
async function validatePortalSessionReadiness(
  config: WorkerConfig,
  definition: ProviderPortalDefinition,
): Promise<string[]> {
  if (config.workerMode !== "live" || !config.workerLiveAdapters.includes(definition.provider)) {
    return [];
  }
  const storageState = await resolveIsolatedProviderStorageState(definition, config);
  return storageState
    ? []
    : [
        `Live mode with ${definition.provider} requires a readable ${definition.displayName} storage state in QUOTE_VENDOR_STORAGE_STATE_PATHS, QUOTE_VENDOR_STORAGE_STATE_JSON, or QUOTE_VENDOR_STORAGE_STATE_DIR.`,
      ];
}

/** OVD-674: Quickparts session readiness. */
export function validateQuickpartsReadiness(config: WorkerConfig): Promise<string[]> {
  return validatePortalSessionReadiness(config, buildQuickpartsProductionPortalDefinition());
}

/** OVD-675: Weerg session readiness. */
export function validateWeergReadiness(config: WorkerConfig): Promise<string[]> {
  return validatePortalSessionReadiness(config, buildWeergProductionPortalDefinition());
}

/** OVD-677: OSH Cut session readiness. */
export function validateOshcutReadiness(config: WorkerConfig): Promise<string[]> {
  return validatePortalSessionReadiness(config, buildOshcutProductionPortalDefinition());
}

/** Production live mode is limited to adapters with a reviewed dispatch preflight. */
export function validateLiveAdapterReadiness(config: WorkerConfig): string[] {
  if (config.workerMode !== "live") {
    return [];
  }

  const production = new Set<string>(PRODUCTION_LIVE_ADAPTERS);
  if (
    config.workerLiveAdapters.length > 0 &&
    config.workerLiveAdapters.every((adapter) => production.has(adapter))
  ) {
    return [];
  }

  return [
    `Live worker readiness requires WORKER_LIVE_ADAPTERS to list only adapters from: ${PRODUCTION_LIVE_ADAPTERS.join(", ")}.`,
  ];
}

export const LIVE_ADAPTER_READINESS_CHECKS = {
  xometry: validateXometryReadiness,
  fictiv: validateFictivReadiness,
  oshcut: validateOshcutReadiness,
  quickparts: validateQuickpartsReadiness,
  weerg: validateWeergReadiness,
} as const satisfies Record<
  (typeof PRODUCTION_LIVE_ADAPTERS)[number],
  (config: WorkerConfig) => Promise<string[]>
>;

export async function validateWorkerReadiness(config: WorkerConfig): Promise<string[]> {
  const [adapterIssues, extractionIssues] = await Promise.all([
    Promise.all(
      PRODUCTION_LIVE_ADAPTERS.map((adapter) => LIVE_ADAPTER_READINESS_CHECKS[adapter](config)),
    ),
    validateDrawingExtractionReadiness(config),
  ]);

  return [
    ...validateLiveAdapterReadiness(config),
    ...adapterIssues.flat(),
    ...extractionIssues,
  ];
}
