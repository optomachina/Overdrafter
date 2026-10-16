// @vitest-environment node

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { genericAuthorizedResponse } from "../test-support/genericDispatchResponse";
import { dispatchAuthorizationFailure, quoteWithRoutedDispatchPreflight } from "./dispatchRouting";
import { ProviderDispatchAuthorizationError } from "./providerDispatchPreflight";
import {
  assertProviderKillSwitchDisengaged,
  CANCELLED_PROVIDER_DISABLED,
  checkProviderKillSwitchAtClaim,
  createProviderKillSwitchGuard,
  parseProviderKillSwitchState,
  PROVIDER_KILL_SWITCH_ENGAGED,
  PROVIDER_KILL_SWITCH_RPC,
  PROVIDER_KILL_SWITCH_STATE_SCHEMA,
  PROVIDER_KILL_SWITCH_TIMEOUT_MS,
  PROVIDER_KILL_SWITCH_UNAVAILABLE,
  PROVIDER_TEMPORARILY_UNAVAILABLE_NOTE,
  ProviderKillSwitchError,
  supabaseProviderKillSwitchReader,
  providerKillSwitchSweepWarnings,
  sweepProviderDisabledTasks,
} from "./providerKillSwitch";
import { createProviderMutationPhase } from "./providerMutationPhase";
import type { QueueTaskRecord, VendorName, VendorQuoteAdapterInput, VendorQuoteAdapterOutput } from "./types";
import { failureCodeForError, isRetryableVendorTaskError } from "./vendorTaskRetry";
import { XometryDispatchAuthorizationError } from "./xometryDispatchPreflight";
import { providerDispatchReservation } from "../test-support/providerDispatchReservation";

/**
 * In-memory stand-in for private.provider_kill_switches and
 * private.provider_global_kill_switch. Flipping it is the "data flip": the
 * module under test is imported once and never reloaded.
 */
function killSwitchStore(initial: Partial<Record<VendorName, boolean>> = {}) {
  const providers = new Map<VendorName, boolean>(Object.entries(initial) as [VendorName, boolean][]);
  const store = {
    global: false,
    set(provider: VendorName, engaged: boolean) {
      providers.set(provider, engaged);
    },
    state(provider: VendorName) {
      return {
        schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA,
        provider,
        // Mirrors the SQL: a provider without a row is engaged (fail-closed).
        engaged: providers.get(provider) ?? true,
        globalEngaged: store.global,
      };
    },
  };
  return store;
}

const SEEDED: Partial<Record<VendorName, boolean>> = {
  xometry: false, fictiv: false, quickparts: false, weerg: false, geomiq: false, rmfg: false,
};
const PROVIDERS_1_0: VendorName[] = ["xometry", "fictiv", "quickparts", "weerg", "geomiq", "rmfg"];

const xometryAuthorized = {
  authorized: true,
  reasonCode: null,
  permitId: "00000000-0000-4000-8000-000000003680",
  provider: "xometry",
  scopeFingerprint: "a".repeat(64),
  envelopeRevision: "xometry-controlled-beta-envelope.v1",
  nonExportControlled: true,
};

/**
 * A fake Supabase whose kill-switch RPC reads the live store on every call,
 * exactly like the production reader. `onPreflight` lets a test flip the
 * switch between the server authorization and the worker launch.
 */
