// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleVendorQuoteTask, processClaimedTask } from "../index";
import { createWorkerRuntimeState } from "../httpServer";
import { collectXometryOffers } from "../adapters/xometryOffers";
import { XOMETRY_LOCATORS } from "../adapters/xometryConstraints";
import type { Page } from "patchright";
import type { EngineeringCatalogAuthority, EngineeringCatalogArtifact } from "./engineeringCatalog";
import { chooseOptionByTerms, XometryAdapter } from "../adapters/xometry";
import { buildAdapterRegistry } from "../adapters/index";
import { createProviderMutationPhase, markProviderMutationStarted, runInProviderMutationPhase } from "../providerMutationPhase";
import { JEV_MODEL, type ChoiceQuestion } from "./choice";
import { OPERATIONAL_JEV_USES, OperationalJevSession, OperationalJevObservations, type OperationalJevScope } from "./operationalSession";
import { VendorAutomationError, type QueueTaskRecord, type VendorQuoteAdapterInput, type WorkerConfig } from "../types";
import { ProviderDispatchAuthorizationError } from "../providerDispatchPreflight";
import { ExportControlLookupError } from "../exportControl";
import { EXPORT_CONTROL_HOLD_AFTER_ADAPTER_START_NOTE, EXPORT_CONTROL_LOOKUP_HOLD_BEFORE_UPLOAD_NOTE } from "../dispatchRouting";
import type { ProviderTaskRouteInput } from "../providerTaskRoute";
import type { ProviderTaskOutcome } from "../providerTaskPipeline";
import { providerDispatchReservation } from "../../test-support/providerDispatchReservation";

vi.mock("../files.js", async (original) => ({
  ...await original<typeof import("../files.js")>(), createRunDir: vi.fn(async () => "/tmp/owned-fake-stage"),
  stageStorageObject: vi.fn(async (_db, file) => file ? ({ originalName: file.original_name, localPath: "/tmp/secret.step",
    storageBucket: file.storage_bucket, storagePath: file.storage_path, trustedContentSha256: "b".repeat(64) }) : null),
  cleanupPaths: vi.fn(async () => undefined),
}));
vi.mock("../scoringIntegration.js", () => ({ computeAndStoreRoutingScores: vi.fn(async () => undefined) }));
// OVD-723: the staged CAD path is fake, so supply an unmarked STEP header.
vi.mock("../exportControl.js", async (original) => ({
  ...await original<typeof import("../exportControl.js")>(),
  readStagedStepHeaderPrefix: vi.fn(async () => new TextEncoder().encode("ISO-10303-21;\nHEADER;\nENDSEC;\n")),
}));
// Lets one test drive the generic route's persist callback without a full permit fixture; every other test runs the real route.
const genericRoute = vi.hoisted(() => ({ run: null as null | ((input: ProviderTaskRouteInput) => Promise<ProviderTaskOutcome>) }));
vi.mock("../providerTaskRoute.js", async (original) => {
  const actual = await original<typeof import("../providerTaskRoute.js")>();
  return { ...actual, runGenericProviderTask: (input: ProviderTaskRouteInput) => (genericRoute.run ?? actual.runGenericProviderTask)(input) };
});

const scope: OperationalJevScope = { organizationId: "secret-org", taskId: "secret-task", quoteRunId: "secret-run",
  provider: "xometry", sourceRevision: "f9195d2f071159bd46873b0ad402b1b12de75601" };
const task = { id: scope.taskId, organization_id: scope.organizationId, quote_run_id: scope.quoteRunId,
  part_id: "part", job_id: "job", task_type: "run_vendor_quote", attempts: 1, locked_at: "2026-10-02T00:00:00Z",
  payload: { vendor: "xometry", vendorQuoteResultId: "result", requestedQuantity: 2 } } as QueueTaskRecord;
const config = { workerMode: "simulate", workerName: "worker", workerLiveAdapters: [], xometryUserDataDir: null,
  xometryProfileSnapshotBucket: null, workerTempDir: "/tmp/owned-fake-stage" } as unknown as WorkerConfig;
const part = { id: "part", job_id: "job", organization_id: scope.organizationId, name: "secret-name",
  normalized_key: "secret", cad_file_id: "cad", drawing_file_id: null, quantity: 2 };
const cad = { id: "cad", job_id: "job", storage_bucket: "secret-bucket", storage_path: "secret/file.step",
  original_name: "secret.step", file_kind: "cad" };
const requirement = { id: "req", part_id: "part", description: "secret-description", part_number: "secret-part",
  revision: null, material: "", finish: null, tightest_tolerance_inch: null, quantity: 2, quote_quantities: [2],
  requested_by_date: null, applicable_vendors: ["xometry"], updated_at: "2026-10-02T00:00:00Z", spec_snapshot: {} };

function sessionFixture() {
  const caps = {
    authorize: vi.fn(async () => true), reserve: vi.fn(async () => ({ reservationId: "secret-reservation", estimatedUsd: 0.25 })),
    settle: vi.fn(async () => undefined), audit: vi.fn(async () => true),
    decide: vi.fn(async (question: ChoiceQuestion) => ({ model: JEV_MODEL, choice: "expired_session", confidence: 0.99,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === "expired_session" ? 1 : 0])),
      inputTokens: 15, outputTokens: 8 })),
  };
  const session = new OperationalJevSession({ mode: "shadow", capabilities: caps, admission: {
    scope, expiresAt: Date.now() + 60_000, uses: OPERATIONAL_JEV_USES, evidenceProfiles: ["failure_words.v1", "requirement_presence.v1", "quote_facts.v1", "catalog_facts.v1", "clarification_facts.v1", "presentation_facts.v1"],
  } });
  return { session, caps, capability: { session, sourceRevision: scope.sourceRevision, observations: new OperationalJevObservations() } };
}

/** In-memory DB/storage boundaries only: actual handler, preflight, registry, Xometry simulation,
 * spend guard, lane snapshot, offer projection, finalization and queue helpers remain real. */
