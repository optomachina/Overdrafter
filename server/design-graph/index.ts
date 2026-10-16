// Public entry for the hardware design graph. Channel and UI code import from here
// only; import-boundary.test.ts enforces that.
export {
  DesignGraph,
  DEFAULT_DECISION_TIMEOUT_MS,
  systemClock,
  type DecisionAnswer,
  type DesignGraphListener,
  type DesignGraphOptions,
  type GraphClock,
  type ResolveDecisionResult,
  type RunSnapshot,
  type RunState,
} from "./graph";
export {
  DomainAgentRegistry,
  DisabledStubAgent,
  StubCadAgent,
  createDefaultRegistry,
  type AgentContext,
  type AgentEmission,
  type AgentEmit,
  type AgentOutput,
  type DecisionSpec,
  type DesignRequest,
  type DomainAgent,
} from "./agents";
export {
  assertValidDesignGraphEvent,
  validateDesignGraphEvent,
  InvalidDesignGraphEventError,
  type DesignGraphEvent,
  type DesignGraphEventType,
  type DomainId,
  type NodeId,
  type ValidationResult,
} from "./events";
