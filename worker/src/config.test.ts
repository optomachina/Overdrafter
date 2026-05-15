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
      workerLiveAdapters: ["xometry"],
      vendorStorageStateDir: null,
      vendorStorageStatePaths: {},
      vendorStorageStateJson: {},
      workerName: "quote-worker-1",
      pollIntervalMs: 5000,
      quantityPricingLadder: [1, 10, 100, 1000],
      vendorRateLimitMs: 0,
      pricingModelEnabled: false,
      pricingModelMinConfidence: 0.7,
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
      fictivStorageStatePath: null,
      openAiApiKey: null,
      anthropicApiKey: null,
      openRouterApiKey: null,
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
      WORKER_LIVE_ADAPTERS: "xometry,fictiv",
      QUOTE_VENDOR_STORAGE_STATE_DIR: "./state/vendor-sessions",
      QUOTE_VENDOR_STORAGE_STATE_PATHS: JSON.stringify({
        oshcut: "./state/vendor-sessions/oshcut.json",
      }),
      QUOTE_VENDOR_STORAGE_STATE_JSON: JSON.stringify({
        fabworks: "{\"cookies\":[],\"origins\":[]}",
      }),
      WORKER_NAME: "worker-2",
      WORKER_POLL_INTERVAL_MS: "2500",
      WORKER_QUANTITY_PRICING_LADDER: "1000,100,10,1",
      WORKER_VENDOR_RATE_LIMIT_MS: "750",
      WORKER_PRICING_MODEL_ENABLED: "true",
      WORKER_PRICING_MODEL_MIN_CONFIDENCE: "0.82",
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
      FICTIV_STORAGE_STATE_PATH: "./fictiv-state.json",
      FICTIV_STORAGE_STATE_JSON: "{\"cookies\":[],\"origins\":[]}",
      OPENAI_API_KEY: "test-openai-key",
      ANTHROPIC_API_KEY: "test-anthropic-key",
      OPENROUTER_API_KEY: "test-openrouter-key",
      WORKER_BUILD_VERSION: "sha-123",
      DRAWING_EXTRACTION_MODEL: "gpt-5.4",
      DRAWING_EXTRACTION_DEBUG_ALLOWED_MODELS: "gpt-5.4,gpt-5.4-mini",
      DRAWING_EXTRACTION_ENABLE_MODEL_FALLBACK: "true",
    });

    expect(config).toMatchObject({
      workerMode: "live",
      workerLiveAdapters: ["xometry", "fictiv"],
      vendorStorageStateDir: path.resolve("./state/vendor-sessions"),
      vendorStorageStatePaths: {
        oshcut: path.resolve("./state/vendor-sessions/oshcut.json"),
      },
      vendorStorageStateJson: {
        fabworks: "{\"cookies\":[],\"origins\":[]}",
      },
      workerName: "worker-2",
      pollIntervalMs: 2500,
      quantityPricingLadder: [1, 10, 100, 1000],
      vendorRateLimitMs: 750,
      pricingModelEnabled: true,
      pricingModelMinConfidence: 0.82,
      httpHost: "127.0.0.1",
      httpPort: 9090,
      artifactBucket: "artifacts",
      playwrightHeadless: false,
      playwrightCaptureTrace: true,
      browserTimeoutMs: 45000,
      playwrightDisableSandbox: true,
      playwrightDisableDevShmUsage: false,
      xometryStorageStateJson: "{\"cookies\":[]}",
      fictivStorageStatePath: path.resolve("./fictiv-state.json"),
      fictivStorageStateJson: "{\"cookies\":[],\"origins\":[]}",
      openAiApiKey: "test-openai-key",
      anthropicApiKey: "test-anthropic-key",
      openRouterApiKey: "test-openrouter-key",
      workerBuildVersion: "sha-123",
      drawingExtractionModel: "gpt-5.4",
      drawingExtractionEnableModelFallback: true,
      drawingExtractionDebugAllowedModels: ["gpt-5.4", "gpt-5.4-mini"],
    });
    expect(config.workerTempDir).toBe(path.resolve("./tmp/worker"));
    expect(config.xometryStorageStatePath).toBe(path.resolve("./state.json"));
  });

  it("enables drawing model fallback by default when OPENAI_API_KEY is present", () => {
    const config = loadConfig({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      OPENAI_API_KEY: "test-openai-key",
    });

    expect(config.drawingExtractionEnableModelFallback).toBe(true);
  });

  it("rejects invalid required settings", () => {
    expect(() =>
      loadConfig({
        SUPABASE_URL: "not-a-url",
        SUPABASE_SERVICE_ROLE_KEY: "",
      }),
    ).toThrow();
  });

  it("rejects unsupported WORKER_LIVE_ADAPTERS values", () => {
    expect(() =>
      loadConfig({
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
        WORKER_LIVE_ADAPTERS: "xometry,unknown_vendor",
      }),
    ).toThrow(/WORKER_LIVE_ADAPTERS includes unsupported adapters/);
  });

  it("rejects an empty WORKER_QUANTITY_PRICING_LADDER", () => {
    expect(() =>
      loadConfig({
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
        WORKER_QUANTITY_PRICING_LADDER: "bad,0,-10",
      }),
    ).toThrow(/WORKER_QUANTITY_PRICING_LADDER/);
  });

  it("rejects pricing model confidence outside the 0..1 range", () => {
    expect(() =>
      loadConfig({
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
        WORKER_PRICING_MODEL_MIN_CONFIDENCE: "1.5",
      }),
    ).toThrow();
  });

  it("accepts hidden vendor candidates in WORKER_LIVE_ADAPTERS", () => {
    const config = loadConfig({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      WORKER_LIVE_ADAPTERS: "oshcut,fabworks,ponoko,quickparts,rapiddirect,geomiq,weerg,protolabsnetwork",
    });

    expect(config.workerLiveAdapters).toEqual([
      "oshcut",
      "fabworks",
      "ponoko",
      "quickparts",
      "rapiddirect",
      "geomiq",
      "weerg",
      "protolabsnetwork",
    ]);
  });

  it("rejects unsupported vendors in generic storage state maps", () => {
    expect(() =>
      loadConfig({
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
        QUOTE_VENDOR_STORAGE_STATE_PATHS: JSON.stringify({
          unknown_vendor: "./state.json",
        }),
      }),
    ).toThrow(/QUOTE_VENDOR_STORAGE_STATE_PATHS includes unsupported vendor/);
  });

  it("allows an explicit empty WORKER_LIVE_ADAPTERS rollout", () => {
    const config = loadConfig({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      WORKER_MODE: "live",
      WORKER_LIVE_ADAPTERS: "",
    });

    expect(config.workerLiveAdapters).toEqual([]);
  });
});
