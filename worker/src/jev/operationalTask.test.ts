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
import { markProviderMutationStarted } from "../providerMutationPhase";
import { JEV_MODEL, type ChoiceQuestion } from "./choice";
import { OPERATIONAL_JEV_USES, OperationalJevSession, OperationalJevObservations, type OperationalJevScope } from "./operationalSession";
import { VendorAutomationError, type QueueTaskRecord, type VendorQuoteAdapterInput, type WorkerConfig } from "../types";

vi.mock("../files.js", async (original) => ({
  ...await original<typeof import("../files.js")>(), createRunDir: vi.fn(async () => "/tmp/owned-fake-stage"),
  stageStorageObject: vi.fn(async (_db, file) => file ? ({ originalName: file.original_name, localPath: "/tmp/secret.step",
    storageBucket: file.storage_bucket, storagePath: file.storage_path, trustedContentSha256: "b".repeat(64) }) : null),
  cleanupPaths: vi.fn(async () => undefined),
}));
vi.mock("../scoringIntegration.js", () => ({ computeAndStoreRoutingScores: vi.fn(async () => undefined) }));

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
function database(requestCanceled = false, denyDispatch = false, queueAck?: () => Promise<void>, approved: unknown = requirement) {
  const writes: unknown[] = [];
  const from = (table: string) => {
    let columns = ""; let mutation = false;
    const response = () => {
      if (mutation) return { data: null, error: null };
      const data = table === "parts" ? part : table === "job_files" ? [cad]
        : table === "approved_part_requirements" ? approved
          : table === "vendor_quote_results" ? (columns === "status" ? [{ status: "instant_quote_received" }] : { id: "result", requested_quantity: 2 })
            : table === "jobs" ? { organization_id: scope.organizationId, status: "internal_review" }
              : table === "quote_runs" ? { status: "received", quote_requests: { status: requestCanceled ? "canceled" : "requesting" } } : null;
      return { data, error: null };
    };
    const query = {
      select(value: string) { columns = value; return query; },
      eq() { return query; }, neq() { return query; }, in() { return query; },
      single: async () => response(), maybeSingle: async () => response(),
      update(value: unknown) { mutation = true; writes.push({ table, update: structuredClone(value) }); return query; },
      insert(value: unknown) { mutation = true; writes.push({ table, insert: structuredClone(value) }); return query; },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        return (async () => { if (mutation && table === "work_queue") await queueAck?.(); return response(); })().then(resolve, reject);
      },
    };
    return query;
  };
  const rpc = (name: string, args: unknown) => {
    writes.push({ rpc: name, args: structuredClone(args) });
    const data = name === "api_reserve_spend" ? { allowed: true, reservationId: "vendor-reservation" }
      : name === "api_get_worker_sourcing_intent" ? { activeDeadline: null, destination: { state: "confirmed", confirmationRevision: "1",
        street: "secret-street", city: "secret-city", region: "WA", postalCode: "secret-zip", country: "US" } }
        : name === "api_authorize_xometry_beta_worker_dispatch" ? { authorized: !denyDispatch, reasonCode: "dispatch_request_inactive" } : null;
    const result = Promise.resolve({ data, error: null });
    return Object.assign(result, { abortSignal: () => result });
  };
  return { client: { from, rpc } as unknown as SupabaseClient, writes };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("actual worker operational advisory seam", () => {
  it("preserves all persistence/offer/task writes through actual registry and custom Xometry", async () => {
    const baseline = database(); await handleVendorQuoteTask(baseline.client, task, config);
    const off = database(); await handleVendorQuoteTask(off.client, task, config,
      { session: new OperationalJevSession({ mode: "off" }), sourceRevision: scope.sourceRevision, observations: new OperationalJevObservations() });
    const fixture = sessionFixture(); const shadow = database();
    await handleVendorQuoteTask(shadow.client, task, config, fixture.capability);
    expect(shadow.writes).toEqual(baseline.writes); expect(off.writes).toEqual(baseline.writes);
    expect(shadow.writes).toEqual(expect.arrayContaining([expect.objectContaining({ rpc: "reconcile_vendor_quote_offers" }),
      expect.objectContaining({ table: "work_queue", update: expect.objectContaining({ status: "completed" }) })]));
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
        notes: ["Automatic fictiv dispatch authorization was denied before adapter launch; manual follow-up is required."],
        raw_payload: expect.objectContaining({ failureCode: "permit_revoked", manualFollowUpReason: "permit_revoked",
          requiresManualVendorFollowUp: true, retryScheduledFor: null }) }) },
      { table: "work_queue", update: expect.objectContaining({ status: "completed" }) },
    ]));
    await fixture.capability.observations.drain();
    expect(fixture.caps.decide).not.toHaveBeenCalled();
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
    await vi.waitFor(() => expect(db.writes).toEqual(expect.arrayContaining([expect.objectContaining({ table: "work_queue" })])));
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
      count: async () => selector === XOMETRY_LOCATORS.offerContainers[0] ? 1 : 0,
      nth: () => ({ innerText: async () => source, getAttribute: async () => null,
        locator: (selector: string) => selector.includes("disabled") ? { count: async () => 0 }
          : { first: () => ({ innerText: async () => "Fastest - Lead Time: 5 business days" }) } }),
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
    expect(db.writes).toEqual(expect.arrayContaining([expect.objectContaining({ table: "work_queue", update: expect.objectContaining({ status: "completed" }) })]));
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
