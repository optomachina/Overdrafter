import { describe, expect, it } from "vitest";
import type { DesignGraphEvent } from "../events";
import { OWNER, PLATE_PROMPT, controlEvents, setup, waitUntil } from "./test-support";

function describeEvent(event: DesignGraphEvent): string {
  const head = `#${String(event.seq).padStart(2, "0")} ${event.type}`;
  switch (event.type) {
    case "status":
      return `${head} ${event.nodeId}/${event.state}: ${event.message}`;
    case "artifact":
      return `${head} ${event.kind} ${event.uri}`;
    case "control_requested":
      return `${head} kind=${event.kind} actor=${event.actorId} key=${event.idempotencyKey} at=${event.nodeId}`;
    case "control_applied":
      return `${head} kind=${event.kind} state=${event.state} at=${event.nodeId}/${event.checkpoint}${
        event.kind === "cancel" ? ` kept=[${event.kept.map((ref) => ref.kind).join(",")}]` : ""
      }`;
    case "control_rejected":
      return `${head} kind=${event.kind} reason=${event.reason}`;
    default:
      return head;
  }
}

describe("DesignGraph control proof", () => {
  it("C-proof prints the event log of a 4-inch plate run paused then cancelled", async () => {
    const { graph } = setup();
    const runId = graph.submit({ prompt: PLATE_PROMPT }, { ownerId: OWNER.userId });
    graph.subscribe(runId, (event) => {
      if (event.type === "artifact" && event.kind === "glb") void graph.control(runId, { kind: "pause", idempotencyKey: "pause-1" }, OWNER);
    });
    await waitUntil(() => graph.getRun(runId).state === "paused", "paused");
    await graph.control(runId, { kind: "cancel", idempotencyKey: "cancel-1" }, OWNER);
    const snapshot = await graph.waitForTerminal(runId);

    const events = graph.getEvents(runId);
    console.log(
      [
        `OVD-810 proof: ${runId} "${PLATE_PROMPT}" (owner ${OWNER.userId})`,
        ...events.map(describeEvent),
        `final state=${snapshot.state} claim=${snapshot.claim?.state} kept=${JSON.stringify(snapshot.artifacts)}`,
      ].join("\n"),
    );

    expect(controlEvents(events).map((e) => (e.type === "control_applied" ? `${e.type}(${e.state})` : e.type))).toEqual([
      "control_requested",
      "control_applied(paused)",
      "control_requested",
      "control_applied(cancelled)",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "control_applied",
      state: "cancelled",
      kept: [
        { kind: "step", uri: `stub://design-graph/${runId}/plate-101.6mm.step` },
        { kind: "glb", uri: `stub://design-graph/${runId}/plate-101.6mm.glb` },
      ],
    });
    expect(snapshot).toMatchObject({ state: "cancelled", claim: { state: "released" } });
  });
});
