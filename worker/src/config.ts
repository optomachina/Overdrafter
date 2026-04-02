import { z } from "zod";
import path from "node:path";
import os from "node:os";
import { parseEnvBooleanLike, parseEnvList } from "./env.js";
import { LIVE_AUTOMATION_VENDORS, type LiveAutomationVendorName, type WorkerConfig } from "./types.js";

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
  WORKER_LIVE_ADAPTERS: z.string().optional(),
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
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  WORKER_BUILD_VERSION: z.string().default("dev-local"),
  DRAWING_EXTRACTION_MODEL: z.string().default("gpt-5.4"),
  DRAWING_EXTRACTION_DEBUG_ALLOWED_MODELS: z.string().optional(),
  DRAWING_EXTRACTION_ENABLE_MODEL_FALLBACK: envBoolean.optional(),
});

function parseWorkerLiveAdapters(rawValue: string | undefined): LiveAutomationVendorName[] {
  const configuredAdapters =
    rawValue === undefined
      ? ["xometry"]
      : [
          ...new Set(
            rawValue
              .split(",")
              .map((entry) => entry.trim().toLowerCase())
              .filter(Boolean),
          ),
        ];

  const liveAutomationSet = new Set<string>(LIVE_AUTOMATION_VENDORS);
  const unsupportedAdapters = configuredAdapters.filter((entry) => !liveAutomationSet.has(entry));

  if (unsupportedAdapters.length > 0) {
    throw new Error(
      `WORKER_LIVE_ADAPTERS includes unsupported adapters: ${unsupportedAdapters.join(", ")}. Supported values: ${LIVE_AUTOMATION_VENDORS.join(", ")}.`,
    );
  }

  return configuredAdapters as LiveAutomationVendorName[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = schema.parse(env);
  const workerTempDir = path.resolve(parsed.WORKER_TEMP_DIR);
  const workerLiveAdapters = parseWorkerLiveAdapters(parsed.WORKER_LIVE_ADAPTERS);
  const drawingExtractionDebugAllowedModels = parseEnvList(
    parsed.DRAWING_EXTRACTION_DEBUG_ALLOWED_MODELS,
    parsed.DRAWING_EXTRACTION_MODEL,
  );

  return {
    supabaseUrl: parsed.SUPABASE_URL,
    supabaseServiceRoleKey: parsed.SUPABASE_SERVICE_ROLE_KEY,
    workerMode: parsed.WORKER_MODE,
    workerLiveAdapters,
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
    anthropicApiKey: parsed.ANTHROPIC_API_KEY ?? null,
    openRouterApiKey: parsed.OPENROUTER_API_KEY ?? null,
    workerBuildVersion: parsed.WORKER_BUILD_VERSION,
    drawingExtractionModel: parsed.DRAWING_EXTRACTION_MODEL,
    drawingExtractionEnableModelFallback: parseEnvBooleanLike(
      parsed.DRAWING_EXTRACTION_ENABLE_MODEL_FALLBACK,
      Boolean(parsed.OPENAI_API_KEY),
    ),
    drawingExtractionDebugAllowedModels,
  };
}