function fakeSupabase(
  store: ReturnType<typeof killSwitchStore>,
  options: { preflight?: unknown; onPreflight?: () => void } = {},
) {
  const calls: string[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push(name);
    if (name === PROVIDER_KILL_SWITCH_RPC) {
      return { data: store.state(args.p_provider as VendorName), error: null };
    }
    if (name === "api_worker_reserve_provider_dispatch") {
      return { data: providerDispatchReservation(args.p_provider), error: null };
    }
    if (name === "api_authorize_xometry_beta_worker_dispatch" || name === "api_authorize_provider_worker_dispatch") {
      options.onPreflight?.();
      return { data: options.preflight ?? xometryAuthorized, error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  });
  return { client: { rpc } as unknown as SupabaseClient, rpc, calls };
}

function routedRun(
  supabase: SupabaseClient,
  quote: ReturnType<typeof vi.fn>,
  vendor: VendorName = "xometry",
  onAuthorized = vi.fn(),
) {
  return quoteWithRoutedDispatchPreflight({
    supabase,
    config: { workerMode: "live", workerName: "worker-1" },
    task: { id: "00000000-0000-4000-8000-000000000001", payload: {} },
    vendorQuoteResultId: "00000000-0000-4000-8000-000000000002",
    claimedAt: "2026-10-11T12:00:00.000Z",
    vendor,
    scopeSnapshot: { schema: "quote-lane-scope.v1", vendor },
    adapter: { quote },
    quoteInput: { organizationId: "org-1", quoteRunId: "run-1", requestedQuantity: 1 } as unknown as VendorQuoteAdapterInput,
    onAuthorized,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("provider kill switch state parsing (OVD-722)", () => {
  it("accepts only an exact v1 object for the requested provider", () => {
    const ok = { schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA, provider: "fictiv", engaged: false, globalEngaged: false };
    expect(parseProviderKillSwitchState(ok, "fictiv")).toEqual({ engaged: false });
    expect(parseProviderKillSwitchState({ ...ok, engaged: true }, "fictiv")).toEqual({ engaged: true });
    expect(parseProviderKillSwitchState({ ...ok, globalEngaged: true }, "fictiv")).toEqual({ engaged: true });
  });

  it.each([
    ["null", null],
    ["array", []],
    ["wrong provider", { schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA, provider: "weerg", engaged: false, globalEngaged: false }],
    ["wrong schema", { schema: "v0", provider: "fictiv", engaged: false, globalEngaged: false }],
    ["string flag", { schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA, provider: "fictiv", engaged: "false", globalEngaged: false }],
    ["missing global", { schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA, provider: "fictiv", engaged: false }],
    ["extra key", { schema: PROVIDER_KILL_SWITCH_STATE_SCHEMA, provider: "fictiv", engaged: false, globalEngaged: false, x: 1 }],
  ])("treats a %s response as unknown", (_label, data) => {
    expect(parseProviderKillSwitchState(data, "fictiv")).toBeNull();
  });
});

describe("provider kill switch checkpoint (OVD-722)", () => {
  it("denies an engaged provider with the terminal provider_kill_switch_engaged code; other providers pass", async () => {
    const store = killSwitchStore({ ...SEEDED, fictiv: true });
    const reader = async (provider: VendorName) => store.state(provider);
    const denial = assertProviderKillSwitchDisengaged({ reader, provider: "fictiv", checkpoint: "before_launch" });
    await expect(denial).rejects.toBeInstanceOf(ProviderKillSwitchError);
    await expect(denial).rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_ENGAGED, retryable: false });
    for (const provider of PROVIDERS_1_0.filter((p) => p !== "fictiv")) {
      await expect(assertProviderKillSwitchDisengaged({ reader, provider, checkpoint: "before_launch" })).resolves.toBeUndefined();
    }
  });

  it("fails closed when the read throws", async () => {
    const reader = vi.fn(async () => {
      throw new Error("connection reset");
    });
    await expect(assertProviderKillSwitchDisengaged({ reader, provider: "weerg", checkpoint: "before_launch" }))
      .rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_UNAVAILABLE, retryable: true });
  });

  it("fails closed when the reader throws synchronously", async () => {
    const reader = (() => {
      throw new Error("sync");
    }) as unknown as (provider: VendorName) => Promise<unknown>;
    await expect(assertProviderKillSwitchDisengaged({ reader, provider: "weerg", checkpoint: "before_upload" }))
      .rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_UNAVAILABLE });
  });

  it("fails closed when the read takes longer than 2 seconds", async () => {
    vi.useFakeTimers();
    expect(PROVIDER_KILL_SWITCH_TIMEOUT_MS).toBe(2_000);
    const reader = vi.fn(() => new Promise<unknown>(() => undefined));
    const pending = assertProviderKillSwitchDisengaged({ reader, provider: "geomiq", checkpoint: "before_launch" });
    const assertion = expect(pending).rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_UNAVAILABLE });
    await vi.advanceTimersByTimeAsync(PROVIDER_KILL_SWITCH_TIMEOUT_MS + 1);
    await assertion;
  });

  it("fails closed on a malformed response", async () => {
    await expect(assertProviderKillSwitchDisengaged({
      reader: async () => ({ engaged: false }),
      provider: "quickparts",
      checkpoint: "before_configure",
    })).rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_UNAVAILABLE });
  });

  it("treats a provider with no kill-switch row as engaged (fail-closed seed)", async () => {
    const store = killSwitchStore({});
    await expect(assertProviderKillSwitchDisengaged({
      reader: async (provider) => store.state(provider),
      provider: "rmfg",
      checkpoint: "claim",
    })).rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_ENGAGED });
  });

  it("global switch denies every provider; turning it off restores each provider's own state", async () => {
    const store = killSwitchStore({ ...SEEDED, weerg: true });
    const reader = async (provider: VendorName) => store.state(provider);
    store.global = true;
    for (const provider of PROVIDERS_1_0) {
      await expect(assertProviderKillSwitchDisengaged({ reader, provider, checkpoint: "before_launch" }))
        .rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_ENGAGED });
    }
    store.global = false;
    for (const provider of PROVIDERS_1_0) {
      const check = assertProviderKillSwitchDisengaged({ reader, provider, checkpoint: "before_launch" });
      if (provider === "weerg") await expect(check).rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_ENGAGED });
      else await expect(check).resolves.toBeUndefined();
    }
  });

  it("the production reader calls the state RPC with the provider and refuses on an RPC error", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "function does not exist" } }));
    const reader = supabaseProviderKillSwitchReader({ rpc } as unknown as SupabaseClient);
    await expect(assertProviderKillSwitchDisengaged({ reader, provider: "fictiv", checkpoint: "claim" }))
      .rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_UNAVAILABLE });
    expect(rpc).toHaveBeenCalledWith(PROVIDER_KILL_SWITCH_RPC, { p_provider: "fictiv" });
  });
});

