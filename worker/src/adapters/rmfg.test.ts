// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../../test-fixtures/provider-dispatch-envelope/geomiq-v1.json";
import { buildProviderDispatchFixtureEnvelope, providerDispatchFixtureAuthorization } from "../../test-support/providerDispatchFixture";
import { loadConfig } from "../config";
import { sha256File } from "../liveEvaluationFiles";
import { REVIEWED_PROVIDER_DISPATCH_ENVELOPES } from "../providerDispatchEnvelope";
import {
  createProviderKillSwitchGuard,
  guardProviderQuote,
  PROVIDER_KILL_SWITCH_ENGAGED,
  PROVIDER_KILL_SWITCH_STATE_SCHEMA,
  PROVIDER_KILL_SWITCH_UNAVAILABLE,
  ProviderKillSwitchError,
  type ProviderKillSwitchReader,
} from "../providerKillSwitch";
import { LIVE_AUTOMATION_VENDORS, VendorAutomationError, type VendorQuoteAdapterInput, type WorkerConfig } from "../types";
import { buildAdapterRegistry } from "./index";
import {
  evaluateRmfgEligibility,
  resetRmfgAdapterStateForTests,
  RMFG_API_KEY_ENV,
  RMFG_DISPATCH_ENVELOPE,
  RmfgAdapter,
  type RmfgDispatchSeams,
} from "./rmfg";
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
  items: [{ design_id: "design-synthetic", quantity: 3, status: "ready",
    unit_amount_cents: 1250, amount_cents: 3750, requirements: [],
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
    ["challenge page", { status: 200, body: null, html: true }, "captcha", "rmfg_challenge_response", "captcha"],
    ["challenge on a 403", { status: 403, body: null, html: true }, "captcha", "rmfg_challenge_response", "captcha"],
    // The client latches 401 and 403 alike, so the replay reports authorization required.
    ["block", { status: 403, body: { error: "forbidden" } }, "anti_detection_block", "rmfg_blocked", "login_required"],
    ["rate limit", { status: 429, body: { error: "slow down" } }, "anti_detection_block", "rmfg_rate_limited", "anti_detection_block"],
    ["login", { status: 401, body: { error: "unauthorized" } }, "login_required", "rmfg_authorization_required", "login_required"],
  ] as const)("stops on a %s and never retries around it", async (_label, reply, code, reason, replayCode) => {
    const { calls, fetchImpl } = fakeFetch((url) => (url.pathname === "/v1/analyze" ? reply : happyPath(url)));
    const first = await adapterWith(fetchImpl).quote(await authorizedInput()).catch((caught: unknown) => caught);
    expect(first).toMatchObject({ code, payload: { reason, retryable: false, terminalState: "manual_follow_up" } });
    expect(calls).toEqual(["/v1/analyze"]);

    // A fresh adapter and client in the same process stays stopped with no request.
    const second = await adapterWith(fetchImpl).quote(await authorizedInput()).catch((caught: unknown) => caught);
    expect(second).toBeInstanceOf(VendorAutomationError);
    expect(second).toMatchObject({ code: replayCode, payload: { retryable: false, terminalState: "manual_follow_up" } });
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
    await expect(adapterWith(fetchImpl).quote(await authorizedInput({ executionContext: "live_evaluation" })))
      .rejects.toMatchObject({ payload: { reason: "rmfg_live_evaluation_unsupported" } });
    await expect(adapterWith(fetchImpl, {}).quote(await authorizedInput()))
      .rejects.toMatchObject({ payload: { reason: "rmfg_api_key_missing" } });
    expect(calls).toEqual([]);
  });

  it("refuses with no request once the daily cap is spent", async () => {
    const { calls, fetchImpl } = fakeFetch(happyPath);
    const now = () => new Date("2026-10-13T12:00:00Z");
    const adapter = new RmfgAdapter(liveConfig(), { env: { [RMFG_API_KEY_ENV]: SYNTHETIC_KEY },
      createTransport: (apiKey) => createRmfgHttpTransport({ apiKey, fetchImpl, now, dailyQuoteCap: 1 }) });
    await expect(adapter.quote(await authorizedInput())).resolves.toMatchObject({ status: "instant_quote_received" });
    await expect(adapter.quote(await authorizedInput()))
      .rejects.toMatchObject({ payload: { reason: "provider_daily_cap_reached", providerInteractionAttempted: false } });
    expect(calls.filter((call) => call === "/v1/analyze")).toHaveLength(1);
  });

  it("is listed for live automation but stays out of the default live registry", () => {
    expect(LIVE_AUTOMATION_VENDORS).toContain("rmfg");
    // The envelope is reviewed in code (OVD-687), which admits nothing without a review row and the live registry.
    expect(REVIEWED_PROVIDER_DISPATCH_ENVELOPES.some((envelope) => envelope.provider === "rmfg")).toBe(true);
    const defaults = loadConfig({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "synthetic",
      WORKER_MODE: "live" } as NodeJS.ProcessEnv);
    expect(defaults.workerLiveAdapters).not.toContain("rmfg");
    expect(Object.keys(buildAdapterRegistry(defaults))).not.toContain("rmfg");
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
