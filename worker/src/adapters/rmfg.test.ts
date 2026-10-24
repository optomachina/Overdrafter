// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../../test-fixtures/provider-dispatch-envelope/geomiq-v1.json";
import { buildProviderDispatchFixtureEnvelope, providerDispatchFixtureAuthorization } from "../../test-support/providerDispatchFixture";
import { loadConfig } from "../config";
import { authorizeLiveEvaluationInput, sha256File } from "../liveEvaluationFiles";
import { ProviderAbortedError, withProviderAbortSignal } from "../providerAbort";
import { REVIEWED_PROVIDER_DISPATCH_ENVELOPES } from "../providerDispatchEnvelope";
import {
  createProviderKillSwitchGuard,
  guardProviderDispatch,
  guardProviderQuote,
  PROVIDER_DAILY_CAP_REACHED,
  PROVIDER_DISPATCH_RESERVATION_SCHEMA,
  PROVIDER_KILL_SWITCH_ENGAGED,
  PROVIDER_KILL_SWITCH_STATE_SCHEMA,
  PROVIDER_KILL_SWITCH_UNAVAILABLE,
  ProviderKillSwitchError,
  type ProviderKillSwitchReader,
} from "../providerKillSwitch";
import { LIVE_AUTOMATION_VENDORS, VendorAutomationError, type VendorQuoteAdapterInput, type WorkerConfig } from "../types";
import { buildAdapterRegistry } from "./index";
import { assertProviderAdapterContract, evaluateProviderAdapterFailureContract } from "./providerAdapterContract";
import {
  evaluateRmfgEligibility,
  resetRmfgAdapterStateForTests,
  RMFG_API_KEY_ENV,
  RmfgAdapter,
  type RmfgDispatchSeams,
} from "./rmfg";
import { RMFG_DISPATCH_ENVELOPE } from "./rmfgDispatchAuthorization";
import { createRmfgHttpTransport, resetRmfgProcessStateForTests } from "./rmfgHttpTransport";

/**
 * RMFG live adapter (OVD-678). The real HTTP client runs against a fake fetch
 * with synthetic responses, so no request leaves the process. The key below is
 * a synthetic placeholder, not a credential.
 */

const SYNTHETIC_KEY = "synthetic-rmfg-key-not-a-secret";
const tempDirs: string[] = [];

const design = {
  id: "design-synthetic", status: "ready",
  parts: [{ id: "part-a", analysis_status: "ready", instance_count: 1, suggested_process: "sheet_metal" }],
};
const readyQuote = {
  id: "quote-synthetic", status: "ready", currency: "usd", requirements: [],
  amount_subtotal_cents: 3750, amount_shipping_cents: null, amount_tax_cents: null, amount_total_cents: 3750,
  items: [{ design_id: "design-synthetic", quantity: 3, status: "ready",
    unit_amount_cents: 1250, amount_cents: 3750, requirements: [],
    line_items: [{ part_id: "part-a", process: "sheet_metal", quantity: 3, material_id: "catalog-stock-a",
      unit_amount_cents: 1250, amount_cents: 3750 }],
    dfm: { design_id: "design-synthetic", status: "ready", requirements: [],
      configuration: { parts: [{ part_id: "part-a", material_id: "catalog-stock-a" }] },
      parts: [{ part_id: "part-a", status: "ready", issues: [] }] } }],
};

type Reply = { status: number; body: unknown; html?: boolean };

