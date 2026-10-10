// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, chmod, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createNativeStopWorkflow } from "./native-stop-workflow";
import { createNativeStopWorkflowStore } from "./native-stop-workflow-store";
import { createNativeObserverRepository } from "./native-observer-repository";
import { createNativeStopClient } from "./native-stop-client";
import { createNativeStopHandler } from "./native-stop-transport";
import { createNativeStopRepository } from "./native-stop-repository";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const uuid = id(30), actorToken = (role = "ovd575_observer_validator") => `e30.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.fixture`;
const identity = { workerId: id(3), bootId: id(5), taskId: id(6), attemptId: id(7), fence: 1, revision: 4, idempotencyKey: id(20) };
const receipt = { outcome: "process_stopped", attemptId: id(7), revision: 5, taskRevision: 6,
  resultEligible: true, phase: "awaiting_result", failureCode: null, verification: "unverified" };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ovd562-stop-workflow-")); roots.push(root);
  const base = "scripts/native/stop-observer/fixtures/";
  const manifest = await readFile(base + "manifest.json"), journal = await readFile(base + "journal.json");
  const ingest = vi.fn(async () => Response.json(uuid));
  const stop = vi.fn(async () => Response.json({ schema: "overdrafter.native-stop-request.v1", action: "record_stop", receipt }));
  const config = { enabled: true, spoolRoot: root,
    observer: { url: "https://validator.invalid", profileId: id(21), token: actorToken(), fetch: ingest as typeof fetch },
    stop: { origin: "https://worker.invalid", token: `odw_${"a".repeat(64)}`, fetch: stop as typeof fetch } };
  return { root, manifest, journal, ingest, stop, config, workflow: createNativeStopWorkflow(config) };
}
describe("private observer-to-stop workflow", () => {
  it("default off performs no disk or transport action", async () => {
    const f = await fixture();
    const workflow = createNativeStopWorkflow({ ...f.config, enabled: undefined, spoolRoot: "/nonexistent" });
    await expect(workflow.stage({ identity, manifest: f.manifest, journal: f.journal })).rejects.toMatchObject({ code: "stop_workflow_disabled" });
    await expect(workflow.ingest(id(7), 1)).rejects.toMatchObject({ code: "stop_workflow_disabled" });
    await expect(workflow.submitStop(id(7), 1)).rejects.toMatchObject({ code: "stop_workflow_disabled" });
    expect(f.ingest).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
  });
  it("stages exact canonical bytes, ingests separately, then sends through existing OVD577 handler and OVD576 adapter", async () => {
    const f = await fixture();
    const sql = vi.fn(async () => Response.json(receipt));
    const handler = createNativeStopHandler({ enabled: () => true,
      repository: () => createNativeStopRepository({ url: "https://stop-executor.invalid", token: actorToken("ovd576_stop_validator"), fetch: sql as typeof fetch }) });
    const stop = vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(new Request(url, init)));
    const workflow = createNativeStopWorkflow({ ...f.config, stop: { ...f.config.stop, fetch: stop as typeof fetch } });
    await workflow.stage({ identity, manifest: f.manifest, journal: f.journal });
    expect(f.ingest).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
    expect(await workflow.ingest(id(7), 1)).toMatchObject({ evidenceId: uuid, stopAdmitted: false });
    expect(stop).not.toHaveBeenCalled();
    const [url, init] = vi.mocked(f.config.observer.fetch).mock.calls[0];
    expect(url).toBe("https://validator.invalid/rpc/store_native_observer_evidence");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("content-profile")).toBe("engineering_private");
    expect(JSON.parse(init?.body as string)).toEqual({ p_profile: id(21), p_manifest: `\\x${f.manifest.toString("hex")}`, p_journal: `\\x${f.journal.toString("hex")}` });
    const result = await workflow.submitStop(id(7), 1);
    expect(result.receipt).toEqual(receipt);
    const args = JSON.parse(vi.mocked(sql as typeof fetch).mock.calls[0][1]?.body as string);
    expect(args).toEqual({ p_worker: identity.workerId, p_credential: createHash("sha256").update(f.config.stop.token).digest("hex"),
      p_boot: identity.bootId, p_task: identity.taskId, p_attempt: identity.attemptId, p_fence: 1, p_evidence: uuid, p_revision: 4, p_key: identity.idempotencyKey });
    expect((await workflow.submitStop(id(7), 1)).replayedLocally).toBe(true);
    expect(sql).toHaveBeenCalledTimes(1);
    const contents = (await Promise.all((await readdir(f.root)).map(file => readFile(join(f.root, file), "utf8")))).join("");
    expect(contents).not.toContain(f.config.observer.token); expect(contents).not.toContain(f.config.stop.token);
  });
  it("restart after lost ingestion reply replays only identical bytes and does not submit stop", async () => {
    const f = await fixture(); let first: unknown;
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const args = JSON.parse(init?.body as string);
      if (!first) { first = args; throw new Error("committed response lost"); }
      expect(args).toEqual(first); return Response.json(uuid);
    });
    const config = { ...f.config, observer: { ...f.config.observer, fetch: fetcher as typeof fetch } };
    const workflow = createNativeStopWorkflow(config);
    await workflow.stage({ identity, manifest: f.manifest, journal: f.journal });
    await expect(workflow.ingest(id(7), 1)).rejects.toMatchObject({ uncertain: true });
    expect(await createNativeStopWorkflow(config).ingest(id(7), 1)).toMatchObject({ evidenceId: uuid });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(f.stop).not.toHaveBeenCalled();
  });
  it("old ingestion SQL duplicate is unknown, not a fabricated evidence ID", async () => {
    const f = await fixture();
    const workflow = createNativeStopWorkflow({ ...f.config, observer: { ...f.config.observer,
      fetch: vi.fn(async () => Response.json({ code: "23505" }, { status: 400 })) as typeof fetch } });
    await workflow.stage({ identity, manifest: f.manifest, journal: f.journal });
    await expect(workflow.ingest(id(7), 1)).rejects.toMatchObject({ code: "observer_outcome_unknown", uncertain: true });
    await expect(workflow.submitStop(id(7), 1)).rejects.toMatchObject({ code: "stop_evidence_missing" });
    expect(f.stop).not.toHaveBeenCalled();
  });
  it("restart after lost stop commit reuses exact durable revision, evidence and key", async () => {
    const f = await fixture(); let first: unknown;
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const args = JSON.parse(init?.body as string);
      if (!first) { first = args; throw new Error("lost committed stop"); }
      expect(args).toEqual(first);
      return Response.json({ schema: "overdrafter.native-stop-request.v1", action: "record_stop", receipt });
    });
    const config = { ...f.config, stop: { ...f.config.stop, fetch: fetcher as typeof fetch } };
    const workflow = createNativeStopWorkflow(config);
    await workflow.stage({ identity, manifest: f.manifest, journal: f.journal }); await workflow.ingest(id(7), 1);
    await expect(workflow.submitStop(id(7), 1)).rejects.toMatchObject({ uncertain: true });
    expect(await createNativeStopWorkflow(config).submitStop(id(7), 1)).toMatchObject({ receipt });
    expect(f.ingest).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("missing independent qualification remains an explicit rejection and no result authority", async () => {
    const f = await fixture();
    const workflow = createNativeStopWorkflow({ ...f.config, stop: { ...f.config.stop,
      fetch: vi.fn(async () => Response.json({ schema: "overdrafter.native-stop-request.v1", error: "stop_not_admitted", outcome: "not_applied", retrySameRequest: false }, { status: 409 })) as typeof fetch } });
    await workflow.stage({ identity, manifest: f.manifest, journal: f.journal }); await workflow.ingest(id(7), 1);
    await expect(workflow.submitStop(id(7), 1)).rejects.toMatchObject({ code: "stop_not_admitted", uncertain: false });
    expect((await readdir(f.root)).some(file => file.includes("receipt"))).toBe(false);
  });
  it.each(["service_role", "authenticated", "anon", "ovd576_stop_validator"])("denies wrong observer executor %s before network", async role => {
    const f = await fixture();
    expect(() => createNativeObserverRepository({ ...f.config.observer, token: actorToken(role) })).toThrow();
    expect(f.ingest).not.toHaveBeenCalled();
  });
  it.each(["42501", "PT409", "22023"])("preserves explicit observer SQL rejection %s", async code => {
    const f = await fixture(); const repo = createNativeObserverRepository({ ...f.config.observer,
      fetch: vi.fn(async () => Response.json({ code }, { status: 400 })) as typeof fetch });
    await expect(repo.ingest(f.manifest, f.journal)).rejects.toMatchObject({ uncertain: false });
  });
  it("bounds noncooperative ingestion and malformed successful replies", async () => {
    const f = await fixture();
    const repo = createNativeObserverRepository({ ...f.config.observer, deadlineMs: 5,
      fetch: vi.fn(() => new Promise(() => {})) as typeof fetch });
    await expect(repo.ingest(f.manifest, f.journal)).rejects.toMatchObject({ uncertain: true });
    const client = createNativeStopClient({ ...f.config.stop, fetch: vi.fn(async () => Response.json({ schema: "overdrafter.native-stop-request.v1", action: "record_stop", receipt: { ...receipt, revision: 999 } })) as typeof fetch });
    await expect(client.submit({ ...identity, evidenceId: uuid })).rejects.toMatchObject({ uncertain: true });
  });
  it.each(["ingest", "stop"])("%s remote success followed by local publication failure remains unknown", async phase => {
    const f = await fixture();
    const commitThenLoseStore = vi.fn(async () => {
      await chmod(f.root, 0o755);
      return phase === "ingest" ? Response.json(uuid) : Response.json({ schema: "overdrafter.native-stop-request.v1", action: "record_stop", receipt });
    });
    const workflow = createNativeStopWorkflow({ ...f.config,
      observer: { ...f.config.observer, fetch: phase === "ingest" ? commitThenLoseStore as typeof fetch : f.config.observer.fetch },
      stop: { ...f.config.stop, fetch: phase === "stop" ? commitThenLoseStore as typeof fetch : f.config.stop.fetch } });
    await workflow.stage({ identity, manifest: f.manifest, journal: f.journal });
    if (phase === "stop") await workflow.ingest(id(7), 1);
    await expect(phase === "ingest" ? workflow.ingest(id(7), 1) : workflow.submitStop(id(7), 1)).rejects.toMatchObject({ uncertain: true });
    expect(commitThenLoseStore).toHaveBeenCalledTimes(1);
    await chmod(f.root, 0o700);
  });
  it("late explicit rejection cannot bypass the elapsed deadline", async () => {
    const f = await fixture();
    const repo = createNativeObserverRepository({ ...f.config.observer, deadlineMs: 2, fetch: vi.fn(async () => {
      const until = performance.now() + 15;
      while (performance.now() < until) { /* inert event-loop stall */ }
      return Response.json({ code: "42501" }, { status: 400 });
    }) as typeof fetch });
    await expect(repo.ingest(f.manifest, f.journal)).rejects.toMatchObject({ uncertain: true });
  });
  it("late event-loop completion is unknown and cannot persist a successful phase", async () => {
    const f = await fixture();
    const late = vi.fn(async () => {
      const until = performance.now() + 15;
      while (performance.now() < until) { /* deterministic inert event-loop stall */ }
      return Response.json(uuid);
    });
    const workflow = createNativeStopWorkflow({ ...f.config, observer: { ...f.config.observer, deadlineMs: 2, fetch: late as typeof fetch } });
    await workflow.stage({ identity, manifest: f.manifest, journal: f.journal });
    await expect(workflow.ingest(id(7), 1)).rejects.toMatchObject({ uncertain: true });
    expect((await readdir(f.root)).some(file => file.includes("evidence"))).toBe(false);
    expect(f.stop).not.toHaveBeenCalled();
  });
  it("deadline cancels a stalled response body and leaves no evidence receipt", async () => {
    const f = await fixture(), cancelled = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled })));
    const workflow = createNativeStopWorkflow({ ...f.config, observer: { ...f.config.observer, deadlineMs: 5, fetch: fetcher as typeof fetch } });
    await workflow.stage({ identity, manifest: f.manifest, journal: f.journal });
    await expect(workflow.ingest(id(7), 1)).rejects.toMatchObject({ uncertain: true });
    expect(cancelled).toHaveBeenCalled();
    expect((await readdir(f.root)).some(file => file.includes("evidence"))).toBe(false);
  });
  it("rejects noncanonical, changed, foreign, oversize and claimed-authority evidence before any send", async () => {
    const f = await fixture();
    for (const manifest of [Buffer.concat([f.manifest, Buffer.from("\n")]), Buffer.from(f.manifest.toString().replace('"stopAdmission":false', '"stopAdmission":true')), Buffer.alloc(131073)]) {
      await expect(f.workflow.stage({ identity, manifest, journal: f.journal })).rejects.toThrow();
    }
    await expect(f.workflow.stage({ identity: { ...identity, fence: 2 }, manifest: f.manifest, journal: f.journal })).rejects.toThrow();
    await expect(f.workflow.stage({ identity, manifest: f.manifest, journal: Buffer.from("{}") })).rejects.toThrow();
    expect(f.ingest).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
  });
  it("immutable packet denies changed revision/key/profile/endpoint and copied attempt", async () => {
    const f = await fixture(); await f.workflow.stage({ identity, manifest: f.manifest, journal: f.journal });
    for (const patch of [{ revision: 5 }, { idempotencyKey: id(99) }]) {
      await expect(f.workflow.stage({ identity: { ...identity, ...patch }, manifest: f.manifest, journal: f.journal })).rejects.toMatchObject({ code: "stop_spool_conflict" });
    }
    const changed = createNativeStopWorkflow({ ...f.config, observer: { ...f.config.observer, profileId: id(98) } });
    await expect(changed.ingest(id(7), 1)).rejects.toMatchObject({ code: "stop_packet_scope_differs" });
    const moved = createNativeStopWorkflow({ ...f.config, stop: { ...f.config.stop, origin: "https://other.invalid" } });
    await expect(moved.ingest(id(7), 1)).rejects.toMatchObject({ code: "stop_packet_scope_differs" });
    await expect(f.workflow.ingest(id(98), 1)).rejects.toMatchObject({ code: "stop_packet_missing" });
    expect(f.ingest).not.toHaveBeenCalled();
  });
  it("concurrent identical staging is create-once and retained bytes survive caller mutation", async () => {
    const f = await fixture(); const bytes = Buffer.from(f.manifest);
    const first = f.workflow.stage({ identity, manifest: bytes, journal: f.journal }); bytes.fill(0);
    await Promise.all([first, f.workflow.stage({ identity, manifest: f.manifest, journal: f.journal })]);
    await f.workflow.ingest(id(7), 1);
    expect((await readdir(f.root)).filter(file => file.endsWith("packet.json"))).toHaveLength(1);
  });
  it("private store denies unsafe roots, links, corrupt and conflicting files", async () => {
    const f = await fixture(), store = createNativeStopWorkflowStore(f.root), name = `${id(7)}-1.packet.json`;
    await store.publish(name, "first"); await expect(store.publish(name, "different")).rejects.toMatchObject({ code: "stop_spool_conflict" });
    await expect(store.read("../../secret")).rejects.toThrow();
    const linkName = `${id(8)}-1.packet.json`;
    await symlink(join(f.root, name), join(f.root, linkName)); await expect(store.read(linkName)).rejects.toThrow();
    await writeFile(join(f.root, name), "", { mode: 0o600 }); await expect(store.read(name)).rejects.toThrow();
    await chmod(f.root, 0o755); await expect(store.read(name)).rejects.toMatchObject({ code: "stop_spool_not_private" });
  });
});