describe("RELEASE REQUIREMENT: a data flip takes effect with no deploy or restart (OVD-722)", () => {
  it("same module instance and same guard: flip the stored state and the very next check refuses", async () => {
    const store = killSwitchStore(SEEDED);
    const { client, rpc } = fakeSupabase(store);
    // One guard, built once, like a long-lived worker process.
    const guard = createProviderKillSwitchGuard(supabaseProviderKillSwitchReader(client), "xometry");
    await expect(guard("before_launch")).resolves.toBeUndefined();
    store.set("xometry", true); // admin flip: data only
    await expect(guard("before_navigation")).rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_ENGAGED });
    store.set("xometry", false); // flip back on
    await expect(guard("before_upload")).resolves.toBeUndefined();
    // Every checkpoint re-read the database; nothing was cached.
    expect(rpc.mock.calls.filter(([name]) => name === PROVIDER_KILL_SWITCH_RPC)).toHaveLength(3);
  });

  it("same worker dispatch path: quotes, then refuses after the flip, then quotes again after flipping back", async () => {
    const store = killSwitchStore(SEEDED);
    const { client } = fakeSupabase(store);
    const quote = vi.fn().mockResolvedValue({ artifacts: [] } as unknown as VendorQuoteAdapterOutput);

    await expect(routedRun(client, quote)).resolves.toEqual({ artifacts: [] });
    expect(quote).toHaveBeenCalledTimes(1);

    store.set("xometry", true);
    await expect(routedRun(client, quote)).rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_ENGAGED });
    expect(quote).toHaveBeenCalledTimes(1);

    store.set("xometry", false);
    await expect(routedRun(client, quote)).resolves.toEqual({ artifacts: [] });
    expect(quote).toHaveBeenCalledTimes(2);
  });

  it("a global flip stops a provider on the same running dispatch path", async () => {
    const store = killSwitchStore(SEEDED);
    const { client } = fakeSupabase(store);
    const quote = vi.fn().mockResolvedValue({ artifacts: [] } as unknown as VendorQuoteAdapterOutput);
    store.global = true;
    await expect(routedRun(client, quote)).rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_ENGAGED });
    store.global = false;
    await expect(routedRun(client, quote)).resolves.toEqual({ artifacts: [] });
    expect(quote).toHaveBeenCalledTimes(1);
  });
});

