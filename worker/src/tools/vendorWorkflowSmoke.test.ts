// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FabworksAdapter } from "../adapters/fabworks";
import type { VendorAdapter } from "../adapters/base";
import type { SendCutSendEvaluationManifest } from "../adapters/sendcutsend";
import {
  authorizeLiveEvaluationInput,
  sha256File,
  stageLiveEvaluationFiles,
} from "../liveEvaluationFiles";
import type { WorkerConfig } from "../types";
import { VendorAutomationError } from "../types";
import {
  buildErrorRow,
  loadSendCutSendEvaluationManifest,
  parseQuantities,
  parseSmokeArgs,
  runEvaluationBatch,
  runQuote,
} from "./vendorWorkflowSmoke";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((tempDir) => fs.rm(tempDir, {
    recursive: true,
    force: true,
  })));
});

async function sendCutSendFixture(options: {
  quantities?: number[];
  drawing?: boolean;
} = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sendcutsend-smoke-test-"));
  tempDirs.push(tempDir);
  const cadPath = path.join(tempDir, "bracket.step");
  const drawingPath = options.drawing ? path.join(tempDir, "bracket.pdf") : null;
  const manifestPath = path.join(tempDir, "sendcutsend-manifest.json");
  const source = await fs.readFile(
    new URL("../adapters/fixtures/sendcutsend-planar-single-solid.step", import.meta.url),
    "utf8",
  );
  const eligibleSource = source.replace(
    /\((-?1)\.,(-?1)\.,(-?1)\.\)/g,
    (_match, x: string, y: string, z: string) => {
      const scaled = [x, y, z].map((coordinate) => Number(coordinate) * 25.4);
      return `(${scaled[0]}.,${scaled[1]}.,${scaled[2]}.)`;
    },
  );
  await fs.writeFile(cadPath, eligibleSource);
  if (drawingPath) {
    await fs.writeFile(drawingPath, "sendcutsend-drawing-bytes");
  }
  const manifest: SendCutSendEvaluationManifest = {
    schemaVersion: "sendcutsend-evaluation-manifest.v1",
    reviewed: true,
    reviewedAt: "2026-08-27",
    reviewedBy: "evaluation-reviewer",
    envelopeRevision: "sendcutsend-cnc-envelope.v1",
    accountMode: "company_controlled",
    cadFileName: path.basename(cadPath),
    drawingFileName: drawingPath ? path.basename(drawingPath) : null,
    cadSha256: await sha256File(cadPath),
    drawingSha256: drawingPath ? await sha256File(drawingPath) : null,
    process: "CNC machining",
    material: "6061-T6 aluminum",
    finish: "as machined",
    tightestToleranceInch: 0.005,
    quantities: options.quantities ?? [1],
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  return { cadPath, drawingPath, manifestPath, manifest, cadBytes: eligibleSource };
}

describe("vendorWorkflowSmoke argument parsing", () => {
  it("parses explicit exact OSH Cut package metadata with the selected files and quantities", () => {
    const args = parseSmokeArgs([
      "--vendor",
      "OSHCut",
      "--cad",
      "./part.step",
      "--drawing",
      "./part.pdf",
      "--quantities",
      "1,5,25",
      "--oshcut-process",
      "laser_cutting",
      "--oshcut-material",
      "aluminum_6061_t6",
      "--oshcut-geometry",
      "flat_sheet",
    ]);

    expect(args.vendors).toEqual(["oshcut"]);
    expect(args.cadPath).toMatch(/part\.step$/);
    expect(args.drawingPath).toMatch(/part\.pdf$/);
    expect(args.quantities).toEqual([1, 5, 25]);
    expect(args.oshcutPackage).toEqual({
      process: "laser_cutting",
      material: "aluminum_6061_t6",
      geometryFamily: "flat_sheet",
    });
  });

  it("rejects OSH Cut selection without explicit package metadata", () => {
    expect(() => parseSmokeArgs([
      "--vendor",
      "oshcut",
      "--cad",
      "./part.step",
    ])).toThrow(/requires explicit exact package metadata/i);
  });

  it("rejects partial or inexact OSH Cut package metadata", () => {
    expect(() => parseSmokeArgs([
      "--vendor",
      "oshcut",
      "--cad",
      "./part.step",
      "--oshcut-process",
      "laser_cutting",
      "--oshcut-material",
      "aluminum_6061",
      "--oshcut-geometry",
      "flat_sheet",
    ])).toThrow(/requires explicit exact package metadata/i);
  });

  it.each(["1.5", "1abc", "1,,5", "0"])(
    "rejects malformed OSH Cut quantity token %s",
    (quantity) => {
      expect(() => parseSmokeArgs([
        "--vendor",
        "oshcut",
        "--cad",
        "./part.step",
        "--quantities",
        quantity,
        "--oshcut-process",
        "laser_cutting",
        "--oshcut-material",
        "aluminum_6061_t6",
        "--oshcut-geometry",
        "flat_sheet",
      ])).toThrow(/complete positive integer tokens/i);
    },
  );

  it("rejects an out-of-envelope OSH Cut quantity", () => {
    expect(() => parseSmokeArgs([
      "--vendor",
      "oshcut",
      "--cad",
      "./part.step",
      "--quantities",
      "10001",
      "--oshcut-process",
      "laser_cutting",
      "--oshcut-material",
      "aluminum_6061_t6",
      "--oshcut-geometry",
      "flat_sheet",
    ])).toThrow(/quantity must be a whole number from 1 through 10000/i);
  });

  it("falls back to env values and the default quantity", () => {
    const args = parseSmokeArgs([], {
      QUOTE_VENDOR_SMOKE_VENDOR: "weerg",
      QUOTE_VENDOR_LIVE_TEST_CAD_PATH: "./part.step",
    });

    expect(args.vendors).toEqual(["weerg"]);
    expect(args.quantities).toEqual([1]);
  });

  it("parses explicit exact Fabworks package metadata", () => {
    const args = parseSmokeArgs([
      "--vendor",
      "fabworks",
      "--cad",
      "./bent-part.step",
      "--fabworks-process",
      "sheet_metal_bending",
      "--fabworks-material",
      "6061-T6 aluminum",
      "--fabworks-geometry",
      "bent_sheet_3d",
    ]);

    expect(args.fabworksPackage).toEqual({
      process: "sheet_metal_bending",
      material: "6061-T6 aluminum",
      geometryFamily: "bent_sheet_3d",
    });
  });

  it.each([
    ["absent", []],
    [
      "partial",
      [
        "--fabworks-process",
        "sheet_metal_bending",
        "--fabworks-material",
        "6061-T6 aluminum",
      ],
    ],
    [
      "inexact",
      [
        "--fabworks-process",
        "sheet metal bending",
        "--fabworks-material",
        "6061 aluminum",
        "--fabworks-geometry",
        "bent sheet",
      ],
    ],
  ])("rejects %s Fabworks package metadata", (_label, metadataFlags) => {
    expect(() => parseSmokeArgs([
      "--vendor",
      "fabworks",
      "--cad",
      "./bent-part.step",
      ...metadataFlags,
    ])).toThrow(/requires explicit exact package metadata/i);
  });

  it("rejects exact Fabworks metadata that is incompatible with the CAD extension", () => {
    expect(() => parseSmokeArgs([
      "--vendor",
      "fabworks",
      "--cad",
      "./bent-part.dxf",
      "--fabworks-process",
      "sheet_metal_bending",
      "--fabworks-material",
      "6061-T6 aluminum",
      "--fabworks-geometry",
      "bent_sheet_3d",
    ])).toThrow(/requires explicit exact package metadata/i);
  });

  it("accepts all runnable live evaluation vendors for batch validation", () => {
    const args = parseSmokeArgs([
      "--vendor",
      "all",
      "--cad",
      "./part.step",
      "--fabworks-process",
      "sheet_metal_bending",
      "--fabworks-material",
      "6061-T6 aluminum",
      "--fabworks-geometry",
      "bent_sheet_3d",
      "--oshcut-process",
      "laser_cutting",
      "--oshcut-material",
      "aluminum_6061_t6",
      "--oshcut-geometry",
      "flat_sheet",
      "--sendcutsend-manifest",
      "./reviewed.json",
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
      "--fabworks-process",
      "sheet_metal_bending",
      "--fabworks-material",
      "6061-T6 aluminum",
      "--fabworks-geometry",
      "bent_sheet_3d",
      "--oshcut-process",
      "laser_cutting",
      "--oshcut-material",
      "aluminum_6061_t6",
      "--oshcut-geometry",
      "flat_sheet",
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

  it("requires a SendCutSend manifest and preserves safe-integer quantity parsing", () => {
    expect(() => parseSmokeArgs([
      "--vendor", "sendcutsend", "--cad", "./part.step",
    ])).toThrow(/requires --sendcutsend-manifest/i);

    expect(() => parseSmokeArgs([
      "--vendor", "sendcutsend", "--cad", "./part.step",
      "--quantities", "9007199254740992",
      "--sendcutsend-manifest", "./reviewed.json",
    ])).toThrow(/safe-integer tokens/i);

    expect(parseSmokeArgs([
      "--vendor", "sendcutsend", "--cad", "./part.step",
      "--quantities", "1,5",
      "--sendcutsend-manifest", "./reviewed.json",
    ])).toMatchObject({
      vendors: ["sendcutsend"],
      quantities: [1, 5],
      sendCutSendManifestPath: expect.stringMatching(/reviewed\.json$/),
    });
  });

  it("rejects duplicate SendCutSend quantities before manifest comparison", () => {
    expect(() => parseSmokeArgs([
      "--vendor", "sendcutsend", "--cad", "./part.step",
      "--quantities", "1,1,5",
      "--sendcutsend-manifest", "./reviewed.json",
    ])).toThrow(/quantities must be unique/i);
  });
});

describe("parseQuantities", () => {
  it("keeps only complete positive integer tokens", () => {
    expect(parseQuantities("1,0,nope,1.5,1abc,10")).toEqual([1, 10]);
  });

  it("uses the smoke-test default when the input is empty or invalid", () => {
    expect(parseQuantities(null)).toEqual([1]);
    expect(parseQuantities("0,nope")).toEqual([1]);
  });
});

describe("SendCutSend reviewed evaluation manifest", () => {
  it("accepts exact manifest facts bound to selected CAD and drawing bytes", async () => {
    const fixture = await sendCutSendFixture({ quantities: [1, 5], drawing: true });
    const args = parseSmokeArgs([
      "--vendor", "sendcutsend",
      "--cad", fixture.cadPath,
      "--drawing", fixture.drawingPath!,
      "--quantities", "1,5",
      "--sendcutsend-manifest", fixture.manifestPath,
      "--confirm-non-export-controlled",
    ]);

    await expect(loadSendCutSendEvaluationManifest(args)).resolves.toEqual(fixture.manifest);
  });

  it("binds CLI and manifest quantities as a unique set regardless of order", async () => {
    const fixture = await sendCutSendFixture({ quantities: [1, 5] });
    const args = parseSmokeArgs([
      "--vendor", "sendcutsend", "--cad", fixture.cadPath,
      "--quantities", "5,1",
      "--sendcutsend-manifest", fixture.manifestPath,
      "--confirm-non-export-controlled",
    ]);

    await expect(loadSendCutSendEvaluationManifest(args)).resolves.toEqual(fixture.manifest);
  });

  it.each([
    ["missing field", (manifest: Record<string, unknown>) => { delete manifest.finish; }],
    ["extra field", (manifest: Record<string, unknown>) => { manifest.extra = true; }],
    ["inexact process", (manifest: Record<string, unknown>) => { manifest.process = "cnc"; }],
    ["filename mismatch", (manifest: Record<string, unknown>) => {
      manifest.cadFileName = "other.step";
    }],
    ["quantity mismatch", (manifest: Record<string, unknown>) => { manifest.quantities = [1]; }],
  ])("rejects a manifest with %s", async (_label, mutate) => {
    const fixture = await sendCutSendFixture({ quantities: [1, 5] });
    const changed = { ...fixture.manifest } as Record<string, unknown>;
    mutate(changed);
    await fs.writeFile(fixture.manifestPath, JSON.stringify(changed));
    const args = parseSmokeArgs([
      "--vendor", "sendcutsend", "--cad", fixture.cadPath,
      "--quantities", "1,5",
      "--sendcutsend-manifest", fixture.manifestPath,
      "--confirm-non-export-controlled",
    ]);

    await expect(loadSendCutSendEvaluationManifest(args)).rejects.toThrow(/manifest/i);
  });

  it("rejects selected CAD and drawing digest mismatches", async () => {
    const fixture = await sendCutSendFixture({ drawing: true });
    const args = parseSmokeArgs([
      "--vendor", "sendcutsend", "--cad", fixture.cadPath,
      "--drawing", fixture.drawingPath!,
      "--sendcutsend-manifest", fixture.manifestPath,
      "--confirm-non-export-controlled",
    ]);
    await fs.writeFile(fixture.cadPath, "changed-cad");
    await expect(loadSendCutSendEvaluationManifest(args)).rejects.toThrow(/CAD digest/i);
    await fs.writeFile(fixture.cadPath, fixture.cadBytes);
    await fs.writeFile(fixture.drawingPath!, "changed-drawing");
    await expect(loadSendCutSendEvaluationManifest(args)).rejects.toThrow(/drawing digest/i);
  });

  it("requires export-control confirmation before any manifest or selected-byte read", async () => {
    const args = parseSmokeArgs([
      "--vendor", "sendcutsend",
      "--cad", "/opt/Acme Defense/Project X/secret.step",
      "--sendcutsend-manifest", "/opt/Acme Defense/Project X/reviewed.json",
    ]);

    await expect(loadSendCutSendEvaluationManifest(args)).rejects.toThrow(
      /confirm-non-export-controlled before reading selected files/i,
    );
  });
});

describe("runQuote", () => {
  it.each([
    ["missing", null],
    ["partial", { process: "laser_cutting" }],
    ["inexact", {
      process: "laser_cutting",
      material: "aluminum_6061",
      geometryFamily: "flat_sheet",
    }],
  ])("rejects %s OSH Cut metadata before constructing a registry", async (_label, metadata) => {
    const args = parseSmokeArgs([
      "--vendor",
      "oshcut",
      "--cad",
      "./part.step",
      "--oshcut-process",
      "laser_cutting",
      "--oshcut-material",
      "aluminum_6061_t6",
      "--oshcut-geometry",
      "flat_sheet",
      "--confirm-non-export-controlled",
    ]);
    const quote = vi.fn<VendorAdapter["quote"]>();
    const buildRegistry = vi.fn(() => ({ oshcut: { quote } }));

    await expect(runQuote(
      {} as WorkerConfig,
      { ...args, oshcutPackage: metadata as never },
      "oshcut",
      1,
      {
        authorization: {
          nonExportControlled: true,
          cadFileSha256: "a".repeat(64),
          drawingFileSha256: null,
        },
        cadPath: "/private/staged/cad.step",
        drawingPath: null,
        cleanup: vi.fn(),
      },
      buildRegistry,
    )).rejects.toThrow(/adapter invocation denied/i);

    expect(buildRegistry).not.toHaveBeenCalled();
    expect(quote).not.toHaveBeenCalled();
  });

  it.each([
    ["missing export-control confirmation", false, "/private/missing/bracket.step"],
    ["staged byte mismatch", true, null],
  ])("denies direct SendCutSend calls with %s before registry construction", async (
    _label,
    confirmed,
    stagedPath,
  ) => {
    const fixture = await sendCutSendFixture();
    const mismatchedPath = path.join(path.dirname(fixture.cadPath), "mismatched.step");
    await fs.writeFile(mismatchedPath, "different-staged-bytes");
    const args = parseSmokeArgs([
      "--vendor", "sendcutsend", "--cad", fixture.cadPath,
      "--sendcutsend-manifest", fixture.manifestPath,
      ...(confirmed ? ["--confirm-non-export-controlled"] : []),
    ]);
    const quote = vi.fn<VendorAdapter["quote"]>();
    const buildRegistry = vi.fn(() => ({ sendcutsend: { quote } }));

    await expect(runQuote(
      {} as WorkerConfig,
      args,
      "sendcutsend",
      1,
      {
        authorization: {
          nonExportControlled: true,
          cadFileSha256: fixture.manifest.cadSha256,
          drawingFileSha256: null,
        },
        cadPath: stagedPath ?? mismatchedPath,
        drawingPath: null,
        cleanup: vi.fn(),
      },
      buildRegistry,
      fixture.manifest,
    )).rejects.toThrow(/invocation denied|staged CAD bytes/i);

    expect(buildRegistry).not.toHaveBeenCalled();
    expect(quote).not.toHaveBeenCalled();
  });

  it("denies direct SendCutSend calls with mismatched staged drawing bytes", async () => {
    const fixture = await sendCutSendFixture({ drawing: true });
    const stagedDrawingPath = path.join(path.dirname(fixture.cadPath), "staged-drawing.pdf");
    await fs.writeFile(stagedDrawingPath, "different-staged-drawing-bytes");
    const args = parseSmokeArgs([
      "--vendor", "sendcutsend", "--cad", fixture.cadPath,
      "--drawing", fixture.drawingPath!,
      "--sendcutsend-manifest", fixture.manifestPath,
      "--confirm-non-export-controlled",
    ]);
    const quote = vi.fn<VendorAdapter["quote"]>();
    const buildRegistry = vi.fn(() => ({ sendcutsend: { quote } }));

    await expect(runQuote(
      {} as WorkerConfig,
      args,
      "sendcutsend",
      1,
      {
        authorization: {
          nonExportControlled: true,
          cadFileSha256: fixture.manifest.cadSha256,
          drawingFileSha256: fixture.manifest.drawingSha256,
        },
        cadPath: fixture.cadPath,
        drawingPath: stagedDrawingPath,
        cleanup: vi.fn(),
      },
      buildRegistry,
      fixture.manifest,
    )).rejects.toThrow(/staged drawing bytes/i);

    expect(buildRegistry).not.toHaveBeenCalled();
    expect(quote).not.toHaveBeenCalled();
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
      "--fabworks-process",
      "sheet_metal_bending",
      "--fabworks-material",
      "6061-T6 aluminum",
      "--fabworks-geometry",
      "bent_sheet_3d",
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
            process: "sheet_metal_bending",
            geometryFamily: "bent_sheet_3d",
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

  it("binds Fabworks validation to the invoked vendor before registry construction", async () => {
    const args = parseSmokeArgs([
      "--vendor",
      "xometry",
      "--cad",
      "./part.step",
      "--confirm-non-export-controlled",
    ]);
    const quote = vi.fn<VendorAdapter["quote"]>();
    const buildRegistry = vi.fn(() => ({ fabworks: { quote } }));

    await expect(runQuote(
      {} as WorkerConfig,
      args,
      "fabworks",
      1,
      {
        authorization: {
          nonExportControlled: true,
          cadFileSha256: "a".repeat(64),
          drawingFileSha256: null,
        },
        cadPath: "/private/staged/part.step",
        drawingPath: null,
        cleanup: vi.fn(),
      },
      buildRegistry,
    )).rejects.toThrow(/Fabworks adapter invocation denied/i);

    expect(buildRegistry).not.toHaveBeenCalled();
    expect(quote).not.toHaveBeenCalled();
  });
});

describe("runEvaluationBatch", () => {
  it("denies a staged SendCutSend digest mismatch before config or registry construction", async () => {
    const fixture = await sendCutSendFixture();
    const args = parseSmokeArgs([
      "--vendor", "sendcutsend", "--cad", fixture.cadPath,
      "--sendcutsend-manifest", fixture.manifestPath,
      "--confirm-non-export-controlled",
    ]);
    const buildRegistry = vi.fn();
    const makeVendorConfig = vi.fn();
    const cleanup = vi.fn();

    await expect(runEvaluationBatch(args, {
      buildRegistry,
      makeVendorConfig,
      stageFiles: async () => ({
        authorization: {
          nonExportControlled: true,
          cadFileSha256: "f".repeat(64),
          drawingFileSha256: null,
        },
        cadPath: "/private/staged/bracket.step",
        drawingPath: null,
        cleanup,
      }),
    })).rejects.toThrow(/staged bytes do not match/i);

    expect(makeVendorConfig).not.toHaveBeenCalled();
    expect(buildRegistry).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("uses only manifest quantities and skips credential preparation", async () => {
    const fixture = await sendCutSendFixture({ quantities: [1, 5] });
    const args = parseSmokeArgs([
      "--vendor", "sendcutsend", "--cad", fixture.cadPath,
      "--quantities", "1,5",
      "--sendcutsend-manifest", fixture.manifestPath,
      "--confirm-non-export-controlled",
    ]);
    const prepareConfig = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const rows = await runEvaluationBatch(args, {
      makeVendorConfig: () => ({
        workerMode: "live",
        workerLiveAdapters: ["sendcutsend"],
      }) as WorkerConfig,
      prepareConfig,
    });

    expect(rows.map((row) => row.quantity)).toEqual([1, 5]);
    expect(rows.every((row) => row.status === "manual_vendor_followup")).toBe(true);
    expect(rows.every((row) => row.rawPayload?.detectedFlow
      === "provider_configuration_contract_uncertified")).toBe(true);
    expect(rows.every((row) => row.rawPayload?.providerInteractionAttempted === false)).toBe(true);
    expect(rows.every((row) => row.rawPayload?.orderAttempted === false)).toBe(true);
    expect(prepareConfig).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ignores malformed unrelated credential and session environment", async () => {
    const fixture = await sendCutSendFixture();
    const args = parseSmokeArgs([
      "--vendor", "sendcutsend", "--cad", fixture.cadPath,
      "--sendcutsend-manifest", fixture.manifestPath,
      "--confirm-non-export-controlled",
    ]);
    vi.stubEnv("QUOTE_VENDOR_STORAGE_STATE_JSON", "not-json");
    vi.stubEnv("QUOTE_VENDOR_STORAGE_STATE_PATHS", "not-json");
    vi.stubEnv("XOMETRY_PROFILE_SNAPSHOT_BUCKET", "unrelated-bucket");
    vi.stubEnv("XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES", "not-a-number");
    vi.stubEnv("XOMETRY_STORAGE_STATE_JSON", "not-json");
    vi.stubEnv("FICTIV_STORAGE_STATE_JSON", "not-json");
    const prepareConfig = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const rows = await runEvaluationBatch(args, { prepareConfig });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      vendor: "sendcutsend",
      status: "manual_vendor_followup",
      rawPayload: {
        detectedFlow: "provider_configuration_contract_uncertified",
        providerInteractionAttempted: false,
      },
    });
    expect(prepareConfig).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("denies a Fabworks metadata bypass before staging or adapter construction", async () => {
    const validArgs = parseSmokeArgs([
      "--vendor",
      "fabworks",
      "--cad",
      "./bent-part.step",
      "--fabworks-process",
      "sheet_metal_bending",
      "--fabworks-material",
      "6061-T6 aluminum",
      "--fabworks-geometry",
      "bent_sheet_3d",
      "--confirm-non-export-controlled",
    ]);
    const stageFiles = vi.fn();
    const buildRegistry = vi.fn();
    const makeVendorConfig = vi.fn();

    await expect(runEvaluationBatch({
      ...validArgs,
      fabworksPackage: null,
    }, {
      stageFiles,
      buildRegistry,
      makeVendorConfig,
    })).rejects.toThrow(/Fabworks adapter invocation denied/i);

    expect(stageFiles).not.toHaveBeenCalled();
    expect(buildRegistry).not.toHaveBeenCalled();
    expect(makeVendorConfig).not.toHaveBeenCalled();
  });

  it("denies a CAD-extension mismatch before staging or adapter construction", async () => {
    const validArgs = parseSmokeArgs([
      "--vendor",
      "fabworks",
      "--cad",
      "./bent-part.step",
      "--fabworks-process",
      "sheet_metal_bending",
      "--fabworks-material",
      "6061-T6 aluminum",
      "--fabworks-geometry",
      "bent_sheet_3d",
      "--confirm-non-export-controlled",
    ]);
    const stageFiles = vi.fn();
    const buildRegistry = vi.fn();
    const makeVendorConfig = vi.fn();

    await expect(runEvaluationBatch({
      ...validArgs,
      cadPath: path.resolve("./bent-part.dxf"),
    }, {
      stageFiles,
      buildRegistry,
      makeVendorConfig,
    })).rejects.toThrow(/Fabworks adapter invocation denied/i);

    expect(stageFiles).not.toHaveBeenCalled();
    expect(buildRegistry).not.toHaveBeenCalled();
    expect(makeVendorConfig).not.toHaveBeenCalled();
  });

  it.each([
    ["fractional", [1.5]],
    ["out-of-envelope", [10_001]],
    ["empty", []],
  ])(
    "rejects an %s OSH Cut quantity selection before staging",
    async (_label, quantities) => {
      const args = parseSmokeArgs([
        "--vendor",
        "oshcut",
        "--cad",
        "./part.step",
        "--oshcut-process",
        "laser_cutting",
        "--oshcut-material",
        "aluminum_6061_t6",
        "--oshcut-geometry",
        "flat_sheet",
        "--confirm-non-export-controlled",
      ]);
      const stageFiles = vi.fn();
      const buildRegistry = vi.fn();

      await expect(runEvaluationBatch({
        ...args,
        quantities,
      }, {
        stageFiles,
        buildRegistry,
      })).rejects.toThrow(/quantity|quantities/i);

      expect(stageFiles).not.toHaveBeenCalled();
      expect(buildRegistry).not.toHaveBeenCalled();
    },
  );

  it("cannot invoke the OSH Cut adapter when package metadata is absent", async () => {
    const quote = vi.fn<VendorAdapter["quote"]>();
    const validArgs = parseSmokeArgs([
      "--vendor",
      "oshcut",
      "--cad",
      "./part.step",
      "--oshcut-process",
      "laser_cutting",
      "--oshcut-material",
      "aluminum_6061_t6",
      "--oshcut-geometry",
      "flat_sheet",
      "--confirm-non-export-controlled",
    ]);

    await expect(runEvaluationBatch({
      ...validArgs,
      oshcutPackage: null,
    }, {
      buildRegistry: () => ({ oshcut: { quote } }),
      makeVendorConfig: () => ({} as WorkerConfig),
    })).rejects.toThrow(/adapter invocation denied/i);

    expect(quote).not.toHaveBeenCalled();
  });

  it("passes explicit exact OSH Cut metadata to the adapter input", async () => {
    const args = parseSmokeArgs([
      "--vendor",
      "oshcut",
      "--cad",
      "./part.step",
      "--oshcut-process",
      "laser_cutting",
      "--oshcut-material",
      "aluminum_6061_t6",
      "--oshcut-geometry",
      "flat_sheet",
      "--confirm-non-export-controlled",
    ]);
    const quote = vi.fn<VendorAdapter["quote"]>().mockResolvedValue({
      vendor: "oshcut",
      status: "manual_followup",
      totalPriceUsd: null,
      unitPriceUsd: null,
      leadTimeBusinessDays: null,
      quoteUrl: null,
      rawPayload: {},
      artifacts: [],
    });

    const rows = await runEvaluationBatch(args, {
      buildRegistry: () => ({ oshcut: { quote } }),
      makeVendorConfig: () => ({} as WorkerConfig),
      prepareConfig: async (config) => config,
      stageFiles: async () => ({
        authorization: {
          nonExportControlled: true,
          cadFileSha256: "a".repeat(64),
          drawingFileSha256: null,
        },
        cadPath: "/private/staged/cad.step",
        drawingPath: null,
        cleanup: vi.fn(),
      }),
    });

    expect(rows).toHaveLength(1);
    expect(quote).toHaveBeenCalledOnce();
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({
      executionContext: "live_evaluation",
      requirement: expect.objectContaining({
        material: "Aluminum 6061-T6",
        spec_snapshot: {
          process: "laser_cutting",
          geometryFamily: "flat_sheet",
        },
      }),
    }));
  });

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
