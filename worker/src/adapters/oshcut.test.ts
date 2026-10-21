// @vitest-environment node

import type { SupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  authorizeLiveEvaluationInput,
  sha256File,
} from "../liveEvaluationFiles";
import { quoteWithDispatchPreflight } from "../xometryDispatchPreflight";
import type {
  VendorQuoteAdapterInput,
  VendorQuoteAdapterOutput,
  WorkerConfig,
} from "../types";
import { oshcutDispatchAuthorization, oshcutDispatchEnvelope } from "../../test-support/oshcutDispatchFixture";
import { getExtendedVendorWorkflow } from "./extendedVendorWorkflows";
import { OSHCUT_PORTAL_DISABLED_MESSAGE } from "./oshcutPortalDisabled";
import {
  assessOshcutEligibility,
  OSHCUT_ENVELOPE_REVISION,
  OSHCUT_PROVIDER_ENVELOPE,
  buildOshcutEvaluationDefinition,
  resolveOshcutThicknessLabel,
  OshcutAdapter,
} from "./oshcut";
import { cleanupOshcutCart } from "./oshcutCartCleanup";

function makeConfig(overrides: Partial<WorkerConfig> = {}) {
  return {
    workerMode: "simulate",
    ...overrides,
  } as WorkerConfig;
}

function makeInput(
  overrides: Partial<VendorQuoteAdapterInput> = {},
): VendorQuoteAdapterInput {
  return {
    organizationId: "org-oshcut",
    quoteRunId: "run-oshcut",
    requestedQuantity: 25,
    part: {
      id: "part-oshcut",
      job_id: "job-oshcut",
      organization_id: "org-oshcut",
      name: "Flat bracket",
      normalized_key: "flat-bracket",
      cad_file_id: "cad-oshcut",
      drawing_file_id: null,
      quantity: 25,
    },
    cadFile: {
      id: "cad-oshcut",
      job_id: "job-oshcut",
      storage_bucket: "job-files",
      storage_path: "cad/flat-bracket.step",
      original_name: "flat-bracket.step",
      file_kind: "cad",
    },
    drawingFile: null,
    stagedCadFile: {
      originalName: "flat-bracket.step",
      localPath: "/private/staged/flat-bracket.step",
      storageBucket: "job-files",
      storagePath: "cad/flat-bracket.step",
      trustedContentSha256: "a".repeat(64),
    },
    stagedDrawingFile: null,
    requirement: {
      id: "requirement-oshcut",
      part_id: "part-oshcut",
      description: "Flat laser-cut bracket",
      part_number: "OSH-001",
      revision: "A",
      material: "Aluminum 6061-T6",
      finish: "Mill finish",
      tightest_tolerance_inch: null,
      quantity: 25,
      quote_quantities: [25],
      requested_by_date: null,
      applicable_vendors: ["oshcut"],
      spec_snapshot: {
        process: "Laser Cutting",
        geometryFamily: "flat_sheet",
        sheetThicknessInch: 0.125,
      },
    },
    ...overrides,
  };
}

function makeAdapter(
  delegateQuote: (input: VendorQuoteAdapterInput) => Promise<VendorQuoteAdapterOutput>,
  config = makeConfig(),
) {
  const workflow = getExtendedVendorWorkflow("oshcut");
  if (!workflow) {
    throw new Error("Expected the registered OSH Cut workflow.");
  }

  // One spy stands in for both delegates, so "not called" covers either path.
  return new OshcutAdapter(config, workflow, { quote: delegateQuote }, { quote: delegateQuote });
}

const CAD_SHA = "a".repeat(64);

/** A package bound to a synthetic OSH Cut dispatch authorization for its staged digest and quantity. */
function authorizedProductionInput(): VendorQuoteAdapterInput {
  const envelope = oshcutDispatchEnvelope({ cadSha256: CAD_SHA, requestedQuantity: 25 });
  return makeInput({
    executionContext: "production_dispatch",
    providerDispatchAuthorization: oshcutDispatchAuthorization(envelope),
  });
}