describe("worker re-check after authorization (OVD-722)", () => {
  it("engaged after the server authorized: refuses before launch and the adapter is never called", async () => {
    const store = killSwitchStore(SEEDED);
    const { client, calls } = fakeSupabase(store, { onPreflight: () => store.set("xometry", true) });
    const quote = vi.fn();
    const onAuthorized = vi.fn();
    await expect(routedRun(client, quote, "xometry", onAuthorized))
      .rejects.toMatchObject({ name: "ProviderKillSwitchError", reasonCode: PROVIDER_KILL_SWITCH_ENGAGED, checkpoint: "before_launch" });
    expect(calls).toEqual(["api_authorize_xometry_beta_worker_dispatch", PROVIDER_KILL_SWITCH_RPC]);
    expect(quote).not.toHaveBeenCalled();
    expect(onAuthorized).not.toHaveBeenCalled();
  });

  it("an unreadable switch after authorization refuses before launch (fail-closed)", async () => {
    const store = killSwitchStore(SEEDED);
    const { client, rpc } = fakeSupabase(store);
    rpc.mockImplementation(async (name: string) => name === PROVIDER_KILL_SWITCH_RPC
      ? { data: null, error: { message: "timeout" } }
      : { data: xometryAuthorized, error: null });
    const quote = vi.fn();
    await expect(routedRun(client, quote)).rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_UNAVAILABLE });
    expect(quote).not.toHaveBeenCalled();
  });

  it("hands the bound guard to the adapter for its own navigation/upload/configure checkpoints", async () => {
    const store = killSwitchStore(SEEDED);
    const { client } = fakeSupabase(store);
    const quote = vi.fn(async (input: VendorQuoteAdapterInput) => {
      await input.providerKillSwitchCheckpoint?.("before_navigation");
      store.set("xometry", true); // flipped while the task is running
      await input.providerKillSwitchCheckpoint?.("before_upload");
      throw new Error("unreachable: upload must not happen");
    });
    await expect(routedRun(client, quote)).rejects.toMatchObject({
      reasonCode: PROVIDER_KILL_SWITCH_ENGAGED,
      checkpoint: "before_upload",
    });
  });

  it("does not read the switch in simulate mode (no provider traffic)", async () => {
    const rpc = vi.fn();
    const quote = vi.fn().mockResolvedValue({ artifacts: [] });
    await quoteWithRoutedDispatchPreflight({
      supabase: { rpc } as unknown as SupabaseClient,
      config: { workerMode: "simulate", workerName: "worker-1" },
      task: { id: "t", payload: {} },
      vendorQuoteResultId: "r",
      claimedAt: "2026-10-11T12:00:00.000Z",
      vendor: "fictiv",
      scopeSnapshot: {},
      adapter: { quote },
      quoteInput: {} as VendorQuoteAdapterInput,
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(quote).toHaveBeenCalledWith({});
  });
});

