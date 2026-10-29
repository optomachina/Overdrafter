// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FabworksAdapter } from "../adapters/fabworks";
import { buildLiveEvaluationAdapterRegistry, OFFLINE_EVALUATION_PORTAL_VENDORS } from "../adapters/index";
import type { VendorAdapter } from "../adapters/base";
import type { SendCutSendEvaluationManifest } from "../adapters/sendcutsend";
import {
  authorizeLiveEvaluationInput,
  sha256File,
  stageLiveEvaluationFiles,
} from "../liveEvaluationFiles";
import type { VendorQuoteAdapterOffer, WorkerConfig } from "../types";
import { VendorAutomationError } from "../types";
import { ProviderKillSwitchError } from "../providerKillSwitch";
import { PROVIDER_KILL_SWITCH_STATE_SCHEMA } from "../providerKillSwitch";
import { assertOperatorProvidersEnabled, guardOperatorQuote } from "./operatorKillSwitchGate";
import {
  buildErrorRow,
  formatRow,
  loadProviderPortalApproval,
  loadSendCutSendEvaluationManifest,
  parseQuantities,
  parseSmokeArgs,
  runEvaluationBatch,
  runQuote,
  safeTopLevelEvaluationError,
  writeEvaluationStartupSummary,
} from "./vendorWorkflowSmoke";

vi.mock("./operatorKillSwitchGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./operatorKillSwitchGate")>()),
  assertOperatorProvidersEnabled: vi.fn(async () => undefined),
  guardOperatorQuote: vi.fn((_provider: string, quote: unknown) => quote),
}));

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

async function providerApprovalFixture(options: {
  providerKey?: "quickparts" | "oshcut";
  allowedOrigins?: string[];
  cadPath?: string;
  drawingPath?: string | null;
  requestedQuantities?: number[];
} = {}) {
  const createdTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "provider-approval-test-"));
  tempDirs.push(createdTempDir);
  const tempDir = await fs.realpath(createdTempDir);
  const approvalPath = path.join(tempDir, "quickparts-approval.json");
  const descriptor = {
    schemaVersion: "provider-portal-approval.v1",
    providerKey: options.providerKey ?? "quickparts",
    accountMode: "isolated_authenticated_session",
    allowedOrigins: options.allowedOrigins
      ?? ["https://quickparts.com", "https://quickquote.quickparts.com"],
    intendedAction: "quote_only",
    artifactScope: ["cad_upload", "scrubbed_local_evidence"],
    cadPath: options.cadPath ?? path.resolve("./part.step"),
    drawingPath: options.drawingPath ?? null,
    requestedQuantities: options.requestedQuantities ?? [1],
    cadFileSha256: "a".repeat(64),
    drawingFileSha256: null,
  } as const;
  await fs.writeFile(approvalPath, JSON.stringify(descriptor), { mode: 0o600 });
  return {
    approvalPath,
    descriptor,
    approvalSha256: await sha256File(approvalPath),
  };
}

