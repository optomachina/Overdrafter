import { describe, expect, it } from "vitest";
import { validateDesignGraphEvent, type DesignGraphEvent } from "../events";
import type { ControlResult } from "./commands";
import { requestTransition } from "./machine";
import { validateStepText } from "./step-validator";
import {
  ADMIN_AAL1,
  ADMIN_AAL2,
  GatedCadAgent,
  OWNER,
  PLATE_PROMPT,
  STRANGER,
  STRANGER_AAL2,
  StepWriterAgent,
  artifactKinds,
  controlEvents,
  flush,
  plateStepLines,
  setup,
  singleAgent,
  types,
  waitUntil,
} from "./test-support";

function expectAllValid(events: DesignGraphEvent[]) {
  for (const event of events) expect(validateDesignGraphEvent(event)).toEqual({ ok: true, event });
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
}

const pause = (key: string) => ({ kind: "pause" as const, idempotencyKey: key });
const cancel = (key: string) => ({ kind: "cancel" as const, idempotencyKey: key });

// Starts a gated run and waits until its CAD node has emitted the step artifact.
async function gatedRun(ownerId = OWNER.userId) {
  const agent = new GatedCadAgent();
  const ctx = setup(singleAgent(agent));
  const runId = ctx.graph.submit({ prompt: PLATE_PROMPT }, { ownerId });
  await waitUntil(() => artifactKinds(ctx.graph.getEvents(runId)).includes("step"), "step artifact");
  return { ...ctx, agent, runId };
}

