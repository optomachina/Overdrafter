import { describe, expect, it, vi } from "vitest";
import {
  DesignGraph,
  DomainAgentRegistry,
  StubCadAgent,
  createDefaultRegistry,
  validateDesignGraphEvent,
  type DesignGraphEvent,
  type DomainAgent,
  type GraphClock,
} from "./index";

class ManualClock implements GraphClock {
  private time = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  private nextId = 1;

  now() {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown) {
    this.timers.delete(handle as number);
  }

  pendingTimers() {
    return this.timers.size;
  }

  advance(ms: number) {
    this.time += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.time) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(options: { registry?: DomainAgentRegistry; decisionTimeoutMs?: number } = {}) {
  const clock = new ManualClock();
  const all: DesignGraphEvent[] = [];
  let n = 0;
  // env: {} keeps JARVIS_CAD_AGENT_ENABLED out, so cad is the hermetic stub here.
  const registry = options.registry ?? createDefaultRegistry({ env: {} });
  const graph = new DesignGraph({ ...options, registry, clock, createRunId: () => `run-${++n}`, onEvent: (e) => all.push(e) });
  return { graph, clock, all };
}

const types = (events: DesignGraphEvent[]) => events.map((e) => e.type);
const nodePath = (events: DesignGraphEvent[]) =>
  [...new Set(events.filter((e) => e.type === "status" && e.state === "started").map((e) => e.nodeId))];

function expectAllValid(events: DesignGraphEvent[]) {
  for (const event of events) expect(validateDesignGraphEvent(event)).toEqual({ ok: true, event });
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
}

describe("DesignGraph slice 1", () => {
  it("G-1 plate request routes intake -> concept_picks -> cad -> verify -> result with 101.6 mm artifacts", async () => {
    const { graph, all } = setup();
    const runId = graph.submit({ prompt: "Make me a 4-inch aluminum mounting plate" });
    const snapshot = await graph.waitForTerminal(runId);

    expect(snapshot).toMatchObject({ state: "completed", agentId: "cad" });
    const events = graph.getEvents(runId);
    expect(all).toEqual(events);
    expectAllValid(events);
    expect(nodePath(events)).toEqual(["intake", "concept_picks", "domain_agent", "verify"]);
    // Material was given, so no question was asked.
    expect(types(events)).not.toContain("decision_requested");

    const artifacts = events.filter((e) => e.type === "artifact");
    expect(artifacts.map((a) => a.kind)).toEqual(["step", "glb", "png"]);
    expect(artifacts.every((a) => a.agentId === "cad" && a.nodeId === "domain_agent")).toBe(true);
    expect(artifacts.find((a) => a.kind === "step")?.dimensionsMm).toEqual({ x: 101.6, y: 101.6, z: 6.35 });

    const result = events.at(-1);
    expect(result?.type).toBe("result");
    if (result?.type !== "result") return;
    expect(result.summary).toContain("101.6 mm");
    expect(result.artifacts.map((a) => a.kind)).toEqual(["step", "glb", "png"]);
  });

  it("G-1 routing: default registry has cad enabled and other domains registered but disabled", () => {
    const registry = createDefaultRegistry({ env: {} });
    expect(registry.ids()).toEqual(["optics", "electronics", "analysis", "cad"]);
    expect(registry.ids().filter((id) => registry.isEnabled(id))).toEqual(["cad"]);
  });

  it("G-2 optics request emits 'agent not enabled', runs nothing, and ends the run", async () => {
    const listener = vi.fn();
    const cadRun = vi.spyOn(StubCadAgent.prototype, "run");
    const registry = createDefaultRegistry({ env: {} });
    const { graph } = setup({ registry });
    const runId = graph.submit({ prompt: "Design a 25 mm achromatic lens mount" });
    graph.subscribe(runId, listener);
    const snapshot = await graph.waitForTerminal(runId);

    expect(snapshot).toMatchObject({ state: "failed", agentId: "optics" });
    const events = graph.getEvents(runId);
    expectAllValid(events);
    expect(types(events)).toEqual(["status", "error"]);
    expect(events[1]).toMatchObject({ type: "error", code: "agent_not_enabled", agentId: "optics", nodeId: "intake" });
    expect(events[1].type === "error" && events[1].message).toContain("agent not enabled");
    expect(nodePath(events)).toEqual(["intake"]);
    expect(cadRun).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(2);
    cadRun.mockRestore();

    // Explicit domain hint routes the same way.
    const hinted = graph.submit({ prompt: "anything", domain: "electronics" });
    expect(await graph.waitForTerminal(hinted)).toMatchObject({ state: "failed", agentId: "electronics" });
  });

  it("G-3 skip records the best guess with rationale and the run continues", async () => {
    const { graph } = setup();
    const runId = graph.submit({ prompt: "4-inch square plate with four corner holes" });
    await flush();

    expect(graph.getRun(runId).state).toBe("awaiting_decision");
    const requested = graph.getEvents(runId).find((e) => e.type === "decision_requested");
    expect(requested).toMatchObject({
      nodeId: "concept_picks",
      options: ["6061-T6 aluminum", "304 stainless steel", "acetal (Delrin)"],
      recommended: "6061-T6 aluminum",
      bestGuess: "6061-T6 aluminum",
    });
    if (requested?.type !== "decision_requested") return;

    expect(graph.resolveDecision(runId, requested.decisionId, { kind: "choose", choice: "titanium" })).toEqual({
      ok: false,
      reason: "invalid_choice",
    });
    expect(graph.resolveDecision(runId, requested.decisionId, { kind: "skip" })).toEqual({ ok: true });
    expect(graph.resolveDecision(runId, requested.decisionId, { kind: "skip" })).toEqual({
      ok: false,
      reason: "unknown_decision",
    });

    const snapshot = await graph.waitForTerminal(runId);
    expect(snapshot).toMatchObject({ state: "completed", picks: { material: "6061-T6 aluminum" } });
    const events = graph.getEvents(runId);
    expectAllValid(events);
    const resolved = events.find((e) => e.type === "decision_resolved");
    expect(resolved).toMatchObject({
      decisionId: requested.decisionId,
      outcome: "skipped_best_guess",
      cause: "skip",
      choice: "6061-T6 aluminum",
    });
    expect(resolved?.type === "decision_resolved" && resolved.rationale).toMatch(/User skipped.*best guess.*machinable/);
    expect(events.at(-1)?.type).toBe("result");
  });

  it("G-3 an explicit choice is recorded as chosen and reaches the agent", async () => {
    const { graph } = setup();
    const runId = graph.submit({ prompt: "4-inch plate" });
    await flush();
    const requested = graph.getEvents(runId).find((e) => e.type === "decision_requested");
    if (requested?.type !== "decision_requested") throw new Error("expected a decision");
    graph.resolveDecision(runId, requested.decisionId, { kind: "choose", choice: "304 stainless steel" });
    await graph.waitForTerminal(runId);
    const events = graph.getEvents(runId);
    expect(events.find((e) => e.type === "decision_resolved")).toMatchObject({ outcome: "chosen", choice: "304 stainless steel" });
    expect(events.at(-1)).toMatchObject({ type: "result", picks: { material: "304 stainless steel" } });
  });

  it("G-4 decision timeout acts as skip using the injected clock", async () => {
    const { graph, clock } = setup({ decisionTimeoutMs: 30_000 });
    const runId = graph.submit({ prompt: "4-inch plate" });
    await flush();
    expect(graph.getRun(runId).state).toBe("awaiting_decision");
    expect(graph.getEvents(runId).find((e) => e.type === "decision_requested")).toMatchObject({ timeoutMs: 30_000 });

    clock.advance(29_999);
    await flush();
    expect(graph.getRun(runId).state).toBe("awaiting_decision");

    clock.advance(1);
    const snapshot = await graph.waitForTerminal(runId);
    expect(snapshot).toMatchObject({ state: "completed", picks: { material: "6061-T6 aluminum" } });
    const events = graph.getEvents(runId);
    expectAllValid(events);
    const resolved = events.find((e) => e.type === "decision_resolved");
    expect(resolved).toMatchObject({ outcome: "skipped_best_guess", cause: "timeout", choice: "6061-T6 aluminum", at: 30_000 });
    expect(resolved?.type === "decision_resolved" && resolved.rationale).toContain("No answer within 30000 ms");
    expect(clock.pendingTimers()).toBe(0);
  });

  it("G-6 event validation rejects malformed events", () => {
    const envelope = { runId: "r", seq: 0, at: 0 };
    const valid: unknown[] = [
      { ...envelope, type: "status", nodeId: "intake", state: "started", message: "ok" },
      {
        ...envelope,
        type: "decision_requested",
        decisionId: "d",
        nodeId: "concept_picks",
        question: "q?",
        options: ["a", "b"],
        recommended: "a",
        bestGuess: "b",
        timeoutMs: 10,
      },
      { ...envelope, type: "decision_resolved", decisionId: "d", nodeId: "concept_picks", outcome: "chosen", choice: "a", rationale: "r" },
      { ...envelope, type: "artifact", nodeId: "domain_agent", agentId: "cad", kind: "glb", name: "n", mimeType: "m", uri: "u" },
      { ...envelope, type: "result", nodeId: "result", agentId: "cad", summary: "s", picks: {}, artifacts: [{ kind: "png", uri: "u" }] },
      { ...envelope, type: "error", nodeId: "domain_agent", code: "agent_failed", message: "boom" },
    ];
    for (const event of valid) expect(validateDesignGraphEvent(event).ok).toBe(true);

    expect(validateDesignGraphEvent({ ...envelope, type: "artifact", nodeId: "domain_agent", agentId: "cad", kind: "usdz", name: "plate.usdz", mimeType: "model/vnd.usdz+zip", uri: "https://example.com/plate.usdz" }).ok).toBe(true);
    const [status, requested, resolved, artifact, result, error] = valid as Record<string, unknown>[];
    const malformed: [string, unknown][] = [
      ["not an object", "status"],
      ["unknown type", { ...status, type: "progress" }],
      ["missing runId", { ...status, runId: "" }],
      ["negative seq", { ...status, seq: -1 }],
      ["bad node", { ...status, nodeId: "planner" }],
      ["no bestGuess", { ...requested, bestGuess: undefined }],
      ["bestGuess not an option", { ...requested, bestGuess: "z" }],
      ["recommended not an option", { ...requested, recommended: "z" }],
      ["single option", { ...requested, options: ["a"], recommended: "a", bestGuess: "a" }],
      ["skip without cause", { ...resolved, outcome: "skipped_best_guess" }],
      ["chosen with cause", { ...resolved, cause: "skip" }],
      ["no rationale", { ...resolved, rationale: "" }],
      ["unknown outcome", { ...resolved, outcome: "maybe" }],
      ["bad artifact kind", { ...artifact, kind: "stl" }],
      ["non-positive dims", { ...artifact, dimensionsMm: { x: 101.6, y: 0, z: 6.35 } }],
      ["result on wrong node", { ...result, nodeId: "verify" }],
      ["bad result artifact ref", { ...result, artifacts: [{ kind: "png" }] }],
      ["unknown error code", { ...error, code: "oops" }],
    ];
    for (const [label, event] of malformed) {
      const verdict = validateDesignGraphEvent(event);
      expect(verdict.ok, label).toBe(false);
      if (!verdict.ok) expect(verdict.errors.length, label).toBeGreaterThan(0);
    }
  });

  it("G-6 an agent emitting a malformed artifact fails the run instead of publishing it", async () => {
    const registry = new DomainAgentRegistry().register(
      {
        id: "cad",
        canHandle: () => true,
        run: async (_ctx, emit) => {
          emit({ type: "artifact", kind: "stl" as "step", name: "x", mimeType: "m", uri: "u" });
          return { summary: "unreachable" };
        },
      },
      { enabled: true },
    );
    const { graph } = setup({ registry });
    const runId = graph.submit({ prompt: "plate" });
    expect(await graph.waitForTerminal(runId)).toMatchObject({ state: "failed" });
    const events = graph.getEvents(runId);
    expectAllValid(events);
    expect(types(events)).not.toContain("artifact");
    expect(events.at(-1)).toMatchObject({ type: "error", code: "agent_failed" });
  });

  it("G-7 agent throw emits one error event, ends the run, and never retries", async () => {
    let lateEmit: (() => void) | undefined;
    const run = vi.fn<DomainAgent["run"]>(async (_ctx, emit) => {
      emit({ type: "status", state: "info", message: "starting" });
      lateEmit = () => emit({ type: "artifact", kind: "png", name: "late.png", mimeType: "image/png", uri: "stub://late" });
      throw new Error("kernel exploded");
    });
    const registry = new DomainAgentRegistry().register({ id: "cad", canHandle: () => true, run }, { enabled: true });
    const { graph, clock, all } = setup({ registry });
    const runId = graph.submit({ prompt: "plate" });
    const snapshot = await graph.waitForTerminal(runId);

    expect(snapshot.state).toBe("failed");
    lateEmit?.();
    clock.advance(60 * 60 * 1000);
    await flush();

    const events = graph.getEvents(runId);
    expectAllValid(events);
    expect(run).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      nodeId: "domain_agent",
      code: "agent_failed",
      agentId: "cad",
      message: "cad agent failed: kernel exploded",
    });
    expect(types(events)).not.toContain("result");
    expect(types(events)).not.toContain("artifact");
    expect(all).toHaveLength(events.length);
    expect(graph.getRun(runId).state).toBe("failed");
  });
});