function fakeFetch(route: (url: URL) => Reply) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const reply = route(url);
    return new Response(reply.html ? "<html>Please verify you are human</html>" : JSON.stringify(reply.body),
      { status: reply.status, headers: { "content-type": reply.html ? "text/html" : "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const happyPath = (url: URL): Reply => {
  if (url.pathname === "/v1/analyze") return { status: 202, body: design };
  if (url.pathname === "/v1/materials") return { status: 200, body: { data: [{ id: "catalog-stock-a" }], has_more: false } };
  if (url.pathname === "/v1/quotes") return { status: 201, body: readyQuote };
  return { status: 404, body: {} };
};

function liveConfig(adapters: string[] = ["rmfg"]): WorkerConfig {
  return { workerMode: "live", workerLiveAdapters: adapters } as unknown as WorkerConfig;
}

function adapterWith(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = { [RMFG_API_KEY_ENV]: SYNTHETIC_KEY },
  config = liveConfig()) {
  return new RmfgAdapter(config, {
    env,
    createTransport: (apiKey) => createRmfgHttpTransport({ apiKey, fetchImpl }),
    pollIntervalMs: 0,
  });
}

async function authorizedInput(overrides: Partial<VendorQuoteAdapterInput & RmfgDispatchSeams> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rmfg-adapter-"));
  tempDirs.push(dir);
  const localPath = path.join(dir, "bracket.step");
  await fs.writeFile(localPath, "synthetic rmfg step bytes");
  const cad = { originalName: "bracket.step", localPath, storageBucket: "job-files",
    storagePath: "cad/bracket.step", trustedContentSha256: await sha256File(localPath) };
  const raw = structuredClone(fixture.envelope) as Record<string, unknown>;
  raw.provider = "rmfg";
  raw.envelope = { ...RMFG_DISPATCH_ENVELOPE };
  const envelope = buildProviderDispatchFixtureEnvelope("RMFG", raw, {
    cadSha256: cad.trustedContentSha256, requestedQuantity: 3 });
  return {
    organizationId: envelope.subject.organizationId,
    quoteRunId: envelope.task.quoteRunId,
    part: { id: envelope.subject.partId },
    requirement: { material: "5052-H32 aluminum",
      spec_snapshot: { process: "sheet_metal_bending", rmfgSelections: { "part-a": { materialId: "catalog-stock-a" } } } },
    requestedQuantity: 3,
    executionContext: "production_dispatch",
    stagedCadFile: cad,
    stagedDrawingFile: null,
    cadFile: null,
    providerDispatchAuthorization: providerDispatchFixtureAuthorization(envelope),
    ...overrides,
  } as unknown as VendorQuoteAdapterInput & RmfgDispatchSeams;
}

beforeEach(() => {
  resetRmfgProcessStateForTests();
  resetRmfgAdapterStateForTests();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("RMFG live adapter", () => {
  it("returns a quote only offer from a ready RMFG quote", async () => {
    const { calls, fetchImpl } = fakeFetch(happyPath);
    const checkpoints: string[] = [];
    const disclosure = vi.fn(async () => undefined);
    const output = await adapterWith(fetchImpl).quote(await authorizedInput({
      providerKillSwitchCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint); },
      beforeProviderDisclosure: disclosure,
    }));
    expect(calls).toEqual(["/v1/analyze", "/v1/materials", "/v1/quotes"]);
    expect(calls.some((call) => /cart|checkout|order/.test(call))).toBe(false);
    expect(checkpoints).toEqual(["before_navigation", "before_upload", "before_navigation", "before_configure"]);
    expect(disclosure).toHaveBeenCalledTimes(1);
    expect(output).toMatchObject({
      vendor: "rmfg", status: "instant_quote_received", unitPriceUsd: 12.5, totalPriceUsd: 37.5,
      leadTimeBusinessDays: null,
      offers: [{ quoteRef: "quote-synthetic", quantity: 3, unitPriceUsd: 12.5, totalPriceUsd: 37.5 }],
      rawPayload: { quoteOnly: true, orderProhibited: true, rmfgState: "ready" },
    });
    expect(JSON.stringify(output)).not.toContain(SYNTHETIC_KEY);
  });

  it("surfaces a provider error as a non retryable failure", async () => {
    const { calls, fetchImpl } = fakeFetch((url) =>
      url.pathname === "/v1/analyze" ? { status: 500, body: { error: "synthetic" } } : happyPath(url));
    const error = await adapterWith(fetchImpl).quote(await authorizedInput()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VendorAutomationError);
    expect(error).toMatchObject({ code: "unexpected_ui_state",
      payload: { reason: "http_500", retryable: false, providerInteractionAttempted: true } });
    expect(calls).toEqual(["/v1/analyze"]);
  });

  it.each([
    ["challenge page", { status: 200, body: null, html: true }, "captcha", "rmfg_challenge_response", "captcha", "captcha", "captcha"],
    ["challenge on a 403", { status: 403, body: null, html: true }, "captcha", "rmfg_challenge_response", "captcha", "captcha", "captcha"],
    // The client latches 401 and 403 alike, so the replay reports authorization required.
    ["block", { status: 403, body: { error: "forbidden" } }, "anti_detection_block", "rmfg_blocked", "unavailable",
      "login_required", "login_required"],
    ["rate limit", { status: 429, body: { error: "slow down" } }, "anti_detection_block", "rmfg_rate_limited", "unavailable",
      "anti_detection_block", "unavailable"],
    ["login", { status: 401, body: { error: "unauthorized" } }, "login_required", "rmfg_authorization_required", "login_required",
      "login_required", "login_required"],
    // OVD-1057: a payment, plan or terms demand is a person's decision, never answered here.
    ["payment demand", { status: 402, body: { error: { code: "payment_required" } } }, "unexpected_ui_state",
      "rmfg_account_action_required", "manual_review", "unexpected_ui_state", "manual_review"],
    ["terms demand on a 403", { status: 403, body: { error: { type: "invalid_request_error", code: "terms_not_accepted" } } },
      "unexpected_ui_state", "rmfg_account_action_required", "manual_review", "unexpected_ui_state", "manual_review"],
  ] as const)("stops on a %s and never retries around it", async (_label, reply, code, reason, terminalState, replayCode,
    replayTerminalState) => {
    const { calls, fetchImpl } = fakeFetch((url) => (url.pathname === "/v1/analyze" ? reply : happyPath(url)));
    const first = await adapterWith(fetchImpl).quote(await authorizedInput()).catch((caught: unknown) => caught);
    expect(first).toMatchObject({ code, payload: { reason, retryable: false, terminalState } });
    expect(evaluateProviderAdapterFailureContract(first)).toMatchObject({ ok: true, terminalState });
    expect(calls).toEqual(["/v1/analyze"]);

    // A fresh adapter and client in the same process stays stopped with no request.
    const second = await adapterWith(fetchImpl).quote(await authorizedInput()).catch((caught: unknown) => caught);
    expect(second).toBeInstanceOf(VendorAutomationError);
    expect(second).toMatchObject({ code: replayCode, payload: { retryable: false, terminalState: replayTerminalState } });
    expect(calls).toEqual(["/v1/analyze"]);
  });

  it("stops with no request when the kill switch is engaged", async () => {
    const { calls, fetchImpl } = fakeFetch(happyPath);
    const engaged = new Error("The rmfg kill switch is engaged; refused at before_navigation.");
    const error = await adapterWith(fetchImpl).quote(await authorizedInput({
      providerKillSwitchCheckpoint: async () => { throw engaged; },
    })).catch((caught: unknown) => caught);
    expect(error).toBe(engaged);
    expect(calls).toEqual([]);
  });

  it("stops before the next request when the kill switch engages mid quote", async () => {
    const { calls, fetchImpl } = fakeFetch(happyPath);
    const engaged = new Error("engaged at before_configure");
    const error = await adapterWith(fetchImpl).quote(await authorizedInput({
      providerKillSwitchCheckpoint: async (checkpoint) => { if (checkpoint === "before_configure") throw engaged; },
    })).catch((caught: unknown) => caught);
    expect(error).toBe(engaged);
    expect(calls).toEqual(["/v1/analyze", "/v1/materials"]);
  });

  it("OVD-748: sends no request when the run is aborted before start", async () => {
    const { calls, fetchImpl } = fakeFetch(happyPath);
    const controller = new AbortController();
    controller.abort();
    const error = await adapterWith(fetchImpl).quote(withProviderAbortSignal(
      await authorizedInput(), controller.signal,
    )).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderAbortedError);
    expect(calls).toEqual([]);
  });

  it("OVD-748: stops before the next request when aborted mid quote, as an abort and not a provider failure", async () => {
    const { calls, fetchImpl } = fakeFetch(happyPath);
    const controller = new AbortController();
    const adapterInput = await authorizedInput({
      providerKillSwitchCheckpoint: async (checkpoint) => { if (checkpoint === "before_configure") controller.abort(); },
    });
    const error = await adapterWith(fetchImpl).quote(withProviderAbortSignal(adapterInput, controller.signal))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderAbortedError);
    expect(error).not.toBeInstanceOf(VendorAutomationError);
    expect(calls).toEqual(["/v1/analyze", "/v1/materials"]);
  });

  it("uploads nothing when the export control recheck denies", async () => {
    const { calls, fetchImpl } = fakeFetch(happyPath);
    const denied = new Error("export control hold");
    const error = await adapterWith(fetchImpl).quote(await authorizedInput({
      beforeProviderDisclosure: async () => { throw denied; },
    })).catch((caught: unknown) => caught);
    expect(error).toBe(denied);
    expect(calls).toEqual([]);
  });

  it("refuses an authorization without the non export controlled affirmation", async () => {
    const { calls, fetchImpl } = fakeFetch(happyPath);
    const input = await authorizedInput();
    const authorization = structuredClone(input.providerDispatchAuthorization!);
    (authorization.envelope.affirmations as { nonExportControlled: boolean }).nonExportControlled = false;
    const error = await adapterWith(fetchImpl).quote({ ...input, providerDispatchAuthorization: authorization })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ payload: { reason: "export_control_affirmation_missing", providerInteractionAttempted: false } });
    expect(calls).toEqual([]);
  });

  it("refuses a CNC only part with a clear reason and no request", async () => {
    const { calls, fetchImpl } = fakeFetch(happyPath);
    for (const process of ["cnc_milling", "CNC turning", "machining"]) {
      const output = await adapterWith(fetchImpl).quote(await authorizedInput({
        requirement: { material: "6061-T6 aluminum", spec_snapshot: { process } } as VendorQuoteAdapterInput["requirement"],
      }));
      expect(output).toMatchObject({ status: "manual_vendor_followup", unitPriceUsd: null,
        rawPayload: { reason: "cnc_only_not_supported", providerInteractionAttempted: false } });
      expect(output.notes[0]).toContain("not CNC");
    }
    expect(calls).toEqual([]);
    expect(evaluateRmfgEligibility({ process: "tube laser", fileName: "frame.stp" })).toEqual({ eligible: true });
    expect(evaluateRmfgEligibility({ process: "welding", fileName: "frame.step" })).toEqual({ eligible: true });
    expect(evaluateRmfgEligibility({ process: null, fileName: "frame.step" }))
      .toMatchObject({ eligible: false, reason: "process_evidence_missing" });
    expect(evaluateRmfgEligibility({ process: "sheet metal", fileName: "flat.dxf" }))
      .toMatchObject({ eligible: false, reason: "step_file_required" });
  });

  it("stays off unless live, listed, authorized and keyed", async () => {
    const { calls, fetchImpl } = fakeFetch(happyPath);
    const simulate = await adapterWith(fetchImpl, undefined,
      { workerMode: "simulate", workerLiveAdapters: ["xometry"] } as unknown as WorkerConfig).quote(await authorizedInput());
    expect(simulate).toMatchObject({ status: "manual_vendor_followup", rawPayload: { reason: "rmfg_live_adapter_disabled" } });
    const unlisted = await adapterWith(fetchImpl, undefined, liveConfig(["xometry"])).quote(await authorizedInput());
    expect(unlisted).toMatchObject({ rawPayload: { reason: "rmfg_live_adapter_disabled" } });
    await expect(adapterWith(fetchImpl).quote(await authorizedInput({ providerDispatchAuthorization: undefined })))
      .rejects.toMatchObject({ payload: { reason: "dispatch_authorization_missing" } });
    // A live evaluation input that did not come through the harness's file capture is refused.
    await expect(adapterWith(fetchImpl).quote(await authorizedInput({ executionContext: "live_evaluation" })))
      .rejects.toMatchObject({ payload: { reason: "evaluation_file_authorization_missing", terminalState: "unavailable" } });
    await expect(adapterWith(fetchImpl, {}).quote(await authorizedInput()))
      .rejects.toMatchObject({ payload: { reason: "rmfg_api_key_missing" } });
    expect(calls).toEqual([]);
  });

  it("never auto-picks stock on the production dispatch path (OVD-1057)", async () => {
    const { calls, fetchImpl } = fakeFetch(happyPath);
    const output = await adapterWith(fetchImpl).quote(await authorizedInput({
      requirement: { material: "5052-H32 aluminum", spec_snapshot: { process: "sheet_metal_bending",
        rmfgStock: { grade: "5052-H32", thicknessIn: 0.125 } } } as VendorQuoteAdapterInput["requirement"],
    }));
    expect(output).toMatchObject({ status: "manual_vendor_followup",
      rawPayload: { reason: "sheet_material_id_required", terminalState: "configuration_required" } });
    expect(calls).toEqual(["/v1/analyze", "/v1/materials"]);
  });

  it("keeps no daily cap of its own: 21 quotes in a row all reach RMFG (OVD-829)", async () => {
    const { calls, fetchImpl } = fakeFetch(happyPath);
    const adapter = new RmfgAdapter(liveConfig(), { env: { [RMFG_API_KEY_ENV]: SYNTHETIC_KEY },
      createTransport: (apiKey) => createRmfgHttpTransport({ apiKey, fetchImpl }) });
    for (let n = 0; n < 21; n += 1) {
      await expect(adapter.quote(await authorizedInput())).resolves.toMatchObject({ status: "instant_quote_received" });
    }
    expect(calls.filter((call) => call === "/v1/analyze")).toHaveLength(21);
  });

  it("is refused provider_daily_cap_reached with no request by the shared settings gate (OVD-829)", async () => {
    const { calls, fetchImpl } = fakeFetch(happyPath);
    const adapter = adapterWith(fetchImpl);
    const quote = guardProviderDispatch({
      provider: "rmfg",
      capMode: "durable",
      port: {
        readKillSwitch: async () => killSwitchState(false),
        readSettings: async () => null,
        reserveDispatch: async () => ({ schema: PROVIDER_DISPATCH_RESERVATION_SCHEMA, provider: "rmfg",
          allowed: false, reason: PROVIDER_DAILY_CAP_REACHED, cap: 5, used: 5 }),
      },
      quote: (input) => adapter.quote(input),
    });
    await expect(quote(await authorizedInput())).rejects.toMatchObject({
      name: "ProviderDispatchRefusedError", reasonCode: PROVIDER_DAILY_CAP_REACHED, dailyQuoteCap: 5,
    });
    expect(calls).toEqual([]);
  });

  it("is listed for live automation but stays out of the default live registry", () => {
    expect(LIVE_AUTOMATION_VENDORS).toContain("rmfg");
    expect(REVIEWED_PROVIDER_DISPATCH_ENVELOPES.some((envelope) => envelope.provider === "rmfg")).toBe(false);
    const defaults = loadConfig({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "synthetic",
      WORKER_MODE: "live" } as NodeJS.ProcessEnv);
    expect(defaults.workerLiveAdapters).not.toContain("rmfg");
    expect(Object.keys(buildAdapterRegistry(defaults))).not.toContain("rmfg");
  });
});