describe("server preflight denial is terminal (OVD-722)", () => {
  it("Xometry preflight denial provider_kill_switch_engaged becomes a terminal kill-switch refusal", async () => {
    const store = killSwitchStore(SEEDED);
    const { client } = fakeSupabase(store, { preflight: { authorized: false, reasonCode: "provider_kill_switch_engaged" } });
    const quote = vi.fn();
    const error = await routedRun(client, quote).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderKillSwitchError);
    expect(error).toMatchObject({ reasonCode: "provider_kill_switch_engaged", provider: "xometry", checkpoint: "server_preflight" });
    expect(isRetryableVendorTaskError(error, createProviderMutationPhase())).toBe(false);
    expect(quote).not.toHaveBeenCalled();
  });

  it("generic preflight denial provider_kill_switch_engaged becomes a terminal kill-switch refusal", async () => {
    const store = killSwitchStore(SEEDED);
    const { client } = fakeSupabase(store, {
      preflight: { schema: "provider-dispatch-authorization.v1", authorized: false, denial: "provider_kill_switch_engaged", retryable: false },
    });
    const quote = vi.fn();
    const error = await quoteWithRoutedDispatchPreflight({
      supabase: client,
      config: { workerMode: "live", workerName: "worker-1" },
      task: { id: "00000000-0000-4000-8000-000000000001", payload: {
        providerDispatchPermitId: "00000000-0000-4000-8000-00000000457c",
        providerDispatchEnvelopeRevision: "fictiv-quote-envelope.v1",
        providerDispatchEnvelopeFingerprint: "c".repeat(64),
      } },
      vendorQuoteResultId: "00000000-0000-4000-8000-000000000002",
      claimedAt: "2026-10-11T12:00:00.000Z",
      vendor: "fictiv",
      scopeSnapshot: { schema: "quote-lane-scope.v1", vendor: "fictiv" },
      adapter: { quote },
      quoteInput: {} as VendorQuoteAdapterInput,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderKillSwitchError);
    expect(error).toMatchObject({ reasonCode: "provider_kill_switch_engaged", provider: "fictiv", checkpoint: "server_preflight", retryable: false });
    expect(quote).not.toHaveBeenCalled();
    // Other preflight denials are untouched.
    expect(new ProviderDispatchAuthorizationError("permit_expired").retryable).toBe(false);
    expect(new XometryDispatchAuthorizationError("dispatch_request_inactive")).not.toBeInstanceOf(ProviderKillSwitchError);
    // The admitted-response fixture still authorizes when the switch is off.
    expect(genericAuthorizedResponse()).toMatchObject({ authorized: true });
  });
});

describe("failure classification (OVD-722)", () => {
  it("maps engaged as terminal and unreadable as retryable only before any provider mutation", () => {
    const engaged = new ProviderKillSwitchError(PROVIDER_KILL_SWITCH_ENGAGED, "fictiv", "before_launch");
    const unavailable = new ProviderKillSwitchError(PROVIDER_KILL_SWITCH_UNAVAILABLE, "fictiv", "before_upload");
    expect(dispatchAuthorizationFailure(engaged)).toEqual({ boundary: "kill_switch", reasonCode: PROVIDER_KILL_SWITCH_ENGAGED, retryable: false });
    expect(failureCodeForError(engaged)).toBe(PROVIDER_KILL_SWITCH_ENGAGED);
    expect(isRetryableVendorTaskError(engaged, createProviderMutationPhase())).toBe(false);
    expect(isRetryableVendorTaskError(unavailable, createProviderMutationPhase())).toBe(true);
    const mutated = createProviderMutationPhase();
    mutated.started = true;
    expect(isRetryableVendorTaskError(unavailable, mutated)).toBe(false);
  });
});

function recordingSupabase() {
  const writes: { table: string; update: Record<string, unknown>; id?: unknown }[] = [];
  const from = (table: string) => {
    const entry: { table: string; update: Record<string, unknown>; id?: unknown } = { table, update: {} };
    const query = {
      update(value: Record<string, unknown>) {
        entry.update = value;
        writes.push(entry);
        return query;
      },
      eq(_column: string, value: unknown) {
        entry.id = value;
        return Promise.resolve({ data: null, error: null });
      },
    };
    return query;
  };
  return { from, writes };
}

const queuedTask = {
  id: "task-1",
  organization_id: "org",
  job_id: "job",
  part_id: "part",
  quote_run_id: "run",
  task_type: "run_vendor_quote",
  attempts: 1,
  payload: { vendor: "weerg", vendorQuoteResultId: "result-1" },
} as unknown as QueueTaskRecord;

