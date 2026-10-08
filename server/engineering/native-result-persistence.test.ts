// @vitest-environment node
import { createHash, createHmac, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createNativeResultFinalizer, type NativeFinalizationEnvelope, type NativeFinalizationReceipt } from "./native-result-finalization";
import { createNativeFinalizationPersistence } from "./native-result-persistence";
import { createNativeFinalizationExecutor, NATIVE_FINALIZATION_SQL,
  type NativeOwnerSqlClient, type NativeOwnerSqlPool } from "./native-result-executor";
import { createNativeResultRepository } from "./native-result-repository";
import { produceNativeVerificationEnvelope } from "./native-result-receipt";
import { storedNativeFixture } from "./native-result-fixture";

/** Inert SQL-driver simulation: models transaction visibility, a unique-attempt
 * insertion lock and commit-response loss. It does NOT execute/prove the SQL. */
function driverFixture() {
  const pending = new Map<string, NativeFinalizationEnvelope>();
  const finals = new Map<string, { envelope: NativeFinalizationEnvelope; receipt: NativeFinalizationReceipt }>();
  const locks = new Map<string, Promise<void>>();
  const calls: { client: number; text: string; values: unknown[] }[] = [];
  const releases: { client: number; destroy: boolean }[] = [];
  let clients = 0, commits = 0, dropCommit: "persist" | "finalize" | undefined;
  const pool: NativeOwnerSqlPool = { connect: vi.fn(async () => {
    const id = ++clients;
    let unlock: (() => void) | undefined;
    let proposedPending: { attempt: string; envelope: NativeFinalizationEnvelope } | undefined;
    let proposedFinal: { attempt: string; envelope: NativeFinalizationEnvelope; receipt: NativeFinalizationReceipt } | undefined;
    const lock = async (attempt: string) => {
      const previous = locks.get(attempt) ?? Promise.resolve();
      const next = new Promise<void>(resolve => { unlock = resolve; });
      locks.set(attempt, next); await previous;
    };
    const client: NativeOwnerSqlClient = {
      async query(text, values = []) {
        calls.push({ client: id, text, values: [...values] });
        if (text.startsWith("begin") || text.startsWith("set local")) return { rows: [] };
        if (text === NATIVE_FINALIZATION_SQL.load) return { rows: [{ value: pending.get(values[1] as string) ?? null }] };
        if (text === NATIVE_FINALIZATION_SQL.persist) {
          const [, attempt, payload, signature, context, key] = values as string[];
          await lock(attempt);
          const envelope = { p_payload_text: payload, p_signature: signature, p_candidate_context_text: context, p_key: key };
          const winner = pending.get(attempt) ?? envelope;
          proposedPending = { attempt, envelope: winner };
          return { rows: [{ value: winner }] };
        }
        if (text === NATIVE_FINALIZATION_SQL.finalize) {
          const [payload, signature, context, key] = values as string[];
          const p = JSON.parse(payload);
          await lock(p.attemptId);
          const envelope = { p_payload_text: payload, p_signature: signature, p_candidate_context_text: context, p_key: key };
          const prior = finals.get(p.attemptId);
          if (prior && JSON.stringify(prior.envelope) !== JSON.stringify(envelope)) throw new Error("conflicting replay");
          const receipt: NativeFinalizationReceipt = prior?.receipt ?? { outcome: "finalized", taskId: p.taskId,
            attemptId: p.attemptId, fence: p.fence, snapshotId: p.candidateSnapshotId,
            inputAdmissionId: "66666666-6666-4666-8666-666666666666", successorTaskId: null };
          proposedFinal = { attempt: p.attemptId, envelope, receipt };
          return { rows: [{ value: receipt }] };
        }
        if (text === "commit") {
          commits++;
          if (proposedPending) pending.set(proposedPending.attempt, proposedPending.envelope);
          if (proposedFinal) finals.set(proposedFinal.attempt, proposedFinal);
          unlock?.(); unlock = undefined;
          if ((proposedPending && dropCommit === "persist") || (proposedFinal && dropCommit === "finalize")) {
            dropCommit = undefined; throw new Error("commit response lost after commit");
          }
          return { rows: [] };
        }
        throw new Error("Unexpected SQL operation");
      },
      release(destroy = false) { releases.push({ client: id, destroy }); unlock?.(); unlock = undefined; },
    };
    return client;
  }) };
  return { pool, pending, finals, calls, releases, commits: () => commits, loseCommit: (operation: "persist" | "finalize") => { dropCommit = operation; } };
}
function setup() {
  const fixture = storedNativeFixture(), db = driverFixture(), key = randomBytes(32);
  const results = { loadAdmission: vi.fn(async () => fixture.admission), readRegisteredObject: vi.fn(fixture.reader), isCurrent: vi.fn(async () => true) };
  const repository = createNativeResultRepository({ enabled: true, pool: db.pool, results });
  const config = { enabled: true, repository, key, now: () => new Date("2026-09-26T00:00:00.000Z") };
  const ids = [fixture.admission.taskId, fixture.admission.active.attemptId] as const;
  const prepared = async (): Promise<NativeFinalizationEnvelope> => {
    const verified = await produceNativeVerificationEnvelope({ ...config, repository: results, taskId: ids[0], attemptId: ids[1] });
    return { p_payload_text: verified.payloadText, p_signature: verified.receipt.signature,
      p_candidate_context_text: verified.candidateContextText, p_key: "55555555-5555-4555-8555-555555555555" };
  };
  return { db, fixture, results, repository, config, ids, prepared, service: createNativeResultFinalizer(config) };
}
const signal = () => new AbortController().signal;

