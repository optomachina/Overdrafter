// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fixtureHealSupplierPause, handleVendorQuoteTask } from "../index";
import { XometryAdapter } from "../adapters/xometry";
import { HISTORY_COLUMNS } from "./sanityHistory";
import { computeAndStoreRoutingScores } from "../scoringIntegration";
import type { QueueTaskRecord, VendorQuoteAdapterOutput, WorkerConfig } from "../types";
import { providerDispatchReservation } from "../../test-support/providerDispatchReservation";
import {
  ACCEPTANCE_BACKOFF_MS, ACCEPTANCE_SCENARIOS, CLAIMED_LOCKED_AT, expectClaimBoundary, prepareAcceptanceScenario, stubAcceptanceRpc,
} from "../../test-support/claimFencedAcceptance";

vi.mock("../files.js", async (original) => ({
  ...await original<typeof import("../files.js")>(), createRunDir: vi.fn(async () => "/tmp/owned-fake-stage"),
  stageStorageObject: vi.fn(async (_db, file) => file ? ({ originalName: file.original_name, localPath: "/tmp/fake.step",
    storageBucket: file.storage_bucket, storagePath: file.storage_path, trustedContentSha256: "b".repeat(64) }) : null),
  cleanupPaths: vi.fn(async () => undefined),
}));
vi.mock("../scoringIntegration.js", () => ({ computeAndStoreRoutingScores: vi.fn(async () => undefined) }));
vi.mock("../exportControl.js", async (original) => ({
  ...await original<typeof import("../exportControl.js")>(),
  readStagedStepHeaderPrefix: vi.fn(async () => new TextEncoder().encode("ISO-10303-21;\nHEADER;\nENDSEC;\n")),
}));

const task = { id: "task", organization_id: "org", quote_run_id: "run", part_id: "part", job_id: "job",
  task_type: "run_vendor_quote", attempts: 1, locked_at: "2026-10-11T00:00:00Z",
  payload: { vendor: "xometry", vendorQuoteResultId: "result", requestedQuantity: 1 } } as QueueTaskRecord;
const live = { workerMode: "live", workerName: "worker", workerLiveAdapters: ["xometry"], xometryUserDataDir: null,
  xometryProfileSnapshotBucket: null, workerTempDir: "/tmp/owned-fake-stage" } as unknown as WorkerConfig;
const part = { id: "part", job_id: "job", organization_id: "org", name: "part", normalized_key: "part",
  cad_file_id: "cad", drawing_file_id: null, quantity: 1 };
const cad = { id: "cad", job_id: "job", storage_bucket: "bucket", storage_path: "p/file.step",
  original_name: "file.step", file_kind: "cad" };
const requirement = { id: "req", part_id: "part", description: "d", part_number: "pn", revision: null,
  material: "Aluminum 6061-T6", finish: null, tightest_tolerance_inch: null, quantity: 1, quote_quantities: [1],
  requested_by_date: null, applicable_vendors: ["xometry"], updated_at: "2026-10-11T00:00:00Z", spec_snapshot: {} };
const xometryAuthorized = { authorized: true, reasonCode: null, permitId: "00000000-0000-4000-8000-000000003680",
  provider: "xometry", scopeFingerprint: "a".repeat(64), envelopeRevision: "xometry-controlled-beta-envelope.v1",
  nonExportControlled: true };

