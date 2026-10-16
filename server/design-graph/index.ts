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
  type RunClaim,
  type RunSnapshot,
  type RunState,
  type SubmitOptions,
} from "./graph";
export {
  InMemoryControlCommandStore,
  RunCancelledError,
  type ActorAal,
  type ControlActor,
  type ControlCommand,
  type ControlCommandStore,
  type ControlResult,
} from "./control";
export {
  DomainAgentRegistry,
  DisabledStubAgent,
  StubCadAgent,
  createDefaultRegistry,
  type AgentContext,
  type DefaultRegistryOptions,
  type AgentEmission,
  type AgentEmit,
  type AgentOutput,
  type DecisionSpec,
  type DesignRequest,
  type DomainAgent,
} from "./agents";
export {
  CadAgent,
  CAD_AGENT_FLAG,
  CAD_PLATE_THICKNESS_MAX_MM,
  CAD_PLATE_THICKNESS_MIN_MM,
  createJarvisWorkerRunner,
  isCadAgentEnabled,
  type CadAgentOptions,
  type CadWorkerRunner,
  type PlateJobParams,
  type PlateWorkerOutcome,
  type PlateWorkerResult,
} from "./cad-agent";
export {
  assertValidDesignGraphEvent,
  validateDesignGraphEvent,
  InvalidDesignGraphEventError,
  type ControlKind,
  type DesignGraphEvent,
  type DesignGraphEventType,
  type DomainId,
  type NodeId,
  type ValidationResult,
} from "./events";
