// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeLiveEvaluationInput, sha256File } from "../liveEvaluationFiles.js";
import {
  VendorAutomationError,
  type VendorQuoteAdapterInput,
  type VendorQuoteAdapterOutput,
  type WorkerConfig,
} from "../types.js";
import { buildAdapterRegistry, buildLiveEvaluationAdapterRegistry } from "./index.js";
import {
  FABWORKS_ENVELOPE,
  FabworksAdapter,
  evaluateFabworksEligibility,
} from "./fabworks.js";

const tempDirs: string[] = [];

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    workerMode: "live",
    workerLiveAdapters: ["fabworks"],
    vendorStorageStateDir: null,
    vendorStorageStatePaths: {},
    vendorStorageStateJson: {
      fabworks: '{"cookies":[],"origins":[]}',
    },
    ...overrides,
  } as WorkerConfig;
}

function makeInput(overrides: Partial<VendorQuoteAdapterInput> = {}): VendorQuoteAdapterInput {
  return {
    organizationId: "org-1",
    quoteRunId: "run-1",
    requestedQuantity: 2,
    part: {
      id: "part-1",
      job_id: "job-1",
      organization_id: "org-1",
      name: "Laser-cut bracket",
      normalized_key: "laser-cut-bracket",
      cad_file_id: "cad-1",
      drawing_file_id: null,
      quantity: 2,
    },
    cadFile: {
      id: "cad-1",
      job_id: "job-1",
      storage_bucket: "job-files",
      storage_path: "cad/bracket.step",
      original_name: "bracket.step",
      size_bytes: 4096,
      file_kind: "cad",
    },
    drawingFile: null,
    stagedCadFile: {
      originalName: "bracket.step",
      localPath: path.resolve(".tmp/bracket.step"),
      storageBucket: "job-files",
      storagePath: "cad/bracket.step",
    },
    stagedDrawingFile: null,
    requirement: {
      id: "requirement-1",
      part_id: "part-1",
      description: "Bent aluminum bracket",
      part_number: "BRACKET-1",
      revision: "A",
      material: "6061-T6 aluminum",
      finish: null,
      tightest_tolerance_inch: 0.005,
      quantity: 2,
      quote_quantities: [2],
      requested_by_date: null,
      applicable_vendors: ["fabworks"],
      spec_snapshot: {
        process: "sheet metal bending",
        geometryFamily: "bent sheet 3d",
      },
    },
    ...overrides,
  };
}

function liveOffer(
  overrides: Partial<VendorQuoteAdapterOutput> = {},
): VendorQuoteAdapterOutput {
  return {
    vendor: "fabworks",
    status: "instant_quote_received",
    unitPriceUsd: 25,
    totalPriceUsd: 50,
    leadTimeBusinessDays: 3,
    quoteUrl: "https://www.fabworks.com/quotes/qte_test",
    dfmIssues: [],
    notes: ["Provider price captured from a declared fixture."],
    artifacts: [],
    rawPayload: {
      source: "fabworks-live-adapter",
      automationVersion: "portal-workflow-v1",
      detectedFlow: "instant_quote",
    },
    ...overrides,
  };
}

async function authorizeInput(
  input: VendorQuoteAdapterInput,
  cadBytes: string | Buffer = "authorized-fabworks-cad",
) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabworks-adapter-test-"));
  tempDirs.push(tempDir);
  const cadPath = path.join(tempDir, input.stagedCadFile?.originalName ?? "bracket.step");
  await fs.writeFile(cadPath, cadBytes);
  const cadFileSha256 = await sha256File(cadPath);
  const stagedCadFile = {
    ...input.stagedCadFile!,
    localPath: cadPath,
    trustedContentSha256: cadFileSha256,
  };
  const authorized = await authorizeLiveEvaluationInput({
    ...input,
    stagedCadFile,
    liveEvaluationAuthorization: {
      nonExportControlled: true,
      cadFileSha256,
      drawingFileSha256: null,
    },
  });
  if (!authorized) {
    throw new Error("Fabworks test input was not authorized.");
  }
  return authorized;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })),
  );
});