function database(requestCanceled = false, denyDispatch = false, queueAck?: () => Promise<void>, approved: unknown = requirement,
  failStatusReadAfterPersist = false, { persistAckLost = false } = {}) {
  const writes: unknown[] = [];
  const persisted = () => writes.some((write) => (write as { rpc?: string }).rpc === "accept_vendor_quote_result");
  // The lane row's status, so a compare and set update matches only what the database would match.
  let laneStatus = "queued";
  let acceptanceCalls = 0;
  const from = (table: string) => {
    let columns = ""; let mutation = false; let one = false; let statusIn: unknown[] | null = null; let write: unknown = null;
    const response = () => {
      if (mutation && table === "vendor_quote_results") {
        const patch = (write as { update?: { status?: string } }).update;
        if (statusIn && !statusIn.includes(laneStatus)) { writes.splice(writes.indexOf(write), 1); return { data: [], error: null }; }
        if (patch?.status) laneStatus = patch.status;
        return { data: [{ id: "result" }], error: null };
      }
      // The claimed task row is still running under its lock, so a guarded queue update matches it.
      if (mutation && table === "work_queue") return { data: [{ id: "task" }], error: null };
      if (mutation) return { data: null, error: null };
      if (table === "vendor_quote_results" && columns === "status" && one) return { data: { status: laneStatus }, error: null };
      if (failStatusReadAfterPersist && table === "quote_runs" && persisted()) return { data: null, error: { message: "status read failed" } };
      const data = table === "parts" ? part : table === "job_files" ? [cad]
        : table === "approved_part_requirements" ? approved
          : table === "vendor_quote_results" ? (columns === "status" ? [{ status: "instant_quote_received" }] : { id: "result", requested_quantity: 2 })
            : table === "jobs" ? { organization_id: scope.organizationId, status: "internal_review" }
              : table === "quote_runs" ? { status: "received", quote_requests: { status: requestCanceled ? "canceled" : "requesting" } }
                : table === "quote_request_lanes" ? { id: "lane", quote_request_id: "request", quote_run_id: scope.quoteRunId,
                  vendor_quote_result_id: "result", scope_fingerprint: "f".repeat(64) } : null;
      return { data, error: null };
    };
    const query = {
      select(value: string) { columns = value; return query; },
      eq() { return query; }, neq() { return query; },
      in(column: string, values: unknown[]) { if (column === "status") statusIn = values; return query; },
      single: async () => response(), maybeSingle: async () => { one = true; return response(); },
      update(value: unknown) { mutation = true; write = { table, update: structuredClone(value) }; writes.push(write); return query; },
      insert(value: unknown) { mutation = true; writes.push({ table, insert: structuredClone(value) }); return query; },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        return (async () => { if (mutation && table === "work_queue") await queueAck?.(); return response(); })().then(resolve, reject);
      },
    };
    return query;
  };
  const rpc = (name: string, args: unknown) => {
    writes.push({ rpc: name, args: structuredClone(args) });
    if (name === "accept_vendor_quote_result") {
      // The function commits; with persistAckLost its response is lost on the way back.
      laneStatus = (args as { p_result: { status: string } }).p_result.status;
      acceptanceCalls += 1;
      if (persistAckLost && acceptanceCalls === 1) {
        const lost = Promise.resolve({ data: null, error: { message: "TypeError: fetch failed" } });
        return Object.assign(lost, { abortSignal: () => lost });
      }
    }
    const data = name === "accept_vendor_quote_result"
      ? (persistAckLost ? { outcome: "replayed", original_outcome: "accepted" } : { outcome: "accepted" })
      : name === "api_reserve_spend" ? { allowed: true, reservationId: "vendor-reservation" }
      : name === "api_get_worker_sourcing_intent" ? { activeDeadline: null, destination: { state: "confirmed", confirmationRevision: "1",
        street: "secret-street", city: "secret-city", region: "WA", postalCode: "secret-zip", country: "US" } }
        : name === "api_authorize_xometry_beta_worker_dispatch" ? { authorized: !denyDispatch, reasonCode: "dispatch_request_inactive" }
          // OVD-723: the unmarked STEP header records a clean scan before dispatch.
          : name === "api_record_export_control_clean_scan" ? "export-scan"
            // OVD-723: the export-control gate admits this clean, scanned part.
            : name === "api_check_export_control_dispatch" ? { allowed: true }
              : name === "api_worker_provider_kill_switch_state" ? { schema: "provider-kill-switch-state.v1",
                provider: (args as { p_provider: string }).p_provider, engaged: false, globalEngaged: false }
                // OVD-829: the supplier settings gate reserves one dispatch before launch.
                : name === "api_worker_reserve_provider_dispatch"
                  ? providerDispatchReservation((args as { p_provider: string }).p_provider) : null;
    const result = (async () => {
      if (name === "accept_vendor_quote_result") await queueAck?.();
      return { data, error: null };
    })();
    return Object.assign(result, { abortSignal: () => result });
  };
  return { client: { from, rpc } as unknown as SupabaseClient, writes };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); genericRoute.run = null; });

/** Every write that came after the atomic result and offer write. */
function writesAfterPersist(writes: unknown[]) {
  const index = writes.findIndex((write) => (write as { rpc?: string }).rpc === "accept_vendor_quote_result");
  expect(index).toBeGreaterThanOrEqual(0);
  return writes.slice(index + 1);
}