// OVD-649's approved comparator deviation: keep the checkpoint tests above verbatim.
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NativeStopFailure, stopObject } from "./native-stop-admission";

type CanonicalProof = {
  canonical: (value: unknown) => string;
  checkedBytes: (bytes: Uint8Array, limit: number) => Record<string, unknown>;
};
const proofDigest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
async function canonicalProof() {
  // Exercise the actual private serializer without adding a production export.
  const source = await readFile("server/engineering/native-stop-workflow.ts", "utf8");
  const start = source.indexOf("function canonical("), end = source.indexOf("function validateEvidence(");
  assert.ok(start >= 0 && end > start);
  const current = source.slice(start, end);
  const comparator = ".sort((left, right) => { if (left < right) return -1; if (left > right) return 1; return 0; })";
  assert.equal(current.split(comparator).length, 2);
  const checkpoint = current.replace(comparator, ".sort()");
  // Pin the original function bytes so the equivalence oracle cannot drift with a refactor.
  assert.equal(proofDigest(checkpoint), "3aa1f1f5b7b51e9b20835ca4853767c8b21d19531024c9e9f9742c36ef123610");
  const compile = (text: string): CanonicalProof => runInNewContext(
    ts.transpileModule(`${text}\n({ canonical, checkedBytes });`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    { NativeStopFailure, stopObject, TextDecoder },
    { timeout: 1000 },
  );
  return { before: compile(checkpoint), after: compile(current) };
}

describe("UTF-16 comparator checkpoint equivalence", () => {
  it("preserves canonical key order for all 65,536 UTF-16 code units", async () => {
    const { before, after } = await canonicalProof();
    const value = Object.fromEntries(Array.from({ length: 65536 }, (_, n) => [String.fromCharCode(65535 - n), n]));
    assert.equal(after.canonical(value), before.canonical(value));
  });

  it("preserves prefixes, numeric-looking keys, escaped characters and surrogate boundaries", async () => {
    const { before, after } = await canonicalProof();
    const keys = ["", "a", "aa", "a\0", "A", "Z", "z", "2", "10", "01", "-1", "4294967295", "4294967294",
      "é", "e\u0301", "ä", "中", "\ud7ff", "\ud800", "\udbff", "\udc00", "\udfff", "\ud83d\ude00", "\ue000", "\uffff",
      '"', "\\", "__proto__", "constructor", "prototype"];
    const value = Object.fromEntries(keys.map((key, n) => [key, { value: [n, key, false, null] }]));
    assert.equal(after.canonical(value), before.canonical(value));
    assert.equal(proofDigest(after.canonical(value)), proofDigest(before.canonical(value)));
    // Explicit outputs distinguish lexical UTF-16 order from numeric/locale/UTF-8 order.
    assert.equal(after.canonical({ "2": false, "10": true }), '{"10":true,"2":false}');
    assert.equal(after.canonical({ a: false, Z: true }), '{"Z":true,"a":false}');
    assert.equal(after.canonical({ "\ue000": false, "\ud83d\ude00": true }), '{"\\ud83d\\ude00":true,"\\ue000":false}');
  });

  it("preserves bytes and hashes for 20,000 random UTF-16 and 5,000 forced-surrogate batches", async () => {
    const { before, after } = await canonicalProof();
    let seed = 0x6490620;
    const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const randomString = () => Array.from({ length: rand() % 13 }, () => String.fromCharCode(rand() & 0xffff)).join("");
    for (let batch = 0; batch < 25000; batch++) {
      const keys = Array.from({ length: 1 + rand() % 24 }, randomString);
      if (batch >= 20000) {
        const prefix = randomString(), high = String.fromCharCode(0xd800 + rand() % 0x400), low = String.fromCharCode(0xdc00 + rand() % 0x400);
        keys.push(prefix, prefix + high, prefix + low, prefix + high + low, prefix + high + "x", prefix + low + "x");
      }
      const value = Object.fromEntries(keys.map((key, n) => [key, { [key + "x"]: [key, n, true, null] }]));
      const expected = before.canonical(value), actual = after.canonical(value);
      assert.equal(actual, expected);
      assert.equal(proofDigest(actual), proofDigest(expected));
    }
  }, 20000);

  it.each([
    ["manifest", "46f015d083af66d255e60092c027793870acf0a4f86246665be1af291199efac"],
    ["journal", "e5f9def086a3292cbcbb7ca81e994b7feaf2a485088d488f562fb71b60eaed0b"],
    ["observation", "82b806ecb2ffa75e5240ae97194abb70a1fcbead1e33a5ce968e445e9c9c3e97"],
  ])("preserves actual %s fixture bytes and rejects reordered keys", async (name, sha256) => {
    const { before, after } = await canonicalProof();
    const bytes = await readFile(`scripts/native/stop-observer/fixtures/${name}.json`);
    const parsed = JSON.parse(bytes.toString("utf8"));
    assert.equal(proofDigest(bytes), sha256);
    for (const proof of [before, after]) {
      assert.equal(proof.canonical(parsed), bytes.toString("utf8"));
      expect(proof.checkedBytes(bytes, 1048576)).toEqual(parsed);
      const reordered = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse())));
      assert.equal(reordered.equals(bytes), false);
      expect(JSON.parse(reordered.toString("utf8"))).toEqual(parsed);
      assert.throws(() => proof.checkedBytes(reordered, 1048576),
        error => error instanceof NativeStopFailure && error.code === "invalid_observer_bytes" && error.status === 400);
    }
  });

  it("retains invalid-value and depth rejection semantics", async () => {
    const { before, after } = await canonicalProof();
    let nested: unknown = null;
    for (let depth = 0; depth < 14; depth++) nested = { a: nested };
    for (const value of [undefined, NaN, Infinity, 1.1, 1n, Symbol("x"), () => {}, { a: undefined }, nested]) {
      for (const proof of [before, after]) {
        assert.throws(() => proof.canonical(value), error => error instanceof NativeStopFailure
          && error.status === 400 && error.code === (value === nested ? "observer_json_depth" : "observer_json_value"));
      }
    }
  });

  it.each(["manifest-top", "manifest-binding", "journal-top", "journal-binding"])("rejects reordered %s keys before disk or transport effects", async variant => {
    const f = await fixture(), journalCase = variant.startsWith("journal");
    const originalBytes = journalCase ? f.journal : f.manifest;
    const original = JSON.parse(originalBytes.toString("utf8"));
    const reordered = variant.endsWith("binding")
      ? { ...original, binding: Object.fromEntries(Object.entries(original.binding).reverse()) }
      : Object.fromEntries(Object.entries(original).reverse());
    const bytes = Buffer.from(JSON.stringify(reordered));
    expect(bytes.equals(originalBytes)).toBe(false);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(original);
    await expect(f.workflow.stage({ identity, manifest: journalCase ? f.manifest : bytes, journal: journalCase ? bytes : f.journal }))
      .rejects.toMatchObject({ status: 400, code: "invalid_observer_bytes" });
    expect(f.ingest).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual([]);
  });
});
