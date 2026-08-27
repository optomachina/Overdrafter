// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FabworksAdapter } from "../adapters/fabworks";
import type { VendorAdapter } from "../adapters/base";
import { authorizeLiveEvaluationInput, stageLiveEvaluationFiles } from "../liveEvaluationFiles";
import type { WorkerConfig } from "../types";
import { VendorAutomationError } from "../types";
import {
  buildErrorRow,
  parseQuantities,
  parseSmokeArgs,
  runEvaluationBatch,
  runQuote,
} from "./vendorWorkflowSmoke";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => fs.rm(tempDir, {
    recursive: true,
    force: true,
  })));
});

describe("vendorWorkflowSmoke argument parsing", () => {
  it("parses the requested hidden vendor, CAD path, drawing path, and quantity list", () => {
    const args = parseSmokeArgs([
      "--vendor",
      "OSHCut",
      "--cad",
      "./part.step",
      "--drawing",
      "./part.pdf",
      "--quantities",
      "1,5,25",
    ]);

    expect(args.vendors).toEqual(["oshcut"]);
    expect(args.cadPath).toMatch(/part\.step$/);
    expect(args.drawingPath).toMatch(/part\.pdf$/);
    expect(args.quantities).toEqual([1, 5, 25]);
  });

  it("falls back to env values and the default quantity", () => {
    const args = parseSmokeArgs([], {
      QUOTE_VENDOR_SMOKE_VENDOR: "weerg",
      QUOTE_VENDOR_LIVE_TEST_CAD_PATH: "./part.step",
    });

    expect(args.vendors).toEqual(["weerg"]);
    expect(args.quantities).toEqual([1]);
  });

  it("accepts all runnable live evaluation vendors for batch validation", () => {
    const args = parseSmokeArgs([
      "--vendor",
      "all",
      "--cad",
      "./part.step",
    ]);

    expect(args.vendors).toEqual([
      "xometry",
      "fictiv",
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

  it("accepts a comma-separated hidden vendor subset", () => {
    const args = parseSmokeArgs([
      "--vendor",
      "oshcut,fabworks",
      "--cad",
      "./part.step",
    ]);

    expect(args.vendors).toEqual(["oshcut", "fabworks"]);
  });

  it("accepts Xometry and Fictiv for direct live evaluation", () => {
    const args = parseSmokeArgs([
      "--vendor",
      "xometry,fictiv",
      "--cad",
      "./part.step",
    ]);

    expect(args.vendors).toEqual(["xometry", "fictiv"]);
  });

  it("rejects unsupported vendors", () => {
    expect(() =>
      parseSmokeArgs([
        "--vendor",
        "unknown",
        "--cad",
        "./part.step",
      ]),
    ).toThrow(/unsupported --vendor/i);
  });

  it("rejects live adapter stubs that cannot perform an evaluation", () => {
    expect(() =>
      parseSmokeArgs([
        "--vendor",
        "protolabs,sendcutsend",
        "--cad",
        "./part.step",
      ]),
    ).toThrow(/unsupported --vendor/i);
  });

  it("rejects partially unsupported vendor batches", () => {
    expect(() =>
      parseSmokeArgs([
        "--vendor",
        "oshcut,unknown",
        "--cad",
        "./part.step",
      ]),
    ).toThrow(/unsupported --vendor/i);
  });
});

describe("parseQuantities", () => {
  it("keeps only positive integer quantities", () => {
    expect(parseQuantities("1,0,nope,10")).toEqual([1, 10]);
  });

  it("uses the smoke-test default when the input is empty or invalid", () => {
    expect(parseQuantities(null)).toEqual([1]);
    expect(parseQuantities("0,nope")).toEqual([1]);
  });
});

describe("buildErrorRow", () => {
  it("preserves vendor automation failure details for live smoke repair", () => {
    const error = new VendorAutomationError(
      "OSH Cut session is not authenticated.",
      "login_required",
      {
        vendor: "oshcut",
        reason: "login_required",
      },
      [
        {
          kind: "screenshot",
          label: "OSH Cut login-required screenshot",
          localPath: ".tmp/vendor-workflow-smoke/oshcut-login.png",
          contentType: "image/png",
        },
      ],
    );

    const row = buildErrorRow("oshcut", 1, "2026-05-14T00:00:00.000Z", Date.now(), error);

    expect(row.errorCode).toBe("login_required");
    expect(row.executionContext).toBe("live_evaluation");
    expect(row.errorPayload).toMatchObject({
      vendor: "oshcut",
      reason: "login_required",
    });
    expect(row.artifacts).toHaveLength(1);
  });
});

describe("runQuote", () => {
  it("builds an eligible Fabworks requirement and reaches the dedicated adapter", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabworks-workflow-smoke-test-"));
    tempDirs.push(tempDir);
    const cadPath = path.join(tempDir, "bent-part.step");
    await fs.writeFile(cadPath, "fabworks-smoke-cad");
    const stagedFiles = await stageLiveEvaluationFiles({
      cadPath,
      drawingPath: null,
      confirmedNonExportControlled: true,
    });
    const args = parseSmokeArgs([
      "--vendor",
      "fabworks",
      "--cad",
      cadPath,
      "--quantities",
      "2",
      "--confirm-non-export-controlled",
    ]);
    const config = {
      workerMode: "live",
      vendorStorageStateJson: {
        fabworks: '{"cookies":[],"origins":[]}',
      },
      vendorStorageStatePaths: {},
    } as WorkerConfig;
    const delegateQuote = vi.fn<VendorAdapter["quote"]>().mockResolvedValue({
      vendor: "fabworks",
      status: "instant_quote_received",
      totalPriceUsd: 42,
      unitPriceUsd: 21,
      leadTimeBusinessDays: 3,
      quoteUrl: "https://www.fabworks.com/quotes/qte_fixture",
      dfmIssues: [],
      notes: [],
      rawPayload: { source: "fabworks-live-adapter" },
      artifacts: [],
    });
    const adapter = new FabworksAdapter(config, { quote: delegateQuote });

    try {
      const row = await runQuote(
        config,
        args,
        "fabworks",
        2,
        stagedFiles,
        () => ({
          fabworks: {
            quote: async (input) => {
              const authorizedInput = await authorizeLiveEvaluationInput(input);
              if (!authorizedInput) {
                throw new Error("Fabworks smoke input authorization failed.");
              }
              return adapter.quote(authorizedInput);
            },
          },
        }),
      );

      expect(delegateQuote).toHaveBeenCalledOnce();
      expect(delegateQuote).toHaveBeenCalledWith(expect.objectContaining({
        requestedQuantity: 2,
        requirement: expect.objectContaining({
          material: "6061-T6 aluminum",
          spec_snapshot: {
            process: "sheet metal bending",
            geometryFamily: "bent sheet 3d",
          },
        }),
      }));
      expect(row).toMatchObject({
        status: "instant_quote_received",
        totalPriceUsd: 42,
        unitPriceUsd: 21,
        rawPayload: {
          fabworksState: "live_offer",
          eligibilityReason: "package_within_envelope",
        },
        error: null,
      });
    } finally {
      await stagedFiles.cleanup();
    }
  });
});

describe("runEvaluationBatch", () => {
  it("stages once and reuses the same captured files for every vendor and quantity", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vendor-workflow-smoke-test-"));
    tempDirs.push(tempDir);
    const cadPath = path.join(tempDir, "part.step");
    const drawingPath = path.join(tempDir, "part.pdf");
    await Promise.all([
      fs.writeFile(cadPath, "cad-bytes"),
      fs.writeFile(drawingPath, "drawing-bytes"),
    ]);
    const args = parseSmokeArgs([
      "--vendor",
      "xometry,fictiv",
      "--cad",
      cadPath,
      "--drawing",
      drawingPath,
      "--quantities",
      "1,5",
      "--confirm-non-export-controlled",
    ]);
    const seenCadBytes: string[] = [];
    const seenDrawingBytes: string[] = [];
    const seenStagedCadPaths: string[] = [];
    const seenAuthorizations: unknown[] = [];
    const quote = vi.fn<VendorAdapter["quote"]>().mockImplementation(async (input) => {
      seenCadBytes.push(await fs.readFile(input.stagedCadFile!.localPath, "utf8"));
      seenDrawingBytes.push(await fs.readFile(input.stagedDrawingFile!.localPath, "utf8"));
      seenStagedCadPaths.push(input.stagedCadFile!.localPath);
      seenAuthorizations.push(input.liveEvaluationAuthorization);
      if (seenCadBytes.length === 1) {
        await Promise.all([
          fs.writeFile(cadPath, "replacement-cad-bytes"),
          fs.writeFile(drawingPath, "replacement-drawing-bytes"),
        ]);
      }

      return {
        vendor: "xometry",
        status: "submitted",
        totalPriceUsd: null,
        unitPriceUsd: null,
        leadTimeBusinessDays: null,
        quoteUrl: null,
        rawPayload: {},
        artifacts: [],
      };
    });
    const cleanup = vi.fn();
    const stageFiles = vi.fn(async (input: Parameters<typeof stageLiveEvaluationFiles>[0]) => {
      const stagedFiles = await stageLiveEvaluationFiles(input);
      return {
        ...stagedFiles,
        cleanup: async () => {
          cleanup();
          await stagedFiles.cleanup();
        },
      };
    });

    const rows = await runEvaluationBatch(args, {
      buildRegistry: () => ({
        xometry: { quote },
        fictiv: { quote },
      }),
      makeVendorConfig: () => ({} as WorkerConfig),
      stageFiles,
    });

    expect(rows).toHaveLength(4);
    expect(stageFiles).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(quote).toHaveBeenCalledTimes(4);
    expect(seenCadBytes).toEqual(["cad-bytes", "cad-bytes", "cad-bytes", "cad-bytes"]);
    expect(seenDrawingBytes).toEqual(["drawing-bytes", "drawing-bytes", "drawing-bytes", "drawing-bytes"]);
    expect(new Set(seenStagedCadPaths).size).toBe(1);
    expect(seenAuthorizations[0]).toEqual(seenAuthorizations[1]);
    expect(quote).toHaveBeenNthCalledWith(4, expect.objectContaining({
      executionContext: "live_evaluation",
      requestedQuantity: 5,
      liveEvaluationAuthorization: expect.objectContaining({
        nonExportControlled: true,
        cadFileSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        drawingFileSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    }));
  });

  it("refuses an upload when non-export-controlled confirmation is missing", async () => {
    const args = parseSmokeArgs([
      "--vendor",
      "xometry",
      "--cad",
      "./part.step",
      "--quantities",
      "1,5",
    ]);
    const quote = vi.fn<VendorAdapter["quote"]>();

    await expect(runEvaluationBatch(args, {
      buildRegistry: () => ({ xometry: { quote } }),
      makeVendorConfig: () => ({} as WorkerConfig),
    })).rejects.toThrow(/confirm-non-export-controlled/);

    expect(quote).not.toHaveBeenCalled();
  });

  it("reports cleanup failure without masking a successful quote", async () => {
    const args = parseSmokeArgs([
      "--vendor",
      "xometry",
      "--cad",
      "./part.step",
      "--quantities",
      "1,5",
      "--confirm-non-export-controlled",
    ]);
    const quote = vi.fn<VendorAdapter["quote"]>().mockResolvedValue({
      vendor: "xometry",
      status: "submitted",
      totalPriceUsd: null,
      unitPriceUsd: null,
      leadTimeBusinessDays: null,
      quoteUrl: null,
      rawPayload: {},
      artifacts: [],
    });
    const cleanup = vi.fn().mockRejectedValue(new Error("cleanup denied"));

    const rows = await runEvaluationBatch(args, {
      buildRegistry: () => ({ xometry: { quote } }),
      makeVendorConfig: () => ({} as WorkerConfig),
      stageFiles: async () => ({
        authorization: {
          nonExportControlled: true,
          cadFileSha256: "b".repeat(64),
          drawingFileSha256: null,
        },
        cadPath: "/private/staged/cad.step",
        drawingPath: null,
        cleanup,
      }),
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.error === null)).toBe(true);
    expect(rows.every((row) => row.status === "submitted")).toBe(true);
    expect(rows.every((row) => row.cleanupError === "cleanup denied")).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("prepares runtime credentials before building an adapter registry", async () => {
    const args = parseSmokeArgs([
      "--vendor",
      "fictiv",
      "--cad",
      "./part.step",
      "--confirm-non-export-controlled",
    ]);
    const quote = vi.fn<VendorAdapter["quote"]>().mockResolvedValue({
      vendor: "fictiv",
      status: "submitted",
      totalPriceUsd: null,
      unitPriceUsd: null,
      leadTimeBusinessDays: null,
      quoteUrl: null,
      rawPayload: {},
      artifacts: [],
    });
    const rawConfig = { fictivStorageStatePath: null } as WorkerConfig;
    const preparedConfig = {
      ...rawConfig,
      fictivStorageStatePath: "/private/runtime-secrets/fictiv.json",
    };
    const prepareConfig = vi.fn().mockResolvedValue(preparedConfig);
    const buildRegistry = vi.fn((config: WorkerConfig) => {
      expect(config).toMatchObject({
        fictivStorageStatePath: preparedConfig.fictivStorageStatePath,
      });
      expect(config.workerTempDir).not.toBe(rawConfig.workerTempDir);
      return { fictiv: { quote } };
    });

    const rows = await runEvaluationBatch(args, {
      makeVendorConfig: () => rawConfig,
      prepareConfig,
      buildRegistry,
      stageFiles: async () => ({
        authorization: {
          nonExportControlled: true,
          cadFileSha256: "c".repeat(64),
          drawingFileSha256: null,
        },
        cadPath: "/private/staged/cad.step",
        drawingPath: null,
        cleanup: vi.fn(),
      }),
    });

    expect(rows).toHaveLength(1);
    expect(prepareConfig).toHaveBeenCalledWith(expect.objectContaining({
      fictivStorageStatePath: null,
      xometryStorageStatePath: null,
      xometryStorageStateJson: null,
    }));
    expect(buildRegistry).toHaveBeenCalledOnce();
  });

  it("ignores unrelated malformed credentials when preparing one vendor", async () => {
    const args = parseSmokeArgs([
      "--vendor",
      "fictiv",
      "--cad",
      "./part.step",
      "--confirm-non-export-controlled",
    ]);
    const quote = vi.fn<VendorAdapter["quote"]>().mockResolvedValue({
      vendor: "fictiv",
      status: "submitted",
      totalPriceUsd: null,
      unitPriceUsd: null,
      leadTimeBusinessDays: null,
      quoteUrl: null,
      rawPayload: {},
      artifacts: [],
    });

    const rows = await runEvaluationBatch(args, {
      makeVendorConfig: (_vendor, credentialRuntimeDir) => ({
        workerTempDir: credentialRuntimeDir,
        xometryStorageStatePath: null,
        xometryStorageStateJson: "malformed-xometry-json",
        xometryUserDataDir: null,
        xometryProfileSnapshotBucket: null,
        fictivStorageStatePath: null,
        fictivStorageStateJson: JSON.stringify({ cookies: [], origins: [] }),
      }) as WorkerConfig,
      stageFiles: async () => ({
        authorization: {
          nonExportControlled: true,
          cadFileSha256: "1".repeat(64),
          drawingFileSha256: null,
        },
        cadPath: "/private/staged/cad.step",
        drawingPath: null,
        cleanup: vi.fn(),
      }),
      buildRegistry: (config) => {
        expect(config.xometryStorageStateJson).toBeNull();
        expect(config.fictivStorageStatePath).toMatch(
          /runtime-secrets\/fictiv-storage-state\.json$/,
        );
        return { fictiv: { quote } };
      },
    });

    expect(rows).toHaveLength(1);
    expect(quote).toHaveBeenCalledOnce();
  });

  it("isolates concurrent materialized sessions and removes them after each batch", async () => {
    const args = parseSmokeArgs([
      "--vendor",
      "fictiv",
      "--cad",
      "./part.step",
      "--confirm-non-export-controlled",
    ]);
    const runtimeDirs: string[] = [];
    const materializedSessionPaths: string[] = [];
    const quote = vi.fn<VendorAdapter["quote"]>().mockResolvedValue({
      vendor: "fictiv",
      status: "submitted",
      totalPriceUsd: null,
      unitPriceUsd: null,
      leadTimeBusinessDays: null,
      quoteUrl: null,
      rawPayload: {},
      artifacts: [],
    });
    const makeVendorConfig = (
      _vendor: string,
      evaluationRuntimeDir: string,
    ) => {
      runtimeDirs.push(evaluationRuntimeDir);
      return { workerTempDir: evaluationRuntimeDir } as WorkerConfig;
    };
    const prepareConfig = async (config: WorkerConfig) => {
      const sessionDir = path.join(config.workerTempDir, "runtime-secrets");
      const sessionPath = path.join(sessionDir, "fictiv-storage-state.json");
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(sessionPath, "authenticated-session", { mode: 0o600 });
      materializedSessionPaths.push(sessionPath);
      return config;
    };
    const stageFiles = async () => ({
      authorization: {
        nonExportControlled: true as const,
        cadFileSha256: "e".repeat(64),
        drawingFileSha256: null,
      },
      cadPath: "/private/staged/cad.step",
      drawingPath: null,
      cleanup: vi.fn(),
    });

    await Promise.all([
      runEvaluationBatch(args, {
        makeVendorConfig,
        prepareConfig,
        stageFiles,
        buildRegistry: () => ({ fictiv: { quote } }),
      }),
      runEvaluationBatch(args, {
        makeVendorConfig,
        prepareConfig,
        stageFiles,
        buildRegistry: () => ({ fictiv: { quote } }),
      }),
    ]);

    expect(runtimeDirs).toHaveLength(2);
    expect(new Set(runtimeDirs).size).toBe(2);
    expect(materializedSessionPaths).toHaveLength(2);
    await Promise.all(materializedSessionPaths.map(async (sessionPath) => {
      await expect(fs.access(sessionPath)).rejects.toThrow();
    }));
  });

  it("preserves browser evidence outside the disposable credential directory", async () => {
    const args = parseSmokeArgs([
      "--vendor",
      "fictiv",
      "--cad",
      "./part.step",
      "--confirm-non-export-controlled",
    ]);
    let evidenceDir = "";
    let artifactPath = "";

    const rows = await runEvaluationBatch(args, {
      makeVendorConfig: (_vendor, credentialRuntimeDir) => ({
        workerTempDir: credentialRuntimeDir,
      }) as WorkerConfig,
      prepareConfig: async (config) => config,
      stageFiles: async () => ({
        authorization: {
          nonExportControlled: true,
          cadFileSha256: "f".repeat(64),
          drawingFileSha256: null,
        },
        cadPath: "/private/staged/cad.step",
        drawingPath: null,
        cleanup: vi.fn(),
      }),
      buildRegistry: (config) => {
        evidenceDir = config.workerTempDir;
        artifactPath = path.join(evidenceDir, "browser-evidence.html");
        return {
          fictiv: {
            quote: async () => {
              await fs.writeFile(artifactPath, "captured browser evidence");
              return {
                vendor: "fictiv",
                status: "submitted",
                totalPriceUsd: null,
                unitPriceUsd: null,
                leadTimeBusinessDays: null,
                quoteUrl: null,
                rawPayload: {},
                artifacts: [{
                  kind: "html_snapshot",
                  label: "browser evidence",
                  localPath: artifactPath,
                  contentType: "text/html",
                }],
              };
            },
          },
        };
      },
    });

    tempDirs.push(path.dirname(evidenceDir));
    expect(rows[0]?.artifacts[0]?.localPath).toBe(artifactPath);
    await expect(fs.readFile(artifactPath, "utf8")).resolves.toBe(
      "captured browser evidence",
    );
  });

  it("preserves both setup and cleanup failures", async () => {
    const args = parseSmokeArgs([
      "--vendor",
      "xometry",
      "--cad",
      "./part.step",
      "--confirm-non-export-controlled",
    ]);
    const setupFailure = new Error("credential preparation failed");
    const cleanupFailure = new Error("private staging cleanup failed");

    try {
      await runEvaluationBatch(args, {
        makeVendorConfig: () => {
          throw setupFailure;
        },
        stageFiles: async () => ({
          authorization: {
            nonExportControlled: true,
            cadFileSha256: "d".repeat(64),
            drawingFileSha256: null,
          },
          cadPath: "/private/staged/cad.step",
          drawingPath: null,
          cleanup: vi.fn().mockRejectedValue(cleanupFailure),
        }),
      });
      throw new Error("expected evaluation setup to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([
        setupFailure,
        cleanupFailure,
      ]);
    }
  });
});
