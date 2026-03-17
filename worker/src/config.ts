import { z } from "zod";
import path from "node:path";
import os from "node:os";
import type { WorkerConfig } from "./types.js";

const envBoolean = z.preprocess((value) => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off", ""].includes(normalized)) {
    return false;
  }

  return value;
}, z.boolean());

const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  WORKER_MODE: z.enum(["simulate", "live"]).default("simulate"),
  WORKER_NAME: z.string().default("quote-worker-1"),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  WORKER_HTTP_HOST: z.string().default("0.0.0.0"),
  WORKER_TEMP_DIR: z.string().default(path.join(os.tmpdir(), "overdrafter-worker")),
  QUOTE_ARTIFACT_BUCKET: z.string().default("quote-artifacts"),
  PORT: z.coerce.number().int().positive().default(8080),
  PLAYWRIGHT_HEADLESS: envBoolean.default(true),
  PLAYWRIGHT_CAPTURE_TRACE: envBoolean.default(false),
  PLAYWRIGHT_BROWSER_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  PLAYWRIGHT_DISABLE_SANDBOX: envBoolean.default(false),
  PLAYWRIGHT_DISABLE_DEV_SHM_USAGE: envBoolean.default(true),
  XOMETRY_STORAGE_STATE_PATH: z.string().optional(),
  XOMETRY_STORAGE_STATE_JSON: z.string().optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  DRAWING_EXTRACTION_MODEL: z.string().default("gpt-5.4"),
  DRAWING_EXTRACTION_ENABLE_MODEL_FALLBACK: envBoolean.optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = schema.parse(env);
  const workerTempDir = path.resolve(parsed.WORKER_TEMP_DIR);

  return {
    supabaseUrl: parsed.SUPABASE_URL,
    supabaseServiceRoleKey: parsed.SUPABASE_SERVICE_ROLE_KEY,
    workerMode: parsed.WORKER_MODE,
    workerName: parsed.WORKER_NAME,
    pollIntervalMs: parsed.WORKER_POLL_INTERVAL_MS,
    httpHost: parsed.WORKER_HTTP_HOST,
    httpPort: parsed.PORT,
    workerTempDir,
    artifactBucket: parsed.QUOTE_ARTIFACT_BUCKET,
    playwrightHeadless: parsed.PLAYWRIGHT_HEADLESS,
    playwrightCaptureTrace: parsed.PLAYWRIGHT_CAPTURE_TRACE,
    browserTimeoutMs: parsed.PLAYWRIGHT_BROWSER_TIMEOUT_MS,
    playwrightDisableSandbox: parsed.PLAYWRIGHT_DISABLE_SANDBOX,
    playwrightDisableDevShmUsage: parsed.PLAYWRIGHT_DISABLE_DEV_SHM_USAGE,
    xometryStorageStatePath: parsed.XOMETRY_STORAGE_STATE_PATH
      ? path.resolve(parsed.XOMETRY_STORAGE_STATE_PATH)
      : null,
    xometryStorageStateJson: parsed.XOMETRY_STORAGE_STATE_JSON ?? null,
    openAiApiKey: parsed.OPENAI_API_KEY ?? null,
    drawingExtractionModel: parsed.DRAWING_EXTRACTION_MODEL,
    drawingExtractionEnableModelFallback:
      parsed.DRAWING_EXTRACTION_ENABLE_MODEL_FALLBACK ?? Boolean(parsed.OPENAI_API_KEY),
  };
}
