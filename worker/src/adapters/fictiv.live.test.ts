// @vitest-environment node

import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FictivAdapter } from "./fictiv";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types";

const runLive = process.env.RUN_FICTIV_LIVE_TEST === "1" && process.env.CI !== "true";
const liveDescribe = runLive ? describe : describe.skip;

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

function makeConfig(): WorkerConfig {
  return {
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "service-role-key",
    workerMode: "live",
    workerLiveAdapters: ["xometry", "fictiv"],
    workerName: "worker-1",
    pollIntervalMs: 5000,
    httpHost: "127.0.0.1",
    httpPort: 0,
    workerTempDir: path.join(os.tmpdir(), "overdrafter-fictiv-live-test"),
    artifactBucket: "quote-artifacts",
    playwrightHeadless: false,
    playwrightCaptureTrace: true,
    browserTimeoutMs: 60000,
    playwrightDisableSandbox: false,
    playwrightDisableDevShmUsage: true,
    xometryStorageStatePath: null,
    xometryStorageStateJson: null,
    fictivStorageStatePath: requiredEnv("FICTIV_STORAGE_STATE_PATH"),
    openAiApiKey: null,
    anthropicApiKey: null,
    openRouterApiKey: null,
    workerBuildVersion: "dev-local",
    drawingExtractionModel: "gpt-5.4",
    drawingExtractionEnableModelFallback: false,
    drawingExtractionDebugAllowedModels: ["gpt-5.4"],
  };
}

function makeInput(): VendorQuoteAdapterInput {
  const cadPath = requiredEnv("FICTIV_LIVE_TEST_CAD_PATH");
  const drawingPath = process.env.FICTIV_LIVE_TEST_DRAWING_PATH ?? null;

  return {
    organizationId: "org-live",
    quoteRunId: `fictiv-live-${Date.now()}`,
    requestedQuantity: 2,
    part: {
      id: `part-live-${Date.now()}`,
      job_id: "job-live",
      organization_id: "org-live",
      name: "Live Test Part",
      normalized_key: "live-test-part",
      cad_file_id: "cad-live",
      drawing_file_id: drawingPath ? "drawing-live" : null,
      quantity: 2,
    },
    cadFile: {
      id: "cad-live",
      job_id: "job-live",
      storage_bucket: "job-files",
      storage_path: "cad/live-test.step",
      original_name: path.basename(cadPath),
      file_kind: "cad",
    },
    drawingFile: drawingPath
      ? {
          id: "drawing-live",
          job_id: "job-live",
          storage_bucket: "job-files",
          storage_path: "drawing/live-test.pdf",
          original_name: path.basename(drawingPath),
          file_kind: "drawing",
        }
      : null,
    stagedCadFile: {
      originalName: path.basename(cadPath),
      localPath: cadPath,
      storageBucket: "job-files",
      storagePath: "cad/live-test.step",
    },
    stagedDrawingFile: drawingPath
      ? {
          originalName: path.basename(drawingPath),
          localPath: drawingPath,
          storageBucket: "job-files",
          storagePath: "drawing/live-test.pdf",
        }
      : null,
    requirement: {
      id: "req-live",
      part_id: "part-live",
      description: "Live Fictiv quote capture test",
      part_number: "LIVE-TEST-001",
      revision: "A",
      material: "6061 aluminum",
      finish: "as machined",
      tightest_tolerance_inch: 0.005,
      quantity: 2,
      quote_quantities: [2],
      requested_by_date: null,
      applicable_vendors: ["fictiv"],
    },
  };
}

liveDescribe("FictivAdapter live mode", () => {
  it(
    "returns a non-simulated quote payload from the live portal session",
    async () => {
      const adapter = new FictivAdapter("fictiv", makeConfig());
      const result = await adapter.quote(makeInput());

      expect(result.status).toBe("instant_quote_received");
      expect(result.totalPriceUsd).not.toBeNull();
      expect(result.leadTimeBusinessDays).not.toBeNull();
      expect(result.quoteUrl).not.toMatch(/^simulated:\/\//);
    },
    300_000,
  );
});