// OVD-1057: the operator live evaluation harness. Inputs go through the same
// digest bound capture the harness uses; every RMFG answer is a synthetic
// stand in shaped like the published V1 schemas.
const plateDesign = {
  id: "design-plate", status: "ready",
  parts: [{ id: "part-plate", analysis_status: "ready", instance_count: 1, suggested_process: "sheet_metal",
    detected_thickness_mm: 3.175, bend_count: 0 }],
};
const plateCatalog = { has_more: false, data: [
  { id: "stock-6061-090", material: "Aluminum", type: "6061 T6", thickness_in: 0.09, bendable: false },
  { id: "stock-6061-125", material: "Aluminum", type: "6061 T6", thickness_in: 0.125, bendable: false },
  { id: "stock-5052-125", material: "Aluminum", type: "5052-H32", thickness_in: 0.125, bendable: true },
] };
const plateQuote = {
  id: "quote-plate", status: "ready", currency: "usd", requirements: [], expires_at: "2099-11-21T00:00:00Z",
  amount_subtotal_cents: 4321, amount_shipping_cents: null, amount_tax_cents: null, amount_total_cents: 4321,
  items: [{ design_id: "design-plate", quantity: 1, status: "ready", unit_amount_cents: 4321, amount_cents: 4321,
    requirements: [],
    line_items: [{ part_id: "part-plate", process: "sheet_metal", quantity: 1, material_id: "stock-6061-125",
      unit_amount_cents: 4321, amount_cents: 4321 }],
    dfm: { design_id: "design-plate", status: "ready", requirements: [],
      configuration: { parts: [{ part_id: "part-plate", material_id: "stock-6061-125" }] },
      parts: [{ part_id: "part-plate", status: "ready", issues: [] }] } }],
};
const platePath = (catalog: unknown = plateCatalog) => (url: URL): Reply => {
  if (url.pathname === "/v1/analyze") return { status: 202, body: plateDesign };
  if (url.pathname === "/v1/materials") return { status: 200, body: catalog };
  if (url.pathname === "/v1/quotes") return { status: 201, body: plateQuote };
  return { status: 404, body: {} };
};
const RMFG_CONTRACT = {
  provider: "rmfg", allowedHosts: ["api.rmfg.com"], selectors: { cadUpload: "input[type='file']" },
  requirements: { quoteOnly: true, orderProhibited: true, isolatedSession: true },
};