describe("actual worker operational advisory seam", () => {
  it("preserves all persistence/offer/task writes through actual registry and custom Xometry", async () => {
    const baseline = database(); await handleVendorQuoteTask(baseline.client, task, config);
    const off = database(); await handleVendorQuoteTask(off.client, task, config,
      { session: new OperationalJevSession({ mode: "off" }), sourceRevision: scope.sourceRevision, observations: new OperationalJevObservations() });
    const fixture = sessionFixture(); const shadow = database();
    await handleVendorQuoteTask(shadow.client, task, config, fixture.capability);
    expect(shadow.writes).toEqual(baseline.writes); expect(off.writes).toEqual(baseline.writes);
    expect(shadow.writes).toEqual(expect.arrayContaining([expect.objectContaining({ rpc: "accept_vendor_quote_result" }),
      expect.objectContaining({ rpc: "drain_quote_run_rollup_followups" })]));
    expect(fixture.caps.authorize).not.toHaveBeenCalled(); expect(fixture.caps.audit).not.toHaveBeenCalled();
    await fixture.capability.observations.drain();
    const receipts = fixture.caps.audit.mock.calls.map(([receipt]) => receipt);
    expect(receipts).toEqual(expect.arrayContaining([expect.objectContaining({ use: "clarification", proposal: "general_review" }),
      ...["quote_evidence", "catalog_mapping", "relevance"].map((use) => expect.objectContaining({ use, outcome: "unavailable" }))]));
    expect(JSON.stringify(receipts)).not.toContain("secret"); expect(fixture.caps.decide).not.toHaveBeenCalled();
  });

  it("preserves original unstructured error and retry writes, classifying only once", async () => {
    vi.useFakeTimers();
    const failure = new Error("session expired secret-token=abc");
    vi.spyOn(XometryAdapter.prototype, "quote").mockRejectedValue(failure);
    const baseline = database(); await expect(handleVendorQuoteTask(baseline.client, task, config)).rejects.toBe(failure);
    const fixture = sessionFixture(); const shadow = database();
    await expect(handleVendorQuoteTask(shadow.client, task, config, fixture.capability)).rejects.toBe(failure);
    expect(shadow.writes).toEqual(baseline.writes);
    expect(fixture.caps.decide).not.toHaveBeenCalled();
    await fixture.capability.observations.drain();
    expect(fixture.caps.decide).toHaveBeenCalledTimes(1); expect(fixture.caps.reserve).toHaveBeenCalledTimes(1);
    expect(fixture.caps.audit.mock.calls).toEqual(expect.arrayContaining([[expect.objectContaining({ use: "exception_routing", category: "expired_session" }), expect.anything()]]));
    expect(Object.keys(failure)).toEqual([]);
  });

  it("host-owned drain runs after authoritative retries without moving their timestamps", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    const failure = new Error("network session expired");
    vi.spyOn(XometryAdapter.prototype, "quote").mockRejectedValue(failure);
    const baseline = database(); await expect(handleVendorQuoteTask(baseline.client, task, config)).rejects.toBe(failure);
    const fixture = sessionFixture();
    fixture.caps.audit.mockImplementation(async (receipt) => {
      if (receipt.use === "exception_routing") vi.setSystemTime(Date.now() + 500);
      return true;
    });
    // Function references are snapshotted; inject the changed sink into a fresh session.
    fixture.capability.session = new OperationalJevSession({ mode: "shadow", admission: {
      scope, expiresAt: Date.now() + 60_000, uses: OPERATIONAL_JEV_USES,
      evidenceProfiles: ["failure_words.v1", "requirement_presence.v1", "quote_facts.v1", "catalog_facts.v1", "clarification_facts.v1", "presentation_facts.v1"],
    }, capabilities: fixture.caps });
    const shadow = database(); await expect(handleVendorQuoteTask(shadow.client, task, config, fixture.capability)).rejects.toBe(failure);
    expect(shadow.writes).toEqual(baseline.writes);
    expect(Date.now()).toBe(Date.parse("2026-10-02T00:00:00Z"));
    await fixture.capability.observations.drain();
    expect(Date.now()).toBeGreaterThan(Date.parse("2026-10-02T00:00:00Z"));
    expect(shadow.writes).toEqual(baseline.writes);
  });

  it.each(["throw", "reject"])("session bugs (%s) cannot prevent quotes or replace original errors", async (kind) => {
    const fixture = sessionFixture();
    const broken = () => { if (kind === "throw") throw Error("advisory bug"); return Promise.reject(Error("advisory bug")); };
    vi.spyOn(fixture.session, "captureClarification").mockImplementation(() => broken as never);
    vi.spyOn(fixture.session, "failure").mockImplementation(broken);
    vi.spyOn(fixture.session, "unavailableEvidence").mockImplementation(broken);
    const baseline = database(); await handleVendorQuoteTask(baseline.client, task, config);
    const shadow = database(); await handleVendorQuoteTask(shadow.client, task, config, fixture.capability);
    expect(shadow.writes).toEqual(baseline.writes);
    const failure = new Error("session expired"); vi.spyOn(XometryAdapter.prototype, "quote").mockRejectedValue(failure);
    await expect(handleVendorQuoteTask(database().client, task, config, fixture.capability)).rejects.toBe(failure);
    await expect(fixture.capability.observations.drain()).resolves.toBeUndefined();
  });

  it("request cancellation reaches neither registry adapter nor session", async () => {
    const fixture = sessionFixture(); const quote = vi.spyOn(XometryAdapter.prototype, "quote");
    const db = database(true); await handleVendorQuoteTask(db.client, task, config, fixture.capability);
    expect(quote).not.toHaveBeenCalled(); expect(fixture.caps.audit).not.toHaveBeenCalled();
    expect(fixture.caps.decide).not.toHaveBeenCalled();
  });

  it("retains dispatch authority and skips structured dispatch errors", async () => {
    const live = { ...config, workerMode: "live", workerLiveAdapters: ["xometry"] } as WorkerConfig;
    const fixture = sessionFixture(); const quote = vi.spyOn(XometryAdapter.prototype, "quote");
    const baseline = database(false, true); await handleVendorQuoteTask(baseline.client, task, live);
    const db = database(false, true); await handleVendorQuoteTask(db.client, task, live, fixture.capability);
    expect(db.writes).toEqual(baseline.writes); expect(quote).not.toHaveBeenCalled();
    expect(fixture.caps.decide).not.toHaveBeenCalled(); expect(fixture.caps.reserve).not.toHaveBeenCalled();
  });

  it("routes a live generic-permit task through the provider-neutral preflight and records its denial", async () => {
    const live = { ...config, workerMode: "live", workerLiveAdapters: ["fictiv"] } as WorkerConfig;
    const generic = { ...task, payload: { vendor: "fictiv", vendorQuoteResultId: "result", requestedQuantity: 2,
      providerDispatchPermitId: "00000000-0000-4000-8000-00000000457c", providerDispatchEnvelopeFingerprint: "c".repeat(64) } } as QueueTaskRecord;
    const fixture = sessionFixture(); const db = database();
    const rpc = db.client.rpc.bind(db.client);
    (db.client as unknown as { rpc: unknown }).rpc = (name: string, args: unknown) => name === "api_authorize_provider_worker_dispatch"
      ? (db.writes.push({ rpc: name, args: structuredClone(args) }), Promise.resolve({ data: {
        schema: "provider-dispatch-authorization.v1", authorized: false, denial: "permit_revoked", retryable: false }, error: null }))
      : rpc(name as never, args as never);
    await handleVendorQuoteTask(db.client, generic, live, fixture.capability);
    const rpcs = db.writes.flatMap((write) => (write as { rpc?: string }).rpc ?? []);
    expect(rpcs).toContain("api_authorize_provider_worker_dispatch");
    expect(rpcs).not.toContain("api_authorize_xometry_beta_worker_dispatch");
    expect(db.writes).toEqual(expect.arrayContaining([
      { table: "vendor_quote_results", update: expect.objectContaining({ status: "manual_vendor_followup",
        notes: ["fictiv automation stopped at authorize (permit_revoked); manual follow up is required."],
        raw_payload: expect.objectContaining({ failureCode: "permit_revoked", manualFollowUpReason: "permit_revoked",
          requiresManualVendorFollowUp: true, retryScheduledFor: null, adapterStarted: false }) }) },
      { table: "work_queue", update: expect.objectContaining({ status: "completed" }) },
    ]));
    await fixture.capability.observations.drain();
    expect(fixture.caps.decide).not.toHaveBeenCalled();
  });

  it("fails closed before the preflight when the session lease setting is on but no lease is wired (OVD-464)", async () => {
    const live = { ...config, workerMode: "live", workerLiveAdapters: ["fictiv"], providerSessionLease: "on" } as WorkerConfig;
    const generic = { ...task, payload: { vendor: "fictiv", vendorQuoteResultId: "result", requestedQuantity: 2,
      providerDispatchPermitId: "00000000-0000-4000-8000-00000000457c", providerDispatchEnvelopeFingerprint: "c".repeat(64) } } as QueueTaskRecord;
    const db = database();
    await handleVendorQuoteTask(db.client, generic, live);
    const rpcs = db.writes.flatMap((write) => (write as { rpc?: string }).rpc ?? []);
    expect(rpcs).not.toContain("api_authorize_provider_worker_dispatch");
    expect(rpcs).not.toContain("accept_vendor_quote_result");
    expect(db.writes).toEqual(expect.arrayContaining([
      { table: "vendor_quote_results", update: expect.objectContaining({ status: "manual_vendor_followup",
        raw_payload: expect.objectContaining({ failureCode: "session_lease_unavailable", adapterStarted: false }) }) },
      { table: "work_queue", update: expect.objectContaining({ status: "completed" }) },
    ]));
  });

  it("wires the lease port when the lease setting is on with a namespace key (OVD-381)", async () => {
    const live = { ...config, workerMode: "live", workerLiveAdapters: ["fictiv"], providerSessionLease: "on",
      providerSessionNamespaceKey: new Uint8Array(32).fill(7) } as WorkerConfig;
    const generic = { ...task, payload: { vendor: "fictiv", vendorQuoteResultId: "result", requestedQuantity: 2,
      providerDispatchPermitId: "00000000-0000-4000-8000-00000000457c", providerDispatchEnvelopeFingerprint: "c".repeat(64) } } as QueueTaskRecord;
    const db = database();
    const rpc = db.client.rpc.bind(db.client);
    (db.client as unknown as { rpc: unknown }).rpc = (name: string, args: unknown) => name === "api_authorize_provider_worker_dispatch"
      ? (db.writes.push({ rpc: name, args: structuredClone(args) }), Promise.resolve({ data: {
        schema: "provider-dispatch-authorization.v1", authorized: false, denial: "permit_revoked", retryable: false }, error: null }))
      : rpc(name as never, args as never);
    await handleVendorQuoteTask(db.client, generic, live);
    const rpcs = db.writes.flatMap((write) => (write as { rpc?: string }).rpc ?? []);
    expect(rpcs).toContain("api_authorize_provider_worker_dispatch");
    expect(db.writes).toEqual(expect.arrayContaining([
      { table: "vendor_quote_results", update: expect.objectContaining({ status: "manual_vendor_followup",
        raw_payload: expect.objectContaining({ failureCode: "permit_revoked", adapterStarted: false }) }) },
    ]));
  });

  it("requeues a generic task on a transient preflight failure with zero adapter calls (OVD-464)", async () => {
    const live = { ...config, workerMode: "live", workerLiveAdapters: ["fictiv"] } as WorkerConfig;
    const generic = { ...task, attempts: 1, payload: { vendor: "fictiv", vendorQuoteResultId: "result", requestedQuantity: 2,
      providerDispatchPermitId: "00000000-0000-4000-8000-00000000457c", providerDispatchEnvelopeFingerprint: "c".repeat(64) } } as QueueTaskRecord;
    const db = database();
    const rpc = db.client.rpc.bind(db.client);
    (db.client as unknown as { rpc: unknown }).rpc = (name: string, args: unknown) => name === "api_authorize_provider_worker_dispatch"
      ? (db.writes.push({ rpc: name }), Promise.resolve({ data: null, error: { code: "08006" }, status: 503 }))
      : rpc(name as never, args as never);
    await handleVendorQuoteTask(db.client, generic, live);
    expect(db.writes).toEqual(expect.arrayContaining([
      { table: "vendor_quote_results", update: expect.objectContaining({ status: "queued",
        raw_payload: expect.objectContaining({ failureCode: "preflight_unavailable", adapterStarted: false }) }) },
      { table: "work_queue", update: expect.objectContaining({ status: "queued" }) },
    ]));
    const rpcs = db.writes.flatMap((write) => (write as { rpc?: string }).rpc ?? []);
    expect(rpcs).not.toContain("accept_vendor_quote_result");
  });

  it("reads the claim RPC attempts and settles a generic task past the cap without a preflight or adapter (OVD-464)", async () => {
    const live = { ...config, workerMode: "live", workerLiveAdapters: ["fictiv"] } as WorkerConfig;
    const permit = { providerDispatchPermitId: "00000000-0000-4000-8000-00000000457c", providerDispatchEnvelopeFingerprint: "c".repeat(64) };
    const claimed = (attempts: number) => ({ ...task, attempts,
      payload: { vendor: "fictiv", vendorQuoteResultId: "result", requestedQuantity: 2, ...permit } }) as QueueTaskRecord;
    const transient = (db: ReturnType<typeof database>) => {
      const rpc = db.client.rpc.bind(db.client);
      (db.client as unknown as { rpc: unknown }).rpc = (name: string, args: unknown) => name === "api_authorize_provider_worker_dispatch"
        ? (db.writes.push({ rpc: name }), Promise.resolve({ data: null, error: { code: "08006" }, status: 503 }))
        : rpc(name as never, args as never);
    };

    // The same transient denial requeues on claim 1 and settles on claim 2: the decision follows the claimed row.
    const second = database(); transient(second);
    await handleVendorQuoteTask(second.client, claimed(2), live);
    expect(second.writes).toEqual(expect.arrayContaining([
      { table: "vendor_quote_results", update: expect.objectContaining({ status: "failed",
        raw_payload: expect.objectContaining({ failureCode: "preflight_unavailable", adapterStarted: false }) }) },
      { table: "work_queue", update: expect.objectContaining({ status: "failed" }) },
    ]));

    const exhausted = database();
    await handleVendorQuoteTask(exhausted.client, claimed(3), live);
    const rpcs = exhausted.writes.flatMap((write) => (write as { rpc?: string }).rpc ?? []);
    expect(rpcs).not.toContain("api_authorize_provider_worker_dispatch");
    expect(rpcs).not.toContain("accept_vendor_quote_result");
    expect(exhausted.writes).toEqual(expect.arrayContaining([
      { table: "vendor_quote_results", update: expect.objectContaining({ status: "failed",
        raw_payload: expect.objectContaining({ failureCode: "attempts_exhausted", adapterStarted: false }) }) },
      { table: "work_queue", update: expect.objectContaining({ status: "failed" }) },
    ]));
  });

  it("keeps a persisted generic result when the status read after persistence fails (OVD-464)", async () => {
    const live = { ...config, workerMode: "live", workerLiveAdapters: ["fictiv"] } as WorkerConfig;
    const generic = { ...task, payload: { vendor: "fictiv", vendorQuoteResultId: "result", requestedQuantity: 2,
      providerDispatchPermitId: "00000000-0000-4000-8000-00000000457c", providerDispatchEnvelopeFingerprint: "c".repeat(64) } } as QueueTaskRecord;
    genericRoute.run = async (route) => {
      const output = { vendor: "fictiv" as const, status: "instant_quote_received" as const, unitPriceUsd: 12, totalPriceUsd: 24,
        leadTimeBusinessDays: 8, quoteUrl: "https://app.fictiv.com/quotes/abc", dfmIssues: [], notes: [], artifacts: [],
        rawPayload: { source: "fictiv-live-adapter" } };
      const { artifactCount, acceptance } = await route.persist(output, { offerCount: 1 });
      return { disposition: "persisted", code: "persisted", stage: "persist", adapterStarted: true, retryAt: null,
        providerDisabledForDay: false, rejection: null, persisted: { status: output.status, offerCount: 1, artifactCount, acceptance },
        evidence: { adapterError: null, artifacts: [] } };
    };
    const db = database(false, false, undefined, requirement, true);
    await processClaimedTask(db.client, generic, live, createWorkerRuntimeState());
    const after = writesAfterPersist(db.writes);
    expect(after.filter((write) => (write as { table?: string }).table === "vendor_quote_results")).toEqual([]);
    expect(after.filter((write) => (write as { table?: string }).table === "work_queue")).toEqual([]);
  });

  // OVD-723 x OVD-464: the generic route asks the export gate right before
  // adapter.quote; a hold raised there closes the lane as held, never as a
  // provider failure or manual follow-up.
  it("closes a generic lane as held when the export gate flips before the adapter (OVD-723)", async () => {
    const live = { ...config, workerMode: "live", workerLiveAdapters: ["fictiv"] } as WorkerConfig;
    const generic = { ...task, payload: { vendor: "fictiv", vendorQuoteResultId: "result", requestedQuantity: 2,
      providerDispatchPermitId: "00000000-0000-4000-8000-00000000457c", providerDispatchEnvelopeFingerprint: "c".repeat(64) } } as QueueTaskRecord;
    let adapterError: unknown = null;
    genericRoute.run = async (route) => {
      adapterError = await route.adapter.quote({} as VendorQuoteAdapterInput).catch((error: unknown) => error);
      // What the pipeline returns for an adapter that threw before any mutation.
      return { disposition: "manual_follow_up", code: "adapter_failed", stage: "adapter", adapterStarted: true, retryAt: null,
        providerDisabledForDay: false, rejection: null, persisted: null, evidence: { adapterError: null, artifacts: [] } };
    };
    const db = database(false, false, undefined, requirement, true);
    const baseRpc = db.client.rpc.bind(db.client);
    let dispatchChecks = 0;
    (db.client as unknown as { rpc: unknown }).rpc = (name: string, args: unknown) => {
      if (name === "api_check_export_control_dispatch" && ++dispatchChecks > 2) {
        db.writes.push({ rpc: name, args: structuredClone(args) });
        const denied = Promise.resolve({ data: { allowed: false, reasonCode: "export_review_pending" }, error: null });
        return Object.assign(denied, { abortSignal: () => denied });
      }
      return baseRpc(name, args as never);
    };
    await expect(handleVendorQuoteTask(db.client, generic, live)).resolves.toBeUndefined();
    expect(adapterError).toBeInstanceOf(ProviderDispatchAuthorizationError);
    const laneWrites = db.writes.filter((write) => (write as { table?: string }).table === "vendor_quote_results");
    expect(laneWrites).toEqual(expect.arrayContaining([expect.objectContaining({ update: expect.objectContaining({ status: "failed",
      raw_payload: expect.objectContaining({ exportControlHold: true, exportControlReasonCode: "export_review_pending" }) }) })]));
    expect(JSON.stringify(laneWrites)).not.toContain("manual_vendor_followup");
    expect(db.writes).toEqual(expect.arrayContaining([{ table: "work_queue", update: expect.objectContaining({ status: "completed",
      payload: expect.objectContaining({ exportControlHold: true, failureCode: "export_review_pending" }) }) }]));
  });

  // OVD-723 x OVD-464: a lookup that fails inside the wrapped adapter after it
  // started must not requeue the task. The note depends on the pipeline's own
  // mutation phase: unmarked means no upload had started, so nothing was sent.
  const holdAfterLookupFailure = async (innerPhaseMarked: boolean) => {
    const live = { ...config, workerMode: "live", workerLiveAdapters: ["fictiv"] } as WorkerConfig;
    const generic = { ...task, payload: { vendor: "fictiv", vendorQuoteResultId: "result", requestedQuantity: 2,
      providerDispatchPermitId: "00000000-0000-4000-8000-00000000457c", providerDispatchEnvelopeFingerprint: "c".repeat(64) } } as QueueTaskRecord;
    let adapterError: unknown = null;
    genericRoute.run = async (route) => {
      // The pipeline runs the adapter in its own mutation phase; an adapter
      // marks it right before its first upload.
      const innerPhase = createProviderMutationPhase();
      innerPhase.started = innerPhaseMarked;
      adapterError = await runInProviderMutationPhase(innerPhase, () => route.adapter.quote({} as VendorQuoteAdapterInput))
        .catch((error: unknown) => error);
      return { disposition: "manual_follow_up", code: "adapter_failed", stage: "adapter", adapterStarted: true, retryAt: null,
        providerDisabledForDay: false, rejection: null, persisted: null, evidence: { adapterError: null, artifacts: [] } };
    };
    const db = database(false, false, undefined, requirement, true);
    const baseRpc = db.client.rpc.bind(db.client);
    let dispatchChecks = 0;
    (db.client as unknown as { rpc: unknown }).rpc = (name: string, args: unknown) => {
      // Checks 1 and 2 run before the adapter; check 3 is the wrapper's recheck right before adapter.quote.
      if (name === "api_check_export_control_dispatch" && ++dispatchChecks > 2) {
        db.writes.push({ rpc: name, args: structuredClone(args) });
        const failed = Promise.resolve({ data: null, error: { message: "transient RPC failure" } });
        return Object.assign(failed, { abortSignal: () => failed });
      }
      return baseRpc(name, args as never);
    };
    await expect(processClaimedTask(db.client, generic, live, createWorkerRuntimeState())).resolves.toBeUndefined();
    expect(adapterError).toBeInstanceOf(ExportControlLookupError);
    const queueWrites = db.writes.filter((write) => (write as { table?: string }).table === "work_queue");
    expect(queueWrites).not.toEqual(expect.arrayContaining([{ table: "work_queue", update: expect.objectContaining({ status: "queued" }) }]));
    expect(queueWrites).toEqual(expect.arrayContaining([{ table: "work_queue", update: expect.objectContaining({ status: "completed",
      payload: expect.objectContaining({ exportControlHold: true, failureCode: "export_control_lookup_failed" }) }) }]));
    return db.writes.filter((write) => (write as { table?: string }).table === "vendor_quote_results");
  };

  it("holds a generic lane, never requeues it, when the pre quote export lookup fails before any upload (OVD-723)", async () => {
    const laneWrites = await holdAfterLookupFailure(false);
    expect(laneWrites.at(-1)).toEqual(expect.objectContaining({ update: expect.objectContaining({ status: "failed",
      notes: [EXPORT_CONTROL_LOOKUP_HOLD_BEFORE_UPLOAD_NOTE],
      raw_payload: expect.objectContaining({ exportControlHold: true, exportControlReasonCode: "export_control_lookup_failed",
        providerMutationPossible: true, retryScheduledFor: null }) }) }));
    expect(JSON.stringify(laneWrites)).not.toContain("may already have reached it");
    expect(EXPORT_CONTROL_LOOKUP_HOLD_BEFORE_UPLOAD_NOTE).toContain("will not be retried automatically");
  });

  it("holds a generic lane with the after start note when the lookup fails once the adapter marked a mutation (OVD-723)", async () => {
    const laneWrites = await holdAfterLookupFailure(true);
    expect(laneWrites.at(-1)).toEqual(expect.objectContaining({ update: expect.objectContaining({ status: "failed",
      notes: [EXPORT_CONTROL_HOLD_AFTER_ADAPTER_START_NOTE],
      raw_payload: expect.objectContaining({ exportControlHold: true, exportControlReasonCode: "export_control_lookup_failed",
        providerMutationPossible: true, retryScheduledFor: null }) }) }));
    expect(JSON.stringify(laneWrites)).not.toContain("Nothing was sent");
  });

  it("never overwrites a committed generic result whose persistence acknowledgement was lost (OVD-464)", async () => {
    const live = { ...config, workerMode: "live", workerLiveAdapters: ["fictiv"] } as WorkerConfig;
    const generic = { ...task, payload: { vendor: "fictiv", vendorQuoteResultId: "result", requestedQuantity: 2,
      providerDispatchPermitId: "00000000-0000-4000-8000-00000000457c", providerDispatchEnvelopeFingerprint: "c".repeat(64) } } as QueueTaskRecord;
    genericRoute.run = async (route) => {
      const output = { vendor: "fictiv" as const, status: "instant_quote_received" as const, unitPriceUsd: 12, totalPriceUsd: 24,
        leadTimeBusinessDays: 8, quoteUrl: "https://app.fictiv.com/quotes/abc", dfmIssues: [], notes: [], artifacts: [],
        rawPayload: { source: "fictiv-live-adapter" } };
      const { artifactCount, acceptance } = await route.persist(output, { offerCount: 1 });
      expect(acceptance).toEqual({ outcome: "replayed", original_outcome: "accepted" });
      return { disposition: "persisted", code: "persisted", stage: "persist", adapterStarted: true, retryAt: null,
        providerDisabledForDay: false, rejection: null, killSwitch: null,
        persisted: { status: output.status, offerCount: 1, artifactCount, acceptance }, evidence: { adapterError: null, artifacts: [] } };
    };
    const db = database(false, false, undefined, requirement, false, { persistAckLost: true });
    await expect(handleVendorQuoteTask(db.client, generic, live)).resolves.toBeUndefined();
    const after = writesAfterPersist(db.writes);
    expect(after.filter((write) => (write as { table?: string }).table === "vendor_quote_results")).toEqual([]);
    expect(after.filter((write) => (write as { table?: string }).table === "work_queue")).toEqual([]);
    expect(after).not.toEqual(expect.arrayContaining([{ table: "work_queue", update: expect.objectContaining({ status: "queued" }) }]));
  });

  it("never overwrites or retries a committed Xometry result whose persistence acknowledgement was lost", async () => {
    const db = database(false, false, undefined, requirement, false, { persistAckLost: true });
    await expect(handleVendorQuoteTask(db.client, task, config)).resolves.toBeUndefined();
    const after = writesAfterPersist(db.writes);
    expect(after.filter((write) => (write as { table?: string }).table === "vendor_quote_results")).toEqual([]);
    expect(after.filter((write) => (write as { table?: string }).table === "work_queue")).toEqual([]);
  });

  it("keeps a persisted Xometry result when the status read after persistence fails, without changing its success writes", async () => {
    const db = database(false, false, undefined, requirement, true);
    await processClaimedTask(db.client, task, config, createWorkerRuntimeState());
    const after = writesAfterPersist(db.writes);
    expect(after.filter((write) => (write as { table?: string }).table === "vendor_quote_results")).toEqual([]);
    expect(after.filter((write) => (write as { table?: string }).table === "work_queue")).toEqual([]);
  });

  it("registry checks actual input org/run and actual provider against admission", async () => {
    const fixture = sessionFixture(); const registry = buildAdapterRegistry(config, { session: fixture.session, scope, observations: fixture.capability.observations });
    const input = { organizationId: "another-org", quoteRunId: "another-run", part, requirement, requestedQuantity: 2,
      cadFile: cad, drawingFile: null, stagedCadFile: null, stagedDrawingFile: null } as VendorQuoteAdapterInput;
    const baseline = await buildAdapterRegistry(config).xometry!.quote(input);
    expect(await registry.xometry!.quote(input)).toEqual(baseline);
    await fixture.capability.observations.drain();
    expect(fixture.caps.audit.mock.calls.every(([receipt]) => receipt.reason === "scope_denied")).toBe(true);
    expect(fixture.caps.decide).not.toHaveBeenCalled();
  });

  // OVD-723: the registry wrapper itself skips the Jev failure report for a
  // dispatch decision. The Xometry adapter's own quote is stubbed here, so its
  // separate skip cannot cover for the wrapper.
  it("registry wrapper does not report a dispatch decision to Jev as an operational failure", async () => {
    const fixture = sessionFixture();
    const enqueue = vi.spyOn(fixture.capability.observations, "enqueue");
    const registry = buildAdapterRegistry(config, { session: fixture.session, scope, observations: fixture.capability.observations });
    const input = { organizationId: scope.organizationId, quoteRunId: scope.quoteRunId, part, requirement, requestedQuantity: 2,
      cadFile: cad, drawingFile: null, stagedCadFile: null, stagedDrawingFile: null } as VendorQuoteAdapterInput;
    const quote = vi.spyOn(XometryAdapter.prototype, "quote");
    for (const decision of [new ProviderDispatchAuthorizationError("export_review_pending"), new ExportControlLookupError("dispatch")]) {
      quote.mockRejectedValueOnce(decision);
      await expect(registry.xometry!.quote(input)).rejects.toBe(decision);
    }
    expect(enqueue.mock.calls.map(([use]) => use)).not.toContain("exception_routing");
    const failure = new Error("session expired");
    quote.mockRejectedValueOnce(failure);
    await expect(registry.xometry!.quote(input)).rejects.toBe(failure);
    expect(enqueue.mock.calls.map(([use]) => use)).toContain("exception_routing");
  });

  it("keeps the consumer methods selected at task entry through capture and drain", async () => {
    const fixture = sessionFixture(); const failure = new Error("session expired");
    vi.spyOn(XometryAdapter.prototype, "quote").mockRejectedValue(failure);
    const pendingTask = handleVendorQuoteTask(database().client, task, config, fixture.capability);
    const replacementFailure = vi.fn(async () => { throw Error("replacement failure method"); });
    const replacementUnavailable = vi.fn(async () => { throw Error("replacement unavailable method"); });
    const replacementClarification = vi.fn(() => { throw Error("replacement clarification method"); });
    fixture.session.failure = replacementFailure;
    fixture.session.unavailableEvidence = replacementUnavailable;
    fixture.session.captureClarification = replacementClarification;
    await expect(pendingTask).rejects.toBe(failure);
    expect(fixture.caps.decide).not.toHaveBeenCalled();
    await fixture.capability.observations.drain();
    expect(replacementFailure).not.toHaveBeenCalled(); expect(replacementUnavailable).not.toHaveBeenCalled();
    expect(replacementClarification).not.toHaveBeenCalled(); expect(fixture.caps.decide).toHaveBeenCalledOnce();
    expect(fixture.caps.audit.mock.calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({ use: "clarification", proposal: "general_review" }), expect.anything()],
      [expect.objectContaining({ use: "quote_evidence", reason: "quote_spans_missing" }), expect.anything()],
    ]));
  });
  it("real claimed-task host waits for completion acknowledgement before the first advisory boundary", async () => {
    const fixture = sessionFixture(); let acknowledge!: () => void;
    const ack = new Promise<void>((resolve) => { acknowledge = resolve; });
    const db = database(false, false, () => ack);
    const captureTask = vi.fn(() => fixture.capability);
    const running = processClaimedTask(db.client, task, config, createWorkerRuntimeState(), { captureTask });
    await vi.waitFor(() => expect(db.writes).toEqual(expect.arrayContaining([expect.objectContaining({ rpc: "accept_vendor_quote_result" })])));
    expect(fixture.caps.authorize).not.toHaveBeenCalled(); expect(fixture.caps.reserve).not.toHaveBeenCalled();
    expect(fixture.caps.audit).not.toHaveBeenCalled(); expect(fixture.caps.decide).not.toHaveBeenCalled();
    acknowledge(); await running;
    expect(fixture.caps.audit).toHaveBeenCalled(); expect(captureTask).toHaveBeenCalledOnce();
  });

  it.each([
    { mutationStarted: false, vendorError: false, queueStatus: "queued", resultStatus: "queued" },
    { mutationStarted: true, vendorError: false, queueStatus: "failed", resultStatus: "failed" },
    { mutationStarted: false, vendorError: true, queueStatus: "queued", resultStatus: "queued" },
    { mutationStarted: true, vendorError: true, queueStatus: "failed", resultStatus: "failed" },
  ])("retries a transient failure only before provider mutation (started=$mutationStarted, vendorError=$vendorError)", async (
    { mutationStarted, vendorError, queueStatus, resultStatus },
  ) => {
    vi.spyOn(XometryAdapter.prototype, "quote").mockImplementation(async () => {
      if (mutationStarted) markProviderMutationStarted();
      const message = "page.goto: net::ERR_NETWORK_CHANGED during navigation";
      throw vendorError ? new VendorAutomationError(message, "navigation_failure", { vendor: "xometry" }) : new Error(message);
    });
    const db = database();
    await expect(processClaimedTask(db.client, task, config, createWorkerRuntimeState())).resolves.toBeUndefined();
    const updates = db.writes.filter((write): write is { table: string; update: Record<string, unknown> } =>
      typeof write === "object" && write !== null && "update" in write);
    expect(updates.filter((write) => write.table === "work_queue").at(-1)?.update).toMatchObject({ status: queueStatus });
    const failureWrite = updates.filter((write) => write.table === "vendor_quote_results").at(-1);
    expect(failureWrite?.update).toMatchObject({
      status: resultStatus,
      raw_payload: { retryScheduledFor: mutationStarted ? null : expect.any(String) },
    });
    // The persisted evidence explains the fail-closed decision for every error type.
    expect((failureWrite?.update.raw_payload as Record<string, unknown>).providerMutationPossible)
      .toBe(mutationStarted ? true : undefined);
  });

  it.each([true, false])("real host drains only after confirmed retry/failure persistence (ack=%s)", async (acknowledged) => {
    const failure = new Error("session expired");
    vi.spyOn(XometryAdapter.prototype, "quote").mockRejectedValue(failure);
    const fixture = sessionFixture(); let persist!: () => void;
    const persistenceError = new Error("queue persistence unknown");
    const ack = new Promise<void>((resolve, reject) => { persist = () => acknowledged ? resolve() : reject(persistenceError); });
    const db = database(false, false, () => ack);
    const running = processClaimedTask(db.client, task, config, createWorkerRuntimeState(), { captureTask: () => fixture.capability });
    const checked = acknowledged ? expect(running).resolves.toBeUndefined() : expect(running).rejects.toBe(persistenceError);
    await vi.waitFor(() => expect(db.writes).toEqual(expect.arrayContaining([expect.objectContaining({ table: "work_queue" })])));
    expect(fixture.caps.authorize).not.toHaveBeenCalled(); expect(fixture.caps.audit).not.toHaveBeenCalled();
    expect(fixture.caps.reserve).not.toHaveBeenCalled(); expect(fixture.caps.decide).not.toHaveBeenCalled();
    persist(); await checked;
    expect(fixture.caps.decide).toHaveBeenCalledTimes(acknowledged ? 1 : 0);
  });

  it("joins real host, task, registry, original collector and admitted consumers after ack without changing quote writes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    const approved = { ...requirement, material: "secret-grade", finish: "secret-finish", revision: "B",
      tightest_tolerance_inch: 0.01, spec_snapshot: { process: "secret-process" } };
    const originalQuote = XometryAdapter.prototype.quote;
    const source = "Standard\nUSD $20.00 ea.\nUSD $40.00\n5 business days\nFirm total USD 40.00 quantity: 2 revision: B\nReference: secret-source";
    const page = { url: () => "https://www.xometry.com/quoting/quote/Q26-SYNTHETIC", locator: (selector: string) => ({
      count: async () => selector === XOMETRY_LOCATORS.priceTierCard ? 1 : 0,
      nth: () => ({ innerText: async () => source, getAttribute: async () => null,
        locator: (selector: string) => /* A markerless price panel under its heading that holds every card encloses each one. */ selector.startsWith("xpath=") ? { count: async (): Promise<number> => 1, nth: () => ({ getAttribute: async (): Promise<string | null> => null, innerText: async () => `Price and Lead Time\n${source}`, locator: (inner: string) => ({ count: async () => inner === XOMETRY_LOCATORS.priceTierCard ? 1 : 0 }) }) } : selector.includes("disabled") ? { count: async () => 0 }
          : { count: async () => selector.startsWith('[data-testid="tierAndLeadTime"]') ? 1 : 0,
            first: () => ({ innerText: async () => "Fastest - Lead Time: 5 business days" }) } }),
    }) } as unknown as Page;
    // Method-level composition fixture: the actual collector emits authentic originals to
    // the registry callback while the original simulation supplies authoritative output.
    // This does not exercise Xometry's full live quote browser flow.
    vi.spyOn(XometryAdapter.prototype, "quote").mockImplementation(async function (input) {
      const result = await originalQuote.call(this, input);
      for (const field of ["material", "finish"] as const) {
        const option = { waitFor: async () => undefined, click: vi.fn(), innerText: async () => `secret-${field}-label`,
          getAttribute: async (name: string) => name === "data-option-id" ? `secret-${field}-id` : null };
        await chooseOptionByTerms({ getByRole: () => ({ first: () => option }) } as unknown as Page,
          [field], [".option"], field, `#${field}`, this.operationalProviderObserver);
      }
      await collectXometryOffers(page, input.requestedQuantity, this.operationalProviderObserver);
      return result;
    });
    const baseline = database(false, false, undefined, approved);
    await processClaimedTask(baseline.client, task, config, createWorkerRuntimeState());
    const fixture = sessionFixture(); let acknowledged = false;
    fixture.caps.authorize.mockImplementation(async () => { expect(acknowledged).toBe(true); return true; });
    fixture.caps.decide.mockImplementation(async (q: ChoiceQuestion) => {
      const choice = "span_0" in q.criteria ? "span_0" : "option_0" in q.criteria ? "option_0" : "drop_optional" in q.criteria ? "drop_optional" : "none";
      return { model: JEV_MODEL, choice, confidence: 1, inputTokens: 10, outputTokens: 5,
        probabilities: Object.fromEntries(Object.keys(q.criteria).map((key) => [key, key === choice ? 1 : 0])) };
    });
    const shadow = database(false, false, async () => { acknowledged = true; }, approved);
    // Separate synthetic provider catalog tuple, not inferred from requested fields/DOM labels.
    const engineeringCatalog: EngineeringCatalogAuthority = (context): EngineeringCatalogArtifact => {
      expect(acknowledged).toBe(true);
      return { contract: "jev-engineering-catalog.v1", provider: "xometry", catalogId: "secret-catalog", catalogRevision: "synthetic-v1",
        scope: context.scope, requirementBinding: context.expectedRequirement, issuedAt: context.now, expiresAt: context.now + 60000,
        source: { identity: "synthetic-provider-fixture", sha256: "f".repeat(64), schemaRevision: "fixture-v1",
          collection: "observed_configuration", completeness: "complete", candidateCount: 1, observationsSha256: context.observationsSha256 },
        namespaces: ["material", "finish"].map((field) => ({ namespace: field, field: field as "material" | "finish",
          attributeName: "data-option-id", controlSelector: `#${field}`, optionSelector: "role=option" })),
        options: [{ id: "secret-tuple", fields: { material: "secret-grade", process: "secret-process", finish: "secret-finish", tightestToleranceInch: 0.01 },
          observedBindings: [{ namespace: "material", observedId: "secret-material-id" }, { namespace: "finish", observedId: "secret-finish-id" }] }], materialEquivalenceApprovals: [] };
    };
    await processClaimedTask(shadow.client, task, config, createWorkerRuntimeState(), { captureTask: () => ({ ...fixture.capability, engineeringCatalog }) });
    expect(shadow.writes).toEqual(baseline.writes);
    expect(fixture.capability.observations.localReview().get("quote_evidence")).toMatchObject({
      receipt: { outcome: "observed", proposal: "span_0" }, result: { status: "evidence_selected", selected: { document: { text: source } } } });
    expect(fixture.capability.observations.localReview().get("relevance")).toMatchObject({ receipt: { outcome: "observed", proposal: "drop_optional" },
      result: { proposedExcludedIds: expect.arrayContaining([expect.any(String)]) } });
    expect(fixture.capability.observations.localReview().get("clarification")).toMatchObject({ receipt: { outcome: "observed", proposal: "none" } });
    expect(fixture.capability.observations.localReview().get("catalog_mapping")).toMatchObject({ receipt: { outcome: "observed", proposal: "option_0" },
      result: { candidateScope: "observed_configuration", result: { status: "exact", option: { id: "option_0" } } } });
    expect(JSON.stringify(fixture.caps.decide.mock.calls)).not.toContain("secret");
    expect(fixture.caps.decide).toHaveBeenCalledTimes(4); expect(fixture.caps.settle).not.toHaveBeenCalled();
  });

  it("host shutdown cancels advisory before drain while authoritative task acknowledgement still completes", async () => {
    const controller = new AbortController(); const fixture = sessionFixture();
    const db = database(false, false, async () => { controller.abort(); });
    await processClaimedTask(db.client, task, config, createWorkerRuntimeState(), { captureTask: () => fixture.capability }, controller.signal);
    expect(db.writes).toEqual(expect.arrayContaining([expect.objectContaining({ rpc: "drain_quote_run_rollup_followups" })]));
    expect(fixture.caps.audit).not.toHaveBeenCalled(); expect(fixture.caps.authorize).not.toHaveBeenCalled();
    expect(fixture.caps.reserve).not.toHaveBeenCalled(); expect(fixture.caps.decide).not.toHaveBeenCalled();
    await fixture.capability.observations.drain(); // Even a later explicit call cannot resurrect canceled admission.
    expect(fixture.caps.authorize).not.toHaveBeenCalled(); expect(fixture.caps.reserve).not.toHaveBeenCalled();
  });

  it.each(["throw", "reject"])("contains %s from injected drain after actual cancelled acknowledgement", async (kind) => {
    const fixture = sessionFixture(); fixture.capability.observations.drain = () => {
      if (kind === "throw") throw new Error("broken drain");
      return Promise.reject(new Error("broken drain"));
    };
    const db = database(true);
    await expect(processClaimedTask(db.client, task, config, createWorkerRuntimeState(), { captureTask: () => fixture.capability })).resolves.toBeUndefined();
    expect(db.writes).toEqual(expect.arrayContaining([expect.objectContaining({ table: "work_queue", update: expect.objectContaining({ status: "cancelled" }) })]));
  });
  it("shutdown aborts pending admitted drain and prevents later inference restart", async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    const failure = new Error("session expired"); vi.spyOn(XometryAdapter.prototype, "quote").mockRejectedValue(failure);
    const fixture = sessionFixture(); let rejectLate!: (error: Error) => void;
    fixture.caps.decide.mockImplementation(() => new Promise((_resolve, reject) => { rejectLate = reject; }));
    const db = database();
    const running = processClaimedTask(db.client, task, config, createWorkerRuntimeState(), { captureTask: () => fixture.capability }, controller.signal);
    await vi.advanceTimersByTimeAsync(1); expect(fixture.caps.decide).toHaveBeenCalledOnce();
    const authoritative = structuredClone(db.writes); controller.abort(); await running;
    rejectLate(new Error("late transport failure")); await vi.advanceTimersByTimeAsync(1);
    expect(db.writes).toEqual(authoritative); expect(fixture.caps.decide).toHaveBeenCalledOnce(); expect(fixture.caps.settle).not.toHaveBeenCalled();
  });

});
