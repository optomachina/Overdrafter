import fs from "node:fs/promises";
import path from "node:path";
import type { WorkerConfig } from "./types.js";

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

  const issues: string[] = [];

  if (!config.xometryStorageStatePath) {
    issues.push(
      "Live mode requires XOMETRY_STORAGE_STATE_PATH or XOMETRY_STORAGE_STATE_JSON.",
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

  if (config.openAiApiKey) {
    return issues;
  }

  issues.push(
    "Drawing extraction model fallback is enabled but OPENAI_API_KEY is missing. Fallback requests will stay disabled.",
  );

  return issues;
}

export async function validateWorkerReadiness(config: WorkerConfig): Promise<string[]> {
  const [xometryIssues, fictivIssues, extractionIssues] = await Promise.all([
    validateXometryReadiness(config),
    validateFictivReadiness(config),
    validateDrawingExtractionReadiness(config),
  ]);

  return [...xometryIssues, ...fictivIssues, ...extractionIssues];
}
