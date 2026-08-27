// @vitest-environment node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VendorAdapter } from "../adapters/base";
import { stageLiveEvaluationFiles } from "../liveEvaluationFiles";
import type { WorkerConfig } from "../types";
import { VendorAutomationError } from "../types";
import {
  buildErrorRow,
  loadSendCutSendEvaluationManifest,
  parseQuantities,
  parseSmokeArgs,
  runEvaluationBatch,
  safeEvaluationError,
  type SendCutSendEvaluationManifest,
} from "./vendorWorkflowSmoke";

const tempDirs: string[] = [];

function digest(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

function makeSendCutSendManifest(
  cadContent: string,
  overrides: Partial<SendCutSendEvaluationManifest> = {},
): SendCutSendEvaluationManifest {
  return {
    schemaVersion: "sendcutsend-evaluation-manifest.v1",
    reviewed: true,
    reviewedAt: "2026-08-26",
    reviewedBy: "OVD-404 test reviewer",
    envelopeRevision: "sendcutsend-cnc-envelope.v1",
    accountMode: "company_controlled",
    cadSha256: digest(cadContent),
    drawingSha256: null,
    process: "CNC machining",
    material: "6061-T6 aluminum",
    finish: "as machined",
    tightestToleranceInch: 0.005,
    quantities: [1],
    ...overrides,
  };
}

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
      "--sendcutsend-manifest",
      "./sendcutsend-reviewed.json",
    ]);

    expect(args.vendors).toEqual([
      "xometry",
      "fictiv",
      "sendcutsend",
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

  it("accepts SendCutSend and rejects remaining live adapter stubs", () => {
    expect(parseSmokeArgs([
      "--vendor",
      "sendcutsend",
      "--cad",
      "./part.step",
      "--sendcutsend-manifest",
      "./sendcutsend-reviewed.json",
    ]).vendors).toEqual(["sendcutsend"]);

    expect(() =>
      parseSmokeArgs([
        "--vendor",
        "protolabs",
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

  it("requires an explicit reviewed manifest whenever SendCutSend is selected", () => {
    expect(() => parseSmokeArgs([
      "--vendor",
      "sendcutsend",
      "--cad",
      "./part.step",
    ])).toThrow(/requires --sendcutsend-manifest/i);
  });
});

describe("parseQuantities", () => {
  it("keeps only positive integer quantities", () => {
    expect(parseQuantities("1,0,nope,10,5x")).toEqual([1, 10]);
  });

  it("uses the smoke-test default when the input is empty or invalid", () => {
    expect(parseQuantities(null)).toEqual([1]);
    expect(parseQuantities("0,nope")).toEqual([1]);
  });
});

describe("SendCutSend reviewed evaluation manifest", () => {
  it("binds exact reviewed facts before staging and preserves every returned offer", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sendcutsend-manifest-test-"));
    tempDirs.push(tempDir);
    const cadContent = "reviewed-cad-bytes";
    const cadPath = path.join(tempDir, "part.step");
    const manifestPath = path.join(tempDir, "reviewed.json");
    const manifest = makeSendCutSendManifest(cadContent, { quantities: [1, 5] });
    await Promise.all([
      fs.writeFile(cadPath, cadContent),
      fs.writeFile(manifestPath, JSON.stringify(manifest)),
    ]);
    const args = parseSmokeArgs([
      "--vendor",
      "sendcutsend",
      "--cad",
      cadPath,
      "--quantities",
      "1,5",
      "--sendcutsend-manifest",
      manifestPath,
      "--confirm-non-export-controlled",
    ]);
    const stageFiles = vi.fn().mockResolvedValue({
      authorization: {
        nonExportControlled: true,
        cadFileSha256: manifest.cadSha256,
        drawingFileSha256: null,
      },
      cadPath: "/private/staged/part.step",
      drawingPath: null,
      cleanup: vi.fn(),
    });
    const quote = vi.fn<VendorAdapter["quote"]>().mockImplementation(async (input) => {
      expect(input.requirement).toMatchObject({
        material: "6061-T6 aluminum",
        finish: "as machined",
        tightest_tolerance_inch: 0.005,
        spec_snapshot: {
          process: "CNC machining",
          evaluationManifest: {
            schemaVersion: "sendcutsend-evaluation-manifest.v1",
            cadSha256: manifest.cadSha256,
          },
        },
      });
      return {
        vendor: "sendcutsend",
        status: "instant_quote_received",
        totalPriceUsd: 120,
        unitPriceUsd: 120 / input.requestedQuantity,
        leadTimeBusinessDays: 5,
        quoteUrl: null,
        artifacts: [],
        offers: [
          {
            providerOptionId: "standard",
            providerLabel: "Standard",
            quoteRef: null,
            quoteUrl: null,
            totalPriceUsd: 120,
            unitPriceUsd: 120 / input.requestedQuantity,
            leadTimeBusinessDays: 5,
            shipReceiveBy: null,
            tier: "Standard",
            sourcing: "automated",
            geographicOrigin: "unknown",
            sortRank: 0,
          },
          {
            providerOptionId: "rush",
            providerLabel: "Rush",
            quoteRef: null,
            quoteUrl: null,
            totalPriceUsd: 180,
            unitPriceUsd: 180 / input.requestedQuantity,
            leadTimeBusinessDays: 2,
            shipReceiveBy: null,
            tier: "Rush",
            sourcing: "automated",
            geographicOrigin: "unknown",
            sortRank: 1,
          },
        ],
        rawPayload: {},
      };
    });

    await expect(loadSendCutSendEvaluationManifest(args)).resolves.toEqual(manifest);
    const rows = await runEvaluationBatch(args, {
      stageFiles,
      makeVendorConfig: () => ({} as WorkerConfig),
      prepareConfig: async (config) => config,
      buildRegistry: () => ({ sendcutsend: { quote } }),
    });

    expect(stageFiles).toHaveBeenCalledOnce();
    expect(quote).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.offers.length === 2)).toBe(true);
    expect(rows[1]?.offers.map((offer) => offer.providerOptionId)).toEqual(["standard", "rush"]);
  });

  it.each([
    ["partial", { schemaVersion: "sendcutsend-evaluation-manifest.v1" }],
    ["inexact", makeSendCutSendManifest("cad", { material: "6061 aluminum" as "6061-T6 aluminum" })],
  ])("rejects a %s manifest before staging or registry construction", async (_label, manifest) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sendcutsend-manifest-invalid-"));
    tempDirs.push(tempDir);
    const cadPath = path.join(tempDir, "part.step");
    const manifestPath = path.join(tempDir, "reviewed.json");
    await Promise.all([
      fs.writeFile(cadPath, "cad"),
      fs.writeFile(manifestPath, JSON.stringify(manifest)),
    ]);
    const args = parseSmokeArgs([
      "--vendor", "sendcutsend",
      "--cad", cadPath,
      "--sendcutsend-manifest", manifestPath,
      "--confirm-non-export-controlled",
    ]);
    const stageFiles = vi.fn();
    const buildRegistry = vi.fn();

    await expect(runEvaluationBatch(args, { stageFiles, buildRegistry })).rejects.toThrow(
      /fields are missing|facts are incomplete/i,
    );
    expect(stageFiles).not.toHaveBeenCalled();
    expect(buildRegistry).not.toHaveBeenCalled();
  });

  it("rejects a digest mismatch before staging", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sendcutsend-manifest-digest-"));
    tempDirs.push(tempDir);
    const cadPath = path.join(tempDir, "part.step");
    const manifestPath = path.join(tempDir, "reviewed.json");
    await Promise.all([
      fs.writeFile(cadPath, "actual-cad"),
      fs.writeFile(manifestPath, JSON.stringify(makeSendCutSendManifest("different-cad"))),
    ]);
    const args = parseSmokeArgs([
      "--vendor", "sendcutsend",
      "--cad", cadPath,
      "--sendcutsend-manifest", manifestPath,
      "--confirm-non-export-controlled",
    ]);
    const stageFiles = vi.fn();

    await expect(runEvaluationBatch(args, { stageFiles })).rejects.toThrow(/CAD digest does not match/i);
    expect(stageFiles).not.toHaveBeenCalled();
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

  it("bounds and redacts arbitrary filesystem errors before console or JSON evidence", () => {
    const rawPath = "/Users/private-person/project/secret.step";
    const oversized = `Playwright failed at ${rawPath}: ${"x".repeat(2_000)}`;
    const error = new VendorAutomationError(
      oversized,
      "unexpected_ui_state",
      { reason: "unexpected_ui_state", debugPath: rawPath, nested: { detail: oversized } },
    );

    const row = buildErrorRow("sendcutsend", 1, "2026-08-26T00:00:00.000Z", Date.now(), error);
    const serialized = JSON.stringify(row);
    expect(row.error?.length).toBeLessThanOrEqual(1_000);
    expect(row.error).toContain("<redacted-path>");
    expect(safeEvaluationError(error)).toBe(row.error);
    expect(serialized).not.toContain("private-person");
    expect(serialized).not.toContain("secret.step");
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