async function evaluationInput(overrides: Partial<VendorQuoteAdapterInput & RmfgDispatchSeams> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rmfg-evaluation-"));
  tempDirs.push(dir);
  const localPath = path.join(dir, "cad.step");
  await fs.writeFile(localPath, "synthetic rmfg plate bytes");
  const sha = await sha256File(localPath);
  const input = {
    executionContext: "live_evaluation",
    liveEvaluationAuthorization: { nonExportControlled: true, cadFileSha256: sha, drawingFileSha256: null },
    organizationId: "org-synthetic", quoteRunId: "rmfg-evaluation-synthetic", part: { id: "part-synthetic" },
    requirement: { material: "6061-T6", finish: "As cut",
      spec_snapshot: { process: "sheet_metal_laser_cutting", rmfgStock: { grade: "6061-T6", thicknessIn: 0.125 } } },
    requestedQuantity: 1, cadFile: null, stagedDrawingFile: null,
    stagedCadFile: { originalName: "plate.step", localPath, storageBucket: "local", storagePath: "cad.step",
      trustedContentSha256: sha },
    ...overrides,
  } as unknown as VendorQuoteAdapterInput & RmfgDispatchSeams;
  return (await authorizeLiveEvaluationInput(input))! as VendorQuoteAdapterInput & RmfgDispatchSeams;
}

