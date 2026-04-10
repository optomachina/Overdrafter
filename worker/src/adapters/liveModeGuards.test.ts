// @vitest-environment node

import path from "node:path";
import { describe, expect, it } from "vitest";
import { FictivAdapter } from "./fictiv";
import { ProtolabsAdapter } from "./protolabs";
import { SendCutSendAdapter } from "./sendcutsend";
import { buildAdapterRegistry } from "./index";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types";

function sortAlphabetically(values: string[]) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "service-role-key",
    workerMode: "simulate",
    workerLiveAdapters: ["xometry"],
    workerName: "worker-1",
    pollIntervalMs: 5000,
    httpHost: "127.0.0.1",
    httpPort: 8080,
    workerTempDir: path.resolve(".tmp/overdrafter-worker"),
    artifactBucket: "quote-artifacts",
    playwrightHeadless: true,
    playwrightCaptureTrace: false,
    browserTimeoutMs: 30000,
    playwrightDisableSandbox: false,
    playwrightDisableDevShmUsage: true,
    xometryStorageStatePath: null,
    xometryStorageStateJson: null,
    openAiApiKey: null,
    anthropicApiKey: null,
    openRouterApiKey: null,
    workerBuildVersion: "dev-local",
    drawingExtractionModel: "gpt-5.4",
    drawingExtractionEnableModelFallback: false,
    drawingExtractionDebugAllowedModels: ["gpt-5.4"],
    ...overrides,
  };
}

function makeInput(overrides: Partial<VendorQuoteAdapterInput> = {}): VendorQuoteAdapterInput {
  return {
    organizationId: "org-1",
    quoteRunId: "run-1",
    requestedQuantity: 10,
    part: {
      id: "part-1",
      job_id: "job-1",
      organization_id: "org-1",
      name: "Bracket",
      normalized_key: "bracket",
      cad_file_id: null,
      drawing_file_id: null,
      quantity: 10,
    },
    cadFile: null,
    drawingFile: null,
    stagedCadFile: null,
    stagedDrawingFile: null,
    requirement: {
      id: "req-1",
      part_id: "part-1",
      description: "Bracket",
      part_number: "1093-00001",
      revision: "A",
      material: "6061",
      finish: null,
      tightest_tolerance_inch: 0.005,
      quantity: 10,
      quote_quantities: [10],
      requested_by_date: null,
      applicable_vendors: ["xometry"],
    },
    ...overrides,
  };
}

describe("live-mode adapter guards", () => {
  it("throws login_required for Fictiv in live mode when session state is missing", async () => {
    const adapter = new FictivAdapter("fictiv", makeConfig({ workerMode: "live" }));

    await expect(
      adapter.quote(
        makeInput({
          stagedCadFile: {
            originalName: "part.step",
            localPath: path.resolve(".tmp/part.step"),
            storageBucket: "job-files",
            storagePath: "cad/part.step",
          },
        }),
      ),
    ).rejects.toMatchObject({
      name: "VendorAutomationError",
      code: "login_required",
    });
  });

  it("throws not_implemented for Protolabs in live mode", async () => {
    const adapter = new ProtolabsAdapter("protolabs", makeConfig({ workerMode: "live" }));

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      name: "VendorAutomationError",
      code: "not_implemented",
    });
  });

  it("throws not_implemented for SendCutSend in live mode", async () => {
    const adapter = new SendCutSendAdapter("sendcutsend", makeConfig({ workerMode: "live" }));

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      name: "VendorAutomationError",
      code: "not_implemented",
    });
  });
});

describe("buildAdapterRegistry", () => {
  it("filters registry in live mode based on WORKER_LIVE_ADAPTERS", () => {
    const registry = buildAdapterRegistry(
      makeConfig({
        workerMode: "live",
        workerLiveAdapters: ["xometry", "fictiv"],
      }),
    );

    expect(sortAlphabetically(Object.keys(registry))).toEqual(["fictiv", "xometry"]);
  });

  it("allows an empty live rollout set (no enabled live adapters)", () => {
    const registry = buildAdapterRegistry(
      makeConfig({
        workerMode: "live",
        workerLiveAdapters: [],
      }),
    );

    expect(Object.keys(registry)).toEqual([]);
  });

  it("keeps all adapters available in simulate mode", () => {
    const registry = buildAdapterRegistry(
      makeConfig({
        workerMode: "simulate",
        workerLiveAdapters: [],
      }),
    );

    expect(sortAlphabetically(Object.keys(registry))).toEqual([
      "fictiv",
      "protolabs",
      "sendcutsend",
      "xometry",
    ]);
  });
});
