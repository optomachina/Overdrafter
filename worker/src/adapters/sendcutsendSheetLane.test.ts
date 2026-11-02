// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VendorAutomationError,
  type ProviderPortalApprovalDescriptor,
  type VendorQuoteAdapterInput,
  type WorkerConfig,
} from "../types";
import { assertProviderAdapterContract, evaluateProviderAdapterFailureContract } from "./providerAdapterContract";
import type * as Kernel from "./providerPortalKernel";
import type { ProviderPortalKernelResult } from "./providerPortalKernel";

const runKernel = vi.hoisted(() => vi.fn());
vi.mock("./providerPortalKernel", async (importOriginal) => ({
  ...await importOriginal<typeof Kernel>(),
  runProviderPortalKernel: runKernel,
}));

const { SendCutSendAdapter } = await import("./sendcutsend");

const tempDirs: string[] = [];
let workerTempDir = "";

beforeEach(async () => {
  workerTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sendcutsend-sheet-lane-"));
  tempDirs.push(workerTempDir);
});

afterEach(async () => {
  runKernel.mockReset();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const approval: ProviderPortalApprovalDescriptor = {
  schemaVersion: "provider-portal-approval.v1",
  providerKey: "sendcutsend",
  accountMode: "existing_authenticated_account",
  allowedOrigins: ["https://app.sendcutsend.com", "https://main.realtime.ably.net"],
  intendedAction: "quote_only",
  artifactScope: ["cad_upload", "scrubbed_local_evidence"],
  cadPath: "/evaluation/plate.step",
  drawingPath: null,
  requestedQuantities: [1],
  cadFileSha256: "a".repeat(64),
  drawingFileSha256: null,
};

function sheetInput(spec: Record<string, unknown> = {}, withApproval = true): VendorQuoteAdapterInput {
  return {
    executionContext: "live_evaluation",
    providerPortalApproval: withApproval ? approval : undefined,
    requestedQuantity: 1,
    requirement: {
      material: "6061-T6 aluminum",
      spec_snapshot: { process: "sheet_laser_cutting", geometryFamily: "flat_sheet", sheetThicknessInch: 0.125, ...spec },
    },
  } as unknown as VendorQuoteAdapterInput;
}

function adapter() {
  return new SendCutSendAdapter("sendcutsend", { workerMode: "live", workerTempDir } as WorkerConfig);
}

const contractDefinition = {
  provider: "sendcutsend" as const,
  allowedHosts: ["app.sendcutsend.com"],
  selectors: { cadUpload: "input[type='file']" },
  requirements: { quoteOnly: true as const, orderProhibited: true as const, isolatedSession: true as const },
};

function result(overrides: Partial<ProviderPortalKernelResult>): ProviderPortalKernelResult {
  return {
    state: "offers_extracted",
    reason: "anchored_offers_extracted",
    url: "https://app.sendcutsend.com/customer#/quote",
    offers: [],
    artifacts: [],
    providerMutationPossible: true,
    ...overrides,
  } as ProviderPortalKernelResult;
}

const offer = {
  providerOptionId: "ALU6061-125",
  providerLabel: "SendCutSend 6061 T6 Aluminum .125 in sheet",
  quoteRef: null,
  quoteUrl: null,
  quantity: 1,
  unitPriceUsd: 31.4,
  totalPriceUsd: 31.4,
  leadTimeBusinessDays: null,
  shipReceiveBy: "Oct 28",
  tier: null,
  sourcing: null,
  geographicOrigin: "unknown" as const,
  sortRank: 0,
  provenance: {
    containerSelector: ".post-processing-summary-container",
    providerOptionIdSource: "provider_label" as const,
    priceSource: "selector" as const,
    leadTimeSource: "none" as const,
    geographicOriginSource: "none" as const,
  },
  validUntil: null,
  validityDurationDays: null,
  validitySource: null,
  validityTerms: null,
  artifactRefs: [],
  rawPayload: {},
};

describe("SendCutSend sheet lane routing", () => {
  it("runs the sheet portal definition only for a SendCutSend approval", async () => {
    runKernel.mockResolvedValue(result({ offers: [offer] }));
    const input = sheetInput();
    await adapter().quote(input);
    expect(runKernel).toHaveBeenCalledOnce();
    const [definition, , passedInput, dependencies] = runKernel.mock.calls[0];
    expect(definition).toMatchObject({
      provider: "sendcutsend",
      envelopeRevision: "sendcutsend-sheet-envelope.v1",
      adapterRevision: "sendcutsend-sheet-portal.v1",
    });
    expect(definition.productionDispatch).toBeUndefined();
    expect(passedInput).toBe(input);
    expect(typeof dependencies.captureEvidence).toBe("function");
  });

  it("keeps the local manifest lane when no approval is supplied", async () => {
    const output = await adapter().quote(sheetInput({}, false));
    expect(runKernel).not.toHaveBeenCalled();
    expect(output.rawPayload).toMatchObject({ providerInteractionAttempted: false });
  });

  it("refuses an input that carries both a CNC manifest and a sheet approval", async () => {
    await expect(adapter().quote(sheetInput({ evaluationManifest: { reviewed: true } })))
      .rejects.toMatchObject({ payload: { terminalState: "unsupported", reason: "sendcutsend_evaluation_lane_ambiguous" } });
    expect(runKernel).not.toHaveBeenCalled();
  });

  it("never reaches the kernel outside live evaluation", async () => {
    const output = await adapter().quote({ ...sheetInput(), executionContext: "production_dispatch" });
    expect(runKernel).not.toHaveBeenCalled();
    expect(output.status).toBe("manual_vendor_followup");
  });
});

describe("SendCutSend sheet lane results", () => {
  it("publishes the anchored USD offer as an instant quote that passes the adapter contract", async () => {
    runKernel.mockResolvedValue(result({ offers: [offer] }));
    const input = sheetInput();
    const output = await adapter().quote(input);
    expect(output).toMatchObject({
      vendor: "sendcutsend",
      status: "instant_quote_received",
      unitPriceUsd: 31.4,
      totalPriceUsd: 31.4,
      leadTimeBusinessDays: null,
      rawPayload: {
        terminalState: "offers_extracted",
        quoteOnly: true,
        orderAttempted: false,
        customerLiveOfferEligible: false,
      },
    });
    expect(assertProviderAdapterContract({ definition: contractDefinition, adapterInput: input, output }).ok).toBe(true);
  });

  it.each([
    ["configuration_required", "manual_vendor_followup"],
    ["unsupported", "manual_vendor_followup"],
    ["manual_review", "manual_review_pending"],
  ] as const)("reports %s as a finite, price-free follow-up", async (state, status) => {
    runKernel.mockResolvedValue(result({ state, reason: `reason_${state}` }));
    const input = sheetInput();
    const output = await adapter().quote(input);
    expect(output).toMatchObject({ status, unitPriceUsd: null, totalPriceUsd: null, offers: [] });
    expect(output.rawPayload).toMatchObject({ terminalState: state, reason: `reason_${state}` });
    expect(assertProviderAdapterContract({ definition: contractDefinition, adapterInput: input, output }).ok).toBe(true);
  });

  it.each(["login_required", "missing_session", "captcha", "unexpected_origin", "selector_drift", "unavailable"] as const)(
    "throws a finite %s failure without a price",
    async (state) => {
      runKernel.mockResolvedValue(result({ state, reason: `reason_${state}` }));
      const error = await adapter().quote(sheetInput()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(VendorAutomationError);
      expect(evaluateProviderAdapterFailureContract(error)).toMatchObject({ ok: true, terminalState: state });
    },
  );

  it.each([
    ["configuration_required", "sendcutsend_thickness_not_offered", "manual_vendor_followup"],
    ["manual_review", "sendcutsend_custom_quote", "manual_review_pending"],
  ] as const)("reports the hooks' own %s stop as a finite follow-up output", async (terminalState, reason, status) => {
    runKernel.mockRejectedValue(new VendorAutomationError("stop", "unexpected_ui_state", {
      vendor: "sendcutsend", terminalState, reason, providerMutationPossible: true,
    }, [{ kind: "json", label: "SendCutSend scrubbed portal text", localPath: "/tmp/t.json", contentType: "application/json" }]));
    const input = sheetInput();
    const output = await adapter().quote(input);
    expect(output).toMatchObject({
      status, offers: [], unitPriceUsd: null,
      artifacts: [{ label: "SendCutSend scrubbed portal text" }],
      rawPayload: { terminalState, reason, providerMutationPossible: true },
    });
    expect(assertProviderAdapterContract({ definition: contractDefinition, adapterInput: input, output }).ok).toBe(true);
  });

  it("keeps kernel refusals, drift and sign-out as thrown failures", async () => {
    for (const [terminalState, reason] of [
      ["unsupported", "exact_provider_approval_mismatch"],
      ["selector_drift", "sendcutsend_price_pending"],
      ["login_required", "sendcutsend_signed_out"],
    ]) {
      const error = new VendorAutomationError("stop", "unexpected_ui_state", { vendor: "sendcutsend", terminalState, reason });
      runKernel.mockRejectedValueOnce(error);
      await expect(adapter().quote(sheetInput())).rejects.toBe(error);
    }
  });

  it("treats an empty or non-USD offer set as selector drift", async () => {
    runKernel.mockResolvedValue(result({ offers: [] }));
    await expect(adapter().quote(sheetInput())).rejects.toMatchObject({
      payload: { terminalState: "selector_drift", reason: "anchored_usd_offer_not_found" },
    });
    runKernel.mockResolvedValue(result({ state: "native_offers_extracted", offers: [], nativeOffers: [] } as never));
    await expect(adapter().quote(sheetInput())).rejects.toMatchObject({ payload: { terminalState: "selector_drift" } });
  });
});

describe("SendCutSend sheet lane evidence", () => {
  const definition = { provider: "sendcutsend", displayName: "SendCutSend", adapterRevision: "sendcutsend-sheet-portal.v1" };
  const snapshot = {
    url: "https://app.sendcutsend.com/customer#/quote",
    bodyText: "Signed in as someone@example.com\nSelect production method:",
    passwordInputCount: 0,
  };

  async function captureEvidence(state: string) {
    runKernel.mockResolvedValue(result({ offers: [offer] }));
    await adapter().quote(sheetInput());
    const dependencies = runKernel.mock.calls[0][3];
    return dependencies.captureEvidence(definition, { workerTempDir } as WorkerConfig, state, snapshot, undefined);
  }

  it("adds scrubbed page text to a non-priced stop", async () => {
    const artifacts = await captureEvidence("selector_drift");
    expect(artifacts.map((artifact: { label: string }) => artifact.label)).toEqual([
      "SendCutSend scrubbed portal state",
      "SendCutSend scrubbed portal text",
    ]);
    const text = JSON.parse(await fs.readFile(artifacts[1].localPath, "utf8"));
    expect(text).toMatchObject({ schemaVersion: "sendcutsend-portal-text.v1", terminalState: "selector_drift" });
    expect(text.textExcerpt).toContain("Select production method:");
    expect(text.textExcerpt).not.toContain("someone@example.com");
    expect((await fs.stat(artifacts[1].localPath)).mode & 0o777).toBe(0o600);
  });

  it("keeps a priced capture to metadata only", async () => {
    const artifacts = await captureEvidence("offers_extracted");
    expect(artifacts).toHaveLength(1);
  });
});
