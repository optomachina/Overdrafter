// @vitest-environment node

import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("applies defaults for optional worker settings", () => {
    const config = loadConfig({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    });

    expect(config).toMatchObject({
      workerMode: "simulate",
      workerName: "quote-worker-1",
      pollIntervalMs: 5000,
      httpHost: "0.0.0.0",
      httpPort: 8080,
      artifactBucket: "quote-artifacts",
      playwrightHeadless: true,
      playwrightCaptureTrace: false,
      browserTimeoutMs: 30000,
      playwrightDisableSandbox: false,
      playwrightDisableDevShmUsage: true,
      xometryStorageStatePath: null,
      xometryStorageStateJson: null,
      openAiApiKey: null,
      workerBuildVersion: "dev-local",
      drawingExtractionModel: "gpt-5.4",
      drawingExtractionEnableModelFallback: false,
      drawingExtractionDebugAllowedModels: ["gpt-5.4"],
    });
    expect(config.workerTempDir).toBe(path.resolve(path.join(os.tmpdir(), "overdrafter-worker")));
  });

  it("coerces booleans, numbers, and relative paths from environment variables", () => {
    const config = loadConfig({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      WORKER_MODE: "live",
      WORKER_NAME: "worker-2",
      WORKER_POLL_INTERVAL_MS: "2500",
      WORKER_HTTP_HOST: "127.0.0.1",
      WORKER_TEMP_DIR: "./tmp/worker",
      QUOTE_ARTIFACT_BUCKET: "artifacts",
      PORT: "9090",
      PLAYWRIGHT_HEADLESS: "false",
      PLAYWRIGHT_CAPTURE_TRACE: "yes",
      PLAYWRIGHT_BROWSER_TIMEOUT_MS: "45000",
      PLAYWRIGHT_DISABLE_SANDBOX: "on",
      PLAYWRIGHT_DISABLE_DEV_SHM_USAGE: "0",
      XOMETRY_STORAGE_STATE_PATH: "./state.json",
      XOMETRY_STORAGE_STATE_JSON: "{\"cookies\":[]}",
      OPENAI_API_KEY: "test-openai-key",
      WORKER_BUILD_VERSION: "sha-123",
      DRAWING_EXTRACTION_MODEL: "gpt-5.4",
      DRAWING_EXTRACTION_DEBUG_ALLOWED_MODELS: "gpt-5.4,gpt-5.4-mini",
      DRAWING_EXTRACTION_ENABLE_MODEL_FALLBACK: "true",
    });

    expect(config).toMatchObject({
      workerMode: "live",
      workerName: "worker-2",
      pollIntervalMs: 2500,
      httpHost: "127.0.0.1",
      httpPort: 9090,
      artifactBucket: "artifacts",
      playwrightHeadless: false,
      playwrightCaptureTrace: true,
      browserTimeoutMs: 45000,
      playwrightDisableSandbox: true,
      playwrightDisableDevShmUsage: false,
      xometryStorageStateJson: "{\"cookies\":[]}",
      openAiApiKey: "test-openai-key",
      workerBuildVersion: "sha-123",
      drawingExtractionModel: "gpt-5.4",
      drawingExtractionEnableModelFallback: true,
      drawingExtractionDebugAllowedModels: ["gpt-5.4", "gpt-5.4-mini"],
    });
    expect(config.workerTempDir).toBe(path.resolve("./tmp/worker"));
    expect(config.xometryStorageStatePath).toBe(path.resolve("./state.json"));
  });

  it("rejects invalid required settings", () => {
    expect(() =>
      loadConfig({
        SUPABASE_URL: "not-a-url",
        SUPABASE_SERVICE_ROLE_KEY: "",
      }),
    ).toThrow();
  });
});
