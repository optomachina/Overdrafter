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