describe("vendorWorkflowSmoke argument parsing", () => {
  it("requires the approval file and its reviewed digest as one CLI pair", () => {
    expect(() => parseSmokeArgs([
      "--vendor", "quickparts", "--cad", "./part.step",
      "--approval-file", "./approval.json",
    ])).toThrow(/requires both --approval-file and --approval-file-sha256/i);
    expect(() => parseSmokeArgs([
      "--vendor", "quickparts", "--cad", "./part.step",
      "--approval-file-sha256", "a".repeat(64),
    ])).toThrow(/requires both --approval-file and --approval-file-sha256/i);
  });

  it("verifies exact approval bytes before strict parsing", async () => {
    const fixture = await providerApprovalFixture();
    const args = parseSmokeArgs([
      "--vendor", "quickparts", "--cad", "./part.step",
      "--approval-file", fixture.approvalPath,
      "--approval-file-sha256", fixture.approvalSha256,
    ]);

    await expect(loadProviderPortalApproval(args)).resolves.toEqual(fixture.descriptor);

    await fs.writeFile(fixture.approvalPath, JSON.stringify({
      ...fixture.descriptor,
      accountMode: "changed-after-review",
    }));
    await expect(loadProviderPortalApproval(args)).rejects.toThrow(/approval file or digest is invalid/i);
  });

  it("rejects missing, wrong-digest, and symlinked portal approvals before provider work", async () => {
    const fixture = await providerApprovalFixture();
    const baseArgs = parseSmokeArgs([
      "--vendor", "quickparts", "--cad", "./part.step",
    ]);
    await expect(loadProviderPortalApproval(baseArgs)).rejects.toThrow(/requires --approval-file/i);

    await expect(loadProviderPortalApproval({
      ...baseArgs,
      approvalFilePath: fixture.approvalPath,
      approvalFileSha256: "f".repeat(64),
    })).rejects.toThrow(/approval file or digest is invalid/i);

    const approvalLink = path.join(path.dirname(fixture.approvalPath), "approval-link.json");
    await fs.symlink(fixture.approvalPath, approvalLink);
    await expect(loadProviderPortalApproval({
      ...baseArgs,
      approvalFilePath: approvalLink,
      approvalFileSha256: fixture.approvalSha256,
    })).rejects.toThrow(/approval file or digest is invalid/i);
  });

  it.each([
    ["CAD path", { cadPath: path.resolve("./same-bytes-other-name.step") }],
    ["drawing path", { drawingPath: path.resolve("./unexpected-drawing.pdf") }],
    ["quantities", { requestedQuantities: [5, 1] }],
  ])("rejects a reviewed approval with mismatched %s", async (_label, override) => {
    const fixture = await providerApprovalFixture(override);
    const args = parseSmokeArgs([
      "--vendor", "quickparts", "--cad", "./part.step",
      "--approval-file", fixture.approvalPath,
      "--approval-file-sha256", fixture.approvalSha256,
    ]);

    await expect(loadProviderPortalApproval(args)).rejects.toThrow(
      /approval file or digest is invalid/i,
    );
  });

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
    const notice = vi.spyOn(console, "info").mockImplementation(() => undefined);
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
      "--sendcutsend-manifest",
      "./reviewed.json",
    ]);

    expect(notice).toHaveBeenCalledWith(expect.stringMatching(/Skipping oshcut:.*disabled/));
    expect(args.vendors).toEqual([
      "xometry",
      "fictiv",
      "sendcutsend",
      "fabworks",
      "ponoko",
      "quickparts",
      "rapiddirect",
      "geomiq",
      "weerg",
      "protolabsnetwork",
    ]);
  });

  it("runs RMFG only when named, with the stated sheet stock (OVD-1057)", () => {
    const args = parseSmokeArgs([
      "--vendor", "rmfg", "--cad", "./plate.step", "--rmfg-grade", "6061-T6", "--rmfg-thickness-in", "0.125",
    ]);
    expect(args.vendors).toEqual(["rmfg"]);
    expect(args.rmfgStock).toEqual({ grade: "6061-T6", thicknessIn: 0.125 });
    expect(() => parseSmokeArgs(["--vendor", "rmfg", "--cad", "./plate.step"]))
      .toThrow(/requires the stated sheet stock/);
    for (const grade of ["6061", "Aluminum", "304", "6061-T6 aluminum"]) {
      expect(() => parseSmokeArgs(["--vendor", "rmfg", "--cad", "./plate.step", "--rmfg-grade", grade,
        "--rmfg-thickness-in", "0.125"])).toThrow(/requires the stated sheet stock/);
    }
    for (const thickness of ["0", "3.175", "1/8", "0.125in"]) {
      expect(() => parseSmokeArgs(["--vendor", "rmfg", "--cad", "./plate.step", "--rmfg-grade", "6061-T6",
        "--rmfg-thickness-in", thickness])).toThrow(/requires the stated sheet stock/);
    }
    expect(() => parseSmokeArgs(["--vendor", "xometry", "--cad", "./plate.step", "--rmfg-grade", "6061-T6"]))
      .toThrow(/only be supplied when --vendor includes rmfg/);
  });

  it.each(["1", "01", ".125", "0.125", "00.125", " 0.125 "])("accepts decimal RMFG thickness %s", (thickness) => {
    const args = parseSmokeArgs(["--vendor", "rmfg", "--cad", "./plate.step", "--rmfg-grade", "6061-T6",
      "--rmfg-thickness-in", thickness]);
    expect(args.rmfgStock?.thicknessIn).toBe(Number(thickness));
  });

  it.each([".", "1.", "+.125", "1e-1", "0x1", "0.1.25"])("rejects nondecimal RMFG thickness %s", (thickness) => {
    expect(() => parseSmokeArgs(["--vendor", "rmfg", "--cad", "./plate.step", "--rmfg-grade", "6061-T6",
      "--rmfg-thickness-in", thickness])).toThrow(/requires the stated sheet stock/);
  });

  it("rejects a long invalid RMFG thickness without quadratic backtracking", () => {
    const thickness = `${"0".repeat(60_000)}!`;
    const started = performance.now();
    expect(() => parseSmokeArgs(["--vendor", "rmfg", "--cad", "./plate.step", "--rmfg-grade", "6061-T6",
      "--rmfg-thickness-in", thickness])).toThrow(/requires the stated sheet stock/);
    // Generous for a linear scan; the overlapping digit repetitions took seconds.
    expect(performance.now() - started).toBeLessThan(500);
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
    ]);

    expect(args.vendors).toEqual(["fabworks"]);
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

describe("parseSmokeArgs RMFG quantities", () => {
  it.each([["1,5"], ["5"]])("rejects RMFG quantity list %s at parse time before staging (OVD-1057)", (list) => {
    expect(() => parseSmokeArgs(["--vendor", "rmfg", "--cad", "./plate.step", "--quantities", list,
      "--rmfg-grade", "6061-T6", "--rmfg-thickness-in", "0.125", "--confirm-non-export-controlled"]))
      .toThrow(/RMFG quotes only quantity 1/);
  });
});

