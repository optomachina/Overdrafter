import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestAdapter, TEST_ADAPTER_SECRET, type TestAdapter, type TestAdapterOptions, type TestInboundRequest } from "../channels/test-adapter";
import { createDefaultChannelRegistry } from "../channels";
import { isJarvisUiEnabled, JARVIS_UI_FLAG } from "../jarvis-ui-flag";
import {
  ConversationService,
  GENERIC_DENIAL,
  LINK_PROMPT,
  NOT_AVAILABLE_REPLY,
  THROTTLED_REPLY,
  type ConversationServiceDeps,
  type InboundResult,
  type JarvisLogEntry,
} from "./conversation-service";
import { deliver } from "./delivery";
import { InMemoryJarvisRepo } from "./in-memory-repo";
import { createSlidingWindowLimiter } from "./rate-limiter";
import { createChannelRegistry } from "./registry";
import { NO_AGENT_REPLY, renderEvent, RUN_FAILED_REPLY } from "./render";
import type { AccessTier, DesignGraph, GraphEvent } from "./types";

const START = Date.parse("2026-10-15T12:00:00.000Z");
const WEB_BASE = "https://jarvis.example";
const hash = (value: string) => `h(${value})`;

type HarnessOptions = {
  readonly uiEnabled?: boolean;
  readonly testEnvironment?: boolean;
  readonly test?: TestAdapterOptions;
  readonly extraAdapters?: readonly TestAdapter[];
  readonly limiter?: ConversationServiceDeps["rateLimiter"];
};

function setup(options: HarnessOptions = {}) {
  const repo = new InMemoryJarvisRepo();
  let runs = 0;
  const runsByKey = new Map<string, string>();
  const graph = {
    // Same contract as the OVD-801 port: one run per idempotency key.
    submit: vi.fn<DesignGraph["submit"]>(async (_request, { idempotencyKey }) => {
      const runId = runsByKey.get(idempotencyKey) ?? `run-${++runs}`;
      runsByKey.set(idempotencyKey, runId);
      return runId;
    }),
    resolveDecision: vi.fn<DesignGraph["resolveDecision"]>(async () => ({ ok: true })),
    control: vi.fn<DesignGraph["control"]>(async () => ({ ok: true })),
    agentAvailability: vi.fn<DesignGraph["agentAvailability"]>((agent) => (agent === "cad" ? "enabled" : "disabled")),
  };
  const test = createTestAdapter(options.test);
  const web = createTestAdapter({ id: "web", testOnly: false });
  const adapters = [test, web, ...(options.extraAdapters ?? [])];
  for (const adapter of adapters) repo.channelSettings.set(adapter.id, { channel: adapter.id, enabled: true, minTier: "owner" });
  const logs: JarvisLogEntry[] = [];
  const sleeps: number[] = [];
  const clock = { ms: START };
  const service = new ConversationService({
    repo,
    graph,
    channels: createChannelRegistry(adapters),
    hash,
    uiEnabled: options.uiEnabled ?? true,
    testEnvironment: options.testEnvironment ?? true,
    rateLimiter: options.limiter ?? createSlidingWindowLimiter(),
    delivery: { maxAttempts: 3, baseDelayMs: 100, sleep: async (ms) => void sleeps.push(ms) },
    webBaseUrl: WEB_BASE,
    now: () => new Date(clock.ms),
    log: (entry) => logs.push(entry),
  });
  const grant = (userId: string, tier: AccessTier = "owner", revokedAt: string | null = null) =>
    repo.accessGrants.set(userId, { userId, tier, grantedBy: "admin", grantedAt: "2026-10-01T00:00:00Z", revokedAt });
  const link = (userId: string, channel = test.id, revokedAt: string | null = null) =>
    repo.insertIdentity({ userId, channel, externalIdHash: hash(`${channel}:ext-${userId}`), revokedAt });
  return { repo, graph, test, web, logs, sleeps, clock, service, grant, link };
}

type Harness = ReturnType<typeof setup>;

let eventSequence = 0;
function request(overrides: Partial<TestInboundRequest> = {}): TestInboundRequest {
  eventSequence += 1;
  return { secret: TEST_ADAPTER_SECRET, eventId: `evt-${eventSequence}`, externalUserId: "ext-blaine", text: "4 inch plate", ...overrides };
}

async function linkedOwner(options: HarnessOptions = {}): Promise<Harness> {
  const harness = setup(options);
  harness.grant("blaine");
  await harness.link("blaine");
  await harness.link("blaine", "web");
  return harness;
}

const graphCalls = (h: Harness) => h.graph.submit.mock.calls.length + h.graph.resolveDecision.mock.calls.length + h.graph.control.mock.calls.length;
const inboundCount = (h: Harness) => h.repo.messages.filter((message) => message.direction === "in").length;

