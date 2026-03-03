import fs from "node:fs/promises";
import path from "node:path";
import type { WorkerConfig } from "./types.js";

export async function prepareRuntimeSecrets(config: WorkerConfig): Promise<WorkerConfig> {
  if (config.xometryStorageStatePath || !config.xometryStorageStateJson) {
    return config;
  }

  let parsedStorageState: unknown;

  try {
    parsedStorageState = JSON.parse(config.xometryStorageStateJson);
  } catch (error) {
    throw new Error(
      `XOMETRY_STORAGE_STATE_JSON is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

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
