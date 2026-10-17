import { describe, expect, it, vi } from "vitest";
import {
  DesignGraph,
  createDefaultRegistry,
  validateDesignGraphEvent,
  type DecisionAnswer,
  type DesignGraphEvent,
  type DesignRequest,
  type DomainId,
  type GraphClock,
  type ResolveDecisionResult,
} from "../design-graph";
import { createTestAdapter, TEST_ADAPTER_SECRET, type TestInboundRequest } from "../../src/features/jarvis/channels/test-adapter";
import { ConversationService, NOT_AVAILABLE_REPLY, type GraphEventResult } from "../../src/features/jarvis/core/conversation-service";
import { InMemoryJarvisRepo } from "../../src/features/jarvis/core/in-memory-repo";
import { createFailedAttemptLimiter, createSlidingWindowLimiter } from "../../src/features/jarvis/core/rate-limiter";
import { createChannelRegistry } from "../../src/features/jarvis/core/registry";
import { NO_AGENT_REPLY } from "../../src/features/jarvis/core/render";
import type {
  DomainAgentId,
  GraphDecisionAnswer,
  GraphDesignRequest,
  GraphEvent,
  GraphResolveDecisionResult,
} from "../../src/features/jarvis/core/types";
import { createDesignGraphPort } from "./design-graph-port";

// Compile-time half of the contract: the core's mirror types must be identical to OVD-801's.
// If either side changes a field, `npm run typecheck` (tsconfig.server.json) fails here.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type PortContract = [
  Assert<Equal<GraphEvent, DesignGraphEvent>>,
  Assert<Equal<GraphEvent["type"], DesignGraphEvent["type"]>>,
  Assert<Equal<GraphDesignRequest, DesignRequest>>,
  Assert<Equal<GraphDecisionAnswer, DecisionAnswer>>,
  Assert<Equal<GraphResolveDecisionResult, ResolveDecisionResult>>,
  Assert<Equal<DomainAgentId, DomainId>>,
];

const idleClock: GraphClock = { now: () => 1_700_000_000_000, setTimeout: () => 0, clearTimeout: () => undefined };
const hash = (value: string) => `h(${value})`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let eventSequence = 0;
function request(overrides: Partial<TestInboundRequest> = {}): TestInboundRequest {
  eventSequence += 1;
  return { secret: TEST_ADAPTER_SECRET, eventId: `evt-${eventSequence}`, externalUserId: "ext-blaine", text: "4 inch plate", ...overrides };
}

/** `live` wires the graph's onEvent straight to the service, the way a same-process relay would. */
async function setup({ live = false } = {}) {
  const registry = createDefaultRegistry();
  let runs = 0;
  const pushed: Promise<GraphEventResult>[] = [];
  // eslint-disable-next-line prefer-const -- assigned below; the onEvent closure needs it declared first
  let service: ConversationService | undefined;
  const onEvent = live ? (event: DesignGraphEvent) => void pushed.push(service!.handleGraphEvent(event)) : undefined;
  const graph = new DesignGraph({ registry, clock: idleClock, createRunId: () => `run-${++runs}`, onEvent });
  const port = createDesignGraphPort({ graph, registry });
  const repo = new InMemoryJarvisRepo();
  const test = createTestAdapter();
  const web = createTestAdapter({ id: "web", testOnly: false });
  for (const adapter of [test, web]) repo.channelSettings.set(adapter.id, { channel: adapter.id, enabled: true, minTier: "owner" });
  repo.accessGrants.set("blaine", { userId: "blaine", tier: "owner", grantedBy: "admin", grantedAt: "2026-10-01T00:00:00Z", revokedAt: null });
  await repo.insertIdentity({ userId: "blaine", channel: "test", externalIdHash: hash("test:ext-blaine"), address: "chat-ext-blaine", revokedAt: null });
  service = new ConversationService({
    repo,
    graph: port,
    channels: createChannelRegistry([test, web]),
    hash,
    uiEnabled: false,
    testEnvironment: true,
    rateLimiter: createSlidingWindowLimiter(),
    linkAttempts: createFailedAttemptLimiter(),
    delivery: { maxAttempts: 1, baseDelayMs: 0, sleep: async () => undefined },
    webBaseUrl: "https://jarvis.example",
    now: () => new Date(idleClock.now()),
    log: () => undefined,
  });
  /** Replays the run's whole event log every time; (runId, seq) dedupe makes that safe. */
  const relay = async (runId: string) => {
    for (const event of graph.getEvents(runId)) await service.handleGraphEvent(event);
  };
  return { graph, port, repo, test, service, relay, pushed };
}

