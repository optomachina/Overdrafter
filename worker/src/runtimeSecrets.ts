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
  if (config.xometryStorageStatePath || !config.xometryStorageStateJson) {
    return config;
  }

  const parsedStorageState = parseStorageStateJson(
    config.xometryStorageStateJson,
    "XOMETRY_STORAGE_STATE_JSON",
  );

  const secretsDir = path.join(config.workerTempDir, "runtime-secrets");
  await fs.mkdir(secretsDir, { recursive: true });

  const xometryStorageStatePath = path.join(secretsDir, "xometry-storage-state.json");
  await fs.writeFile(
    xometryStorageStatePath,
    JSON.stringify(parsedStorageState),
    "utf8",
  );

  return {
    ...config,
    xometryStorageStatePath,
  };
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

export async function validateDrawingExtractionReadiness(config: WorkerConfig): Promise<string[]> {
  if (!config.drawingExtractionEnableModelFallback) {
    return [];
  }

  if (config.openAiApiKey) {
    return [];
  }

  return [
    "Drawing extraction model fallback is enabled but OPENAI_API_KEY is missing. Fallback requests will stay disabled.",
  ];
}

export async function validateWorkerReadiness(config: WorkerConfig): Promise<string[]> {
  const [xometryIssues, extractionIssues] = await Promise.all([
    validateXometryReadiness(config),
    validateDrawingExtractionReadiness(config),
  ]);

  return [...xometryIssues, ...extractionIssues];
}