describe("runQuote", () => {
  it("refuses RMFG at any quantity but 1 before constructing a registry (OVD-1057)", async () => {
    const args = {
      ...parseSmokeArgs(["--vendor", "rmfg", "--cad", "./plate.step", "--quantities", "1",
        "--rmfg-grade", "6061-T6", "--rmfg-thickness-in", "0.125", "--confirm-non-export-controlled"]),
      quantities: [5],
    };
    const buildRegistry = vi.fn(() => ({}));
    await expect(runQuote({} as WorkerConfig, args, "rmfg", 5, {
      authorization: { nonExportControlled: true, cadFileSha256: "a".repeat(64), drawingFileSha256: null },
      cadPath: "/private/staged/cad.step", drawingPath: null, cleanup: vi.fn(),
    }, buildRegistry)).rejects.toThrow(/only quantity 1/);
    expect(buildRegistry).not.toHaveBeenCalled();
  });

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
    )).rejects.toThrow(/OSH Cut portal automation is disabled.*OVD-1022/);

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
    expect(row.offers).toEqual([]);
  });

  it("drops arbitrary nested payloads and redacts artifacts without mutating internal errors", () => {
    const selectedPath = "/opt/Acme Defense/Project X/secret.step";
    const stagedPath = "/private/staged/Acme Defense/secret.step";
    const manifestPath = "/mnt/reviews/Acme Defense/reviewed.json";
    const runtimeRoot = "relative runtime";
    const runtimePath = path.join(runtimeRoot, "evidence/login.html");
    const resolvedRuntimePath = path.resolve(runtimePath);
    const oversizedKey = "k".repeat(1_200);
    const artifact = {
      kind: "html_snapshot" as const,
      label: `evidence from ${runtimePath}`,
      localPath: resolvedRuntimePath,
      contentType: "text/html",
    };
    const error = new VendorAutomationError(
      `${"x".repeat(1_200)} failed at ${selectedPath}`,
      "unexpected_ui_state",
      {
        paths: { selectedPath, stagedPath, manifestPath, runtimePath, resolvedRuntimePath },
        deep: { one: { two: { three: { four: selectedPath } } } },
        keyed: {
          [selectedPath]: "selected-value",
          [stagedPath]: "staged-value",
          [oversizedKey]: "oversized-key-value",
        },
        entries: Object.fromEntries(Array.from({ length: 110 }, (_, index) => [
          `entry-${index}`,
          runtimePath,
        ])),
        list: Array.from({ length: 60 }, () => stagedPath),
      },
      [artifact],
    );

    const row = buildErrorRow(
      "sendcutsend",
      1,
      "2026-08-27T00:00:00.000Z",
      Date.now(),
      error,
      [selectedPath, stagedPath, manifestPath, runtimeRoot],
    );
    const serialized = JSON.stringify(row);
    expect(row.error?.length).toBeLessThanOrEqual(1_000);
    expect(row.errorPayload).toEqual({});
    expect(serialized).not.toContain("Acme Defense");
    expect(serialized).not.toContain(runtimeRoot);
    expect(serialized).not.toContain(path.resolve(runtimeRoot));
    expect(serialized).not.toContain(oversizedKey);
    expect(row.artifacts[0]?.localPath).toBe("<redacted-artifact-path>");
    expect(error.artifacts[0]).toEqual(artifact);
  });

  it("bounds and redacts top-level CLI failures", () => {
    const selectedPath = "/opt/Acme Defense/Project X/secret.step";
    const manifestPath = "/mnt/reviews/Acme Defense/reviewed.json";
    const runtimeRoot = "relative runtime";
    const runtimePath = path.join(runtimeRoot, "private/session.json");
    const resolvedRuntimePath = path.resolve(runtimePath);
    const safeError = safeTopLevelEvaluationError(
      new Error(
        `${"x".repeat(1_200)} ${selectedPath} ${manifestPath} ${runtimePath} ${resolvedRuntimePath}`,
      ),
      [
        "--cad", selectedPath,
        "--sendcutsend-manifest", manifestPath,
      ],
      { WORKER_TEMP_DIR: runtimeRoot },
    );

    expect(safeError.length).toBeLessThanOrEqual(1_000);
    expect(safeError).not.toContain("Acme Defense");
    expect(safeError).not.toContain(runtimeRoot);
    expect(safeError).not.toContain(path.resolve(runtimeRoot));
  });
});

describe("evaluation startup output", () => {
  it("reports selected inputs without serializing their paths", () => {
    const selectedPath = "/opt/Acme Defense/Project X/part.step";
    const drawingPath = "/mnt/reviews/Acme Defense/part.pdf";
    const args = parseSmokeArgs([
      "--vendor", "xometry",
      "--cad", selectedPath,
      "--drawing", drawingPath,
      "--confirm-non-export-controlled",
    ]);
    const lines: string[] = [];

    writeEvaluationStartupSummary(args, (line) => lines.push(line));

    const output = lines.join("\n");
    expect(output).toContain("CAD: selected");
    expect(output).toContain("Drawing: selected");
    expect(output).not.toContain(selectedPath);
    expect(output).not.toContain(drawingPath);
  });
});