async function withAuthorizedEvaluation<T>(
  run: (input: VendorQuoteAdapterInput) => Promise<T>,
): Promise<T> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oshcut-adapter-test-"));
  const cadPath = path.join(tempDir, "flat-bracket.step");

  try {
    await fs.writeFile(cadPath, "authorized OSH Cut evaluation fixture");
    const cadFileSha256 = await sha256File(cadPath);
    const input = makeInput({
      stagedCadFile: {
        originalName: "flat-bracket.step",
        localPath: cadPath,
        storageBucket: "job-files",
        storagePath: "cad/flat-bracket.step",
        trustedContentSha256: cadFileSha256,
      },
      liveEvaluationAuthorization: {
        nonExportControlled: true,
        cadFileSha256,
        drawingFileSha256: null,
      },
    });
    const authorizedInput = await authorizeLiveEvaluationInput(input);
    if (!authorizedInput) {
      throw new Error("Expected exact evaluation-file authorization.");
    }

    return await run(authorizedInput);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

describe("OSH Cut provider envelope", () => {
  it("keeps the provider manifest aligned with the provider-local offline envelope", async () => {
    const manifest = JSON.parse(await fs.readFile(
      new URL("../../../provider-integrations/oshcut/manifest.v1.json", import.meta.url),
      "utf8",
    ));

    expect(manifest.integration.processFamily).toBe("sheet_metal");
    expect(manifest.capabilityEnvelope).toMatchObject({
      version: 1,
      processes: { status: "supported", values: [OSHCUT_PROVIDER_ENVELOPE.process] },
      materials: { status: "supported", values: [OSHCUT_PROVIDER_ENVELOPE.material] },
      files: {
        status: "supported",
        values: [...OSHCUT_PROVIDER_ENVELOPE.supportedFileExtensions].sort(),
      },
      quantity: {
        status: "supported",
        minimum: OSHCUT_PROVIDER_ENVELOPE.quantity.minimum,
        maximum: OSHCUT_PROVIDER_ENVELOPE.quantity.certifiedMaximum,
      },
      geometry: { status: "supported", constraints: ["flat_sheet_only"] },
      tolerance: { status: "unknown", minimumMm: null, maximumMm: null },
      drawings: { status: "unknown", values: [] },
      accountModes: { status: "unknown", values: [] },
    });
  });

  it("records a versioned first-party-evidence-backed process envelope", () => {
    expect(OSHCUT_PROVIDER_ENVELOPE).toMatchObject({
      provider: "oshcut",
      revision: "oshcut-sheet-laser-6061-t6.v2",
      evidenceReviewedAt: "2026-09-28",
      process: "laser_cutting",
      material: "aluminum_6061_t6",
      geometryFamilies: ["flat_sheet"],
      quantity: { minimum: 1, certifiedMaximum: 10_000 },
      drawingUpload: "unsupported_by_current_adapter",
      account: {
        isolatedAuthenticatedSessionRequired: true,
        productionAdmissionRequired: true,
        actionTimeDisclosurePermitRequired: true,
        immediatePreflightRequired: true,
        currentProductionState: "default_off_pending_admission",
      },
      guarantees: {
        quoteOnly: true,
        orderAuthority: false,
        checkoutAllowed: false,
      },
    });
    expect(OSHCUT_PROVIDER_ENVELOPE.evidence.map((entry) => entry.url)).toEqual([
      "https://www.oshcut.com/online-metal-fabrication/",
      "https://www.oshcut.com/tutorials/osh-cut-online-quoting-app",
      "https://www.oshcut.com/minimum-maximum-material-sizes",
    ]);
    expect(getExtendedVendorWorkflow("oshcut")).toMatchObject({
      vendor: "oshcut",
      processFamily: "sheet_metal",
    });
  });

  it("marks an exact flat-sheet 6061-T6 package statically eligible", () => {
    expect(assessOshcutEligibility(makeInput())).toEqual({
      state: "eligible",
      reasonCode: "static_envelope_match",
      guidance: expect.stringContaining("production dispatch still requires admission"),
      envelopeRevision: OSHCUT_ENVELOPE_REVISION,
    });
  });

  it.each(["CNC Milling", "milling", "CNC Machining"])(
    "fails closed for the CNC package process %s",
    (process) => {
      const input = makeInput({
        requirement: {
          ...makeInput().requirement,
          spec_snapshot: { process, geometryFamily: "machined_solid" },
        },
      });

      expect(assessOshcutEligibility(input)).toMatchObject({
        state: "unsupported",
        reasonCode: "cnc_milling_not_supported",
      });
    },
  );

  it("requires explicit process and geometry instead of inferring from a file extension", () => {
    const missingProcess = makeInput({
      requirement: { ...makeInput().requirement, spec_snapshot: {} },
    });
    const missingGeometry = makeInput({
      requirement: {
        ...makeInput().requirement,
        spec_snapshot: { process: "Laser Cutting" },
      },
    });

    expect(assessOshcutEligibility(missingProcess)).toMatchObject({
      state: "manual_followup",
      reasonCode: "process_confirmation_required",
    });
    expect(assessOshcutEligibility(missingGeometry)).toMatchObject({
      state: "manual_followup",
      reasonCode: "geometry_confirmation_required",
    });
  });

  it("keeps unsupported geometry, material, file, drawing, and quantity finite", () => {
    const base = makeInput();
    const cases: Array<[VendorQuoteAdapterInput, string]> = [
      [
        makeInput({
          requirement: {
            ...base.requirement,
            spec_snapshot: {
              process: "Laser Cutting",
              geometryFamily: "formed_sheet",
            },
          },
        }),
        "geometry_outside_envelope",
      ],
      [
        makeInput({
          requirement: { ...base.requirement, material: "Aluminum 5052-H32" },
        }),
        "material_outside_envelope",
      ],
      [
        makeInput({
          cadFile: { ...base.cadFile!, original_name: "flat-bracket.stl" },
          stagedCadFile: { ...base.stagedCadFile!, originalName: "flat-bracket.stl" },
        }),
        "file_format_outside_envelope",
      ],
      [
        makeInput({
          drawingFile: {
            id: "drawing-oshcut",
            job_id: "job-oshcut",
            storage_bucket: "job-files",
            storage_path: "drawing/flat-bracket.pdf",
            original_name: "flat-bracket.pdf",
            file_kind: "drawing",
          },
        }),
        "drawing_upload_not_supported",
      ],
      [makeInput({ requestedQuantity: 10_001 }), "quantity_outside_envelope"],
    ];

    for (const [input, reasonCode] of cases) {
      expect(assessOshcutEligibility(input)).toMatchObject({
        state: "unsupported",
        reasonCode,
      });
    }
  });

  it("rejects an unsupported staged file even when the stored CAD name looks supported", () => {
    const input = makeInput({
      stagedCadFile: {
        ...makeInput().stagedCadFile!,
        originalName: "flat-bracket.stl",
      },
    });

    expect(assessOshcutEligibility(input)).toMatchObject({
      state: "unsupported",
      reasonCode: "file_format_mismatch",
    });
  });

  it.each(["stp", "nx", "solidedge"])(
    "does not infer a supported file extension from the provider's format label %s",
    (extension) => {
      const input = makeInput({
        cadFile: { ...makeInput().cadFile!, original_name: `flat-bracket.${extension}` },
        stagedCadFile: {
          ...makeInput().stagedCadFile!,
          originalName: `flat-bracket.${extension}`,
        },
      });

      expect(assessOshcutEligibility(input)).toMatchObject({
        state: "unsupported",
        reasonCode: "file_format_outside_envelope",
      });
    },
  );
});

describe("OshcutAdapter hard disable (OVD-1022)", () => {
  it.each(["live", "simulate"] as const)("refuses production and evaluation in %s mode even with authorization", async (workerMode) => {
    const delegateQuote = vi.fn();
    const adapter = makeAdapter(delegateQuote, makeConfig({ workerMode }));
    await expect(adapter.quote(authorizedProductionInput())).rejects.toThrow(OSHCUT_PORTAL_DISABLED_MESSAGE);
    await withAuthorizedEvaluation(async (input) => {
      await expect(adapter.quote(input)).rejects.toThrow(OSHCUT_PORTAL_DISABLED_MESSAGE);
    });
    expect(delegateQuote).not.toHaveBeenCalled();
  });

  it.each([
    [0.125, '0.125"'],
    [0.063, '0.063"'],
    [0.5, '0.500"'],
    [0.01, null],
    [1.5, null],
    [Number.NaN, null],
  ])("maps a recorded thickness of %s inch to the reviewed filter label %s", (thickness, label) => {
    const input = makeInput({
      requirement: { ...makeInput().requirement, spec_snapshot: { sheetThicknessInch: thickness } },
    });
    expect(resolveOshcutThicknessLabel(input)).toBe(label);
  });

  it("is denied by the immediate production preflight before any adapter call", async () => {
    const adapterQuote = vi.fn();

    await expect(
      quoteWithDispatchPreflight({
        supabase: {} as SupabaseClient,
        config: { workerMode: "live", workerName: "worker-oshcut" },
        workQueueTaskId: "task-oshcut",
        vendorQuoteResultId: "result-oshcut",
        claimedAt: "2026-08-26T00:00:00.000Z",
        vendor: "oshcut",
        scopeSnapshot: { vendor: "oshcut" },
        adapter: { quote: adapterQuote },
        quoteInput: makeInput(),
      }),
    ).rejects.toMatchObject({
      reasonCode: "dispatch_live_provider_not_permitted",
    });
    expect(adapterQuote).not.toHaveBeenCalled();
  });
});

describe("OSH Cut live-harness evaluation definition (standing cleanup rule)", () => {
  it("reports cart candidates after capture without removal controls", () => {
    const definition = buildOshcutEvaluationDefinition(getExtendedVendorWorkflow("oshcut")!);
    expect(definition.hooks.cleanup).toBe(cleanupOshcutCart);
    expect(Object.keys(definition.selectors.cleanup ?? {})).toEqual(["partRow"]);
    expect(definition.selectors.cleanup?.partRow.reportOnly).toBe(true);
    expect(definition.routes.uploadUrl).toBe("https://app.oshcut.com/cart");
  });
});
