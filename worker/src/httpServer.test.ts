// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import { createWorkerRuntimeState, recordRuntimeEvent, startHealthServer } from "./httpServer";
import type { WorkerConfig } from "./types";

const workerConfig: WorkerConfig = {
  supabaseUrl: "https://example.supabase.co",
  supabaseServiceRoleKey: "service-role-key",
  workerMode: "simulate",
  workerLiveAdapters: [],
  workerName: "worker-debug-test",
  pollIntervalMs: 1000,
  httpHost: "127.0.0.1",
  httpPort: 0,
  workerTempDir: "/tmp/overdrafter-worker-test",
  artifactBucket: "quote-artifacts",
  playwrightHeadless: true,
  playwrightCaptureTrace: false,
  browserTimeoutMs: 30000,
  playwrightDisableSandbox: false,
  playwrightDisableDevShmUsage: true,
  xometryStorageStatePath: null,
  xometryStorageStateJson: null,
  xometryUserDataDir: null,
  xometryBrowserChannel: null,
  xometryProfileLockWaitMs: 0,
  openAiApiKey: null,
  anthropicApiKey: null,
  openRouterApiKey: null,
  workerBuildVersion: "build-test",
  drawingExtractionModel: "gpt-5.4",
  drawingExtractionEnableModelFallback: false,
  drawingExtractionDebugAllowedModels: ["gpt-5.4", "gpt-5.4-mini"],
};

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("startHealthServer", () => {
  it("exposes recent runtime events for troubleshooting", async () => {
    const runtimeState = createWorkerRuntimeState();
    runtimeState.status = "running";
    runtimeState.lastLoopAt = new Date("2026-03-06T12:00:00.000Z").toISOString();

    recordRuntimeEvent(runtimeState, {
      level: "info",
      source: "worker.task.start",
      message: "Starting run_vendor_quote task-1.",
      context: {
        taskId: "task-1",
        taskType: "run_vendor_quote",
      },
    });
    recordRuntimeEvent(runtimeState, {
      level: "error",
      source: "worker.task.failure",
      message: "Failed run_vendor_quote task-1: boom",
      context: {
        taskId: "task-1",
      },
      error: new Error("boom"),
    });

    const server = await startHealthServer(workerConfig, runtimeState);
    servers.push(server);

    const healthResponse = await fetch(`${server.url}/healthz`);
    const healthPayload = await healthResponse.json();
    expect(healthResponse.status).toBe(200);
    expect(healthPayload).toMatchObject({
      workerName: "worker-debug-test",
      workerBuildVersion: "build-test",
      drawingExtractionModel: "gpt-5.4",
      drawingExtractionDebugAllowedModels: ["gpt-5.4", "gpt-5.4-mini"],
      status: "running",
      ready: true,
      readinessIssues: [],
      eventCounts: {
        info: 1,
        warn: 0,
        error: 1,
      },
    });
    expect(healthPayload.recentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "worker.task.failure",
          message: "Failed run_vendor_quote task-1: boom",
        }),
      ]),
    );

    const debugResponse = await fetch(`${server.url}/debug/events`);
    const debugPayload = await debugResponse.json();
    expect(debugResponse.status).toBe(200);
    expect(debugPayload).toMatchObject({
      workerName: "worker-debug-test",
      eventCounts: {
        info: 1,
        warn: 0,
        error: 1,
      },
      events: [
        {
          source: "worker.task.failure",
          error: {
            message: "boom",
            name: "Error",
          },
        },
        {
          source: "worker.task.start",
          context: {
            taskId: "task-1",
          },
        },
      ],
    });
  });

  it("denies debug routes when the worker is running in live mode", async () => {
    const runtimeState = createWorkerRuntimeState();
    runtimeState.status = "running";

    const server = await startHealthServer(
      {
        ...workerConfig,
        workerMode: "live",
      },
      runtimeState,
      {
        previewExtraction: async () => ({
          accepted: true,
        }),
      },
    );
    servers.push(server);

    const previewResponse = await fetch(`${server.url}/debug/extraction/preview`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        partId: "part-1",
        modelId: "gpt-5.4",
      }),
    });
    const previewPayload = await previewResponse.json();

    expect(previewResponse.status).toBe(403);
    expect(previewPayload).toEqual({
      error: "debug_route_disabled",
      message: "Worker debug endpoints are disabled when WORKER_MODE=live.",
    });
  });

  it("allows debug extraction preview from a loopback client in non-live mode", async () => {
    const runtimeState = createWorkerRuntimeState();
    runtimeState.status = "running";

    const previewExtraction = vi.fn(async () => ({
      accepted: true,
      partId: "part-1",
      modelId: "gpt-5.4-mini",
    }));

    const server = await startHealthServer(workerConfig, runtimeState, {
      previewExtraction,
    });
    servers.push(server);

    const previewResponse = await fetch(`${server.url}/debug/extraction/preview`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        partId: "part-1",
        modelId: "gpt-5.4-mini",
      }),
    });
    const previewPayload = await previewResponse.json();

    expect(previewResponse.status).toBe(200);
    expect(previewPayload).toEqual({
      accepted: true,
      partId: "part-1",
      modelId: "gpt-5.4-mini",
    });
    expect(previewExtraction).toHaveBeenCalledWith({
      partId: "part-1",
      modelId: "gpt-5.4-mini",
    });
  });

  it("reports readiness failures on /readyz", async () => {
    const runtimeState = createWorkerRuntimeState();
    runtimeState.status = "running";
    runtimeState.readinessIssues = [
      "Xometry storage state file was not found at /tmp/missing.json.",
    ];

    const server = await startHealthServer(workerConfig, runtimeState);
    servers.push(server);

    const readyResponse = await fetch(`${server.url}/readyz`);
    const readyPayload = await readyResponse.json();

    expect(readyResponse.status).toBe(503);
    expect(readyPayload).toMatchObject({
      ready: false,
      readinessIssues: [
        "Xometry storage state file was not found at /tmp/missing.json.",
      ],
      status: "running",
    });
  });
});