describe("Fabworks provider envelope", () => {
  it("keeps the process-specific envelope versioned and first-party evidence-backed", () => {
    expect(FABWORKS_ENVELOPE).toMatchObject({
      schemaVersion: "provider-envelope.v1",
      revision: "fabworks-sheet-tube-envelope.2026-08-26.v1",
      compatibilityMatrix: expect.arrayContaining([
        expect.objectContaining({
          process: "sheet_metal_laser_cutting",
          geometryFamily: "flat_sheet_2d",
          fileExtensions: ["dxf", "step", "stp"],
        }),
        expect.objectContaining({
          process: "sheet_metal_bending",
          geometryFamily: "bent_sheet_3d",
          fileExtensions: ["step", "stp"],
        }),
        expect.objectContaining({
          process: "tube_laser_cutting",
          geometryFamily: "tube_3d",
          fileExtensions: ["step", "stp"],
        }),
      ]),
      files: {
        maxBytes: 24_000_000,
      },
      quantity: {
        minimum: 1,
        maximum: null,
      },
      productionControls: {
        providerAdmission: "required_unavailable",
        actionTimeDisclosureAuthorization: "required_unavailable",
        immediatePreflight: "required_unavailable",
        sessionIsolation: "one_browser_context_per_attempt",
        intent: "quote_only",
        orderActions: "prohibited",
      },
    });
    expect(FABWORKS_ENVELOPE.evidence).not.toHaveLength(0);
    for (const evidence of FABWORKS_ENVELOPE.evidence) {
      expect(evidence.url).toMatch(/^https:\/\/(?:www\.)?fabworks\.com\//);
    }
  });

  it.each([
    {
      process: "laser cutting",
      geometryFamily: null,
      fileName: "flat-part.dxf",
      material: "5052-H32 aluminum",
      expectedGeometry: "flat_sheet_2d",
    },
    {
      process: "sheet metal bending",
      geometryFamily: "bent sheet",
      fileName: "bent-part.step",
      material: "6061-T6 aluminum",
      expectedGeometry: "bent_sheet_3d",
    },
    {
      process: "tube laser cutting",
      geometryFamily: "square tube",
      fileName: "tube.stp",
      material: "A513 steel",
      expectedGeometry: "tube_3d",
    },
  ])("admits evidenced $process packages", (fixture) => {
    expect(
      evaluateFabworksEligibility({
        ...fixture,
        fileSizeBytes: 4096,
        quantity: 1,
        accountAvailable: true,
      }),
    ).toMatchObject({
      state: "eligible",
      reason: "package_within_envelope",
      geometryFamily: fixture.expectedGeometry,
    });
  });

  it("fails CNC milling closed before considering otherwise supported 6061 and STEP inputs", () => {
    expect(
      evaluateFabworksEligibility({
        process: "CNC milling",
        geometryFamily: "bent sheet",
        fileName: "bracket.step",
        fileSizeBytes: 4096,
        material: "6061-T6 aluminum",
        quantity: 2,
        accountAvailable: true,
      }),
    ).toMatchObject({
      state: "unsupported",
      reason: "cnc_milling_not_certified",
    });
  });

  it.each([
    ["DXF tube", "tube laser cutting", "square tube", "tube.dxf", "A513 steel"],
    ["DXF bent sheet", "sheet metal bending", "bent sheet", "bracket.dxf", "6061-T6 aluminum"],
    ["G90 tube", "tube laser cutting", "round tube", "tube.step", "G90 galvanized steel"],
    ["A513 bent sheet", "sheet metal bending", "bent sheet", "bracket.step", "A513 steel"],
  ])("rejects the unsupported %s matrix combination", (_label, process, geometryFamily, fileName, material) => {
    expect(evaluateFabworksEligibility({
      process,
      geometryFamily,
      fileName,
      fileSizeBytes: 4096,
      material,
      quantity: 2,
      accountAvailable: true,
    })).toMatchObject({
      state: "unsupported",
      reason: "combination_outside_envelope",
    });
  });

  it.each([
    ["unsupported", "file_format_outside_envelope", { fileName: "part.iges" }],
    ["unsupported", "file_size_outside_envelope", { fileSizeBytes: 24_000_001 }],
    ["unsupported", "material_outside_envelope", { material: "titanium grade 5" }],
    ["unsupported", "quantity_outside_envelope", { quantity: 0 }],
    ["unavailable", "file_size_evidence_missing", { fileSizeBytes: null }],
    ["unavailable", "authenticated_session_unavailable", { accountAvailable: false }],
    ["manual_follow_up", "geometry_requires_review", { geometryFamily: null }],
    ["manual_follow_up", "material_grade_requires_review", { material: "aluminum" }],
  ] as const)("returns %s for %s", (state, reason, overrides) => {
    expect(
      evaluateFabworksEligibility({
        process: "sheet metal bending",
        geometryFamily: "bent sheet",
        fileName: "bracket.step",
        fileSizeBytes: 4096,
        material: "6061-T6 aluminum",
        quantity: 2,
        accountAvailable: true,
        ...overrides,
      }),
    ).toMatchObject({ state, reason });
  });
});

describe("FabworksAdapter", () => {
  it("is wired through both common provider-neutral registries", () => {
    expect(buildAdapterRegistry(makeConfig()).fabworks).toBeInstanceOf(FabworksAdapter);
    expect(buildLiveEvaluationAdapterRegistry(makeConfig()).fabworks).toBeDefined();
  });

  it("returns unsupported guidance and makes zero delegate calls for CNC milling", async () => {
    const quote = vi.fn();
    const adapter = new FabworksAdapter(makeConfig(), { quote });
    const input = makeInput({
      requirement: {
        ...makeInput().requirement,
        spec_snapshot: {
          process: "CNC milling",
          geometryFamily: "bent sheet",
        },
      },
    });

    const result = await adapter.quote(input);

    expect(quote).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "manual_vendor_followup",
      unitPriceUsd: null,
      totalPriceUsd: null,
      quoteUrl: null,
      rawPayload: {
        fabworksState: "unsupported",
        eligibilityReason: "cnc_milling_not_certified",
        quoteIntent: "quote_only",
        orderActions: "prohibited",
      },
    });
  });

  it("makes zero delegate calls when production authorization and preflight are unavailable", async () => {
    const quote = vi.fn();
    const adapter = new FabworksAdapter(makeConfig(), { quote });

    const result = await adapter.quote(makeInput());

    expect(quote).not.toHaveBeenCalled();
    expect(result.rawPayload).toMatchObject({
      fabworksState: "unavailable",
      productionControls: {
        providerAdmission: "required_unavailable",
        actionTimeDisclosureAuthorization: "required_unavailable",
        immediatePreflight: "required_unavailable",
      },
    });
    expect(result.notes.join(" ")).toMatch(/production dispatch is unavailable/i);
  });

  it("does not accept a forged live-evaluation context", async () => {
    const quote = vi.fn();
    const adapter = new FabworksAdapter(makeConfig(), { quote });

    const result = await adapter.quote(
      makeInput({
        executionContext: "live_evaluation",
        liveEvaluationAuthorization: {
          nonExportControlled: true,
          cadFileSha256: "a".repeat(64),
          drawingFileSha256: null,
        },
      }),
    );

    expect(quote).not.toHaveBeenCalled();
    expect(result.rawPayload).toMatchObject({ fabworksState: "unavailable" });
  });

  it("normalizes an authorized evaluation price as a quote-only live offer", async () => {
    const quote = vi.fn().mockResolvedValue(liveOffer());
    const adapter = new FabworksAdapter(makeConfig(), { quote });
    const input = await authorizeInput(makeInput());

    const result = await adapter.quote(input);

    expect(quote).toHaveBeenCalledOnce();
    expect(quote).toHaveBeenCalledWith(input);
    expect(result).toMatchObject({
      status: "instant_quote_received",
      unitPriceUsd: 25,
      totalPriceUsd: 50,
      rawPayload: {
        fabworksState: "live_offer",
        executionContext: "live_evaluation",
        quoteIntent: "quote_only",
        orderActions: "prohibited",
      },
    });
  });

  it("trusts captured authorized bytes over stale oversized file metadata", async () => {
    const quote = vi.fn().mockResolvedValue(liveOffer());
    const adapter = new FabworksAdapter(makeConfig(), { quote });
    const input = makeInput({
      cadFile: {
        ...makeInput().cadFile!,
        size_bytes: 24_000_001,
      },
    });

    const result = await adapter.quote(await authorizeInput(input, "small-authorized-cad"));

    expect(quote).toHaveBeenCalledOnce();
    expect(result.rawPayload).toMatchObject({ fabworksState: "live_offer" });
  });

  it("rejects captured oversized bytes even when file metadata claims a small file", async () => {
    const quote = vi.fn();
    const adapter = new FabworksAdapter(makeConfig(), { quote });
    const input = await authorizeInput(makeInput(), Buffer.alloc(24_000_001));

    const result = await adapter.quote(input);

    expect(quote).not.toHaveBeenCalled();
    expect(result.rawPayload).toMatchObject({
      fabworksState: "unsupported",
      eligibilityReason: "file_size_outside_envelope",
    });
  });

  it.each([
    ["zero total", { totalPriceUsd: 0 }],
    ["negative unit", { unitPriceUsd: -1 }],
    ["non-finite total", { totalPriceUsd: Number.NaN }],
    ["infinite unit", { unitPriceUsd: Number.POSITIVE_INFINITY }],
    ["missing unit", { unitPriceUsd: null }],
  ] as const)("normalizes a success status with %s to finite manual follow-up", async (_label, invalidPrice) => {
    const quote = vi.fn().mockResolvedValue(liveOffer(invalidPrice));
    const adapter = new FabworksAdapter(makeConfig(), { quote });

    const result = await adapter.quote(await authorizeInput(makeInput()));

    expect(result).toMatchObject({
      status: "manual_vendor_followup",
      unitPriceUsd: null,
      totalPriceUsd: null,
      quoteUrl: null,
      rawPayload: {
        fabworksState: "manual_follow_up",
        normalizationReason: "invalid_live_offer_payload",
      },
    });
    expect(result.offers).toBeUndefined();
  });

  it("strips invalid offer variants instead of preserving a live-offer status", async () => {
    const quote = vi.fn().mockResolvedValue(liveOffer({
      offers: [{
        providerOptionId: "standard",
        providerLabel: "Standard",
        quoteRef: "Q-1",
        quoteUrl: "https://www.fabworks.com/quotes/qte_test",
        unitPriceUsd: 25,
        totalPriceUsd: 0,
        leadTimeBusinessDays: 3,
        shipReceiveBy: null,
        tier: "standard",
        sourcing: null,
        geographicOrigin: "unknown",
        sortRank: 0,
        provenance: {
          containerSelector: "[data-quote-option]",
          providerOptionIdSource: "attribute",
          priceSource: "selector",
          leadTimeSource: "selector",
          geographicOriginSource: "none",
        },
        rawPayload: {},
      }],
    }));
    const adapter = new FabworksAdapter(makeConfig(), { quote });

    const result = await adapter.quote(await authorizeInput(makeInput()));

    expect(result).toMatchObject({
      status: "manual_vendor_followup",
      unitPriceUsd: null,
      totalPriceUsd: null,
      quoteUrl: null,
      rawPayload: {
        fabworksState: "manual_follow_up",
        normalizationReason: "invalid_live_offer_payload",
      },
    });
    expect(result.offers).toBeUndefined();
  });

  it("normalizes non-priced provider results as manual follow-up", async () => {
    const quote = vi.fn().mockResolvedValue({
      ...liveOffer(),
      status: "manual_review_pending",
      unitPriceUsd: null,
      totalPriceUsd: null,
    });
    const adapter = new FabworksAdapter(makeConfig(), { quote });
    const result = await adapter.quote(await authorizeInput(makeInput()));

    expect(result).toMatchObject({
      status: "manual_review_pending",
      unitPriceUsd: null,
      totalPriceUsd: null,
      rawPayload: {
        fabworksState: "manual_follow_up",
      },
    });
  });

  it.each([
    ["login_required", "unavailable"],
    ["selector_failure", "manual_follow_up"],
  ] as const)("normalizes %s as a finite %s state", async (code, expectedState) => {
    const quote = vi.fn().mockRejectedValue(
      new VendorAutomationError("fixture failure", code, { secret: "not-copied" }),
    );
    const adapter = new FabworksAdapter(makeConfig(), { quote });
    const result = await adapter.quote(await authorizeInput(makeInput()));

    expect(result).toMatchObject({
      status: "manual_vendor_followup",
      unitPriceUsd: null,
      totalPriceUsd: null,
      rawPayload: {
        fabworksState: expectedState,
      },
    });
    expect(result.rawPayload).not.toHaveProperty("secret");
  });
});