// Graph events in the OVD-801 shape; every event carries its (runId, seq) identity.
let graphSeq = 0;
const envelope = (runId: string) => ({ runId, seq: ++graphSeq, at: START });

const decisionEvent = (runId: string, decisionId = "dec-1"): GraphEvent => ({
  ...envelope(runId),
  type: "decision_requested",
  decisionId,
  nodeId: "concept_picks",
  question: "Which material?",
  options: ["6061 aluminum", "304 stainless"],
  recommended: "6061 aluminum",
  bestGuess: "6061 aluminum",
  timeoutMs: 300_000,
});

const statusEvent = (runId: string, message: string): GraphEvent => ({ ...envelope(runId), type: "status", nodeId: "domain_agent", state: "info", message });

const artifactEvent = (runId: string, kind: "glb" | "step" | "png", uri: string): GraphEvent => ({
  ...envelope(runId),
  type: "artifact",
  nodeId: "domain_agent",
  agentId: "cad",
  kind,
  name: `plate.${kind}`,
  mimeType: "model/gltf-binary",
  uri,
});

describe("Jarvis ConversationService (OVD-798)", () => {
  it("CS-1 happy path: one submit, one append, outbound to origin + web", async () => {
    const h = await linkedOwner();
    const result = await h.service.handleInbound("test", request());

    expect(result).toEqual({ status: "accepted", runId: "run-1" });
    expect(h.graph.submit).toHaveBeenCalledTimes(1);
    expect(h.graph.submit.mock.calls[0][0]).toEqual({ prompt: "4 inch plate" });
    expect(h.graph.submit.mock.calls[0][1]).toMatchObject({ userId: "blaine", idempotencyKey: expect.stringMatching(/^test:evt-/) });
    expect(inboundCount(h)).toBe(1);
    expect(h.repo.messages[0]).toMatchObject({ direction: "in", channel: "test", graphRunId: "run-1" });
    expect(h.test.sent).toHaveLength(1);
    expect(h.test.sent[0].user).toEqual({ userId: "blaine", externalIdHash: hash("test:ext-blaine") });
    expect(h.web.sent).toHaveLength(1);
    expect(h.web.sent[0].message.text).toBe("Got it. Working on it.");
  });

  it("CS-2 duplicate inbound event id is processed once, including two concurrent copies", async () => {
    const h = await linkedOwner();
    const first = request();
    expect(await h.service.handleInbound("test", first)).toMatchObject({ status: "accepted" });
    expect(await h.service.handleInbound("test", first)).toEqual({ status: "duplicate" });
    expect(inboundCount(h)).toBe(1);
    expect(h.graph.submit).toHaveBeenCalledTimes(1);

    const concurrent = request();
    const results = await Promise.all([h.service.handleInbound("test", concurrent), h.service.handleInbound("test", concurrent)]);
    expect(results.map((r) => r.status).sort()).toEqual(["accepted", "duplicate"]);
    expect(inboundCount(h)).toBe(2);
    expect(h.graph.submit).toHaveBeenCalledTimes(2);
  });

  it("CS-3 unlinked identity is denied with a generic link prompt and a reason-code-only log", async () => {
    const h = setup();
    const result = await h.service.handleInbound("test", request({ externalUserId: "ext-stranger" }));

    expect(result).toEqual({ status: "denied", reply: LINK_PROMPT });
    expect(h.repo.conversations.size).toBe(0);
    expect(h.repo.messages).toHaveLength(0);
    expect(graphCalls(h)).toBe(0);
    expect(h.logs).toEqual([{ channel: "test", outcome: "denied", reason: "identity_unlinked" }]);
    expect(JSON.stringify(h.logs)).not.toContain("stranger");
  });

  it("CS-3b revoked identity gets the same response as an unlinked one", async () => {
    const h = setup();
    h.grant("blaine");
    await h.link("blaine", "test", "2026-10-14T00:00:00Z");
    const revoked = await h.service.handleInbound("test", request());
    const unlinked = await h.service.handleInbound("test", request({ externalUserId: "ext-stranger" }));

    expect(revoked).toEqual(unlinked);
    expect(h.repo.conversations.size).toBe(0);
    expect(graphCalls(h)).toBe(0);
    expect(h.logs[0]).toEqual({ channel: "test", outcome: "denied", reason: "identity_revoked" });
  });

  it("CS-4 disabled channel drops before identity lookup, persists nothing, and suppresses outbound", async () => {
    const h = await linkedOwner();
    h.repo.channelSettings.set("test", { channel: "test", enabled: false, minTier: "owner" });
    const findIdentity = vi.spyOn(h.repo, "findIdentity");

    expect(await h.service.handleInbound("test", request())).toEqual({ status: "dropped", reason: "channel_disabled" });
    expect(findIdentity).not.toHaveBeenCalled();
    expect(h.repo.inboundEvents.size).toBe(0);
    expect(h.repo.messages).toHaveLength(0);

    h.repo.channelSettings.set("test", { channel: "test", enabled: true, minTier: "owner" });
    h.repo.channelSettings.set("web", { channel: "web", enabled: false, minTier: "owner" });
    expect(await h.service.handleInbound("test", request())).toMatchObject({ status: "accepted" });
    expect(h.test.sent).toHaveLength(1);
    expect(h.web.attempts).toHaveLength(0);
    expect(h.logs).toContainEqual({ channel: "web", outcome: "outbound_suppressed" });
  });

  it.each([
    ["no grant", (h: Harness) => h.repo.accessGrants.delete("blaine"), "no_grant"],
    ["revoked grant", (h: Harness) => h.grant("blaine", "owner", "2026-10-14T00:00:00Z"), "grant_revoked"],
    ["tier below min_tier", (h: Harness) => h.grant("blaine", "beta"), "tier_below_min"],
  ])("CS-5 user outside the allowlist tier (%s) gets a generic denial and no graph call", async (_label, arrange, reason) => {
    const h = await linkedOwner();
    arrange(h);
    expect(await h.service.handleInbound("test", request())).toEqual({ status: "denied", reply: GENERIC_DENIAL });
    expect(graphCalls(h)).toBe(0);
    expect(h.repo.messages).toHaveLength(0);
    expect(h.logs.at(-1)).toEqual({ channel: "test", outcome: "denied", reason });
  });

  it("CS-6 rate limit throttles with zero side effects and releases the idempotency key", async () => {
    const h = await linkedOwner({ limiter: createSlidingWindowLimiter(1, 60_000) });
    expect(await h.service.handleInbound("test", request())).toMatchObject({ status: "accepted" });
    await h.service.handleGraphEvent(decisionEvent("run-1"));

    const throttledEvent = request();
    const messagesBefore = h.repo.messages.length;
    const decisionsBefore = JSON.stringify([...h.repo.decisions.values()]);
    expect(await h.service.handleInbound("test", throttledEvent)).toEqual({ status: "throttled", reply: THROTTLED_REPLY });
    expect(h.repo.messages).toHaveLength(messagesBefore);
    expect(h.graph.submit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...h.repo.decisions.values()])).toBe(decisionsBefore);
    expect(h.repo.inboundEvents.has(JSON.stringify(["test", throttledEvent.eventId]))).toBe(false);

    h.clock.ms += 60_000;
    expect(await h.service.handleInbound("test", throttledEvent)).toMatchObject({ status: "accepted" });
    expect(h.graph.submit).toHaveBeenCalledTimes(2);
  });

  it("CS-7 capability downgrade renders text plus a link instead of buttons or 3D", async () => {
    const h = await linkedOwner({ test: { capabilities: { buttons: false, model3d: false } } });
    await h.service.handleInbound("test", request());
    await h.service.handleGraphEvent(decisionEvent("run-1"));
    await h.service.handleGraphEvent(artifactEvent("run-1", "glb", "https://cdn.example/plate.glb"));

    const [, decision, artifact] = h.test.sent.map((send) => send.message);
    expect(decision.buttons).toBeUndefined();
    expect(decision.text).toContain("1. 6061 aluminum\n2. 304 stainless");
    expect(decision.text).toContain("Reply 1 / 2 / skip");
    expect(decision.link).toBe(`${WEB_BASE}/runs/run-1`);
    expect(artifact).toEqual({ text: "Your GLB is ready. Open it on the web.", link: `${WEB_BASE}/runs/run-1` });

    const [, webDecision, webArtifact] = h.web.sent.map((send) => send.message);
    expect(webDecision.buttons?.map((button) => button.id)).toEqual(["6061 aluminum", "304 stainless", "skip"]);
    expect(webArtifact.model3dUrl).toBe("https://cdn.example/plate.glb");
  });

  it("CS-8 send failures retry with backoff, never duplicate, and mark failed after N attempts", async () => {
    const h = await linkedOwner({ test: { sendResults: [{ ok: false, error: "503" }, { ok: false, error: "503" }] } });
    await h.service.handleInbound("test", request());
    expect(h.test.attempts).toHaveLength(3);
    expect(h.test.sent).toHaveLength(1);
    expect(new Set(h.test.attempts.map((attempt) => attempt.deliveryKey)).size).toBe(1);
    expect(h.sleeps).toEqual([100, 200]);
    const messageId = h.test.sent[0].deliveryKey.split(":")[0];
    expect(h.repo.outboundDeliveries.get(JSON.stringify([messageId, "test"]))).toMatchObject({ status: "sent", attempts: 3 });

    const policy = { maxAttempts: 3, baseDelayMs: 100, sleep: async () => undefined };
    const user = { userId: "blaine", externalIdHash: null };
    expect(await deliver(h.repo, h.test, user, messageId, { text: "again" }, policy)).toBe("duplicate");
    expect(h.test.attempts).toHaveLength(3);

    const failing = createTestAdapter({ id: "flaky", sendResults: [{ ok: false, error: "x" }, { ok: false, error: "x" }, { ok: false, error: "x" }] });
    expect(await deliver(h.repo, failing, user, "msg-x", { text: "hi" }, policy)).toBe("failed");
    expect(failing.attempts).toHaveLength(3);
    expect(h.repo.outboundDeliveries.get(JSON.stringify(["msg-x", "flaky"]))).toMatchObject({ status: "failed", attempts: 3 });

    const throwing = { ...createTestAdapter({ id: "throws" }), send: vi.fn(async () => Promise.reject(new Error("socket"))) };
    expect(await deliver(h.repo, throwing, user, "msg-y", { text: "hi" }, policy)).toBe("failed");
    expect(throwing.send).toHaveBeenCalledTimes(3);
  });

  it("CS-8b a replayed graph event (same runId + seq) is stored and sent once", async () => {
    const h = await linkedOwner({ test: { sendResults: [{ ok: true }, { ok: false, error: "503" }] } });
    await h.service.handleInbound("test", request());
    const decision = decisionEvent("run-1");
    const status = statusEvent("run-1", "Modeling the plate");
    for (const event of [decision, status, decision, status, { ...status }]) await h.service.handleGraphEvent(event);

    const outbound = h.repo.messages.filter((message) => message.direction === "out");
    expect(outbound.map((message) => message.kind)).toEqual(["run_accepted", "decision_requested", "status"]);
    expect(h.repo.decisions.size).toBe(1);
    expect(h.test.sent.map((send) => send.message.text)).toEqual(["Got it. Working on it.", "Which material?", "Modeling the plate"]);
    expect(h.web.sent).toHaveLength(3);
    expect(h.logs.filter((entry) => entry.outcome === "outbound_duplicate")).toHaveLength(6);

    // A different seq is a different event, even with the same body.
    await h.service.handleGraphEvent({ ...status, seq: status.seq + 1000 });
    expect(h.web.sent).toHaveLength(4);
  });

  it("M1 graph.submit rejects once: the claim is released and the channel's retry is accepted once", async () => {
    const h = await linkedOwner();
    h.graph.submit.mockRejectedValueOnce(new Error("graph unavailable"));
    const event = request();

    await expect(h.service.handleInbound("test", event)).rejects.toThrow("graph unavailable");
    expect(h.repo.inboundEvents.size).toBe(0);
    expect(h.logs.at(-1)).toEqual({ channel: "test", outcome: "failed", reason: "internal_error" });

    expect(await h.service.handleInbound("test", event)).toEqual({ status: "accepted", runId: "run-1" });
    expect(await h.service.handleInbound("test", event)).toEqual({ status: "duplicate" });
    expect(inboundCount(h)).toBe(1);
    expect(h.repo.messages.filter((message) => message.kind === "run_accepted")).toHaveLength(1);
    expect(h.test.sent).toHaveLength(1);
    expect(h.graph.submit).toHaveBeenCalledTimes(2);
    expect(new Set(h.graph.submit.mock.calls.map(([, context]) => context.idempotencyKey)).size).toBe(1);
  });

  it("M1 a failure after the graph accepted the submit retries onto the same run without a second submit", async () => {
    const h = await linkedOwner();
    const attachRun = vi.spyOn(h.repo, "attachRun").mockRejectedValueOnce(new Error("db timeout"));
    const event = request();
    await expect(h.service.handleInbound("test", event)).rejects.toThrow("db timeout");
    expect(await h.service.handleInbound("test", event)).toEqual({ status: "accepted", runId: "run-1" });
    expect(inboundCount(h)).toBe(1);
    expect(attachRun).toHaveBeenCalledTimes(2);

    // Fan-out fails after the run is attached: the retry reuses the row's runId and never resubmits.
    const second = request();
    const deliveries = vi.spyOn(h.repo, "claimDelivery").mockRejectedValueOnce(new Error("db timeout"));
    await expect(h.service.handleInbound("test", second)).rejects.toThrow("db timeout");
    const submitsBefore = h.graph.submit.mock.calls.length;
    expect(await h.service.handleInbound("test", second)).toEqual({ status: "accepted", runId: "run-2" });
    expect(h.graph.submit).toHaveBeenCalledTimes(submitsBefore);
    expect(inboundCount(h)).toBe(2);
    expect(h.test.sent.map((send) => send.message.text)).toEqual(["Got it. Working on it.", "Got it. Working on it."]);
    deliveries.mockRestore();
  });

  it("M1 graph.resolveDecision rejects once: nothing is committed and the retry resolves the decision", async () => {
    const h = await linkedOwner();
    await h.service.handleInbound("test", request());
    await h.service.handleGraphEvent(decisionEvent("run-1"));
    h.graph.resolveDecision.mockRejectedValueOnce(new Error("graph unavailable"));
    const answer = request({ action: { kind: "decision", decisionId: "dec-1", choice: "2" } });

    await expect(h.service.handleInbound("test", answer)).rejects.toThrow("graph unavailable");
    expect(h.repo.decisions.get("dec-1")).toMatchObject({ resolution: null, chosen: null, pendingKey: null });

    expect(await h.service.handleInbound("test", answer)).toEqual({ status: "accepted", runId: "run-1" });
    expect(h.repo.decisions.get("dec-1")).toMatchObject({ resolution: "chosen", chosen: "304 stainless", pendingKey: null });
    expect(h.graph.resolveDecision).toHaveBeenCalledTimes(2);
    expect(inboundCount(h)).toBe(2);

    // The graph refusing an answer commits nothing either.
    await h.service.handleGraphEvent(decisionEvent("run-1", "dec-2"));
    h.graph.resolveDecision.mockResolvedValueOnce({ ok: false, reason: "unknown_decision" });
    const refused = await h.service.handleInbound("test", request({ action: { kind: "decision", decisionId: "dec-2", choice: "1" } }));
    expect(refused).toMatchObject({ status: "refused", reason: "graph_unknown_decision" });
    expect(h.repo.decisions.get("dec-2")).toMatchObject({ resolution: null, pendingKey: null });
  });

  it("M1 a decision held pending by one event is busy for another", async () => {
    const h = await linkedOwner();
    await h.service.handleInbound("test", request());
    await h.service.handleGraphEvent(decisionEvent("run-1"));
    let finish: (value: { ok: true }) => void = () => undefined;
    h.graph.resolveDecision.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const first = h.service.handleInbound("test", request({ action: { kind: "decision", decisionId: "dec-1", choice: "1" } }));
    await vi.waitFor(() => expect(h.graph.resolveDecision).toHaveBeenCalledTimes(1));
    const second = await h.service.handleInbound("test", request({ action: { kind: "decision", decisionId: "dec-1", choice: "2" } }));
    expect(second).toMatchObject({ status: "refused", reason: "decision_in_progress" });
    finish({ ok: true });
    expect(await first).toEqual({ status: "accepted", runId: "run-1" });
    expect(h.repo.decisions.get("dec-1")).toMatchObject({ resolution: "chosen", chosen: "6061 aluminum" });
  });

  it("M1 graph.control rejects once: the command stays pending and the retry re-sends and promotes it", async () => {
    const h = await linkedOwner();
    await h.service.handleInbound("test", request());
    h.graph.control.mockRejectedValueOnce(new Error("graph unavailable"));
    const pause = request({ action: { kind: "control", runId: "run-1", command: "pause" } });

    await expect(h.service.handleInbound("test", pause)).rejects.toThrow("graph unavailable");
    expect([...h.repo.controlCommands.values()]).toEqual([expect.objectContaining({ status: "pending" })]);

    expect(await h.service.handleInbound("test", pause)).toEqual({ status: "accepted", runId: "run-1" });
    expect([...h.repo.controlCommands.values()]).toEqual([expect.objectContaining({ status: "queued", idempotencyKey: pause.eventId })]);
    expect(h.graph.control).toHaveBeenCalledTimes(2);
    expect(h.graph.control.mock.calls[0]).toEqual(h.graph.control.mock.calls[1]);
    expect(await h.service.handleInbound("test", pause)).toEqual({ status: "duplicate" });

    // A command the graph refuses is recorded rejected, never queued.
    h.graph.control.mockResolvedValueOnce({ ok: false, reason: "unknown_run" });
    const cancel = request({ action: { kind: "control", runId: "run-1", command: "cancel" } });
    expect(await h.service.handleInbound("test", cancel)).toEqual({ status: "unavailable", reply: NOT_AVAILABLE_REPLY });
    expect(h.repo.controlCommands.get(JSON.stringify(["run-1", cancel.eventId]))?.status).toBe("rejected");
  });

  it("CS-9 adding TestAdapter2 needs only a registry line (no core diff)", async () => {
    const testAdapter2 = createTestAdapter({ id: "test2" });
    const h = await linkedOwner({ extraAdapters: [testAdapter2] });
    await h.link("blaine", "test2");
    expect(await h.service.handleInbound("test2", request())).toMatchObject({ status: "accepted" });
    expect(testAdapter2.sent).toHaveLength(1);
    expect(h.web.sent).toHaveLength(1);

    const coreDir = path.resolve(import.meta.dirname);
    const coreSources = readdirSync(coreDir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    for (const name of coreSources) {
      expect(readFileSync(path.join(coreDir, name), "utf8"), name).not.toMatch(/["'](test2?|slack|telegram|imessage)["']/);
    }
    expect(createDefaultChannelRegistry().ids()).toEqual(["test"]);
  });

  it("CS-10 a skipped decision records skipped_best_guess with rationale and the run continues", async () => {
    const h = await linkedOwner();
    await h.service.handleInbound("test", request());
    await h.service.handleGraphEvent(decisionEvent("run-1"));
    const skip = await h.service.handleInbound("test", request({ action: { kind: "decision", decisionId: "dec-1", choice: null } }));

    expect(skip).toEqual({ status: "accepted", runId: "run-1" });
    expect(h.repo.decisions.get("dec-1")).toMatchObject({ resolution: "skipped_best_guess", chosen: "6061 aluminum", resolvedBy: "blaine" });
    expect(h.repo.decisions.get("dec-1")?.rationale).toBe('User skipped; proceeding with best guess "6061 aluminum".');
    expect(h.graph.resolveDecision).toHaveBeenCalledWith("run-1", "dec-1", { kind: "skip" });

    // The graph's own decision_resolved carries the authoritative rationale; the core stores it.
    const graphRationale = 'User skipped; proceeding with best guess "6061 aluminum": cheapest default.';
    await h.service.handleGraphEvent({
      ...envelope("run-1"),
      type: "decision_resolved",
      decisionId: "dec-1",
      nodeId: "concept_picks",
      outcome: "skipped_best_guess",
      cause: "skip",
      choice: "6061 aluminum",
      rationale: graphRationale,
    });
    expect(h.repo.decisions.get("dec-1")).toMatchObject({ resolution: "skipped_best_guess", rationale: graphRationale, resolvedBy: "blaine" });
    expect(h.web.sent.at(-1)?.message.text).toBe("Skipped. Going with the best guess: 6061 aluminum.");

    await h.service.handleGraphEvent(statusEvent("run-1", "Modeling the plate"));
    expect(h.web.sent.at(-1)?.message.text).toBe("Modeling the plate");

    const again = await h.service.handleInbound("test", request({ action: { kind: "decision", decisionId: "dec-1", choice: "304 stainless" } }));
    expect(again).toMatchObject({ status: "refused", reason: "already_resolved" });
    expect(h.graph.resolveDecision).toHaveBeenCalledTimes(1);

    await h.service.handleGraphEvent(decisionEvent("run-1", "dec-2"));
    await h.service.handleInbound("test", request({ action: { kind: "decision", decisionId: "dec-2", choice: "2" } }));
    expect(h.repo.decisions.get("dec-2")).toMatchObject({ resolution: "chosen", chosen: "304 stainless" });
    expect(h.graph.resolveDecision).toHaveBeenLastCalledWith("run-1", "dec-2", { kind: "choose", choice: "304 stainless" });

    // A timeout never passes through the core: the graph's event fills the row.
    await h.service.handleGraphEvent(decisionEvent("run-1", "dec-3"));
    await h.service.handleGraphEvent({
      ...envelope("run-1"),
      type: "decision_resolved",
      decisionId: "dec-3",
      nodeId: "concept_picks",
      outcome: "skipped_best_guess",
      cause: "timeout",
      choice: "6061 aluminum",
      rationale: "No answer within 300000 ms; proceeding with best guess.",
    });
    expect(h.repo.decisions.get("dec-3")).toMatchObject({ resolution: "timeout_best_guess", chosen: "6061 aluminum", resolvedBy: null });
    expect(h.web.sent.at(-1)?.message.text).toBe("No answer in time. Going with the best guess: 6061 aluminum.");
    const invalid = await h.service.handleInbound("test", request({ action: { kind: "decision", decisionId: "dec-9", choice: "1" } }));
    expect(invalid).toMatchObject({ status: "refused", reason: "decision_unknown" });
  });

  it("CS-11 a request for an agent that isn't enabled gets 'not available yet' and no work", async () => {
    const h = await linkedOwner();
    expect(await h.service.handleInbound("test", request({ agent: "optics" }))).toEqual({ status: "unavailable", reply: NOT_AVAILABLE_REPLY });
    expect(graphCalls(h)).toBe(0);
    expect(h.graph.agentAvailability).toHaveBeenCalledWith("optics");
    expect(await h.service.handleInbound("test", request({ agent: "cad" }))).toMatchObject({ status: "accepted" });
    expect(h.graph.submit).toHaveBeenLastCalledWith({ prompt: "4 inch plate", domain: "cad" }, expect.anything());

    // Without an explicit agent the graph routes; its agent_not_enabled error reaches the user the same way.
    await h.service.handleGraphEvent({ ...envelope("run-1"), type: "error", nodeId: "intake", code: "agent_not_enabled", message: "agent not enabled: optics" });
    expect(h.test.sent.at(-1)?.message.text).toBe(NOT_AVAILABLE_REPLY);
  });

  it("CS-12 pause/cancel from a non-owner is refused; the owner's passes through with its idempotency key", async () => {
    const h = await linkedOwner();
    h.grant("mallory");
    await h.link("mallory");
    await h.service.handleInbound("test", request());
    await h.service.handleGraphEvent(decisionEvent("run-1"));

    for (const command of ["pause", "cancel"] as const) {
      const refused = await h.service.handleInbound("test", request({ externalUserId: "ext-mallory", action: { kind: "control", runId: "run-1", command } }));
      expect(refused).toMatchObject({ status: "refused", reason: "not_owner" });
    }
    const stolenDecision = await h.service.handleInbound("test", request({ externalUserId: "ext-mallory", action: { kind: "decision", decisionId: "dec-1", choice: "1" } }));
    expect(stolenDecision).toMatchObject({ status: "refused", reason: "not_owner" });
    expect(h.graph.control).not.toHaveBeenCalled();
    expect(h.graph.resolveDecision).not.toHaveBeenCalled();
    expect(h.repo.controlCommands.size).toBe(0);
    expect(h.repo.decisions.get("dec-1")?.resolution).toBeNull();

    const pause = request({ action: { kind: "control", runId: "run-1", command: "pause" } });
    expect(await h.service.handleInbound("test", pause)).toEqual({ status: "accepted", runId: "run-1" });
    expect(h.graph.control).toHaveBeenCalledWith("run-1", { kind: "pause", idempotencyKey: pause.eventId, actor: "blaine" });
    expect([...h.repo.controlCommands.values()]).toEqual([expect.objectContaining({ kind: "pause", status: "queued", idempotencyKey: pause.eventId })]);

    const cancel = request({ action: { kind: "control", runId: "run-1", command: "cancel" } });
    expect(await h.service.handleInbound("test", cancel)).toMatchObject({ status: "accepted" });
    expect(await h.service.handleInbound("test", request({ action: { kind: "control", runId: "run-1", command: "steer" } }))).toEqual({
      status: "unavailable",
      reply: NOT_AVAILABLE_REPLY,
    });
    expect(h.graph.control).toHaveBeenCalledTimes(2);

    h.graph.control.mockResolvedValueOnce({ ok: false, reason: "unsupported" });
    const unsupported = request({ action: { kind: "control", runId: "run-1", command: "pause" } });
    expect(await h.service.handleInbound("test", unsupported)).toEqual({ status: "unavailable", reply: NOT_AVAILABLE_REPLY });
    expect(h.logs.at(-1)).toEqual({ channel: "test", outcome: "unavailable", reason: "control_unsupported" });
  });

  it("CS-13 flag JARVIS_UI_ENABLED off routes nothing for real adapters; only TestAdapter works in the test env", async () => {
    expect(JARVIS_UI_FLAG).toBe("JARVIS_UI_ENABLED");
    expect([undefined, "", "1", "TRUE", "false"].map(isJarvisUiEnabled)).toEqual([false, false, false, false, false]);
    expect(isJarvisUiEnabled("true")).toBe(true);

    const slack = createTestAdapter({ id: "slack", testOnly: false });
    const off = await linkedOwner({ uiEnabled: false, extraAdapters: [slack] });
    await off.link("blaine", "slack");
    for (const channel of ["web", "slack"]) {
      expect(await off.service.handleInbound(channel, request())).toEqual({ status: "dropped", reason: "flag_off" });
    }
    expect(off.repo.inboundEvents.size).toBe(0);
    expect(await off.service.handleInbound("test", request())).toMatchObject({ status: "accepted" });
    expect(off.web.attempts).toHaveLength(0);

    const production = await linkedOwner({ uiEnabled: false, testEnvironment: false });
    expect(await production.service.handleInbound("test", request())).toEqual({ status: "dropped", reason: "flag_off" });
    const onOutsideTests = await linkedOwner({ uiEnabled: true, testEnvironment: false });
    expect(await onOutsideTests.service.handleInbound("test", request())).toEqual({ status: "dropped", reason: "flag_off" });
    expect(graphCalls(production) + graphCalls(onOutsideTests)).toBe(0);
  });

  it("CS-14 no bypass: every path that leads to work goes through the DesignGraph entry", async () => {
    const h = await linkedOwner({ limiter: createSlidingWindowLimiter(8, 60_000) });
    h.grant("mallory", "beta");
    await h.link("mallory");
    const results: InboundResult[] = [];
    const counts: number[] = [];
    const send = async (channel: string, body: unknown) => {
      const before = graphCalls(h);
      results.push(await h.service.handleInbound(channel, body));
      counts.push(graphCalls(h) - before);
    };
    await send("test", request());
    await h.service.handleGraphEvent(decisionEvent("run-1"));
    await send("nope", request());
    await send("test", { ...request(), secret: "forged" });
    await send("test", { secret: TEST_ADAPTER_SECRET });
    await send("test", request({ externalUserId: "ext-stranger" }));
    await send("test", request({ externalUserId: "ext-mallory" }));
    await send("test", request({ agent: "electronics" }));
    await send("test", request({ action: { kind: "decision", decisionId: "dec-1", choice: "skip" } }));
    await send("test", request({ action: { kind: "control", runId: "run-1", command: "pause" } }));
    for (let i = 0; i < 6; i += 1) await send("test", request());

    expect(results.map((r) => r.status)).toContain("throttled");
    results.forEach((result, index) => expect(counts[index], `${index}:${result.status}`).toBe(result.status === "accepted" ? 1 : 0));
    expect(results.filter((r) => r.status === "rejected").map((r) => "reason" in r && r.reason)).toEqual(["unverified", "malformed"]);
    expect(h.logs.some((entry) => JSON.stringify(entry).includes("ext-"))).toBe(false);
  });
});

describe("Jarvis identity linking", () => {
  it("consumes a one-time code once, rejects expired codes, and stores only the external id hash", async () => {
    const h = setup();
    const expiresAt = new Date(START + 10 * 60_000).toISOString();
    h.repo.linkCodes.set(hash("123456"), { codeHash: hash("123456"), userId: "blaine", channel: "test", expiresAt, consumedAt: null });
    h.repo.linkCodes.set(hash("999999"), { codeHash: hash("999999"), userId: "blaine", channel: "test", expiresAt: new Date(START).toISOString(), consumedAt: null });

    expect(await h.service.linkIdentity("test", "123456", "ext-blaine")).toBe("blaine");
    expect(await h.service.linkIdentity("test", "123456", "ext-other")).toBeNull();
    expect(await h.service.linkIdentity("test", "999999", "ext-other")).toBeNull();
    expect([...h.repo.channelIdentities.values()]).toEqual([{ userId: "blaine", channel: "test", externalIdHash: hash("test:ext-blaine"), revokedAt: null }]);

    h.repo.linkCodes.set(hash("222222"), { codeHash: hash("222222"), userId: "mallory", channel: "test", expiresAt, consumedAt: null });
    expect(await h.service.linkIdentity("test", "222222", "ext-blaine")).toBeNull();
  });
});

describe("Jarvis render and registry", () => {
  const caps = { buttons: true, images: true, model3d: true, maxText: 12 };

  it("renders resolutions and truncates to the channel's maxText", () => {
    const wide = { ...caps, maxText: 100 };
    const resolved = { ...envelope("r"), type: "decision_resolved", decisionId: "d", nodeId: "concept_picks", choice: "a", rationale: "why" } as const;
    expect(renderEvent({ ...resolved, outcome: "chosen" }, wide, WEB_BASE)).toEqual({ text: "Decision recorded: a." });
    expect(renderEvent(statusEvent("r", "A long status text"), caps, WEB_BASE)).toEqual({ text: "A long stat…" });
    expect(renderEvent(artifactEvent("r", "png", "u"), caps, WEB_BASE).link).toBe(`${WEB_BASE}/runs/r`);
  });

  it("renders result and error events; error text never echoes the graph's internal message", () => {
    const wide = { ...caps, maxText: 200 };
    const result: GraphEvent = {
      ...envelope("r"),
      type: "result",
      nodeId: "result",
      agentId: "cad",
      summary: "4-inch plate",
      picks: {},
      artifacts: [
        { kind: "step", uri: "s.step" },
        { kind: "glb", uri: "m.glb" },
      ],
    };
    expect(renderEvent(result, wide, WEB_BASE)).toEqual({ text: "Done: 4-inch plate", model3dUrl: "m.glb", link: `${WEB_BASE}/runs/r` });
    expect(renderEvent(result, { ...wide, model3d: false }, WEB_BASE)).toEqual({ text: "Done: 4-inch plate", link: `${WEB_BASE}/runs/r` });
    const error = (code: "agent_failed" | "no_agent" | "agent_not_enabled"): GraphEvent => ({
      ...envelope("r"),
      type: "error",
      nodeId: "domain_agent",
      code,
      message: "cad agent failed: ENOENT /srv/secret/path",
    });
    expect(renderEvent(error("agent_failed"), wide, WEB_BASE)).toEqual({ text: RUN_FAILED_REPLY, link: `${WEB_BASE}/runs/r` });
    expect(renderEvent(error("no_agent"), wide, WEB_BASE)).toEqual({ text: NO_AGENT_REPLY });
    expect(renderEvent(error("agent_not_enabled"), wide, WEB_BASE)).toEqual({ text: NOT_AVAILABLE_REPLY });
  });

  it("rejects two adapters with the same id", () => {
    expect(() => createChannelRegistry([createTestAdapter(), createTestAdapter()])).toThrow("duplicate channel adapter: test");
  });
});