describe("DesignGraph control (OVD-810)", () => {
  it("C-1 pause during the CAD node applies at the next checkpoint; the run stays paused with artifacts so far", async () => {
    const { graph } = setup();
    const runId = graph.submit({ prompt: PLATE_PROMPT }, { ownerId: OWNER.userId });
    let pauseResult: Promise<ControlResult> | undefined;
    graph.subscribe(runId, (event) => {
      if (event.type === "artifact" && event.kind === "step") pauseResult = graph.control(runId, pause("pause-1"), OWNER);
    });
    await waitUntil(() => graph.getRun(runId).state === "paused", "paused");

    expect(await pauseResult).toMatchObject({ status: 202, outcome: "accepted", kind: "pause", state: "pausing" });
    const events = graph.getEvents(runId);
    expectAllValid(events);
    expect(types(events).slice(-3)).toEqual(["artifact", "control_requested", "control_applied"]);
    expect(events.at(-1)).toMatchObject({ type: "control_applied", kind: "pause", state: "paused", nodeId: "domain_agent", checkpoint: "agent" });
    expect(graph.getRun(runId)).toMatchObject({
      state: "paused",
      artifacts: [{ kind: "step", uri: `stub://design-graph/${runId}/plate-101.6mm.step` }],
      pendingControls: 0,
      claim: { state: "held" },
    });

    // Paused means no further progress.
    for (let i = 0; i < 10; i++) await flush();
    expect(graph.getEvents(runId)).toHaveLength(events.length);
    expect(graph.getRun(runId).state).toBe("paused");

    await graph.control(runId, cancel("cancel-1"), OWNER);
    expect(await graph.waitForTerminal(runId)).toMatchObject({ state: "cancelled" });
  });

  it("C-2 cancel from running keeps partial artifacts, releases the claim, and publishes nothing after", async () => {
    const { graph } = setup();
    const runId = graph.submit({ prompt: PLATE_PROMPT }, { ownerId: OWNER.userId });
    graph.subscribe(runId, (event) => {
      if (event.type === "artifact" && event.kind === "glb") void graph.control(runId, cancel("cancel-1"), OWNER);
    });
    expect(await graph.waitForTerminal(runId)).toMatchObject({ state: "cancelled", claim: { state: "released" }, pendingControls: 0 });
    for (let i = 0; i < 10; i++) await flush();

    const events = graph.getEvents(runId);
    expectAllValid(events);
    const kept = [
      { kind: "step", uri: `stub://design-graph/${runId}/plate-101.6mm.step` },
      { kind: "glb", uri: `stub://design-graph/${runId}/plate-101.6mm.glb` },
    ];
    expect(events.at(-1)).toMatchObject({ type: "control_applied", kind: "cancel", state: "cancelled", checkpoint: "agent", kept });
    expect(graph.getRun(runId).artifacts).toEqual(kept);
    expect(artifactKinds(events)).toEqual(["step", "glb"]);
    expect(types(events)).not.toContain("result");
    expect(types(events)).not.toContain("error");
  });

  it("C-2 cancel from paused applies at once, keeps the paused run's artifacts, and releases the claim", async () => {
    const { graph } = setup();
    const runId = graph.submit({ prompt: PLATE_PROMPT }, { ownerId: OWNER.userId });
    graph.subscribe(runId, (event) => {
      if (event.type === "artifact" && event.kind === "step") void graph.control(runId, pause("pause-1"), OWNER);
    });
    await waitUntil(() => graph.getRun(runId).state === "paused", "paused");
    const before = graph.getEvents(runId).length;
    expect(graph.getRun(runId).claim).toEqual({ workerId: "design-graph-local", state: "held" });

    expect(await graph.control(runId, cancel("cancel-1"), OWNER)).toMatchObject({ status: 202, outcome: "accepted", state: "cancelling" });
    expect(await graph.waitForTerminal(runId)).toMatchObject({ state: "cancelled", claim: { state: "released" } });
    for (let i = 0; i < 10; i++) await flush();

    const events = graph.getEvents(runId);
    expectAllValid(events);
    expect(types(events.slice(before))).toEqual(["control_requested", "control_applied"]);
    expect(events.at(-1)).toMatchObject({ kind: "cancel", state: "cancelled", kept: [{ kind: "step" }] });
    expect(artifactKinds(events)).toEqual(["step"]);
  });

  it("C-2 cancel before the run starts applies at the intake boundary with nothing kept", async () => {
    const { graph } = setup();
    const runId = graph.submit({ prompt: PLATE_PROMPT }, { ownerId: OWNER.userId });
    await graph.control(runId, cancel("early"), OWNER);
    expect(await graph.waitForTerminal(runId)).toMatchObject({ state: "cancelled", claim: { state: "released" } });
    const events = graph.getEvents(runId);
    expect(types(events)).toEqual(["control_requested", "control_applied"]);
    expect(events[1]).toMatchObject({ nodeId: "intake", checkpoint: "node_boundary", kept: [] });
  });

  it("C-2 cancel while waiting on a concept decision drops the decision and ends the run", async () => {
    const { graph } = setup();
    const runId = graph.submit({ prompt: "4-inch plate" }, { ownerId: OWNER.userId });
    await waitUntil(() => graph.getRun(runId).state === "awaiting_decision", "decision");
    await graph.control(runId, cancel("cancel-1"), OWNER);
    expect(await graph.waitForTerminal(runId)).toMatchObject({ state: "cancelled", artifacts: [] });
    const events = graph.getEvents(runId);
    expectAllValid(events);
    expect(events.at(-1)).toMatchObject({ type: "control_applied", nodeId: "concept_picks", checkpoint: "decision", kept: [] });
    expect(types(events)).not.toContain("decision_resolved");
  });

  it("C-3 a repeated (run_id, key) has one effect and returns the original response", async () => {
    const { graph, store, agent, runId } = await gatedRun();
    const first = await graph.control(runId, pause("pause-1"), OWNER);
    const second = await graph.control(runId, pause("pause-1"), OWNER);
    expect(first).toMatchObject({ status: 202, outcome: "accepted", state: "pausing" });
    expect(second).toBe(first);
    expect(store.size()).toBe(1);

    // A new key is a new command, rejected as a duplicate request rather than replayed.
    expect(await graph.control(runId, pause("pause-2"), OWNER)).toMatchObject({ outcome: "rejected", reason: "duplicate" });
    // Reusing a key for a different kind is a conflict and changes nothing.
    const eventsBefore = graph.getEvents(runId).length;
    expect(await graph.control(runId, cancel("pause-1"), OWNER)).toEqual({ status: 409, outcome: "idempotency_conflict" });
    expect(graph.getEvents(runId)).toHaveLength(eventsBefore);

    agent.gate.resolve();
    await waitUntil(() => graph.getRun(runId).state === "paused", "paused");
    // A replay after the command applied still returns the original response.
    expect(await graph.control(runId, pause("pause-1"), OWNER)).toBe(first);
    const pauses = controlEvents(graph.getEvents(runId)).filter((e) => e.type === "control_requested" && e.kind === "pause");
    expect(pauses).toHaveLength(2);
    expect(controlEvents(graph.getEvents(runId)).filter((e) => e.type === "control_applied")).toHaveLength(1);
  });

  it("C-3 two concurrent identical commands have one effect", async () => {
    const { graph, store, runId } = await gatedRun();
    const [a, b] = await Promise.all([
      graph.control(runId, cancel("cancel-1"), OWNER),
      graph.control(runId, cancel("cancel-1"), OWNER),
    ]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ status: 202, outcome: "accepted", kind: "cancel" });
    expect(store.size()).toBe(1);
    const events = controlEvents(graph.getEvents(runId));
    expect(types(events)).toEqual(["control_requested"]);
    expect(graph.getRun(runId).pendingControls).toBe(1);
  });

  it("C-4 only the owner, or an admin at AAL2, may control a run; denials change nothing", async () => {
    const { graph, store, runId } = await gatedRun();
    const eventsBefore = graph.getEvents(runId);
    const runBefore = graph.getRun(runId);

    // The request cannot name the owner: a payload claiming ownership is ignored.
    const spoofed = { kind: "cancel" as const, idempotencyKey: "deny-0", payload: { ownerId: STRANGER.userId } };
    expect(await graph.control(runId, spoofed, STRANGER)).toEqual({ status: 403, outcome: "forbidden" });
    for (const [label, actor] of [
      ["non-owner", STRANGER],
      ["non-admin at AAL2", STRANGER_AAL2],
      ["admin at AAL1", ADMIN_AAL1],
    ] as const) {
      for (const command of [pause(`deny-${label}`), cancel(`deny-${label}`)]) {
        expect(await graph.control(runId, command, actor), label).toEqual({ status: 403, outcome: "forbidden" });
      }
    }
    expect(graph.getEvents(runId)).toEqual(eventsBefore);
    expect(graph.getRun(runId)).toEqual(runBefore);
    expect(store.size()).toBe(0);

    // A denied key is not consumed.
    expect(await graph.control(runId, pause("deny-non-owner"), ADMIN_AAL2)).toMatchObject({ status: 202, outcome: "accepted" });
    expect(controlEvents(graph.getEvents(runId))).toEqual([
      expect.objectContaining({ type: "control_requested", kind: "pause", actorId: ADMIN_AAL2.userId }),
    ]);
  });

  it("C-4 the owner may control at AAL1, and a run with no recorded owner is admin-AAL2 only", async () => {
    const owned = await gatedRun();
    expect(await owned.graph.control(owned.runId, cancel("k"), OWNER)).toMatchObject({ status: 202 });

    const unowned = setup(singleAgent(new GatedCadAgent()));
    const runId = unowned.graph.submit({ prompt: PLATE_PROMPT });
    expect(await unowned.graph.control(runId, cancel("k"), OWNER)).toEqual({ status: 403, outcome: "forbidden" });
    expect(await unowned.graph.control(runId, cancel("k"), ADMIN_AAL2)).toMatchObject({ status: 202 });
  });

  it("C-5 control on a completed or cancelled run is a no-op that emits control_rejected{terminal}", async () => {
    const { graph, store } = setup();
    const done = graph.submit({ prompt: PLATE_PROMPT }, { ownerId: OWNER.userId });
    expect(await graph.waitForTerminal(done)).toMatchObject({ state: "completed", claim: { state: "released" } });
    const completedLength = graph.getEvents(done).length;
    for (const command of [pause("late-pause"), cancel("late-cancel")]) {
      expect(await graph.control(done, command, OWNER)).toMatchObject({ status: 200, outcome: "rejected", reason: "terminal" });
    }
    const after = graph.getEvents(done).slice(completedLength);
    expectAllValid(graph.getEvents(done));
    expect(after.map((e) => [e.type, "kind" in e ? e.kind : ""])).toEqual([
      ["control_requested", "pause"],
      ["control_rejected", "pause"],
      ["control_requested", "cancel"],
      ["control_rejected", "cancel"],
    ]);
    expect(after.filter((e) => e.type === "control_rejected").every((e) => e.type === "control_rejected" && e.reason === "terminal")).toBe(true);
    expect(graph.getRun(done).state).toBe("completed");
    expect(graph.getEvents(done)[completedLength - 1].type).toBe("result");

    const cancelled = graph.submit({ prompt: PLATE_PROMPT }, { ownerId: OWNER.userId });
    await graph.control(cancelled, cancel("c1"), OWNER);
    await graph.waitForTerminal(cancelled);
    expect(await graph.control(cancelled, cancel("c2"), OWNER)).toMatchObject({ outcome: "rejected", reason: "terminal" });
    expect(await graph.control(cancelled, pause("p1"), OWNER)).toMatchObject({ outcome: "rejected", reason: "terminal" });
    expect(graph.getRun(cancelled)).toMatchObject({ state: "cancelled", artifacts: [] });
    expect(controlEvents(graph.getEvents(cancelled)).filter((e) => e.type === "control_applied")).toHaveLength(1);
    expect(store.has(cancelled, "c2")).toBe(true);
  });

  it("C-6 cancel issued mid-STEP-write waits for the checkpoint and the STEP stays valid", async () => {
    const statesDuringWrite: string[] = [];
    let issued: Promise<ControlResult> | undefined;
    const agent = new StepWriterAgent((index, ctx) => {
      statesDuringWrite.push(graph.getRun(ctx.runId).state);
      if (index === 0) issued = graph.control(ctx.runId, cancel("cancel-mid-write"), OWNER);
    });
    const { graph } = setup(singleAgent(agent));
    const runId = graph.submit({ prompt: PLATE_PROMPT }, { ownerId: OWNER.userId });
    expect(await graph.waitForTerminal(runId)).toMatchObject({ state: "cancelled" });
    expect(await issued).toMatchObject({ status: 202, outcome: "accepted", state: "cancelling" });

    // The write ran to the end with the cancel queued; nothing cut it short.
    expect(statesDuringWrite).toEqual(["running", "cancelling", "cancelling", "cancelling", "cancelling"]);
    const stepUri = `mem://${runId}/plate.step`;
    const step = agent.files.get(stepUri) ?? "";
    expect(validateStepText(step)).toEqual({ ok: true, entityCount: 6 });
    expect(agent.files.has(`mem://${runId}/plate.glb`)).toBe(false);

    const events = graph.getEvents(runId);
    expectAllValid(events);
    const stepEvent = events.find((e) => e.type === "artifact");
    const applied = events.find((e) => e.type === "control_applied");
    expect(stepEvent?.seq).toBeLessThan(applied?.seq ?? -1);
    expect(applied).toMatchObject({ checkpoint: "agent", kept: [{ kind: "step", uri: stepUri }] });
    expect(artifactKinds(events)).toEqual(["step"]);
  });

  it("C-6 the STEP validator accepts a whole file and rejects truncated or malformed ones", () => {
    const lines = plateStepLines("run-x");
    expect(validateStepText(lines.join("\n"))).toMatchObject({ ok: true });
    const bad: [string, string[]][] = [
      ["truncated after first chunk", lines.slice(0, 3)],
      ["truncated before DATA ENDSEC", lines.slice(0, -2)],
      ["no end marker", lines.slice(0, -1)],
      ["no ISO header line", lines.slice(1)],
      ["missing FILE_SCHEMA", lines.filter((l) => !l.startsWith("FILE_SCHEMA"))],
      ["empty DATA", [...lines.slice(0, 7), ...lines.slice(-2)]],
      ["half-written record", lines.map((l) => (l.startsWith("#5=") ? "#5=AXIS2_PLACEMENT_3D('',#1," : l))],
    ];
    for (const [label, input] of bad) expect(validateStepText(input.join("\n")).ok, label).toBe(false);
  });

  it("C-7 resume and steer return not_yet with no state change and no queued command", async () => {
    const { graph, store, agent, runId } = await gatedRun();
    const check = async (expectedState: string) => {
      const events = graph.getEvents(runId);
      for (const command of [
        { kind: "resume" as const, idempotencyKey: "r1" },
        { kind: "steer" as const, idempotencyKey: "s1", payload: { note: "make it 5 inches" } },
      ]) {
        expect(await graph.control(runId, command, OWNER)).toEqual({ status: 501, outcome: "not_yet", kind: command.kind });
      }
      expect(graph.getEvents(runId)).toEqual(events);
      expect(graph.getRun(runId)).toMatchObject({ state: expectedState, pendingControls: 0 });
      expect(store.has(runId, "r1") || store.has(runId, "s1")).toBe(false);
    };
    await check("running");

    await graph.control(runId, pause("pause-1"), OWNER);
    agent.gate.resolve();
    await waitUntil(() => graph.getRun(runId).state === "paused", "paused");
    await check("paused");
    for (let i = 0; i < 5; i++) await flush();
    expect(graph.getRun(runId).state).toBe("paused");
    expect(store.size()).toBe(1);
  });

  it("C-0 malformed commands and unknown runs are refused without effect", async () => {
    const { graph, store, runId } = await gatedRun();
    expect(await graph.control("nope", pause("k"), OWNER)).toEqual({ status: 404, outcome: "unknown_run" });
    expect(await graph.control(runId, pause(""), OWNER)).toMatchObject({ status: 400, outcome: "invalid" });
    expect(await graph.control(runId, { kind: "explode" as "pause", idempotencyKey: "k" }, OWNER)).toMatchObject({ status: 400 });
    expect(controlEvents(graph.getEvents(runId))).toEqual([]);
    expect(store.size()).toBe(0);
  });

  it("C-0 transition table and control event validation", () => {
    expect(requestTransition("running", "pause")).toEqual({ kind: "queue", next: "pausing" });
    expect(requestTransition("awaiting_decision", "pause")).toEqual({ kind: "queue", next: "pausing" });
    expect(requestTransition("pausing", "pause")).toEqual({ kind: "reject", reason: "duplicate" });
    expect(requestTransition("paused", "cancel")).toEqual({ kind: "queue", next: "cancelling" });
    expect(requestTransition("pausing", "cancel")).toEqual({ kind: "queue", next: "cancelling" });
    expect(requestTransition("cancelling", "pause")).toEqual({ kind: "reject", reason: "cancel_pending" });
    expect(requestTransition("cancelling", "cancel")).toEqual({ kind: "reject", reason: "duplicate" });
    for (const state of ["completed", "cancelled", "failed"] as const) {
      expect(requestTransition(state, "cancel")).toEqual({ kind: "reject", reason: "terminal" });
    }

    const envelope = { runId: "r", seq: 0, at: 0, commandId: "c", nodeId: "domain_agent" };
    const applied = { ...envelope, type: "control_applied", checkpoint: "agent" };
    expect(validateDesignGraphEvent({ ...envelope, type: "control_requested", kind: "pause", actorId: "u", idempotencyKey: "k" }).ok).toBe(true);
    expect(validateDesignGraphEvent({ ...applied, kind: "pause", state: "paused" }).ok).toBe(true);
    expect(validateDesignGraphEvent({ ...applied, kind: "cancel", state: "cancelled", kept: [{ kind: "step", uri: "u" }] }).ok).toBe(true);
    expect(validateDesignGraphEvent({ ...envelope, type: "control_rejected", kind: "cancel", reason: "terminal" }).ok).toBe(true);
    const malformed: [string, unknown][] = [
      ["requested resume", { ...envelope, type: "control_requested", kind: "resume", actorId: "u", idempotencyKey: "k" }],
      ["requested without key", { ...envelope, type: "control_requested", kind: "pause", actorId: "u", idempotencyKey: "" }],
      ["pause applied as cancelled", { ...applied, kind: "pause", state: "cancelled" }],
      ["pause applied with kept", { ...applied, kind: "pause", state: "paused", kept: [] }],
      ["cancel applied without kept", { ...applied, kind: "cancel", state: "cancelled" }],
      ["bad kept ref", { ...applied, kind: "cancel", state: "cancelled", kept: [{ kind: "usd" }] }],
      ["bad checkpoint", { ...applied, kind: "pause", state: "paused", checkpoint: "mid_write" }],
      ["unknown reject reason", { ...envelope, type: "control_rejected", kind: "cancel", reason: "nah" }],
    ];
    for (const [label, event] of malformed) expect(validateDesignGraphEvent(event).ok, label).toBe(false);
  });
});