describe("concrete private native finalization persistence and executor", () => {
  it("is default-off and never checks out a connection", async () => {
    const s = setup(), adapter = createNativeFinalizationPersistence({ pool: s.db.pool });
    await expect(adapter.loadPending(...s.ids, signal())).rejects.toThrow("disabled");
    expect(s.db.pool.connect).not.toHaveBeenCalled();
  });
  it("passes exact strings as parameters and acknowledges commit before returning persistence", async () => {
    const s = setup(), envelope = await s.prepared();
    // JSON whitespace and string escaping must survive as signed UTF-8 text.
    const formattedContext = JSON.stringify(JSON.parse(envelope.p_candidate_context_text), null, 2) + "\n";
    const payload = JSON.parse(envelope.p_payload_text);
    payload.candidateContextSha256 = createHash("sha256").update(formattedContext).digest("hex");
    const formattedPayload = JSON.stringify(payload, null, 2) + "\n";
    const exact = { ...envelope, p_candidate_context_text: formattedContext, p_payload_text: formattedPayload,
      p_signature: createHmac("sha256", s.config.key).update(formattedPayload).digest("hex") };
    const saved = await s.repository.persistPending(...s.ids, exact, signal());
    expect(saved).toEqual(exact);
    expect(s.db.pending.get(s.ids[1])).toEqual(exact);
    expect(s.db.commits()).toBe(1);
    const query = s.db.calls.find(call => call.text === NATIVE_FINALIZATION_SQL.persist)!;
    expect(query.values).toEqual([...s.ids, exact.p_payload_text, exact.p_signature, exact.p_candidate_context_text, exact.p_key]);
    expect(query.text).not.toContain(envelope.p_payload_text);
    expect(s.db.calls.map(call => call.text)).toEqual(["begin isolation level read committed", "set local synchronous_commit = 'on'", "set local statement_timeout = '30s'",
      "set local lock_timeout = '5s'", NATIVE_FINALIZATION_SQL.persist, "commit"]);
    expect(s.db.releases).toEqual([{ client: 1, destroy: false }]);
    expect(await s.repository.loadPending(...s.ids, signal())).toEqual(exact);
  });
  it("completes through the existing bridge with the exact owner-only finalization operation", async () => {
    const s = setup();
    const receipt = await s.service.finalize(...s.ids);
    expect(receipt.outcome).toBe("finalized");
    expect(s.results.readRegisteredObject).toHaveBeenCalledTimes(7);
    expect(s.db.finals.size).toBe(1);
    const envelope = s.db.pending.get(s.ids[1])!;
    expect(s.db.calls.filter(call => call.text === NATIVE_FINALIZATION_SQL.finalize).map(call => call.values)).toEqual([
      [envelope.p_payload_text, envelope.p_signature, envelope.p_candidate_context_text, envelope.p_key],
    ]);
  });
  it.each(["persist", "finalize"] as const)("reconciles lost %s COMMIT reply after restart without regenerating bytes", async (operation) => {
    const s = setup(); s.db.loseCommit(operation);
    await expect(s.service.finalize(...s.ids)).rejects.toThrow(/outcome unknown/);
    expect(s.db.pending.size).toBe(1);
    expect(s.db.releases.at(-1)?.destroy).toBe(true);
    const envelope = s.db.pending.get(s.ids[1]);
    const restarted = createNativeResultFinalizer(s.config);
    await expect(restarted.finalize(...s.ids)).rejects.toThrow("explicit replay");
    await expect(restarted.replay(...s.ids)).resolves.toMatchObject({ outcome: "finalized" });
    expect(s.db.pending.get(s.ids[1])).toEqual(envelope);
    expect(s.db.finals.size).toBe(1);
    expect(s.results.readRegisteredObject).toHaveBeenCalledTimes(7);
    expect(s.db.calls.filter(call => call.text === NATIVE_FINALIZATION_SQL.persist)).toHaveLength(1);
  });
  it("returns one immutable winner across concurrent clients and leaves the losing bridge for explicit replay", async () => {
    const s = setup();
    const responses = await Promise.allSettled([s.service.finalize(...s.ids), s.service.finalize(...s.ids)]);
    expect(responses.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(responses.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(s.db.pending.size).toBe(1); expect(s.db.finals.size).toBe(1);
    expect(s.db.calls.filter(call => call.text === NATIVE_FINALIZATION_SQL.finalize)).toHaveLength(1);
    await expect(s.service.replay(...s.ids)).resolves.toMatchObject({ outcome: "finalized" });
  });
  it("rejects foreign or oversized envelope inputs before SQL", async () => {
    const s = setup(), envelope = await s.prepared();
    await expect(s.repository.persistPending("77777777-7777-4777-8777-777777777777", s.ids[1], envelope, signal())).rejects.toThrow("binding mismatch");
    await expect(s.repository.persistPending(...s.ids, { ...envelope, p_payload_text: "x".repeat(16385) }, signal())).rejects.toThrow("Invalid pending");
    expect(s.db.pool.connect).not.toHaveBeenCalled();
  });
  it.each(["persist", "finalize"] as const)("labels malformed %s responses after COMMIT as unknown", async (operation) => {
    const s = setup(), prepared = await s.prepared(), release = vi.fn();
    const client = { query: vi.fn(async (text: string) => text.startsWith("select") ? { rows: [{ value: {} }] } : { rows: [] }), release };
    const repository = createNativeFinalizationPersistence({ enabled: true, pool: { connect: async () => client } });
    const result = operation === "persist" ? repository.persistPending(...s.ids, prepared, signal()) : repository.finalize(prepared, signal());
    await expect(result).rejects.toThrow("outcome unknown");
    expect(client.query).toHaveBeenCalledWith("commit");
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it("rejects a nonfixed operation without acquiring a connection", async () => {
    const s = setup(), execute = createNativeFinalizationExecutor({ pool: s.db.pool, enabled: true });
    await expect(execute("set role postgres" as "load", [], signal())).rejects.toThrow("Invalid native SQL operation");
    expect(s.db.pool.connect).not.toHaveBeenCalled();
  });
});

describe("native owner SQL transaction cancellation and malformed responses", () => {
  function harness(query: NativeOwnerSqlClient["query"], timeoutMs = 100) {
    const release = vi.fn(), client = { query: vi.fn(query), release };
    const pool = { connect: vi.fn(async () => client) };
    return { client, pool, execute: createNativeFinalizationExecutor({ pool, enabled: true, timeoutMs }) };
  }
  it("destroys a client with an unacknowledged write and never queues COMMIT or retry", async () => {
    const h = harness(async text => text === NATIVE_FINALIZATION_SQL.persist ? new Promise(() => {}) : { rows: [] }, 10);
    await expect(h.execute("persist", ["t", "a", "p", "s", "c", "k"], signal())).rejects.toThrow("outcome unknown");
    expect(h.client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.client.query).not.toHaveBeenCalledWith("commit");
    expect(h.client.query.mock.calls.filter(([text]) => text === NATIVE_FINALIZATION_SQL.persist)).toHaveLength(1);
  });
  it("destroys late checkout after abort without sending any SQL", async () => {
    const controller = new AbortController(), client = { query: vi.fn(), release: vi.fn() };
    let finish!: (value: NativeOwnerSqlClient) => void;
    const pool = { connect: vi.fn(() => new Promise<NativeOwnerSqlClient>(resolve => { finish = resolve; })) };
    const execute = createNativeFinalizationExecutor({ pool, enabled: true });
    const result = execute("load", ["t", "a"], controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow("before write");
    finish(client); await new Promise(resolve => setTimeout(resolve, 0));
    expect(client.query).not.toHaveBeenCalled(); expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("does not queue a successor when an aborted query resolves late", async () => {
    const controller = new AbortController(); let finish!: (value: { rows: unknown[] }) => void;
    const h = harness(async text => text === NATIVE_FINALIZATION_SQL.persist
      ? new Promise(resolve => { finish = resolve; controller.abort(); }) : { rows: [] });
    await expect(h.execute("persist", ["t", "a", "p", "s", "c", "k"], controller.signal)).rejects.toThrow("outcome unknown");
    finish({ rows: [{ value: {} }] }); await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.client.query).not.toHaveBeenCalledWith("commit");
    expect(h.client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("rejects malformed SQL cardinality and destroys the transaction", async () => {
    const h = harness(async () => ({ rows: [{ value: null }, { value: null }] }));
    await expect(h.execute("load", ["t", "a"], signal())).rejects.toThrow("before write");
    expect(h.client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.client.query).not.toHaveBeenCalledWith("commit");
  });
  it("rejects an already aborted invocation before checkout", async () => {
    const h = harness(async () => ({ rows: [] })), controller = new AbortController(); controller.abort();
    await expect(h.execute("load", ["t", "a"], controller.signal)).rejects.toThrow("before write");
    expect(h.pool.connect).not.toHaveBeenCalled();
  });
});