/** In-memory DB; `events` records the history read, the atomic finalize and routing scores in order. */
function database(options: { historyError?: boolean; laneSettled?: boolean; material?: string } = {}) {
  const events: string[] = [];
  const rpcArgs: Record<string, Record<string, unknown>> = {};
  const writes: Record<string, unknown>[] = [];
  const from = (table: string) => {
    let columns = "";
    let mutation = false;
    const response = () => {
      if (mutation) {
        if (table === "work_queue") return { data: [{ id: "task" }], error: null };
        // A compare-and-set lane write matches the row unless the lane was settled elsewhere.
        if (table === "vendor_quote_results") return { data: options.laneSettled ? [] : [{ id: "result" }], error: null };
        return { data: null, error: null };
      }
      if (table === "vendor_quote_results" && columns === "status" && options.laneSettled) {
        return { data: { status: "failed" }, error: null };
      }
      if (table === "vendor_quote_results" && columns === HISTORY_COLUMNS) {
        events.push("sanity_history");
        return options.historyError ? { data: null, error: { message: "history read failed" } } : { data: [], error: null };
      }
      const data = table === "parts" ? part : table === "job_files" ? [cad]
        : table === "approved_part_requirements" ? { ...requirement, material: options.material ?? requirement.material }
          : table === "vendor_quote_results" ? (columns === "status" ? [{ status: "manual_review_pending" }] : { id: "result", requested_quantity: 1 })
            : table === "jobs" ? { organization_id: "org", status: "internal_review" }
              : table === "quote_runs" ? { status: "received", quote_requests: { status: "requesting" } } : null;
      return { data, error: null };
    };
    const query = {
      select(value: string) { columns = value; return query; },
      eq() { return query; }, neq() { return query; }, is() { return query; }, in() { return query; },
      gte() { return query; }, or() { return query; }, order() { return query; }, limit() { return query; },
      single: async () => response(), maybeSingle: async () => response(),
      update(value: unknown) { mutation = true; writes.push({ table, update: structuredClone(value) }); return query; },
      insert(value: unknown) { mutation = true; writes.push({ table, insert: structuredClone(value) }); return query; },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        return Promise.resolve(response()).then(resolve, reject);
      },
    };
    return query;
  };
  const rpc = (name: string, args: Record<string, unknown>) => {
    if (name === "accept_vendor_quote_result") events.push("finalize");
    rpcArgs[name] = args;
    const data = name === "accept_vendor_quote_result" ? { outcome: "accepted" } : name === "api_worker_provider_kill_switch_state"
      ? { schema: "provider-kill-switch-state.v1", provider: args.p_provider, engaged: false, globalEngaged: false }
      : name === "api_authorize_xometry_beta_worker_dispatch" ? xometryAuthorized
        : name === "api_reserve_spend" ? { allowed: true, reservationId: "r" }
          : name === "api_worker_reserve_provider_dispatch" ? providerDispatchReservation(args.p_provider)
          : name === "api_record_export_control_clean_scan" ? "export-scan"
            : name === "api_check_export_control_dispatch" ? { allowed: true }
              : name === "api_get_worker_sourcing_intent" ? { activeDeadline: null, destination: { state: "confirmed",
                confirmationRevision: "1", street: "s", city: "c", region: "WA", postalCode: "z", country: "US" } } : null;
    const result = Promise.resolve({ data, error: null });
    return Object.assign(result, { abortSignal: () => result });
  };
  return { client: { from, rpc } as unknown as SupabaseClient, events, rpcArgs, writes };
}

function xometryOutput(selectedMaterial: string): VendorQuoteAdapterOutput {
  return {
    vendor: "xometry",
    status: "instant_quote_received",
    unitPriceUsd: 45.56,
    totalPriceUsd: 45.56,
    leadTimeBusinessDays: 7,
    quoteUrl: "https://www.xometry.com/quoting/quote/abc",
    dfmIssues: [],
    notes: ["Live Xometry quote captured via Playwright."],
    artifacts: [],
    rawPayload: { detectedFlow: "instant_quote", selectedMaterial, requestedQuantity: 1 },
  };
}

function scoringRecordsInto(events: string[]) {
  vi.mocked(computeAndStoreRoutingScores).mockImplementation(async () => {
    events.push("routing_scores");
  });
}

afterEach(() => {
  vi.useRealTimers();
  fixtureHealSupplierPause.release("xometry", { via: "reverify", evidenceRef: "test-cleanup" });
  vi.restoreAllMocks();
});