describe("queued and running tasks end cancelled_provider_disabled (OVD-722)", () => {
  it("claim-time: an engaged provider's task is cancelled truthfully and nothing proceeds", async () => {
    const store = killSwitchStore({ ...SEEDED, weerg: true });
    const db = recordingSupabase();
    const outcome = await checkProviderKillSwitchAtClaim({
      supabase: db as unknown as SupabaseClient,
      reader: async (provider) => store.state(provider),
      task: queuedTask,
      vendor: "weerg",
      vendorQuoteResultId: "result-1",
      requestedQuantity: 3,
    });
    expect(outcome).toBe("cancelled");
    expect(db.writes).toEqual([
      {
        table: "vendor_quote_results",
        id: "result-1",
        update: {
          status: "failed",
          notes: [PROVIDER_TEMPORARILY_UNAVAILABLE_NOTE],
          raw_payload: expect.objectContaining({
            failureCode: CANCELLED_PROVIDER_DISABLED,
            killSwitchReasonCode: PROVIDER_KILL_SWITCH_ENGAGED,
            killSwitchCheckpoint: "claim",
            providerMutationPossible: false,
            requestedQuantity: 3,
          }),
        },
      },
      {
        table: "work_queue",
        id: "task-1",
        update: expect.objectContaining({
          status: "cancelled",
          last_error: expect.stringContaining(CANCELLED_PROVIDER_DISABLED),
          payload: expect.objectContaining({ cancellationReason: CANCELLED_PROVIDER_DISABLED, killSwitchCheckpoint: "claim" }),
        }),
      },
    ]);
  });

  it("claim-time: a disengaged provider proceeds with no writes", async () => {
    const store = killSwitchStore(SEEDED);
    const db = recordingSupabase();
    await expect(checkProviderKillSwitchAtClaim({
      supabase: db as unknown as SupabaseClient,
      reader: async (provider) => store.state(provider),
      task: queuedTask,
      vendor: "weerg",
      vendorQuoteResultId: "result-1",
      requestedQuantity: 1,
    })).resolves.toBe("proceed");
    expect(db.writes).toEqual([]);
  });

  it("claim-time: an unreadable switch throws (retryable) and writes nothing provider-facing", async () => {
    const db = recordingSupabase();
    await expect(checkProviderKillSwitchAtClaim({
      supabase: db as unknown as SupabaseClient,
      reader: async () => {
        throw new Error("down");
      },
      task: queuedTask,
      vendor: "weerg",
      vendorQuoteResultId: "result-1",
      requestedQuantity: 1,
    })).rejects.toMatchObject({ reasonCode: PROVIDER_KILL_SWITCH_UNAVAILABLE, retryable: true });
    expect(db.writes).toEqual([]);
  });

  it("sweep: parses the cancelled count and the quote runs to refresh", async () => {
    const rpc = vi.fn(async () => ({
      data: { cancelled: 2, resultsUpdated: 2, quoteRuns: [{ jobId: "job", quoteRunId: "run" }, { bogus: true }] },
      error: null,
    }));
    await expect(sweepProviderDisabledTasks({ rpc } as unknown as SupabaseClient))
      .resolves.toEqual({ cancelled: 2, resultsUpdated: 2, skipped: 0, quoteRuns: [{ jobId: "job", quoteRunId: "run" }] });
    expect(rpc).toHaveBeenCalledWith("api_worker_cancel_provider_disabled_tasks");
  });

  it("sweep: reports skipped rows and the operator log warns about them", async () => {
    const rpc = vi.fn(async () => ({ data: { cancelled: 1, resultsUpdated: 1, skipped: 2, quoteRuns: [] }, error: null }));
    const result = await sweepProviderDisabledTasks({ rpc } as unknown as SupabaseClient);
    expect(result).toEqual({ cancelled: 1, resultsUpdated: 1, skipped: 2, quoteRuns: [] });
    expect(providerKillSwitchSweepWarnings(result)).toEqual([
      expect.objectContaining({ context: { cancelled: 1, resultsUpdated: 1 } }),
      expect.objectContaining({ message: expect.stringMatching(/skipped 2 queued task/), context: { skipped: 2 } }),
    ]);
    expect(providerKillSwitchSweepWarnings({ cancelled: 0, resultsUpdated: 0, skipped: 0, quoteRuns: [] })).toEqual([]);
  });

  it("sweep: surfaces RPC errors and malformed responses instead of reporting success", async () => {
    await expect(sweepProviderDisabledTasks({ rpc: async () => ({ data: null, error: new Error("x") }) } as unknown as SupabaseClient))
      .rejects.toThrow();
    await expect(sweepProviderDisabledTasks({ rpc: async () => ({ data: 3, error: null }) } as unknown as SupabaseClient))
      .rejects.toThrow(/malformed/);
  });
});