describe("RMFG live evaluation with a stated stock (OVD-1057)", () => {
  it("quotes the one matching catalog stock at quantity 1 and meets the provider contract", async () => {
    const { calls, fetchImpl } = fakeFetch(platePath());
    const checkpoints: string[] = [];
    const adapterInput = await evaluationInput({
      providerKillSwitchCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint); },
    });
    const output = await adapterWith(fetchImpl).quote(adapterInput);
    expect(calls).toEqual(["/v1/analyze", "/v1/materials", "/v1/quotes"]);
    expect(checkpoints).toEqual(["before_navigation", "before_upload", "before_navigation", "before_configure"]);
    expect(output).toMatchObject({
      vendor: "rmfg", status: "instant_quote_received", unitPriceUsd: 43.21, totalPriceUsd: 43.21,
      validUntil: "2099-11-21T00:00:00.000Z", validitySource: "vendor_date",
      offers: [{ quoteRef: "quote-plate", quantity: 1, totalPriceUsd: 43.21 }],
      rawPayload: { rmfgState: "ready", stock: { materialId: "stock-6061-125", thicknessIn: 0.125 },
        quoteOnly: true, orderProhibited: true },
    });
    expect(assertProviderAdapterContract({ definition: RMFG_CONTRACT, adapterInput, output }))
      .toMatchObject({ ok: true, terminalState: "offers_extracted" });
    // Labels and figures a reviewer can check, and no RMFG IDs.
    const evidence = output.rawPayload.rmfgEvidence;
    expect(evidence).toEqual({
      stock: { label: "Aluminum 6061 T6", displayThickness: null, thicknessIn: 0.125 }, stockOffered: null,
      dfmStatus: "ready", dfmIssueCodes: [], requirementCodes: [], totalCents: 4321,
      excludes: ["shipping", "tax", "cart_minimum_order"],
      fulfillment: { standardProductionDays: null, standardShipDate: null, expeditedOffered: false }, pricedComponents: [],
    });
    expect(JSON.stringify(evidence)).not.toMatch(/stock-6061|quote-plate|design-plate|part-plate/);
  });

  it("sends the captured bytes under operation specific idempotency keys", async () => {
    const seen: Array<{ path: string; key: string | null; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const body = init?.body instanceof FormData
        ? await (init.body.get("file") as Blob).text()
        : init?.body ? JSON.parse(String(init.body)) : null;
      seen.push({ path: url.pathname, key: headers.get("idempotency-key"), body });
      const reply = platePath()(url);
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as unknown as typeof fetch;
    await adapterWith(fetchImpl).quote(await evaluationInput());
    expect(seen[0]).toMatchObject({ path: "/v1/analyze", body: "synthetic rmfg plate bytes" });
    expect(seen[0].key).toMatch(/^ovd-[0-9a-f]{40}-analyze$/);
    expect(seen[2].key).toMatch(/^ovd-[0-9a-f]{40}-quote-[0-9a-f]{16}$/);
    expect(seen[2].key!.slice(0, 44)).toBe(seen[0].key!.slice(0, 44));
    expect(seen[1].key).toBeNull();
  });

  it("stops before the quote when the catalog has no exact stock, as a finite configuration stop", async () => {
    const { calls, fetchImpl } = fakeFetch(platePath({ has_more: false, data: [plateCatalog.data[0], plateCatalog.data[2]] }));
    const adapterInput = await evaluationInput();
    const output = await adapterWith(fetchImpl).quote(adapterInput);
    expect(calls).toEqual(["/v1/analyze", "/v1/materials"]);
    expect(output).toMatchObject({ status: "manual_vendor_followup", unitPriceUsd: null,
      rawPayload: { reason: "stock_not_offered", terminalState: "configuration_required" } });
    expect(assertProviderAdapterContract({ definition: RMFG_CONTRACT, adapterInput, output }))
      .toMatchObject({ terminalState: "configuration_required" });
  });

  it("reports an unrecognized ready quote as a manual review failure with no price", async () => {
    const { fetchImpl } = fakeFetch((url) => url.pathname === "/v1/quotes"
      ? { status: 201, body: { ...plateQuote, amount_shipping_cents: 1500 } } : platePath()(url));
    const error = await adapterWith(fetchImpl).quote(await evaluationInput()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ payload: { reason: "quote_totals_unverified", terminalState: "manual_review" } });
    expect(evaluateProviderAdapterFailureContract(error)).toMatchObject({ ok: true });
  });

  it.each([
    ["a quantity other than 1", { requestedQuantity: 5 }],
    ["no stated stock", { requirement: { material: "6061-T6",
      spec_snapshot: { process: "sheet_metal_laser_cutting", rmfgSelections: { "part-plate": { materialId: "stock-6061-125" } } } } }],
    ["a stated stock alongside person-chosen IDs", { requirement: { material: "6061-T6",
      spec_snapshot: { process: "sheet_metal_laser_cutting", rmfgStock: { grade: "6061-T6", thicknessIn: 0.125 },
        rmfgSelections: { "part-plate": { materialId: "stock-6061-125" } } } } }],
  ])("refuses %s in a live evaluation before any request", async (_label, overrides) => {
    const { calls, fetchImpl } = fakeFetch(platePath());
    const error = await adapterWith(fetchImpl).quote(await evaluationInput(overrides as Partial<VendorQuoteAdapterInput>))
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ payload: { reason: "evaluation_scope_unapproved", terminalState: "unsupported",
      providerInteractionAttempted: false } });
    expect(calls).toEqual([]);
  });

  it("checks evaluation file authorization before scope and provider checkpoints", async () => {
    const { calls, fetchImpl } = fakeFetch(platePath());
    const checkpoint = vi.fn(async () => undefined);
    const adapterInput = await evaluationInput({ requestedQuantity: 5 });
    (adapterInput.liveEvaluationAuthorization as { nonExportControlled: boolean }).nonExportControlled = false;
    const inputWithCheckpoint = adapterInput as VendorQuoteAdapterInput & RmfgDispatchSeams;
    inputWithCheckpoint.providerKillSwitchCheckpoint = checkpoint;
    await expect(adapterWith(fetchImpl).quote(inputWithCheckpoint)).rejects.toMatchObject({
      payload: { reason: "evaluation_file_authorization_missing", providerInteractionAttempted: false },
    });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("reports a malformed mounted key as a finite refusal that names nothing about the key", async () => {
    const { calls, fetchImpl } = fakeFetch(platePath());
    const error = await adapterWith(fetchImpl, { [RMFG_API_KEY_ENV]: `${SYNTHETIC_KEY} ` }).quote(await evaluationInput())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ payload: { reason: "rmfg_api_key_malformed", terminalState: "unavailable" } });
    expect(evaluateProviderAdapterFailureContract(error)).toMatchObject({ ok: true });
    expect(JSON.stringify(error)).not.toContain(SYNTHETIC_KEY);
    expect(calls).toEqual([]);
  });

  it("starts no request once the run has returned, even if a checkpoint resolves late", async () => {
    const { calls, fetchImpl } = fakeFetch(platePath());
    const adapterInput = await evaluationInput({
      providerKillSwitchCheckpoint: async (checkpoint) => {
        if (checkpoint === "before_upload") await new Promise((resolve) => setTimeout(resolve, 11_000));
      },
    });
    vi.useFakeTimers();
    try {
      const pending = adapterWith(fetchImpl).quote(adapterInput).catch((caught: unknown) => caught);
      // The step's ten second budget ends the run; the late checkpoint then finds it closed.
      await vi.advanceTimersByTimeAsync(12_000);
      expect(await pending).toMatchObject({ payload: { reason: "transport_error", terminalState: "unavailable" } });
      expect(calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a copy of an authorized input, which carries no captured bytes", async () => {
    const { calls, fetchImpl } = fakeFetch(platePath());
    const adapterInput = await evaluationInput();
    const tampered = { ...adapterInput } as typeof adapterInput;
    await expect(adapterWith(fetchImpl).quote(tampered))
      .rejects.toMatchObject({ payload: { reason: "evaluation_file_authorization_missing" } });
    expect(calls).toEqual([]);
  });
});