describe("OVD-813 sanity gate on the Xometry persist path", () => {
  it("xometry_path_runs_gate_before_finalize", async () => {
    vi.spyOn(XometryAdapter.prototype, "quote").mockResolvedValue(xometryOutput("6061-T6"));
    const db = database();
    scoringRecordsInto(db.events);

    await handleVendorQuoteTask(db.client, task, live);

    // Gate (own and peer history reads) first, then the atomic finalize, then routing scores.
    expect(db.events).toEqual(["sanity_history", "sanity_history", "finalize", "routing_scores"]);
    const finalize = db.rpcArgs.accept_vendor_quote_result;
    expect(finalize.p_result).toMatchObject({
      status: "instant_quote_received",
      unit_price_usd: 45.56,
      raw_payload: { fixtureSanity: { verdict: "pass", held: false, packageId: expect.stringMatching(/^[a-f0-9]{64}$/) } },
    });
    expect(finalize.p_offers).toHaveLength(1);
    expect(fixtureHealSupplierPause.isPaused("xometry")).toBe(false);
  });

  it("xometry_stainless_summary_label_passes", async () => {
    // Xometry's saved summary for 304 is "Stainless Steel 304/304L" (xometryConstraints MATERIAL_SUMMARY_MAPPINGS).
    vi.spyOn(XometryAdapter.prototype, "quote").mockResolvedValue(xometryOutput("Stainless Steel 304/304L"));
    const db = database({ material: "304 Stainless" });
    scoringRecordsInto(db.events);

    await handleVendorQuoteTask(db.client, task, live);

    expect(db.rpcArgs.accept_vendor_quote_result.p_result).toMatchObject({
      status: "instant_quote_received",
      raw_payload: { fixtureSanity: { verdict: "pass", held: false, findings: [] } },
    });
    expect(fixtureHealSupplierPause.isPaused("xometry")).toBe(false);
  });

  it("xometry_hold_skips_routing_scores", async () => {
    const page = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const quote = vi.spyOn(XometryAdapter.prototype, "quote").mockResolvedValue(xometryOutput("5052-H32"));
    const db = database();
    scoringRecordsInto(db.events);

    await handleVendorQuoteTask(db.client, task, live);

    // Held: finalized without prices or offers, and no routing scores computed from it.
    expect(db.events).toEqual(["sanity_history", "sanity_history", "finalize"]);
    expect(computeAndStoreRoutingScores).not.toHaveBeenCalled();
    const finalize = db.rpcArgs.accept_vendor_quote_result;
    expect(finalize.p_offers).toEqual([]);
    expect(finalize.p_result).toMatchObject({
      status: "manual_review_pending",
      unit_price_usd: null,
      total_price_usd: null,
      raw_payload: {
        offers: [],
        fixtureSanity: {
          verdict: "hold",
          findings: [{ code: "material_echo", class: "hard" }],
          withheldResult: { unitPriceUsd: 45.56, totalPriceUsd: 45.56 },
        },
      },
    });
    // The first drift finding paused Xometry and paged.
    expect(fixtureHealSupplierPause.isPaused("xometry")).toBe(true);
    expect(page.mock.calls.some(([line]) => String(line).includes("\"source\":\"fixture_heal.pause\""))).toBe(true);

    // The next customer quote for the paused supplier never reaches the adapter.
    const next = database();
    await handleVendorQuoteTask(next.client, task, live);
    expect(quote).toHaveBeenCalledOnce();
    expect(next.rpcArgs.accept_vendor_quote_result).toBeUndefined();
    expect(next.writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "vendor_quote_results", update: expect.objectContaining({
        status: "manual_vendor_followup",
        raw_payload: expect.objectContaining({ failureCode: "provider_paused_fixture_heal" }),
      }) }),
    ]));
  });

  it("xometry_pause_while_in_flight_holds_the_result", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Admitted at claim; another Xometry lane pauses the supplier while this one quotes.
    vi.spyOn(XometryAdapter.prototype, "quote").mockImplementation(async () => {
      fixtureHealSupplierPause.pause({ provider: "xometry", codes: ["material_echo"], runId: "other", vendorQuoteResultId: "other", nowMs: Date.now() });
      return xometryOutput("6061-T6");
    });
    const db = database();
    scoringRecordsInto(db.events);

    await handleVendorQuoteTask(db.client, task, live);

    expect(computeAndStoreRoutingScores).not.toHaveBeenCalled();
    const finalize = db.rpcArgs.accept_vendor_quote_result;
    expect(finalize.p_offers).toEqual([]);
    expect(finalize.p_result).toMatchObject({
      status: "manual_review_pending",
      unit_price_usd: null,
      raw_payload: { fixtureSanity: { verdict: "pass", held: true, holdReason: "supplier_paused" } },
    });
  });

  it("xometry_history_unavailable_holds_without_pausing", async () => {
    vi.spyOn(XometryAdapter.prototype, "quote").mockResolvedValue(xometryOutput("6061-T6"));
    const db = database({ historyError: true });
    scoringRecordsInto(db.events);

    await handleVendorQuoteTask(db.client, task, live);

    expect(computeAndStoreRoutingScores).not.toHaveBeenCalled();
    const finalize = db.rpcArgs.accept_vendor_quote_result;
    expect(finalize.p_offers).toEqual([]);
    expect(finalize.p_result).toMatchObject({
      status: "manual_review_pending",
      unit_price_usd: null,
      raw_payload: { fixtureSanity: { verdict: "hold", holdReason: "sanity", pause: false,
        findings: [{ code: "history_unavailable", class: "unavailable" }] } },
    });
    // Not supplier drift: Xometry stays unpaused.
    expect(fixtureHealSupplierPause.isPaused("xometry")).toBe(false);
  });

  it("xometry_throwing_gate_holds_the_result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(XometryAdapter.prototype, "quote").mockResolvedValue(xometryOutput("6061-T6"));
    // The claim-time admits() check passes; the gate itself throws.
    vi.spyOn(fixtureHealSupplierPause, "isPaused").mockImplementation(() => {
      throw new Error("gate exploded");
    });
    const db = database();
    scoringRecordsInto(db.events);

    await handleVendorQuoteTask(db.client, task, live);

    // Persisted held, never the unchecked price, and the task is completed (no retry).
    expect(computeAndStoreRoutingScores).not.toHaveBeenCalled();
    const finalize = db.rpcArgs.accept_vendor_quote_result;
    expect(finalize.p_offers).toEqual([]);
    expect(finalize.p_result).toMatchObject({
      status: "manual_review_pending",
      unit_price_usd: null,
      total_price_usd: null,
      raw_payload: { fixtureSanity: { held: true, holdReason: "fixture_sanity_failed",
        packageId: expect.stringMatching(/^[a-f0-9]{64}$/),
        withheldResult: { unitPriceUsd: 45.56, totalPriceUsd: 45.56 } } },
    });
    expect(warn.mock.calls.some(([line]) => String(line).includes("fixture_sanity_failed"))).toBe(true);
    expect(db.writes.filter((write) => write.table === "work_queue")).toEqual([]);
    expect(db.rpcArgs.accept_vendor_quote_result.p_task_payload_patch).toMatchObject({ vendorStatus: "manual_review_pending" });
  });

  it("xometry_paused_claim_write_is_compare_and_set", async () => {
    fixtureHealSupplierPause.pause({ provider: "xometry", codes: ["material_echo"], runId: "r", vendorQuoteResultId: "r", nowMs: Date.now() });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const quote = vi.spyOn(XometryAdapter.prototype, "quote");
    const db = database({ laneSettled: true });

    await handleVendorQuoteTask(db.client, task, live);

    // The lane was settled elsewhere: it is not overwritten as completed; the task fails with a stable code.
    expect(quote).not.toHaveBeenCalled();
    const queueUpdates = db.writes.filter((write) => write.table === "work_queue").map((write) => write.update);
    expect(queueUpdates).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(JSON.stringify(queueUpdates)).toContain("lane_already_settled");
  });

  it("xometry_priced_manual_review_result_is_gated", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Manual review flagged, but the price locator still matched: the result carries a price.
    vi.spyOn(XometryAdapter.prototype, "quote").mockResolvedValue({
      ...xometryOutput("5052-H32"),
      status: "manual_review_pending",
      offers: [],
    });
    const db = database();
    scoringRecordsInto(db.events);

    await handleVendorQuoteTask(db.client, task, live);

    // Checked, not skipped: the drifting price is withheld, so no offer row is written.
    expect(db.events[0]).toBe("sanity_history");
    const finalize = db.rpcArgs.accept_vendor_quote_result;
    expect(finalize.p_offers).toEqual([]);
    expect(finalize.p_result).toMatchObject({
      status: "manual_review_pending",
      unit_price_usd: null,
      total_price_usd: null,
      raw_payload: {
        fixtureSanity: {
          verdict: "hold",
          findings: [{ code: "material_echo", class: "hard" }],
          withheldStatus: "manual_review_pending",
          withheldResult: { unitPriceUsd: 45.56, totalPriceUsd: 45.56 },
        },
      },
    });
    expect(fixtureHealSupplierPause.isPaused("xometry")).toBe(true);
  });
});


describe("claim-fenced acceptance route", () => {
  it.each(ACCEPTANCE_SCENARIOS)("$name preserves the claim boundary", async (scenario) => {
    prepareAcceptanceScenario();
    vi.spyOn(XometryAdapter.prototype, "quote").mockResolvedValue(xometryOutput("6061-T6"));
    const db = database();
    const stub = stubAcceptanceRpc(db.client, scenario);
    const claimed = { ...task, locked_by: "worker", locked_at: CLAIMED_LOCKED_AT };
    const run = handleVendorQuoteTask(db.client, claimed, live);
    const assertion = scenario.failed
      ? expect(run).rejects.toMatchObject({ code: "persistence_failure" })
      : expect(run).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(ACCEPTANCE_BACKOFF_MS);
    await assertion;
    expectClaimBoundary({ scenario, stub, claimed, taskPayloadPatch: { vendorStatus: "instant_quote_received", artifactCount: 0 }, writes: db.writes });
  });
});