describe("Jarvis DesignGraph port against the OVD-801 graph (OVD-798 M5)", () => {
  it("runs a real graph end to end: decision skip records the graph's rationale, result reaches the channel", async () => {
    const h = await setup();
    const accepted = await h.service.handleInbound("test", request());
    expect(accepted).toEqual({ status: "accepted", runId: "run-1" });
    await settle();
    await h.relay("run-1");

    const decision = h.graph.getEvents("run-1").find((event) => event.type === "decision_requested");
    expect(decision && validateDesignGraphEvent(decision).ok).toBe(true);
    const row = h.repo.decisions.get(decision!.type === "decision_requested" ? decision!.decisionId : "");
    expect(row).toMatchObject({ graphRunId: "run-1", bestGuess: "6061-T6 aluminum", resolution: null });
    expect(row?.options).toContain("304 stainless steel");

    expect(await h.service.handleInbound("test", request({ action: { kind: "decision", decisionId: row!.id, choice: "skip" } }))).toEqual({
      status: "accepted",
      runId: "run-1",
    });
    expect(await h.graph.waitForTerminal("run-1")).toMatchObject({ state: "completed", picks: { material: "6061-T6 aluminum" } });
    await h.relay("run-1");

    expect(h.repo.decisions.get(row!.id)).toMatchObject({ resolution: "skipped_best_guess", chosen: "6061-T6 aluminum", resolvedBy: "blaine" });
    expect(h.repo.decisions.get(row!.id)?.rationale).toContain("cheapest, most machinable default");
    const events = h.graph.getEvents("run-1");
    expect(h.repo.messages.filter((message) => message.direction === "out")).toHaveLength(events.length + 1);
    expect(h.test.sent).toHaveLength(events.length + 1);
    const last = h.test.sent.at(-1)?.message;
    expect(last?.text).toMatch(/^Done: 4-inch/);
    expect(last?.model3dUrl).toMatch(/plate-101\.6mm\.glb$/);
  });

  it("maps the graph's agent registry and error events: disabled agents and failed runs reach the user", async () => {
    const h = await setup();
    expect(h.port.agentAvailability("cad")).toBe("enabled");
    expect(h.port.agentAvailability("optics")).toBe("disabled");
    expect(await h.service.handleInbound("test", request({ agent: "optics" }))).toEqual({ status: "unavailable", reply: NOT_AVAILABLE_REPLY });

    const viaRouting = await h.service.handleInbound("test", request({ text: "design a laser lens mount" }));
    expect(viaRouting).toMatchObject({ status: "accepted" });
    const runId = "runId" in viaRouting ? viaRouting.runId : "";
    await h.graph.waitForTerminal(runId);
    await h.relay(runId);
    expect(h.graph.getEvents(runId).at(-1)).toMatchObject({ type: "error", code: "agent_not_enabled" });
    expect(h.test.sent.at(-1)?.message.text).toBe(NOT_AVAILABLE_REPLY);

    const unrouted = await h.service.handleInbound("test", request({ text: "hello there" }));
    const unroutedRun = "runId" in unrouted ? unrouted.runId : "";
    await h.graph.waitForTerminal(unroutedRun);
    await h.relay(unroutedRun);
    expect(h.test.sent.at(-1)?.message.text).toBe(NO_AGENT_REPLY);
  });

  it("N1 live push: the graph's fast no_agent error, emitted before the run is linked, reaches the channel", async () => {
    const h = await setup({ live: true });
    // Linking is a network round trip in production; the graph's first events land before it commits.
    const attachRun = h.repo.attachRun.bind(h.repo);
    vi.spyOn(h.repo, "attachRun").mockImplementation(async (messageId, runId) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return attachRun(messageId, runId);
    });
    const accepted = await h.service.handleInbound("test", request({ text: "hello there" }));
    expect(accepted).toEqual({ status: "accepted", runId: "run-1" });
    expect(await h.graph.waitForTerminal("run-1")).toMatchObject({ state: "failed" });
    const results = await Promise.all(h.pushed);
    expect(results).toHaveLength(h.graph.getEvents("run-1").length);
    expect(results.every((result) => result.status === "handled")).toBe(true);
    expect(h.graph.getEvents("run-1").at(-1)).toMatchObject({ type: "error", code: "no_agent" });
    expect(h.test.sent.at(0)?.message.text).toBe("Got it. Working on it.");
    expect(h.test.sent.at(-1)?.message.text).toBe(NO_AGENT_REPLY);
  });

  it("OVD-810 the graph's control events reach the shared thread through the service", async () => {
    const h = await setup();
    const accepted = await h.service.handleInbound("test", request({ text: "hello there" }));
    const runId = "runId" in accepted ? accepted.runId : "";
    await h.graph.waitForTerminal(runId);
    const admin = { userId: "admin-1", isAdmin: true, aal: "aal2" } as const;
    expect(await h.graph.control(runId, { kind: "cancel", idempotencyKey: "c-1" }, admin)).toMatchObject({ outcome: "rejected", reason: "terminal" });
    await h.relay(runId);

    const control = h.graph.getEvents(runId).filter((event) => event.type.startsWith("control_"));
    expect(control.every((event) => validateDesignGraphEvent(event).ok)).toBe(true);
    expect(h.test.sent.slice(-2).map((send) => send.message.text)).toEqual(["Cancel requested.", "Cancel rejected: terminal."]);
  });

  it("dedupes submit on the idempotency key and reports control as unsupported", async () => {
    const h = await setup();
    const context = { userId: "blaine", conversationId: "conv-1", idempotencyKey: "test:evt-x" };
    const first = await h.port.submit({ prompt: "4 inch plate" }, context);
    expect(await h.port.submit({ prompt: "4 inch plate" }, context)).toBe(first);
    expect(await h.port.submit({ prompt: "4 inch plate" }, { ...context, idempotencyKey: "test:evt-y" })).not.toBe(first);
    expect(await h.port.control(first, { kind: "pause", idempotencyKey: "k", actor: "blaine" })).toEqual({ ok: false, reason: "unsupported" });
    expect(await h.port.resolveDecision("missing", "d", { kind: "skip" })).toEqual({ ok: false, reason: "unknown_run" });
  });
});
