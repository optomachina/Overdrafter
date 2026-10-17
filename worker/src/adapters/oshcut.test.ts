// @vitest-environment node

import type { SupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { ProviderAbortedError, withProviderAbortSignal } from "../providerAbort";
import { oshcutDispatchAuthorization, oshcutDispatchEnvelope } from "../../test-support/oshcutDispatchFixture";
import { quickpartsDispatchAuthorization, quickpartsDispatchEnvelope } from "../../test-support/quickpartsDispatchFixture";
import { getExtendedVendorWorkflow } from "./extendedVendorWorkflows";
import { OSHCUT_DISPATCH_ENVELOPE } from "./oshcutDispatchAuthorization";
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

describe("OshcutAdapter", () => {

  it("returns unsupported guidance without invoking a provider delegate", async () => {
    const delegateQuote = vi.fn();
    const adapter = makeAdapter(delegateQuote);
    const input = makeInput({
      requirement: {
        ...makeInput().requirement,
        spec_snapshot: { process: "CNC Milling", geometryFamily: "machined_solid" },
      },
    });

    await expect(adapter.quote(input)).resolves.toMatchObject({
      vendor: "oshcut",
      status: "failed",
      unitPriceUsd: null,
      totalPriceUsd: null,
      quoteUrl: null,
      rawPayload: {
        operationalState: "unsupported",
        reasonCode: "cnc_milling_not_supported",
        customerLiveOfferEligible: false,
        quoteIntent: "quote_only",
        orderAuthority: false,
        checkoutAllowed: false,
      },
    });
    expect(delegateQuote).not.toHaveBeenCalled();
  });

  it("returns a finite manual-follow-up state for incomplete requirements", async () => {
    const delegateQuote = vi.fn();
    const adapter = makeAdapter(delegateQuote);
    const input = makeInput({
      requirement: { ...makeInput().requirement, spec_snapshot: {} },
    });

    await expect(adapter.quote(input)).resolves.toMatchObject({
      status: "manual_vendor_followup",
      rawPayload: {
        operationalState: "manual_followup",
        reasonCode: "process_confirmation_required",
      },
    });
    expect(delegateQuote).not.toHaveBeenCalled();
  });

  it("returns a finite manual follow-up on a simulate worker without considering authorization", async () => {
    const delegateQuote = vi.fn();
    const adapter = makeAdapter(delegateQuote, makeConfig({ workerMode: "simulate" }));

    await expect(adapter.quote(makeInput())).resolves.toMatchObject({
      vendor: "oshcut",
      status: "manual_vendor_followup",
      unitPriceUsd: null,
      totalPriceUsd: null,
      quoteUrl: null,
      rawPayload: {
        operationalState: "manual_followup",
        reasonCode: "simulate_hidden_vendor",
        reason: "simulate_hidden_vendor",
        providerInteractionAttempted: false,
        providerMutationPossible: false,
        customerLiveOfferEligible: false,
        orderAuthority: false,
        checkoutAllowed: false,
      },
    });
    expect(delegateQuote).not.toHaveBeenCalled();
  });

  it("refuses an eligible live production package without a dispatch authorization, with zero provider interaction", async () => {
    const delegateQuote = vi.fn();
    const adapter = makeAdapter(delegateQuote, makeConfig({ workerMode: "live" }));

    await expect(adapter.quote(makeInput())).rejects.toMatchObject({
      code: "unexpected_ui_state",
      payload: {
        vendor: "oshcut",
        reason: "dispatch_authorization_missing",
        terminalState: "unsupported",
        providerInteractionAttempted: false,
        providerMutationPossible: false,
      },
    });
    expect(delegateQuote).not.toHaveBeenCalled();
  });

  it.each([
    ["another provider", () => quickpartsDispatchAuthorization(quickpartsDispatchEnvelope({ cadSha256: CAD_SHA, requestedQuantity: 25 })), "dispatch_authorization_provider_mismatch"],
    ["another quantity", () => oshcutDispatchAuthorization(oshcutDispatchEnvelope({ cadSha256: CAD_SHA, requestedQuantity: 24 })), "dispatch_authorization_quantity_mismatch"],
    ["other bytes", () => oshcutDispatchAuthorization(oshcutDispatchEnvelope({ cadSha256: "b".repeat(64), requestedQuantity: 25 })), "dispatch_authorization_file_mismatch"],
  ] as const)("refuses an authorization bound to %s before the production delegate", async (_name, authorization, reason) => {
    const delegateQuote = vi.fn();
    const adapter = makeAdapter(delegateQuote, makeConfig({ workerMode: "live" }));

    await expect(adapter.quote(makeInput({ providerDispatchAuthorization: authorization() })))
      .rejects.toMatchObject({ payload: { reason, providerInteractionAttempted: false } });
    expect(delegateQuote).not.toHaveBeenCalled();
  });

  it("refuses an envelope revision that is not the OSH Cut envelope", async () => {
    const delegateQuote = vi.fn();
    const adapter = makeAdapter(delegateQuote, makeConfig({ workerMode: "live" }));
    const authorization = structuredClone(authorizedProductionInput().providerDispatchAuthorization!);
    authorization.envelope.envelope = { id: OSHCUT_DISPATCH_ENVELOPE.id, version: 2 };

    await expect(adapter.quote(makeInput({ providerDispatchAuthorization: authorization })))
      .rejects.toMatchObject({ payload: { reason: "dispatch_authorization_envelope_unreviewed" } });
    expect(delegateQuote).not.toHaveBeenCalled();
  });

  it("passes an authorized production package to the production delegate and returns its USD offers", async () => {
    const delegateQuote = vi.fn(async (): Promise<VendorQuoteAdapterOutput> => ({
      vendor: "oshcut",
      status: "instant_quote_received",
      unitPriceUsd: 4.1,
      totalPriceUsd: 102.5,
      leadTimeBusinessDays: 3,
      quoteUrl: "https://app.oshcut.com/cart",
      dfmIssues: [],
      notes: [],
      artifacts: [],
      rawPayload: { terminalState: "offers_extracted" },
    }));
    const adapter = makeAdapter(delegateQuote, makeConfig({ workerMode: "live" }));
    const input = authorizedProductionInput();

    await expect(adapter.quote(input)).resolves.toMatchObject({
      status: "instant_quote_received",
      unitPriceUsd: 4.1,
      totalPriceUsd: 102.5,
    });
    expect(delegateQuote).toHaveBeenCalledExactlyOnceWith(input);
  });

  it("has no OSH Cut-specific daily cap; repeated quotes all reach the production delegate", async () => {
    const delegateQuote = vi.fn(async (): Promise<VendorQuoteAdapterOutput> => ({
      vendor: "oshcut", status: "instant_quote_received", unitPriceUsd: 1, totalPriceUsd: 25,
      leadTimeBusinessDays: 3, quoteUrl: null, dfmIssues: [], notes: [], artifacts: [], rawPayload: {},
    }));
    const adapter = makeAdapter(delegateQuote, makeConfig({ workerMode: "live" }));

    for (let i = 0; i < 25; i += 1) await adapter.quote(authorizedProductionInput());
    expect(delegateQuote).toHaveBeenCalledTimes(25);
  });

  it.each([
    ["no thickness", undefined],
    ["a millimetre-scale number", 3.175],
    ["more than three decimals", 0.0625],
    ["a string", "0.125"],
  ])("ends an authorized package with %s as configuration required before the production delegate", async (_name, thickness) => {
    const delegateQuote = vi.fn();
    const adapter = makeAdapter(delegateQuote, makeConfig({ workerMode: "live" }));
    const base = authorizedProductionInput();
    const input = {
      ...base,
      requirement: {
        ...base.requirement,
        spec_snapshot: { process: "Laser Cutting", geometryFamily: "flat_sheet", sheetThicknessInch: thickness },
      },
    } as VendorQuoteAdapterInput;

    await expect(adapter.quote(input)).resolves.toMatchObject({
      status: "manual_vendor_followup",
      rawPayload: {
        reasonCode: "thickness_confirmation_required",
        terminalState: "configuration_required",
        providerInteractionAttempted: false,
        providerMutationPossible: false,
      },
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

  it("stops an aborted authorized run before the production delegate (OVD-748)", async () => {
    const delegateQuote = vi.fn();
    const adapter = makeAdapter(delegateQuote, makeConfig({ workerMode: "live" }));
    const controller = new AbortController();
    controller.abort();

    await expect(adapter.quote(withProviderAbortSignal(authorizedProductionInput(), controller.signal)))
      .rejects.toBeInstanceOf(ProviderAbortedError);
    expect(delegateQuote).not.toHaveBeenCalled();
  });

  it("keeps authorized evaluation manual-follow-up local and quote-only", async () => {
    const delegateQuote = vi.fn(async (): Promise<VendorQuoteAdapterOutput> => ({
      vendor: "oshcut",
      status: "manual_review_pending",
      unitPriceUsd: null,
      totalPriceUsd: null,
      leadTimeBusinessDays: 2,
      quoteUrl: "https://app.oshcut.com/cart/evaluation-only",
      dfmIssues: [],
      notes: ["Provider review required."],
      artifacts: [],
      rawPayload: { source: "oshcut-live-adapter" },
    }));
    const adapter = makeAdapter(delegateQuote, makeConfig({ workerMode: "live" }));

    const output = await withAuthorizedEvaluation((input) => adapter.quote(input));

    expect(output).toMatchObject({
      status: "manual_vendor_followup",
      unitPriceUsd: null,
      totalPriceUsd: null,
      leadTimeBusinessDays: null,
      quoteUrl: null,
      rawPayload: {
        operationalState: "manual_followup",
        reasonCode: "provider_manual_followup",
        executionContext: "live_evaluation",
        customerLiveOfferEligible: false,
        quoteIntent: "quote_only",
        orderAuthority: false,
        checkoutAllowed: false,
      },
    });
    expect(output.offers).toBeUndefined();
    expect(delegateQuote).toHaveBeenCalledOnce();
  });

  it("rejects a forged evaluation context before invoking the delegate", async () => {
    const delegateQuote = vi.fn();
    const adapter = makeAdapter(delegateQuote, makeConfig({ workerMode: "live" }));

    await expect(
      adapter.quote(makeInput({ executionContext: "live_evaluation" })),
    ).resolves.toMatchObject({
      status: "failed",
      rawPayload: {
        operationalState: "unavailable",
        reasonCode: "evaluation_file_authorization_missing",
      },
    });
    expect(delegateQuote).not.toHaveBeenCalled();
  });

  it("does not let another provider session or a missing exact approval authorize OSH Cut evaluation", async () => {
    const workflow = getExtendedVendorWorkflow("oshcut");
    if (!workflow) {
      throw new Error("Expected the registered OSH Cut workflow.");
    }
    const adapter = new OshcutAdapter(
      makeConfig({
        workerMode: "live",
        vendorStorageStateJson: { fictiv: "{}" },
        vendorStorageStatePaths: {},
        vendorStorageStateDir: null,
      }),
      workflow,
      { quote: vi.fn() },
    );

    await expect(
      withAuthorizedEvaluation((input) => adapter.quote(input)),
    ).rejects.toMatchObject({
      code: "unexpected_ui_state",
      payload: {
        vendor: "oshcut",
        reason: "exact_provider_approval_mismatch",
        providerInteractionAttempted: false,
      },
    });
  });

  it("normalizes authorized evaluation pricing to a finite non-offer result", async () => {
    const delegateQuote = vi.fn(async (): Promise<VendorQuoteAdapterOutput> => ({
      vendor: "oshcut",
      status: "instant_quote_received",
      unitPriceUsd: 12,
      totalPriceUsd: 24,
      leadTimeBusinessDays: 3,
      quoteUrl: "https://app.oshcut.com/cart/evaluation-only",
      dfmIssues: [],
      notes: [],
      artifacts: [],
      offers: [
        {
          providerOptionId: "evaluation-option",
          providerLabel: "Evaluation option",
          quoteRef: "OSH-EVAL",
          quoteUrl: "https://app.oshcut.com/cart/evaluation-only",
          unitPriceUsd: 12,
          totalPriceUsd: 24,
          leadTimeBusinessDays: 3,
          shipReceiveBy: null,
          tier: "standard",
          sourcing: null,
          geographicOrigin: "unknown",
          sortRank: 0,
          provenance: {
            containerSelector: "[data-evaluation-option]",
            providerOptionIdSource: "attribute",
            priceSource: "selector",
            leadTimeSource: "selector",
            geographicOriginSource: "none",
          },
          rawPayload: {},
        },
      ],
      rawPayload: {
        source: "oshcut-live-adapter",
        fixture: "normalized-success",
      },
    }));
    const adapter = makeAdapter(delegateQuote, makeConfig({ workerMode: "live" }));

    const output = await withAuthorizedEvaluation((input) => adapter.quote(input));

    expect(output).toMatchObject({
      status: "failed",
      unitPriceUsd: null,
      totalPriceUsd: null,
      leadTimeBusinessDays: null,
      quoteUrl: null,
      rawPayload: {
        fixture: "normalized-success",
        operationalState: "unavailable",
        reasonCode: "evaluation_result_not_customer_live_offer",
        customerLiveOfferEligible: false,
      },
    });
    expect(output.offers).toBeUndefined();
    expect(output.rawPayload.operationalState).not.toBe("live_offer");
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
  it("removes the uploaded test part from the cart after capture", () => {
    const definition = buildOshcutEvaluationDefinition(getExtendedVendorWorkflow("oshcut")!);
    expect(definition.hooks.cleanup).toBe(cleanupOshcutCart);
    expect(Object.keys(definition.selectors.cleanup ?? {})).toEqual(["partRow", "removePart", "confirmRemove"]);
    expect(definition.routes.uploadUrl).toBe("https://app.oshcut.com/cart");
  });
});
