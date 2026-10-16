// Adapts the OVD-801 design graph to the Jarvis core's async DesignGraph port (OVD-798).
// The core cannot import server code (src/features/jarvis/import-boundary.test.ts), so this
// adapter sits outside it and design-graph-port.test.ts pins the core's mirror types to OVD-801.

import { DesignGraph as Ovd801DesignGraph, type DomainAgentRegistry } from "../design-graph";
import type { DesignGraph, GraphAgentAvailability } from "../../src/features/jarvis/core/types";

export type DesignGraphPortOptions = {
  readonly graph: Ovd801DesignGraph;
  /** The registry the graph was constructed with, so availability is the graph's own answer. */
  readonly registry: DomainAgentRegistry;
};

/**
 * OVD-801 `submit` has no idempotency key, so the port remembers the runId per key: a retried
 * inbound event that already reached the graph gets the same run back. This map is per process;
 * the durable guard is the core's inbound message row, which keeps the runId once attached.
 * OVD-801 has no control surface yet, so `control` reports `unsupported`.
 */
export function createDesignGraphPort({ graph, registry }: DesignGraphPortOptions): DesignGraph {
  const runsByKey = new Map<string, string>();
  return {
    async submit(request, context) {
      const existing = runsByKey.get(context.idempotencyKey);
      if (existing) return existing;
      const runId = graph.submit({ ...request });
      runsByKey.set(context.idempotencyKey, runId);
      return runId;
    },
    async resolveDecision(runId, decisionId, answer) {
      return graph.resolveDecision(runId, decisionId, answer);
    },
    async control() {
      return { ok: false, reason: "unsupported" };
    },
    agentAvailability(agent): GraphAgentAvailability {
      if (!registry.ids().includes(agent)) return "unknown";
      return registry.isEnabled(agent) ? "enabled" : "disabled";
    },
  };
}
