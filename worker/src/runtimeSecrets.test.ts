// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareRuntimeSecrets,
  validateDrawingExtractionReadiness,
  validateFictivReadiness,
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
    fictivStorageStatePath: null,
    fictivStorageStateJson: null,
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
    const storageStatePath = prepared.xometryStorageStatePath;
    if (!storageStatePath) {
      throw new Error("Expected runtime secrets preparation to produce a storage-state path.");
    }
    const fileStat = await fs.stat(storageStatePath);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("writes Fictiv storage-state JSON to a runtime file", async () => {
    const workerTempDir = await makeTempDir();
    const prepared = await prepareRuntimeSecrets(
      makeConfig({
        workerTempDir,
        fictivStorageStateJson: JSON.stringify({ cookies: [], origins: [] }),
      }),
    );

    expect(prepared.fictivStorageStatePath).toBe(
      path.join(workerTempDir, "runtime-secrets", "fictiv-storage-state.json"),
    );
    expect(
      JSON.parse(await fs.readFile(prepared.fictivStorageStatePath!, "utf8")),
    ).toEqual({
      cookies: [],
      origins: [],
    });
    const storageStatePath = prepared.fictivStorageStatePath;
    if (!storageStatePath) {
      throw new Error("Expected runtime secrets preparation to produce a Fictiv storage-state path.");
    }
    const fileStat = await fs.stat(storageStatePath);
    expect(fileStat.mode & 0o777).toBe(0o600);
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

  it("reports readiness issues for missing and malformed Fictiv live storage state", async () => {
    const workerTempDir = await makeTempDir();
    const missingPath = path.join(workerTempDir, "missing-fictiv.json");

    expect(
      await validateFictivReadiness(
        makeConfig({
          workerTempDir,
          fictivStorageStatePath: missingPath,
        }),
      ),
    ).toEqual([
      `Fictiv storage state file was not found at ${missingPath}.`,
    ]);

    const malformedPath = path.join(workerTempDir, "bad-fictiv.json");
    await fs.writeFile(malformedPath, JSON.stringify({ cookies: [] }), "utf8");

    expect(
      await validateFictivReadiness(
        makeConfig({
          workerTempDir,
          fictivStorageStatePath: malformedPath,
        }),
      ),
    ).toEqual([
      `Fictiv storage state file at ${malformedPath} must include cookies and origins arrays.`,
    ]);
  });

  it("returns no Fictiv readiness issues for valid live storage state", async () => {
    const workerTempDir = await makeTempDir();
    const storageStatePath = path.join(workerTempDir, "fictiv.json");
    await fs.writeFile(
      storageStatePath,
      JSON.stringify({ cookies: [], origins: [] }),
      "utf8",
    );

    expect(
      await validateFictivReadiness(
        makeConfig({
          workerTempDir,
          fictivStorageStatePath: storageStatePath,
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

  it("reports readiness issues when no debug extraction models are allowlisted", async () => {
    expect(
      await validateDrawingExtractionReadiness(
        makeConfig({
          drawingExtractionDebugAllowedModels: [],
        }),
      ),
    ).toEqual([
      "DRAWING_EXTRACTION_DEBUG_ALLOWED_MODELS must include at least one model for debug extraction runs.",
    ]);
  });

  it("combines worker readiness issues across subsystems", async () => {
    const workerTempDir = await makeTempDir();
    const missingPath = path.join(workerTempDir, "missing.json");

    expect(
      await validateWorkerReadiness(
        makeConfig({
          xometryStorageStatePath: missingPath,
          fictivStorageStatePath: missingPath,
          drawingExtractionEnableModelFallback: true,
          openAiApiKey: null,
        }),
      ),
    ).toEqual([
      `Xometry storage state file was not found at ${missingPath}.`,
      `Fictiv storage state file was not found at ${missingPath}.`,
      "Drawing extraction model fallback is enabled but OPENAI_API_KEY is missing. Fallback requests will stay disabled.",
    ]);
  });
});
