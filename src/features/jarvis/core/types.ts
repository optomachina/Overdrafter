// Core Jarvis channel contracts (OVD-798). Channels only translate transport; every
// decision about routing, access and work lives in the ConversationService.

export type ChannelId = string;
export type UserId = string;
export type AccessTier = "owner" | "beta" | "paid";
export type ControlKind = "pause" | "resume" | "cancel" | "steer";

export const WEB_CHANNEL: ChannelId = "web";

export type ChannelCapabilities = {
  readonly buttons: boolean;
  readonly images: boolean;
  readonly model3d: boolean;
  readonly maxText: number;
};

export type InboundAction =
  | { readonly kind: "decision"; readonly decisionId: string; readonly choice: string | null }
  | { readonly kind: "control"; readonly runId: string; readonly command: ControlKind };

export type InboundMessage = {
  readonly channel: ChannelId;
  readonly externalUserId: string;
  readonly text: string;
  readonly agent?: DomainAgentId;
  readonly action?: InboundAction;
  readonly idempotencyKey: string;
  readonly receivedAt: string;
};

export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type ReplyButton = { readonly id: string; readonly label: string };

/** What an adapter receives: already shaped for its capabilities. */
export type RenderedMessage = {
  readonly text: string;
  readonly buttons?: readonly ReplyButton[];
  readonly model3dUrl?: string;
  readonly link?: string;
};

/** Address for an outbound send. External ids are only ever known by hash. */
export type UserRef = { readonly userId: UserId; readonly externalIdHash: string | null };

export type DeliveryResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface ChannelAdapter {
  readonly id: ChannelId;
  /** Test-only adapters route in the test environment only, regardless of the UI flag. */
  readonly testOnly?: boolean;
  readonly capabilities: ChannelCapabilities;
  verifyInbound(request: unknown): Promise<VerifyResult>;
  normalizeInbound(request: unknown): InboundMessage;
  send(user: UserRef, message: RenderedMessage, deliveryKey: string): Promise<DeliveryResult>;
}

// ---------------------------------------------------------------------------------------------
// DesignGraph port. These types mirror the OVD-801 graph (server/design-graph/events.ts and
// graph.ts) field for field. The core may not import server code, so the mirror is pinned by
// server/jarvis/design-graph-port.test.ts, which fails to typecheck if the two drift.

export type DomainAgentId = "cad" | "optics" | "electronics" | "analysis";
export type GraphNodeId = "intake" | "concept_picks" | "domain_agent" | "verify" | "result";
export type GraphArtifactKind = "png" | "glb" | "step";
export type GraphStatusState = "started" | "completed" | "info";
export type GraphSkipCause = "skip" | "timeout";
export type GraphErrorCode = "agent_not_enabled" | "no_agent" | "agent_failed" | "verify_failed" | "internal_error";

interface GraphEventEnvelope {
  runId: string;
  seq: number;
  at: number;
}

export interface GraphStatusEvent extends GraphEventEnvelope {
  type: "status";
  nodeId: GraphNodeId;
  state: GraphStatusState;
  message: string;
}

export interface GraphDecisionRequestedEvent extends GraphEventEnvelope {
  type: "decision_requested";
  decisionId: string;
  nodeId: GraphNodeId;
  question: string;
  options: string[];
  recommended: string;
  bestGuess: string;
  timeoutMs: number;
}

export type GraphDecisionResolvedEvent = GraphEventEnvelope & {
  type: "decision_resolved";
  decisionId: string;
  nodeId: GraphNodeId;
  choice: string;
  rationale: string;
} & ({ outcome: "chosen" } | { outcome: "skipped_best_guess"; cause: GraphSkipCause });

export interface GraphArtifactEvent extends GraphEventEnvelope {
  type: "artifact";
  nodeId: GraphNodeId;
  agentId: DomainAgentId;
  kind: GraphArtifactKind;
  name: string;
  mimeType: string;
  uri: string;
  dimensionsMm?: { x: number; y: number; z: number };
}

export interface GraphResultEvent extends GraphEventEnvelope {
  type: "result";
  nodeId: "result";
  agentId: DomainAgentId;
  summary: string;
  picks: Record<string, string>;
  artifacts: { kind: GraphArtifactKind; uri: string }[];
}

export interface GraphErrorEvent extends GraphEventEnvelope {
  type: "error";
  nodeId: GraphNodeId;
  code: GraphErrorCode;
  message: string;
  agentId?: DomainAgentId;
}

/** Mirror of OVD-801 `DesignGraphEvent`. Every event carries `(runId, seq)`, its identity. */
export type GraphEvent =
  | GraphStatusEvent
  | GraphDecisionRequestedEvent
  | GraphDecisionResolvedEvent
  | GraphArtifactEvent
  | GraphResultEvent
  | GraphErrorEvent;

/** Mirror of OVD-801 `DesignRequest`. */
export interface GraphDesignRequest {
  prompt: string;
  domain?: DomainAgentId;
}

/** Mirror of OVD-801 `DecisionAnswer`. */
export type GraphDecisionAnswer = { kind: "choose"; choice: string } | { kind: "skip" };

/** Mirror of OVD-801 `ResolveDecisionResult`. */
export type GraphResolveDecisionResult =
  | { ok: true }
  | { ok: false; reason: "unknown_run" | "unknown_decision" | "invalid_choice" };

export type GraphControlCommand = {
  readonly kind: ControlKind;
  readonly idempotencyKey: string;
  readonly actor: UserId;
};

/** OVD-801 has no control surface yet; the adapter reports `unsupported` until it does. */
export type GraphControlResult = { readonly ok: true } | { readonly ok: false; readonly reason: "unsupported" | "unknown_run" };

export type GraphAgentAvailability = "enabled" | "disabled" | "unknown";

/** Extra context the core passes alongside the OVD-801 request; the adapter dedupes on idempotencyKey. */
export type GraphSubmitContext = {
  readonly userId: UserId;
  readonly conversationId: string;
  readonly idempotencyKey: string;
};

/**
 * The only exit to work. server/jarvis/design-graph-port.ts adapts the OVD-801 `DesignGraph`
 * (sync submit, three-argument resolveDecision, no control) to this async port.
 */
export interface DesignGraph {
  /** Same idempotencyKey -> same runId, so a retried inbound event never starts a second run. */
  submit(request: GraphDesignRequest, context: GraphSubmitContext): Promise<string>;
  resolveDecision(runId: string, decisionId: string, answer: GraphDecisionAnswer): Promise<GraphResolveDecisionResult>;
  control(runId: string, command: GraphControlCommand): Promise<GraphControlResult>;
  /** Read from the graph's own agent registry, so the core never keeps a second enabled list. */
  agentAvailability(agent: DomainAgentId): GraphAgentAvailability;
}