// OVD-722 through the real guard: the same guardProviderQuote wrapping the
// generic dispatch route puts around a live adapter, with a synthetic reader.
function killSwitchState(engaged: boolean, globalEngaged = false) {
  return { schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA, provider: "rmfg", engaged, globalEngaged };
}

function guardedRmfgQuote(fetchImpl: typeof fetch, reader: ProviderKillSwitchReader) {
  const adapter = adapterWith(fetchImpl);
  const launched = vi.fn();
  const quote = guardProviderQuote(createProviderKillSwitchGuard(reader, "rmfg"), (input) => adapter.quote(input), launched);
  return { quote, launched };
}

describe("RMFG live adapter behind the provider kill switch guard (OVD-722)", () => {
  it("refuses before launch with no request when the RMFG switch is engaged", async () => {
    const { calls, fetchImpl } = fakeFetch(happyPath);
    const reader = vi.fn(async () => killSwitchState(true));
    const { quote, launched } = guardedRmfgQuote(fetchImpl, reader);
    const error = await quote(await authorizedInput()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderKillSwitchError);
    expect(error).toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_ENGAGED, provider: "rmfg", checkpoint: "before_launch" });
    expect(launched).not.toHaveBeenCalled();
    expect(reader).toHaveBeenCalledWith("rmfg");
    expect(calls).toEqual([]);
  });

  it("refuses before launch with no request when the global switch is engaged", async () => {
    const { calls, fetchImpl } = fakeFetch(happyPath);
    const { quote } = guardedRmfgQuote(fetchImpl, async () => killSwitchState(false, true));
    const error = await quote(await authorizedInput()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_ENGAGED, checkpoint: "before_launch" });
    expect(calls).toEqual([]);
  });

  it("fails closed with no request when the switch state cannot be read", async () => {
    const { calls, fetchImpl } = fakeFetch(happyPath);
    const { quote } = guardedRmfgQuote(fetchImpl, async () => { throw new Error("synthetic rpc outage"); });
    const error = await quote(await authorizedInput()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_UNAVAILABLE, retryable: true, checkpoint: "before_launch" });
    expect(calls).toEqual([]);
  });

  it("stops before the next RMFG request when the switch engages mid quote", async () => {
    const { calls, fetchImpl } = fakeFetch(happyPath);
    let reads = 0;
    // Launch, before_navigation, before_upload (analyze), before_navigation (materials) pass; the next read is engaged.
    const { quote, launched } = guardedRmfgQuote(fetchImpl, async () => killSwitchState(++reads > 4));
    const error = await quote(await authorizedInput()).catch((caught: unknown) => caught);
    expect(launched).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_ENGAGED, checkpoint: "before_configure" });
    expect(calls).toEqual(["/v1/analyze", "/v1/materials"]);
  });

  it("runs to a quote when every read is disengaged", async () => {
    const { calls, fetchImpl } = fakeFetch(happyPath);
    const reader = vi.fn(async () => killSwitchState(false));
    const { quote } = guardedRmfgQuote(fetchImpl, reader);
    await expect(quote(await authorizedInput())).resolves.toMatchObject({ vendor: "rmfg", status: "instant_quote_received" });
    expect(reader).toHaveBeenCalledTimes(5);
    expect(calls).toEqual(["/v1/analyze", "/v1/materials", "/v1/quotes"]);
  });
});
