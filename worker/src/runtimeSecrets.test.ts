// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareRuntimeSecrets,
  validateDrawingExtractionReadiness,
  validateWorkerReadiness,
  validateXometryReadiness,
} from "./runtimeSecrets";
import type { WorkerConfig } from "./types";

const tempDirs: string[] = [];

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "service-role-key",
    workerMode: "live",
    workerName: "worker-1",
    pollIntervalMs: 5000,
    httpHost: "127.0.0.1",
    httpPort: 0,
    workerTempDir: path.join(os.tmpdir(), "overdrafter-runtime-secrets-test"),
    artifactBucket: "quote-artifacts",
    playwrightHeadless: true,
    playwrightCaptureTrace: false,
    browserTimeoutMs: 30000,
    playwrightDisableSandbox: false,
    playwrightDisableDevShmUsage: true,
    xometryStorageStatePath: null,
    xometryStorageStateJson: null,
    openAiApiKey: null,
    drawingExtractionModel: "gpt-5.4",
    drawingExtractionEnableModelFallback: false,
    ...overrides,
  };
}

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-runtime-secrets-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("runtimeSecrets", () => {
  it("writes storage-state JSON to a runtime file", async () => {
    const workerTempDir = await makeTempDir();
    const prepared = await prepareRuntimeSecrets(
      makeConfig({
        workerTempDir,
        xometryStorageStateJson: JSON.stringify({ cookies: [], origins: [] }),
      }),
    );

    expect(prepared.xometryStorageStatePath).toBe(
      path.join(workerTempDir, "runtime-secrets", "xometry-storage-state.json"),
    );
    expect(
      JSON.parse(await fs.readFile(prepared.xometryStorageStatePath!, "utf8")),
    ).toEqual({
      cookies: [],
      origins: [],
    });
  });

  it("reports readiness issues for missing and malformed live storage state", async () => {
    const workerTempDir = await makeTempDir();
    const missingPath = path.join(workerTempDir, "missing.json");

    expect(
      await validateXometryReadiness(
        makeConfig({
          workerTempDir,
          xometryStorageStatePath: missingPath,
        }),
      ),
    ).toEqual([
      `Xometry storage state file was not found at ${missingPath}.`,
    ]);

    const malformedPath = path.join(workerTempDir, "bad.json");
    await fs.writeFile(malformedPath, JSON.stringify({ cookies: [] }), "utf8");

    expect(
      await validateXometryReadiness(
        makeConfig({
          workerTempDir,
          xometryStorageStatePath: malformedPath,
        }),
      ),
    ).toEqual([
      `Xometry storage state file at ${malformedPath} must include cookies and origins arrays.`,
    ]);
  });

  it("returns no readiness issues for valid live storage state", async () => {
    const workerTempDir = await makeTempDir();
    const storageStatePath = path.join(workerTempDir, "xometry.json");
    await fs.writeFile(
      storageStatePath,
      JSON.stringify({ cookies: [], origins: [] }),
      "utf8",
    );

    expect(
      await validateXometryReadiness(
        makeConfig({
          workerTempDir,
          xometryStorageStatePath: storageStatePath,
        }),
      ),
    ).toEqual([]);
  });

  it("reports model fallback readiness issues when enabled without a key", async () => {
    expect(
      await validateDrawingExtractionReadiness(
        makeConfig({
          drawingExtractionEnableModelFallback: true,
          openAiApiKey: null,
        }),
      ),
    ).toEqual([
      "Drawing extraction model fallback is enabled but OPENAI_API_KEY is missing. Fallback requests will stay disabled.",
    ]);
  });

  it("combines worker readiness issues across subsystems", async () => {
    const workerTempDir = await makeTempDir();
    const missingPath = path.join(workerTempDir, "missing.json");

    expect(
      await validateWorkerReadiness(
        makeConfig({
          xometryStorageStatePath: missingPath,
          drawingExtractionEnableModelFallback: true,
          openAiApiKey: null,
        }),
      ),
    ).toEqual([
      `Xometry storage state file was not found at ${missingPath}.`,
      "Drawing extraction model fallback is enabled but OPENAI_API_KEY is missing. Fallback requests will stay disabled.",
    ]);
  });
});