describe("runQuote", () => {
  it("preserves normalized offers while bounding nested public result payloads", async () => {
    const selectedPath = "/opt/Acme Defense/Project X/part.step";
    const stagedPath = "/private/staged/Acme Defense/part.step";
    const runtimeRoot = "relative runtime";
    const runtimePath = path.join(runtimeRoot, "evidence/result.html");
    const resolvedRuntimePath = path.resolve(runtimePath);
    const args = parseSmokeArgs([
      "--vendor", "xometry", "--cad", selectedPath,
      "--confirm-non-export-controlled",
    ]);
    const offers: VendorQuoteAdapterOffer[] = [{
      providerOptionId: "option-1",
      providerLabel: `Standard from ${selectedPath}`,
      quoteRef: runtimePath,
      quoteUrl: "https://www.xometry.com/quoting/quote/Q01-FIXTURE",
      unitPriceUsd: 12,
      totalPriceUsd: 12,
      leadTimeBusinessDays: 5,
      shipReceiveBy: null,
      tier: null,
      sourcing: null,
      geographicOrigin: "unknown",
      sortRank: 0,
      provenance: {
        containerSelector: `[data-source='${stagedPath}']`,
        providerOptionIdSource: "attribute",
        priceSource: "selector",
        leadTimeSource: "selector",
        geographicOriginSource: "none",
      },
      rawPayload: {
        source: "fixture",
        token: "secret-token-value",
        customerId: "customer-8472",
        nested: { selectedPath, stagedPath, runtimePath, resolvedRuntimePath },
        long: "y".repeat(1_200),
        deep: { one: { two: { three: { four: runtimePath } } } },
      },
    }];
    const originalOffers = structuredClone(offers);
    const quote = vi.fn<VendorAdapter["quote"]>().mockResolvedValue({
      vendor: "xometry",
      status: "instant_quote_received",
      totalPriceUsd: 12,
      unitPriceUsd: 12,
      leadTimeBusinessDays: 5,
      quoteUrl: "https://www.xometry.com/quoting/quote/Q01-FIXTURE",
      offers,
      rawPayload: {
        nested: { selectedPath, stagedPath, runtimePath, resolvedRuntimePath },
        long: "x".repeat(1_200),
        deep: { one: { two: { three: { four: runtimePath } } } },
      },
      artifacts: [{
        kind: "html_snapshot",
        label: `result for customer@example.com token=secret-token-value quote:Q-778 at ${runtimePath}`,
        localPath: runtimePath,
        contentType: "text/html",
      }],
    });

    const row = await runQuote(
      { workerTempDir: runtimeRoot } as WorkerConfig,
      args,
      "xometry",
      1,
      {
        authorization: {
          nonExportControlled: true,
          cadFileSha256: "a".repeat(64),
          drawingFileSha256: null,
        },
        cadPath: stagedPath,
        drawingPath: null,
        cleanup: vi.fn(),
      },
      () => ({ xometry: { quote } }),
    );
    const serialized = JSON.stringify(row);

    expect(row.offers).toHaveLength(1);
    expect(row.offers[0]).toMatchObject({
      providerOptionId: "option-1",
      unitPriceUsd: 12,
      totalPriceUsd: 12,
    });
    expect(row.offers[0]?.rawPayload).toEqual({
      normalizationRevision: "provider-live-evaluation-offer.v1",
      sourcePayloadRetained: false,
    });
    expect(offers).toEqual(originalOffers);
    expect(row.rawPayload).toEqual({});
    expect(serialized).not.toContain("Acme Defense");
    expect(serialized).not.toContain("secret-token-value");
    expect(serialized).not.toContain("customer@example.com");
    expect(serialized).not.toContain("customer-8472");
    expect(serialized).not.toContain("Q-778");
    expect(serialized).not.toContain(runtimeRoot);
    expect(serialized).not.toContain(path.resolve(runtimeRoot));
    expect(row.evidence).toMatchObject({
      schemaVersion: "provider-live-evaluation-evidence.v1",
      providerKey: "xometry",
      manifestRevision: "provider-manifest.v1",
      envelopeRevision: "provider-capability-envelope.v1",
      adapterRevision: "unknown",
      cadFileSha256: "a".repeat(64),
      drawingFileSha256: null,
      accountMode: "isolated_authenticated_session",
      terminalState: "instant_quote_received",
      persistence: {
        localOnly: true,
        customerOfferPersistence: false,
        providerAdmission: false,
      },
    });
    expect(row.evidence.normalizedOffers[0]).toMatchObject({
      providerOptionId: "option-1",
      quantity: 1,
      validUntil: null,
      validitySource: null,
      geographicOrigin: "unknown",
      artifactRefs: [expect.stringMatching(/^html_snapshot:1:/)],
    });
    expect(Date.parse(row.evidence.completedAt)).not.toBeNaN();
  });

  it("withholds an adapter result that fails the provider-neutral offer contract", async () => {
    const args = parseSmokeArgs([
      "--vendor", "xometry", "--cad", "/selected/part.step",
      "--confirm-non-export-controlled",
    ]);
    const quote = vi.fn<VendorAdapter["quote"]>().mockResolvedValue({
      vendor: "xometry",
      status: "instant_quote_received",
      totalPriceUsd: 12,
      unitPriceUsd: 12,
      leadTimeBusinessDays: 5,
      quoteUrl: "https://www.xometry.com/quoting/quote/Q01-FIXTURE",
      offers: [{
        providerOptionId: "unsafe-option",
        providerLabel: "Unsafe",
        quoteRef: "Q01-FIXTURE",
        quoteUrl: "https://www.xometry.com/quoting/quote/Q01-FIXTURE",
        quantity: 1,
        unitPriceUsd: 12,
        totalPriceUsd: 12,
        leadTimeBusinessDays: 5,
        shipReceiveBy: null,
        tier: null,
        sourcing: null,
        geographicOrigin: "unknown",
        sortRank: 0,
        provenance: {
          containerSelector: "[data-option-id='unsafe-option']",
          providerOptionIdSource: "attribute",
          priceSource: "body_text",
          leadTimeSource: "body_text",
          geographicOriginSource: "none",
        },
        rawPayload: {},
      }],
      rawPayload: {},
      artifacts: [],
    });

    const row = await runQuote(
      { workerTempDir: "/private/runtime" } as WorkerConfig,
      args,
      "xometry",
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
      () => ({ xometry: { quote } }),
    );

    expect(row.offers).toEqual([]);
    expect(row.totalPriceUsd).toBeNull();
    expect(row.error).toContain("Provider adapter contract failed");
    expect(row.error).toContain("offer_price_unanchored");
  });

  // Standing rule (2026-10-15): every run that uploaded a test part records
  // whether the supplier cart was cleaned, without changing the row outcome.
  describe("supplier cart cleanup record", () => {
    const staged = () => ({
      authorization: { nonExportControlled: true, cadFileSha256: "a".repeat(64), drawingFileSha256: null },
      cadPath: "/private/staged/part.step",
      drawingPath: null,
      cleanup: vi.fn(),
    });
    const smokeArgs = () => parseSmokeArgs(["--vendor", "xometry", "--cad", "./part.step", "--confirm-non-export-controlled"]);

    it("records the removal reported with a successful quote", async () => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const quote = vi.fn<VendorAdapter["quote"]>().mockResolvedValue({
        vendor: "xometry", status: "manual_vendor_followup", unitPriceUsd: null, totalPriceUsd: null,
        leadTimeBusinessDays: null, quoteUrl: null, offers: [], dfmIssues: [], notes: [], artifacts: [],
        rawPayload: { providerMutationPossible: true, cartCleanup: { status: "removed", removed: 1, remaining: 0, reason: null } },
      });
      const row = await runQuote({ workerTempDir: "/private/runtime" } as WorkerConfig, smokeArgs(), "xometry", 1, staged(),
        () => ({ xometry: { quote } }));
      expect(row.status).toBe("manual_vendor_followup");
      expect(row.supplierCartCleanup).toMatchObject({ status: "removed", manualRemovalRequired: false });
    });

    it("records the cleanup on a failure after upload and keeps the failure", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const error = new VendorAutomationError("price pending", "selector_failure", {
        terminalState: "selector_drift", reason: "oshcut_price_pending", providerMutationPossible: true,
        cartCleanup: { status: "removed", removed: 1, remaining: 0, reason: null },
      });
      const quote = vi.fn<VendorAdapter["quote"]>().mockRejectedValue(error);
      const row = await runQuote({ workerTempDir: "/private/runtime" } as WorkerConfig, smokeArgs(), "xometry", 1, staged(),
        () => ({ xometry: { quote } }));
      expect(row.errorCode).toBe("selector_failure");
      expect(row.supplierCartCleanup).toMatchObject({ status: "removed", manualRemovalRequired: false });
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("liveHarnessSupplierCleanup"));
    });

    it.each(["xometry", "fictiv"] as const)("warns before rethrowing a %s kill-switch interruption after upload", async (vendor) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const actual = await vi.importActual<typeof import("./operatorKillSwitchGate")>("./operatorKillSwitchGate");
      vi.mocked(guardOperatorQuote).mockImplementationOnce(actual.guardOperatorQuote);
      let engaged = false;
      const killSwitchReader = vi.fn(async (provider: string) => ({
        schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA, provider, engaged, globalEngaged: false,
      }));
      const upload = vi.fn(async () => { engaged = true; });
      const configure = vi.fn();
      const quote = vi.fn<VendorAdapter["quote"]>(async (input) => {
        await input.providerKillSwitchCheckpoint?.("before_upload");
        await upload();
        await input.providerKillSwitchCheckpoint?.("before_configure");
        configure();
        throw new Error("unreachable");
      });
      const args = parseSmokeArgs(["--vendor", vendor, "--cad", "./part.step", "--confirm-non-export-controlled"]);

      await expect(runQuote(
        { workerTempDir: "/private/runtime" } as WorkerConfig, args, vendor, 1, staged(),
        () => ({ [vendor]: { quote } }), null, null, killSwitchReader,
      )).rejects.toMatchObject({
        reasonCode: "provider_kill_switch_engaged", provider: vendor, checkpoint: "before_configure",
      });
      expect(upload).toHaveBeenCalledOnce();
      expect(configure).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledOnce();
      expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({
        source: "liveHarnessSupplierCleanup", vendor, quantity: 1,
        status: "unknown", manualRemovalRequired: true,
        action: `Review the ${vendor} cart/quote manually and remove any uploaded test part.`,
      });
    });

    it("warns for manual removal when the cleanup failed, without changing the outcome", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const error = new VendorAutomationError("price pending", "selector_failure", {
        terminalState: "selector_drift", reason: "oshcut_price_pending", providerMutationPossible: true,
        cartCleanup: { status: "failed", removed: 0, remaining: null, reason: "CleanupTimeout" },
      });
      const quote = vi.fn<VendorAdapter["quote"]>().mockRejectedValue(error);
      const row = await runQuote({ workerTempDir: "/private/runtime" } as WorkerConfig, smokeArgs(), "xometry", 1, staged(),
        () => ({ xometry: { quote } }));
      expect(row.errorCode).toBe("selector_failure");
      expect(row.errorPayload).toMatchObject({ reason: "oshcut_price_pending" });
      expect(row.supplierCartCleanup).toMatchObject({ status: "failed", manualRemovalRequired: true });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("\"source\":\"liveHarnessSupplierCleanup\""));
      expect(formatRow(row)).toMatch(/ERROR selector_failure .* \| SUPPLIER CART CLEANUP NEEDED \(failed\)/);
    });
  });

  it("redacts relative runtime roots from failures and artifacts through runQuote", async () => {
    const runtimeRoot = "relative runtime";
    const relativeArtifactPath = path.join(runtimeRoot, "evidence/failure.html");
    const resolvedArtifactPath = path.resolve(relativeArtifactPath);
    const artifact = {
      kind: "html_snapshot" as const,
      label: `failure at ${relativeArtifactPath}`,
      localPath: resolvedArtifactPath,
      contentType: "text/html",
    };
    const args = parseSmokeArgs([
      "--vendor", "xometry",
      "--cad", "./part.step",
      "--confirm-non-export-controlled",
    ]);
    const error = new VendorAutomationError(
      `failed at ${relativeArtifactPath} and ${resolvedArtifactPath}`,
      "unexpected_ui_state",
      {
        terminalState: "selector_drift",
        relativeArtifactPath,
        resolvedArtifactPath,
      },
      [artifact],
    );
    const quote = vi.fn<VendorAdapter["quote"]>().mockRejectedValue(error);

    const row = await runQuote(
      { workerTempDir: runtimeRoot } as WorkerConfig,
      args,
      "xometry",
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
      () => ({ xometry: { quote } }),
    );
    const serialized = JSON.stringify(row);

    expect(serialized).not.toContain(runtimeRoot);
    expect(serialized).not.toContain(path.resolve(runtimeRoot));
    expect(row.artifacts[0]?.localPath).toBe("<redacted-artifact-path>");
    expect(error.artifacts[0]).toEqual(artifact);
  });

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
      offers: [{
        providerOptionId: "fabworks-standard",
        providerLabel: "Standard",
        quoteRef: "qte_fixture",
        quoteUrl: "https://www.fabworks.com/quotes/qte_fixture",
        quantity: 2,
        unitPriceUsd: 21,
        totalPriceUsd: 42,
        leadTimeBusinessDays: 3,
        shipReceiveBy: null,
        tier: "standard",
        sourcing: null,
        geographicOrigin: "unknown",
        sortRank: 0,
        provenance: {
          containerSelector: "[data-provider-option='standard']",
          providerOptionIdSource: "attribute",
          priceSource: "selector",
          leadTimeSource: "selector",
          geographicOriginSource: "none",
        },
        rawPayload: {},
      }],
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
  it("skips OSH Cut in a programmatic batch before approval validation and runs Quickparts", async () => {
    const fixture = await providerApprovalFixture();
    const args = parseSmokeArgs([
      "--vendor", "quickparts", "--cad", "./part.step",
      "--approval-file", fixture.approvalPath,
      "--approval-file-sha256", fixture.approvalSha256,
      "--confirm-non-export-controlled",
    ]);
    args.vendors.unshift("oshcut");
    const notice = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const quote = vi.fn<VendorAdapter["quote"]>().mockResolvedValue({
      vendor: "quickparts", status: "submitted", totalPriceUsd: null,
      unitPriceUsd: null, leadTimeBusinessDays: null, quoteUrl: null,
      rawPayload: { providerMutationPossible: false }, artifacts: [],
    });
    const makeVendorConfig = vi.fn(() => ({} as WorkerConfig));
    const cleanup = vi.fn();
    const rows = await runEvaluationBatch(args, {
      buildRegistry: () => ({ quickparts: { quote } }),
      makeVendorConfig,
      prepareConfig: async (config) => config,
      stageFiles: async () => ({
        authorization: { nonExportControlled: true, cadFileSha256: "a".repeat(64), drawingFileSha256: null },
        cadPath: "/private/staged/part.step", drawingPath: null, cleanup,
      }),
    });
    expect(rows).toMatchObject([{ vendor: "quickparts", status: "submitted", error: null }]);
    expect(quote).toHaveBeenCalledOnce();
    expect(makeVendorConfig).toHaveBeenCalledOnce();
    expect(makeVendorConfig).toHaveBeenCalledWith("quickparts", expect.any(String));
    expect(cleanup).toHaveBeenCalledOnce();
    expect(args.vendors).toEqual(["oshcut", "quickparts"]);
    expect(notice).toHaveBeenCalledWith(expect.stringMatching(/Skipping oshcut:.*disabled/));
  });

  it("parses a mixed CLI batch without requiring disabled-provider metadata", () => {
    expect(parseSmokeArgs([
      "--vendor", "oshcut,quickparts,weerg", "--cad", "./part.step",
    ]).vendors).toEqual(["quickparts", "weerg"]);
  });

  it("refuses on the kill switch before staging, config, or registry construction", async () => {
    const args = parseSmokeArgs([
      "--vendor", "fictiv", "--cad", "./part.step",
      "--confirm-non-export-controlled",
    ]);
    const stageFiles = vi.fn();
    const makeVendorConfig = vi.fn();
    const buildRegistry = vi.fn();
    vi.mocked(assertOperatorProvidersEnabled).mockRejectedValueOnce(
      new ProviderKillSwitchError("provider_kill_switch_engaged", "fictiv", "before_launch"),
    );

    await expect(runEvaluationBatch(args, { stageFiles, makeVendorConfig, buildRegistry })).rejects.toThrow(
      /fictiv kill switch is engaged/,
    );
    expect(assertOperatorProvidersEnabled).toHaveBeenCalledWith(["fictiv"], undefined);
    expect(stageFiles).not.toHaveBeenCalled();
    expect(makeVendorConfig).not.toHaveBeenCalled();
    expect(buildRegistry).not.toHaveBeenCalled();
  });

  it.each(["quote", "evaluateLocally"] as const)("hands the kill switch checkpoint to %s so a mid run engagement stops the next mutation", async (method) => {
    const args = parseSmokeArgs([
      "--vendor", "xometry", "--cad", "./part.step",
      "--confirm-non-export-controlled",
    ]);
    let reads = 0;
    const killSwitchReader = vi.fn(async (provider: string) => ({
      schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA,
      provider,
      engaged: reads++ >= 1,
      globalEngaged: false,
    }));
    const actual = await vi.importActual<typeof import("./operatorKillSwitchGate")>("./operatorKillSwitchGate");
    vi.mocked(guardOperatorQuote).mockImplementationOnce(actual.guardOperatorQuote as never);
    const mutation = vi.fn();
    const quote = vi.fn<VendorAdapter["quote"]>(async (input) => {
      await input.providerKillSwitchCheckpoint?.("before_upload");
      mutation();
      throw new Error("unreachable");
    });

    await expect(runQuote(
      {} as WorkerConfig,
      args,
      "xometry",
      1,
      {
        authorization: { nonExportControlled: true, cadFileSha256: "a".repeat(64), drawingFileSha256: null },
        cadPath: "/private/staged/part.step",
        drawingPath: null,
        cleanup: vi.fn(),
      },
      () => ({ xometry: { quote, [method]: quote } }),
      null,
      null,
      killSwitchReader,
    )).rejects.toMatchObject({ reasonCode: "provider_kill_switch_engaged", checkpoint: "before_upload" });
    expect(mutation).not.toHaveBeenCalled();
  });

  it("refuses subsequent live evaluateLocally quantities when the switch engages after batch startup", async () => {
    const args = parseSmokeArgs([
      "--vendor", "fictiv", "--cad", "./part.step", "--quantities", "1,2",
      "--confirm-non-export-controlled",
    ]);
    let engaged = false;
    const killSwitchReader = vi.fn(async (provider: string) => ({
      schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA,
      provider,
      engaged,
      globalEngaged: false,
    }));
    const actual = await vi.importActual<typeof import("./operatorKillSwitchGate")>("./operatorKillSwitchGate");
    vi.mocked(guardOperatorQuote).mockImplementationOnce(actual.guardOperatorQuote)
      .mockImplementationOnce(actual.guardOperatorQuote);
    const quote = vi.fn<VendorAdapter["quote"]>();
    const evaluateLocally = vi.fn<VendorAdapter["quote"]>(async () => {
      engaged = true;
      throw new Error("first quantity attempted");
    });
    const cleanup = vi.fn();

    await expect(runEvaluationBatch(args, {
      killSwitchReader,
      stageFiles: async () => ({
        authorization: { nonExportControlled: true, cadFileSha256: "a".repeat(64), drawingFileSha256: null },
        cadPath: "/private/staged/part.step",
        drawingPath: null,
        cleanup,
      }),
      makeVendorConfig: () => ({} as WorkerConfig),
      buildRegistry: () => ({ fictiv: { quote, evaluateLocally } }),
    })).rejects.toMatchObject({ reasonCode: "provider_kill_switch_engaged", checkpoint: "before_launch" });
    expect(evaluateLocally).toHaveBeenCalledTimes(1);
    expect(quote).not.toHaveBeenCalled();
    expect(killSwitchReader).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not read the kill switch per quote for an evaluateLocally that never reaches the provider", async () => {
    const args = parseSmokeArgs([
      "--vendor", "fictiv", "--cad", "./part.step", "--quantities", "1,2",
      "--confirm-non-export-controlled",
    ]);
    const killSwitchReader = vi.fn(async () => { throw new Error("switch unreadable"); });
    const quote = vi.fn<VendorAdapter["quote"]>();
    const evaluateLocally = vi.fn<VendorAdapter["quote"]>(async () => {
      throw new Error("offline preflight attempted");
    });

    await runEvaluationBatch(args, {
      killSwitchReader,
      stageFiles: async () => ({
        authorization: { nonExportControlled: true, cadFileSha256: "a".repeat(64), drawingFileSha256: null },
        cadPath: "/private/staged/part.step",
        drawingPath: null,
        cleanup: vi.fn(),
      }),
      makeVendorConfig: () => ({} as WorkerConfig),
      buildRegistry: () => ({ fictiv: { quote, evaluateLocally, evaluateLocallyReachesProvider: false } }),
    }).catch(() => undefined);

    expect(evaluateLocally).toHaveBeenCalledTimes(2);
    expect(quote).not.toHaveBeenCalled();
    expect(vi.mocked(guardOperatorQuote)).not.toHaveBeenCalled();
  });

  // Runs the batch with the real startup gate and an unreadable kill switch.
  async function runWithUnreadableKillSwitch(vendor: string) {
    const args = parseSmokeArgs([
      "--vendor", vendor, "--cad", "./part.step",
      "--confirm-non-export-controlled",
    ]);
    const actual = await vi.importActual<typeof import("./operatorKillSwitchGate")>("./operatorKillSwitchGate");
    vi.mocked(assertOperatorProvidersEnabled).mockImplementationOnce(actual.assertOperatorProvidersEnabled);
    const killSwitchReader = vi.fn(async () => { throw new Error("switch unreadable"); });
    const stageFiles = vi.fn(async () => { throw new Error("staging reached"); });
    const result = runEvaluationBatch(args, {
      killSwitchReader,
      stageFiles,
      makeVendorConfig: () => ({} as WorkerConfig),
      buildRegistry: () => ({}),
    });
    return { result, killSwitchReader, stageFiles };
  }

  it("gates the Quickparts batch on the kill switch before staging (OVD-1059)", async () => {
    const { result, killSwitchReader, stageFiles } = await runWithUnreadableKillSwitch("quickparts");

    await expect(result)
      .rejects.toMatchObject({ reasonCode: "provider_kill_switch_unavailable", checkpoint: "before_launch" });
    expect(killSwitchReader).toHaveBeenCalledWith("quickparts");
    expect(stageFiles).not.toHaveBeenCalled();
  });

  it("evaluates Quickparts through the production portal definition that reaches the provider", () => {
    const registry = buildLiveEvaluationAdapterRegistry({
      workerMode: "dev", workerLiveAdapters: [], workerTempDir: os.tmpdir(),
    } as unknown as WorkerConfig);
    expect(OFFLINE_EVALUATION_PORTAL_VENDORS.has("quickparts")).toBe(false);
    expect((registry.quickparts as { evaluateLocallyReachesProvider?: boolean }).evaluateLocallyReachesProvider)
      .toBe(true);
  });

  it.each(["weerg", "geomiq", "ponoko", "protolabsnetwork", "rapiddirect"] as const)("does not gate the offline %s batch on the kill switch with the real startup gate", async (vendor) => {
    const { result, killSwitchReader } = await runWithUnreadableKillSwitch(vendor);

    await expect(result).rejects.not.toMatchObject({ reasonCode: "provider_kill_switch_unavailable" });
    expect(killSwitchReader).not.toHaveBeenCalled();
  });

  it("keeps the offline portal vendor set in step with the registry", () => {
    const registry = buildLiveEvaluationAdapterRegistry({
      workerMode: "dev", workerLiveAdapters: [], workerTempDir: os.tmpdir(),
    } as unknown as WorkerConfig);
    const offline = Object.entries(registry)
      .filter(([, adapter]) => adapter && (adapter as { evaluateLocallyReachesProvider?: boolean }).evaluateLocallyReachesProvider === false)
      .map(([vendor]) => vendor).sort();
    expect(offline).toEqual([...OFFLINE_EVALUATION_PORTAL_VENDORS].sort());
  });

  it("does not consult the kill switch for the offline SendCutSend batch", async () => {
    const fixture = await sendCutSendFixture({ quantities: [1] });
    const args = parseSmokeArgs([
      "--vendor", "sendcutsend", "--cad", fixture.cadPath,
      "--sendcutsend-manifest", fixture.manifestPath,
      "--confirm-non-export-controlled",
    ]);
    const killSwitchReader = vi.fn();
    const quote = vi.fn<VendorAdapter["quote"]>();
    const evaluateLocally = vi.fn<VendorAdapter["quote"]>(async () => {
      throw new Error("offline evaluation attempted");
    });

    await runEvaluationBatch(args, {
      killSwitchReader,
      buildRegistry: () => ({ sendcutsend: { quote, evaluateLocally } }),
      makeVendorConfig: () => ({} as WorkerConfig),
    }).catch(() => undefined);

    expect(assertOperatorProvidersEnabled).toHaveBeenLastCalledWith([], killSwitchReader);
    expect(killSwitchReader).not.toHaveBeenCalled();
    expect(evaluateLocally).toHaveBeenCalledTimes(1);
    expect(quote).not.toHaveBeenCalled();
    expect(evaluateLocally.mock.calls[0][0].providerKillSwitchCheckpoint).toBeUndefined();
  });

  it("rejects missing portal approval before staging or registry construction", async () => {
    const args = parseSmokeArgs([
      "--vendor", "quickparts", "--cad", "./part.step",
      "--confirm-non-export-controlled",
    ]);
    const stageFiles = vi.fn();
    const buildRegistry = vi.fn();

    await expect(runEvaluationBatch(args, {
      stageFiles,
      buildRegistry,
    })).rejects.toThrow(/requires --approval-file/i);
    expect(stageFiles).not.toHaveBeenCalled();
    expect(buildRegistry).not.toHaveBeenCalled();
  });

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
    expect(rows.every((row) => row.offers.length === 0)).toBe(true);
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
      })).rejects.toThrow(/OSH Cut portal automation is disabled.*OVD-1022/);

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
    })).rejects.toThrow(/OSH Cut portal automation is disabled.*OVD-1022/);

    expect(quote).not.toHaveBeenCalled();
  });

  it("refuses even explicitly approved OSH Cut metadata before invoking the adapter", async () => {
    const approval = await providerApprovalFixture({
      providerKey: "oshcut",
      allowedOrigins: ["https://app.oshcut.com", "https://www.oshcut.com"],
    });
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
      "--approval-file",
      approval.approvalPath,
      "--approval-file-sha256",
      approval.approvalSha256,
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

    const stageFiles = vi.fn();
    const makeVendorConfig = vi.fn();
    await expect(runEvaluationBatch(args, {
      buildRegistry: () => ({ oshcut: { quote } }),
      makeVendorConfig,
      stageFiles,
    })).rejects.toThrow(/OSH Cut portal automation is disabled.*OVD-1022/);
    expect(quote).not.toHaveBeenCalled();
    expect(stageFiles).not.toHaveBeenCalled();
    expect(makeVendorConfig).not.toHaveBeenCalled();
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

  it("redacts and bounds cleanup failures without masking successful quotes", async () => {
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
    const stagedPath = "/private/staged/cad.step";
    let privateRuntimeDir = "";
    const cleanup = vi.fn().mockImplementation(async () => {
      throw new Error(
        `${"x".repeat(1_200)} cleanup denied at ${args.cadPath} ${stagedPath} ${privateRuntimeDir}`,
      );
    });

    const rows = await runEvaluationBatch(args, {
      buildRegistry: () => ({ xometry: { quote } }),
      makeVendorConfig: (_vendor, runtimeDir) => {
        privateRuntimeDir = runtimeDir;
        return {} as WorkerConfig;
      },
      stageFiles: async () => ({
        authorization: {
          nonExportControlled: true,
          cadFileSha256: "b".repeat(64),
          drawingFileSha256: null,
        },
        cadPath: stagedPath,
        drawingPath: null,
        cleanup,
      }),
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.error === null)).toBe(true);
    expect(rows.every((row) => row.status === "submitted")).toBe(true);
    expect(rows.every((row) => (row.cleanupError?.length ?? 0) <= 1_000)).toBe(true);
    expect(rows.every((row) => !row.cleanupError?.includes(args.cadPath))).toBe(true);
    expect(rows.every((row) => !row.cleanupError?.includes(stagedPath))).toBe(true);
    expect(rows.every((row) => !row.cleanupError?.includes(privateRuntimeDir))).toBe(true);
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
    expect(rows[0]?.artifacts[0]?.localPath).toBe("<redacted-artifact-path>");
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
